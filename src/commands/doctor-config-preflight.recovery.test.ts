import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { patchConfigHealthEntryToStore } from "../config/io.health-state.js";
import { createConfigIO } from "../config/io.js";
import { createConfigHealthFingerprint } from "../config/io.observe-state.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withTempDir } from "../test-utils/temp-dir.js";
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

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
});

it("Doctor repairs authored OTel grpc before restoring a suspicious config from backup", async () => {
  const legacy = {
    gateway: { mode: "local" },
    diagnostics: { otel: { enabled: true, protocol: "grpc", traces: true } },
  };
  await withDoctorConfigPreflightHome(async (home) => {
    const stateDir = path.join(home, ".openclaw");
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.mkdir(stateDir, { recursive: true });
    const original = '{"update":{"channel":"stable"}}\n';
    const backup = `${JSON.stringify({ ...legacy, plugins: { enabled: false } }, null, 2)}\n`;
    await fs.writeFile(configPath, original);
    await fs.writeFile(`${configPath}.bak`, backup);

    const result = await runDoctorConfigPreflight(repairOptions);

    expect(result.snapshot.valid).toBe(true);
    expect(result.snapshot.legacyIssues).toEqual([]);
    const saved = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(saved).toMatchObject({
      gateway: { mode: "local" },
      diagnostics: { otel: { enabled: false, traces: true } },
    });
    expect(result.snapshot.config.diagnostics?.otel?.protocol).toBeUndefined();
    expect(await fs.readFile(`${configPath}.bak`, "utf8")).toBe(backup);
    const clobbered = (await fs.readdir(stateDir)).filter((name) => name.includes(".clobbered."));
    expect(clobbered).toHaveLength(1);
    expect(await fs.readFile(path.join(stateDir, clobbered[0]!), "utf8")).toBe(original);
  });
});

it("Doctor preserves an invalid config from a future writer instead of restoring an older backup", async () => {
  const original = '{ meta: { lastTouchedVersion: "9999.1.1" }, gateway: { mode: "invalid" } }\n';
  await withDoctorConfigPreflightHome(async (home) => {
    const stateDir = path.join(home, ".openclaw");
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.mkdir(stateDir, { recursive: true });
    const backup = '{ gateway: { mode: "local", port: 19091 }, plugins: { enabled: false } }\n';
    const backupPath = `${configPath}.last-good`;

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

    expect(await fs.readFile(configPath, "utf8")).toBe(original);
    expect(await fs.readFile(backupPath, "utf8")).toBe(backup);
    expect(result.snapshot.valid).toBe(false);
    expect(result.snapshot.config.gateway?.port).toBeUndefined();
    expect((await fs.readdir(stateDir)).filter((name) => name.includes(".clobbered."))).toEqual([]);
  });
});

it.each(["env", "include"] as const)(
  "Doctor leaves an %s-owned OTel backup unchanged when restoration would flatten its owner",
  async (owner) => {
    await withDoctorConfigPreflightHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const configPath = path.join(stateDir, "openclaw.json");
      const includePath = path.join(stateDir, "otel.json5");
      const includeRaw = '{ enabled: true, protocol: "grpc", traces: true }\n';
      await fs.mkdir(stateDir, { recursive: true });
      const original = '{"update":{"channel":"stable"}}\n';
      const backup = JSON.stringify({
        gateway: { mode: "local" },
        plugins: { enabled: false },
        diagnostics: {
          otel:
            owner === "include"
              ? { $include: "./otel.json5" }
              : { enabled: true, protocol: "${OTEL_PROTOCOL}", traces: true },
        },
      });
      await fs.writeFile(configPath, original);
      await fs.writeFile(`${configPath}.bak`, backup);
      if (owner === "include") {
        await fs.writeFile(includePath, includeRaw);
      }

      await withEnvAsync({ OTEL_PROTOCOL: "grpc" }, () => runDoctorConfigPreflight(repairOptions));

      expect(await fs.readFile(configPath, "utf8")).toBe(original);
      expect(await fs.readFile(`${configPath}.bak`, "utf8")).toBe(backup);
      if (owner === "include") {
        expect(await fs.readFile(includePath, "utf8")).toBe(includeRaw);
      }
      expect((await fs.readdir(stateDir)).filter((name) => name.includes(".clobbered."))).toEqual(
        [],
      );
    });
  },
);

