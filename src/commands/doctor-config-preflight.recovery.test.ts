import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { patchConfigHealthEntryToStore } from "../config/io.health-state.js";
import { createConfigIO } from "../config/io.js";
import { createConfigHealthFingerprint } from "../config/io.observe-state.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { runDoctorConfigPreflight } from "./doctor-config-preflight.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
});

it.each([
  {
    name: "loopback bind alias",
    legacy: { gateway: { mode: "local", bind: "localhost" } },
    expected: { gateway: { mode: "local", bind: "loopback" } },
  },
  {
    name: "LAN bind alias",
    legacy: { gateway: { mode: "local", bind: "0.0.0.0" } },
    expected: { gateway: { mode: "local", bind: "lan" } },
  },
  {
    name: "authored OTel grpc",
    legacy: {
      gateway: { mode: "local" },
      diagnostics: { otel: { enabled: true, protocol: "grpc", traces: true } },
    },
    expected: {
      gateway: { mode: "local" },
      diagnostics: { otel: { enabled: false, traces: true } },
    },
  },
])(
  "Doctor repairs $name before restoring a suspicious config from backup",
  async ({ legacy, expected }) => {
    await withDoctorConfigPreflightHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const configPath = path.join(stateDir, "openclaw.json");
      await fs.mkdir(stateDir, { recursive: true });
      const original = '{"update":{"channel":"stable"}}\n';
      const backup = `${JSON.stringify({ ...legacy, plugins: { enabled: false } }, null, 2)}\n`;
      await fs.writeFile(configPath, original);
      await fs.writeFile(`${configPath}.bak`, backup);

      const result = await runDoctorConfigPreflight({
        observe: false,
        migrateState: false,
        migrateLegacyConfig: false,
        repairPrefixedConfig: true,
        invalidConfigNote: false,
      });

      expect(result.snapshot.valid).toBe(true);
      expect(result.snapshot.legacyIssues).toEqual([]);
      const saved = JSON.parse(await fs.readFile(configPath, "utf8"));
      expect(saved).toMatchObject(expected);
      expect(result.snapshot.config.diagnostics?.otel?.protocol).toBeUndefined();
      expect(await fs.readFile(`${configPath}.bak`, "utf8")).toBe(backup);
      const clobbered = (await fs.readdir(stateDir)).filter((name) => name.includes(".clobbered."));
      expect(clobbered).toHaveLength(1);
      expect(await fs.readFile(path.join(stateDir, clobbered[0]!), "utf8")).toBe(original);
    });
  },
);

it.each([
  {
    name: "a valid active config",
    original: '{ gateway: { mode: "local", port: 19092 }, plugins: { enabled: false } }\n',
    port: 19092,
    valid: true,
  },
  {
    name: "a suspicious config from a future writer",
    original: '{ meta: { lastTouchedVersion: "9999.1.1" }, update: { channel: "stable" } }\n',
    port: undefined,
    valid: true,
  },
  {
    name: "an invalid config from a future writer",
    original: '{ meta: { lastTouchedVersion: "9999.1.1" }, gateway: { mode: "invalid" } }\n',
    port: undefined,
    valid: false,
    lastGood: true,
  },
])(
  "Doctor preserves $name instead of restoring an older backup",
  async ({ original, port, valid, lastGood }) => {
    await withDoctorConfigPreflightHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const configPath = path.join(stateDir, "openclaw.json");
      await fs.mkdir(stateDir, { recursive: true });
      const backup = '{ gateway: { mode: "local", port: 19091 }, plugins: { enabled: false } }\n';
      const backupPath = `${configPath}.${lastGood ? "last-good" : "bak"}`;
      if (lastGood) {
        await fs.writeFile(configPath, backup);
        const io = createConfigIO({ configPath });
        expect(
          await io.promoteConfigSnapshotToLastKnownGood(await io.readConfigFileSnapshot()),
        ).toBe(true);
      } else {
        await fs.writeFile(backupPath, backup);
      }
      await fs.writeFile(configPath, original);

      const result = await withEnvAsync(
        { OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS: undefined },
        () =>
          runDoctorConfigPreflight({
            observe: false,
            migrateState: false,
            migrateLegacyConfig: false,
            repairPrefixedConfig: true,
            invalidConfigNote: false,
          }),
      );

      expect(await fs.readFile(configPath, "utf8")).toBe(original);
      expect(await fs.readFile(backupPath, "utf8")).toBe(backup);
      expect(result.snapshot.valid).toBe(valid);
      expect(result.snapshot.config.gateway?.port).toBe(port);
      expect((await fs.readdir(stateDir)).filter((name) => name.includes(".clobbered."))).toEqual(
        [],
      );
    });
  },
);

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

      await withEnvAsync({ OTEL_PROTOCOL: "grpc" }, () =>
        runDoctorConfigPreflight({
          observe: false,
          migrateState: false,
          migrateLegacyConfig: false,
          repairPrefixedConfig: true,
          invalidConfigNote: false,
        }),
      );

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

