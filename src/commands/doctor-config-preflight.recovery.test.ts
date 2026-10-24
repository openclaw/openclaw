import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it as baseIt, vi } from "vitest";
import { patchConfigHealthEntryToStore } from "../config/io.health-state.js";
import { createConfigIO } from "../config/io.js";
import { createConfigHealthFingerprint } from "../config/io.observe-state.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { runDoctorConfigPreflight } from "./doctor-config-preflight.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";
import type { DoctorConfigPreflightOptions } from "./doctor/shared/config-migration-result.js";

const repairOptions = {
  observe: false,
  migrateState: false,
  migrateLegacyConfig: false,
  repairPrefixedConfig: true,
  invalidConfigNote: false,
} satisfies DoctorConfigPreflightOptions;

afterEach(closeOpenClawStateDatabaseForTest);

const it = baseIt.extend<{ home: string; configPath: string }>({
  home: ({ task: _task }, use) => withDoctorConfigPreflightHome(use),
  configPath: ({ home }, use) => use(path.join(home, ".openclaw", "openclaw.json")),
});
async function expectFiles(files: Record<string, string>) {
  for (const [filename, content] of Object.entries(files)) {
    expect(await fs.readFile(filename, "utf8")).toBe(content);
  }
}
async function expectClobbered(configPath: string, original?: string) {
  const stateDir = path.dirname(configPath);
  const files = (await fs.readdir(stateDir)).filter((name) => name.includes(".clobbered."));
  expect(files).toHaveLength(original === undefined ? 0 : 1);
  if (original !== undefined) {
    await expectFiles({ [path.join(stateDir, files[0]!)]: original });
  }
}

it("preserves an invalid future-writer config instead of restoring an older backup", async ({
  configPath,
}) => {
  const original = '{ meta: { lastTouchedVersion: "9999.1.1" }, gateway: { mode: "invalid" } }\n';
  const backup = '{ gateway: { mode: "local", port: 19091 }, plugins: { enabled: false } }\n';

  await fs.writeFile(configPath, backup);
  const io = createConfigIO({ configPath });
  expect(await io.promoteConfigSnapshotToLastKnownGood(await io.readConfigFileSnapshot())).toBe(
    true,
  );

  await fs.writeFile(configPath, original);

  const result = await withEnvAsync(
    { OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS: undefined },
    () => runDoctorConfigPreflight(repairOptions),
  );

  await expectFiles({ [configPath]: original, [`${configPath}.last-good`]: backup });
  expect(result.snapshot.valid).toBe(false);
  expect(result.snapshot.config.gateway?.port).toBeUndefined();
  await expectClobbered(configPath);
});

it.for(["authored", "env", "include"] as const)(
  "Doctor repairs only authored OTel backups without flattening %s ownership",
  async (owner, { configPath }) => {
    const includePath = path.join(path.dirname(configPath), "otel.json5");
    const includeRaw = '{ enabled: true, protocol: "grpc", traces: true }\n';
    const original = '{"update":{"channel":"stable"}}\n';
    const otel = {
      enabled: true,
      protocol: owner === "env" ? "${OTEL_PROTOCOL}" : "grpc",
      traces: true,
    };
    const backup = JSON.stringify({
      gateway: { mode: "local" },
      plugins: { enabled: false },
      diagnostics: { otel: owner === "include" ? { $include: "./otel.json5" } : otel },
    });
    await fs.writeFile(configPath, original);
    await fs.writeFile(`${configPath}.bak`, backup);
    if (owner === "include") {
      await fs.writeFile(includePath, includeRaw);
    }

    const result = await withEnvAsync({ OTEL_PROTOCOL: "grpc" }, () =>
      runDoctorConfigPreflight(repairOptions),
    );
    await expectFiles({ [`${configPath}.bak`]: backup });
    if (owner === "authored") {
      expect(result.snapshot).toMatchObject({ valid: true, legacyIssues: [] });
      expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toMatchObject({
        gateway: { mode: "local" },
        diagnostics: { otel: { enabled: false, traces: true } },
      });
      expect(result.snapshot.config.diagnostics?.otel?.protocol).toBeUndefined();
    } else {
      await expectFiles({ [configPath]: original });
    }
    if (owner === "include") {
      expect(await fs.readFile(includePath, "utf8")).toBe(includeRaw);
    }
    await expectClobbered(configPath, owner === "authored" ? original : undefined);
  },
);