it("Doctor recovers list roster ownership and the legacy default after runtime recovery refuses it", async () => {
  await withDoctorConfigPreflightHome(async (home) => {
    const stateDir = path.join(home, ".openclaw");
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.mkdir(stateDir, { recursive: true });
    const entries = {
      alpha: {
        workspace: path.join(home, "workspace-alpha"),
      },
      beta: { workspace: path.join(home, "workspace-beta") },
      gamma: { workspace: path.join(home, "workspace-gamma") },
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
    expect(await fs.readFile(configPath, "utf8")).toBe(original);
    expect(await fs.readFile(lastGoodPath, "utf8")).toBe(backup);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Config last-known-good recovery skipped"),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("agents.list"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("openclaw doctor --fix"));
    expect((await fs.readdir(stateDir)).filter((name) => name.includes(".clobbered."))).toEqual([]);
    const snapshot = (await runDoctorConfigPreflight(repairOptions)).snapshot;
    expect(snapshot.valid).toBe(true);
    expect(snapshot.config.bindings).toEqual(bindings);
    expect(snapshot.config.agents?.defaults?.systemAgent?.agentId).toBe("alpha");
    expect(snapshot.config.agents?.entries).toEqual(entries);
    expect(await fs.readFile(lastGoodPath, "utf8")).toBe(backup);
    const clobbered = (await fs.readdir(stateDir)).filter((name) => name.includes(".clobbered."));
    expect(clobbered).toHaveLength(1);
    expect(await fs.readFile(path.join(stateDir, clobbered[0]!), "utf8")).toBe(original);
  });
});

it("refuses retired cron files before repairing their custom locator or recovering config", async () => {
  await withDoctorConfigPreflightHome(async (home) => {
    const stateDir = path.join(home, ".openclaw");
    const configPath = path.join(stateDir, "openclaw.json");
    const storePath = path.join(home, "custom-cron", "jobs.json");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    const original = JSON.stringify({ cron: { store: storePath }, update: { channel: "stable" } });
    const backup = '{"gateway":{"mode":"local"},"plugins":{"enabled":false}}\n';
    const retired = '{"version":1,"jobs":[{"id":"retained"}]}\n';
    await fs.writeFile(configPath, original);
    await fs.writeFile(`${configPath}.bak`, backup);
    await fs.writeFile(storePath, retired);

    await expect(runDoctorConfigPreflight(repairOptions)).rejects.toThrow(
      /Upgrade through OpenClaw 2026\.9\.7/,
    );

    expect(await fs.readFile(configPath, "utf8")).toBe(original);
    expect(await fs.readFile(`${configPath}.bak`, "utf8")).toBe(backup);
    expect(await fs.readFile(storePath, "utf8")).toBe(retired);
    expect((await fs.readdir(stateDir)).filter((name) => name.includes(".clobbered."))).toEqual([]);
  });
});

const envKeys = ["HOME", "OPENCLAW_HOME", "OPENCLAW_CONFIG_PATH", "OPENCLAW_STATE_DIR"] as const;
function setEnv(values: Partial<Record<(typeof envKeys)[number], string>>) {
  for (const key of envKeys) {
    vi.stubEnv(key, values[key]);
  }
}

describe("Doctor legacy config rename", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("renames the config after root relocation and leaves a second pass unchanged", async () => {
    await withTempDir("openclaw-doctor-legacy-rename-", async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const legacyPath = path.join(stateDir, "clawdbot.json");
      const configPath = path.join(stateDir, "openclaw.json");
      await fs.mkdir(stateDir);
      await fs.writeFile(legacyPath, "{}\n");
      const original = await fs.stat(legacyPath, { bigint: true });
      setEnv({ HOME: home });
      await runDoctorConfigPreflight({ migrateState: false, invalidConfigNote: false });
      const renamed = await fs.stat(configPath, { bigint: true });
      expect([renamed.dev, renamed.ino]).toEqual([original.dev, original.ino]);
      await expect(fs.readFile(configPath, "utf8")).resolves.toBe("{}\n");
      await expect(fs.stat(legacyPath)).rejects.toMatchObject({ code: "ENOENT" });
      await runDoctorConfigPreflight({ migrateState: false, invalidConfigNote: false });
      const again = await fs.stat(configPath, { bigint: true });
      expect([again.dev, again.ino, again.mtimeNs]).toEqual([
        renamed.dev,
        renamed.ino,
        renamed.mtimeNs,
      ]);
    });
  });

  it.each(["both-roots", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"] as const)(
    "leaves legacy config untouched with %s",
    async (selector) => {
      await withTempDir("openclaw-doctor-legacy-control-", async (home) => {
        const stateDir = path.join(home, ".openclaw");
        const source = path.join(stateDir, "clawdbot.json");
        const target = path.join(stateDir, "openclaw.json");
        await fs.mkdir(stateDir);
        await fs.writeFile(source, "{}\n");
        if (selector === "both-roots") {
          await fs.mkdir(path.join(home, ".clawdbot"));
        }
        setEnv({
          HOME: home,
          ...(selector === "both-roots"
            ? {}
            : {
                [selector]:
                  selector === "OPENCLAW_HOME"
                    ? home
                    : selector === "OPENCLAW_STATE_DIR"
                      ? stateDir
                      : target,
              }),
        });
        await runDoctorConfigPreflight({ migrateState: false, invalidConfigNote: false });
        await expect(fs.readFile(source, "utf8")).resolves.toBe("{}\n");
        await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
      });
    },
  );
});