it.each([
  { shape: "list", legacyDefault: false },
  { shape: "entries", legacyDefault: false },
  { shape: "list", legacyDefault: true },
])(
  "normal and Doctor recovery preserve $shape roster ownership (legacy default: $legacyDefault)",
  async ({ shape, legacyDefault }) => {
    await withDoctorConfigPreflightHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const configPath = path.join(stateDir, "openclaw.json");
      await fs.mkdir(stateDir, { recursive: true });
      const entries = {
        alpha: {
          workspace: path.join(home, "workspace-alpha"),
          ...(legacyDefault ? { default: true } : {}),
        },
        beta: { workspace: path.join(home, "workspace-beta") },
        gamma: { workspace: path.join(home, "workspace-gamma") },
      };
      const bindings = [{ agentId: "beta", match: { channel: "discord" } }];
      const backup = JSON.stringify({
        gateway: { mode: "local" },
        plugins: { enabled: false },
        agents:
          shape === "entries"
            ? { entries }
            : {
                list: Object.entries(entries).map(([id, config]) => Object.assign({ id }, config)),
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
      // This promotion predates the ownership requirement; today's validator rejects markerless rosters.
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
      expect(restored).toBe(legacyDefault);
      expect(await fs.readFile(configPath, "utf8")).toBe(legacyDefault ? backup : original);
      expect(await fs.readFile(lastGoodPath, "utf8")).toBe(backup);
      if (!legacyDefault) {
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining("Config last-known-good recovery skipped"),
        );
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("agents.ownership"));
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("run openclaw doctor"));
        expect((await fs.readdir(stateDir)).filter((name) => name.includes(".clobbered."))).toEqual(
          [],
        );
      }
      const snapshot = legacyDefault
        ? await io.readConfigFileSnapshot()
        : (
            await runDoctorConfigPreflight({
              observe: false,
              migrateState: false,
              migrateLegacyConfig: false,
              repairPrefixedConfig: true,
              invalidConfigNote: false,
            })
          ).snapshot;
      expect(snapshot.valid).toBe(true);
      expect(snapshot.config.bindings).toEqual(bindings);
      if (legacyDefault) {
        expect(snapshot.config.agents?.defaults?.systemAgent?.agentId).toBe("alpha");
      } else {
        const saved = JSON.parse(await fs.readFile(configPath, "utf8"));
        expect(saved.agents).toEqual({ ownership: "explicit", entries });
      }
      expect(await fs.readFile(lastGoodPath, "utf8")).toBe(backup);
      const clobbered = (await fs.readdir(stateDir)).filter((name) => name.includes(".clobbered."));
      expect(clobbered).toHaveLength(1);
      expect(await fs.readFile(path.join(stateDir, clobbered[0]!), "utf8")).toBe(original);
    });
  },
);