it("recovers roster ownership and the legacy default after runtime recovery refuses it", async ({
  configPath,
  home,
}) => {
  const workspace = (id: string) => ({ workspace: path.join(home, `workspace-${id}`) });
  const entries = {
    alpha: workspace("alpha"),
    beta: workspace("beta"),
    gamma: workspace("gamma"),
  };
  const bindings = [{ agentId: "beta", match: { channel: "discord" } }];
  const backup = JSON.stringify({
    gateway: { mode: "local" },
    plugins: { enabled: false },
    agents: {
      list: Object.entries(entries).map(([id, config]) =>
        Object.assign({ id }, config, id === "alpha" ? { default: true } : {}),
      ),
    },
    bindings,
  });
  const lastGoodPath = `${configPath}.last-good`;
  await fs.writeFile(lastGoodPath, backup);
  const fingerprint = createConfigHealthFingerprint({
    raw: backup,
    parsed: JSON.parse(backup),
    stat: await fs.stat(lastGoodPath),
  });
  // This promotion predates canonical rosters; runtime recovery must not normalize the backup.
  patchConfigHealthEntryToStore(
    { env: process.env, homedir: () => home, logger: { warn() {} } },
    configPath,
    { lastKnownGood: fingerprint, lastPromotedGood: fingerprint },
  );
  const original = '{ "gateway": { "mode": "local" },';
  await fs.writeFile(configPath, original);
  const warn = vi.fn();
  const io = createConfigIO({
    configPath,
    env: process.env,
    observe: false,
    logger: { warn, error() {} },
  });
  const restored = await io.recoverConfigFromLastKnownGood({
    snapshot: await io.readConfigFileSnapshot(),
    reason: "doctor-invalid-config",
  });
  expect(restored).toBe(false);
  await expectFiles({ [configPath]: original, [lastGoodPath]: backup });
  expect(warn).toHaveBeenCalledWith(
    expect.stringContaining("Config last-known-good recovery skipped"),
  );
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("agents.list"));
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("openclaw doctor --fix"));
  await expectClobbered(configPath);
  const snapshot = (await runDoctorConfigPreflight(repairOptions)).snapshot;
  expect(snapshot.valid).toBe(true);
  expect(snapshot.config.bindings).toEqual(bindings);
  expect(snapshot.config.agents?.defaults?.systemAgent?.agentId).toBe("alpha");
  expect(snapshot.config.agents?.entries).toEqual(entries);
  await expectFiles({ [lastGoodPath]: backup });
  await expectClobbered(configPath, original);
});

it("keeps a custom cron locator until state repair can preserve its retired data", async ({
  configPath,
  home,
}) => {
  const storePath = path.join(home, "custom-cron", "jobs.json");
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  const original = JSON.stringify({ cron: { store: storePath }, update: { channel: "stable" } });
  const backup = '{"gateway":{"mode":"local"},"plugins":{"enabled":false}}\n';
  const retired = '{"version":1,"jobs":[{"id":"retained"}]}\n';
  await fs.writeFile(configPath, original);
  await fs.writeFile(`${configPath}.bak`, backup);
  await fs.writeFile(storePath, retired);

  await expect(runDoctorConfigPreflight(repairOptions)).rejects.toThrow(/openclaw doctor --fix/);

  await expectFiles({
    [configPath]: original,
    [`${configPath}.bak`]: backup,
    [storePath]: retired,
  });
  await expectClobbered(configPath);
});

it.for([
  "none",
  "both-roots",
  "OPENCLAW_HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
] as const)(
  "renames legacy config only without a relocation control (%s), then stays unchanged",
  async (selector, { configPath: target, home }) => {
    const stateDir = path.dirname(target);
    const source = path.join(stateDir, "clawdbot.json");
    await fs.writeFile(source, "{}\n");
    const original = await fs.stat(source, { bigint: true });
    if (selector === "both-roots") {
      await fs.mkdir(path.join(home, ".clawdbot"));
    }
    await withEnvAsync(
      {
        OPENCLAW_HOME: selector === "OPENCLAW_HOME" ? home : undefined,
        OPENCLAW_STATE_DIR: selector === "OPENCLAW_STATE_DIR" ? stateDir : undefined,
        OPENCLAW_CONFIG_PATH: selector === "OPENCLAW_CONFIG_PATH" ? target : undefined,
      },
      async () => {
        await runDoctorConfigPreflight({ migrateState: false, invalidConfigNote: false });
        if (selector !== "none") {
          await expect(fs.readFile(source, "utf8")).resolves.toBe("{}\n");
          await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
        } else {
          const renamed = await fs.stat(target, { bigint: true });
          expect([renamed.dev, renamed.ino]).toEqual([original.dev, original.ino]);
          await expect(fs.readFile(target, "utf8")).resolves.toBe("{}\n");
          await expect(fs.stat(source)).rejects.toMatchObject({ code: "ENOENT" });
          await runDoctorConfigPreflight({ migrateState: false, invalidConfigNote: false });
          const again = await fs.stat(target, { bigint: true });
          expect(again).toMatchObject({
            dev: renamed.dev,
            ino: renamed.ino,
            mtimeNs: renamed.mtimeNs,
          });
        }
      },
    );
  },
);
