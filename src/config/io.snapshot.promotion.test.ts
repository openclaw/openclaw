import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import JSON5 from "json5";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { createConfigIO } from "./io.factory.js";
import { readConfigHealthStateFromStore } from "./io.health-state.js";
import * as healthOwner from "./io.health-state.js";
import {
  registerConfigWriteListener,
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
  writeConfigFile,
} from "./io.js";
import { promoteConfigSnapshotToLastKnownGoodCore } from "./io.observe-promotion.js";
import { recoverConfigFromLastKnownGoodCore } from "./io.observe-recovery.js";
import { createConfigHealthFingerprint } from "./io.observe-state.js";
import {
  advanceConfigHealthBaselineForAcceptedWrite,
  captureConfigHealthBaselineForWrite,
  observeConfigSnapshotSync,
  restoreConfigHealthBaselineForRolledBackWrite,
} from "./io.observe.js";
import { normalizeConfigIoDeps } from "./io.read-helpers.js";
import { withTempHomeConfig } from "./test-helpers.js";
import type { ConfigFileSnapshot } from "./types.js";

// Split from io.snapshot.recovery.test.ts when main's growth left that file
// over the 1000-line test budget; the promotion suites keep their own home.
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    clearPluginMetadataLifecycleCaches();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

// Covers last-known-good promotion admission for suspicious snapshots (#152509).
type ObserveRecoveryDeps = Parameters<typeof promoteConfigSnapshotToLastKnownGoodCore>[0]["deps"];

const approveRecoveryCandidate = <T extends { raw: string; parsed: unknown }>(candidate: T) => ({
  ok: true as const,
  candidate,
});

function resolveLastKnownGoodConfigPath(configPath: string): string {
  return `${configPath}.last-good`;
}

describe("config observe recovery promotion", () => {
  async function makeSnapshot(configPath: string, config: Record<string, unknown>) {
    const raw = `${JSON.stringify(config, null, 2)}\n`;
    await fsp.mkdir(path.dirname(configPath), { recursive: true });
    await fsp.writeFile(configPath, raw, "utf-8");
    return {
      path: configPath,
      exists: true,
      raw,
      parsed: config,
      sourceConfig: config,
      resolved: config,
      valid: true,
      runtimeConfig: config,
      config,
      issues: [],
      warnings: [],
      legacyIssues: [],
    } satisfies ConfigFileSnapshot;
  }

  function makeDeps(home: string, warn = vi.fn()) {
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    return {
      deps: {
        fs,
        json5: JSON5,
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: { warn },
      } as unknown as ObserveRecoveryDeps,
      configPath,
      warn,
    };
  }

  it("refuses to promote a suspicious snapshot over last-known-good", async () => {
    const home = tempDirs.make("openclaw-config-lgg-promotion-");
    const { deps, configPath, warn } = makeDeps(home);
    const healthyConfig = {
      meta: { lastTouchedVersion: "2026.4.22" },
      update: { channel: "beta" },
      gateway: {
        mode: "local" as const,
        trustedProxies: Array.from({ length: 60 }, (_, index) => `192.0.2.${index}`),
      },
    };
    const healthy = await makeSnapshot(configPath, healthyConfig);

    await expect(
      promoteConfigSnapshotToLastKnownGoodCore({ deps, snapshot: healthy, logger: deps.logger }),
    ).resolves.toBe(true);
    await expect(fsp.readFile(resolveLastKnownGoodConfigPath(configPath), "utf-8")).resolves.toBe(
      healthy.raw,
    );

    const truncated = await makeSnapshot(configPath, { gateway: { mode: "local", port: 19187 } });

    await expect(
      promoteConfigSnapshotToLastKnownGoodCore({
        deps,
        snapshot: truncated,
        logger: deps.logger,
      }),
    ).resolves.toBe(false);
    expect(warn.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
      "Config last-known-good promotion skipped",
    );
    expect(warn.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
      "size-drop-vs-last-good",
    );
    expect(warn.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
      "missing-meta-vs-last-good",
    );
    await expect(fsp.readFile(resolveLastKnownGoodConfigPath(configPath), "utf-8")).resolves.toBe(
      healthy.raw,
    );

    const brokenRaw = "{ gateway: { mode: 123 } }\n";
    await fsp.writeFile(configPath, brokenRaw, "utf-8");
    const restored = await recoverConfigFromLastKnownGoodCore({
      deps,
      snapshot: {
        ...truncated,
        raw: brokenRaw,
        parsed: { gateway: { mode: 123 } },
        valid: false,
        issues: [{ path: "gateway.mode", message: "Expected string" }],
      },
      reason: "test-suspicious-promotion",
      prepareCandidate: approveRecoveryCandidate,
    });

    expect(restored).toBe(true);
    await expect(fsp.readFile(configPath, "utf-8")).resolves.toBe(healthy.raw);
  });

  it("keeps a newer last-known-good observation when a rolled-back write restores its baseline", async () => {
    const home = tempDirs.make("openclaw-config-lgg-rollback-newer-");
    const warn = vi.fn();
    const error = vi.fn();
    const deps = normalizeConfigIoDeps({ env: {}, homedir: () => home, logger: { warn, error } });
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const healthyConfig = {
      meta: { lastTouchedVersion: "2026.4.22" },
      gateway: {
        mode: "local" as const,
        trustedProxies: Array.from({ length: 40 }, (_, index) => `192.0.2.${index}`),
      },
    };
    const healthy = await makeSnapshot(configPath, healthyConfig);
    await expect(
      promoteConfigSnapshotToLastKnownGoodCore({ deps, snapshot: healthy, logger: { warn } }),
    ).resolves.toBe(true);

    // An accepted write grows the file beyond twice its size and advances the
    // last-known-good baseline, publishing the compensation record.
    const grown = await makeSnapshot(configPath, {
      ...healthyConfig,
      gateway: {
        mode: "local" as const,
        trustedProxies: Array.from({ length: 400 }, (_, index) => `192.0.2.${index}`),
      },
    });
    const capture = await captureConfigHealthBaselineForWrite(deps, configPath);
    const compensation = await advanceConfigHealthBaselineForAcceptedWrite(deps, capture, {
      raw: grown.raw,
      parsed: grown.parsed,
      resolved: grown.resolved,
    });
    if (!compensation) {
      throw new Error("expected the accepted size-growth write to advance the baseline");
    }

    // A newer observation replaces the candidate baseline before the rollback
    // compensation runs, so the restore must keep the newer baseline.
    const newer = await makeSnapshot(configPath, {
      ...healthyConfig,
      gateway: {
        mode: "local" as const,
        trustedProxies: Array.from({ length: 300 }, (_, index) => `192.0.2.${index}`),
      },
    });
    await expect(
      promoteConfigSnapshotToLastKnownGoodCore({ deps, snapshot: newer, logger: { warn } }),
    ).resolves.toBe(true);
    const newerBaseline = readConfigHealthStateFromStore(deps).entries?.[configPath]?.lastKnownGood;
    expect(newerBaseline?.hash).not.toBe(compensation.candidate.hash);

    await restoreConfigHealthBaselineForRolledBackWrite(deps, compensation);

    const restoredEntry = readConfigHealthStateFromStore(deps).entries?.[configPath];
    expect(restoredEntry?.lastKnownGood?.hash).toBe(newerBaseline?.hash);
  });

  it("promotes a non-suspicious snapshot whose shape matches the baseline", async () => {
    const home = tempDirs.make("openclaw-config-lgg-promotion-");
    const { deps, configPath, warn } = makeDeps(home);
    const healthy = await makeSnapshot(configPath, {
      meta: { lastTouchedVersion: "2026.4.22" },
      update: { channel: "beta" },
      gateway: { mode: "local" as const },
    });

    await expect(
      promoteConfigSnapshotToLastKnownGoodCore({ deps, snapshot: healthy, logger: deps.logger }),
    ).resolves.toBe(true);

    const edited = await makeSnapshot(configPath, {
      meta: { lastTouchedVersion: "2026.4.22" },
      update: { channel: "beta" },
      gateway: { mode: "local" as const, port: 19187 },
    });

    await expect(
      promoteConfigSnapshotToLastKnownGoodCore({
        deps,
        snapshot: edited,
        logger: deps.logger,
      }),
    ).resolves.toBe(true);
    expect(warn.mock.calls.map(([message]) => String(message)).join("\n")).not.toContain(
      "Config last-known-good promotion skipped",
    );
    await expect(fsp.readFile(resolveLastKnownGoodConfigPath(configPath), "utf-8")).resolves.toBe(
      edited.raw,
    );
  });

  it("keeps pre-upgrade health-state rows working without schema or shape drift", async () => {
    const home = tempDirs.make("openclaw-config-lgg-compat-");
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const deps = normalizeConfigIoDeps({
      env: {},
      homedir: () => home,
      logger: { warn: vi.fn(), error: vi.fn() },
    });
    const healthyConfig = {
      meta: { lastTouchedVersion: "2026.4.22" },
      update: { channel: "beta" },
      gateway: {
        mode: "local" as const,
        trustedProxies: Array.from({ length: 60 }, (_, index) => `192.0.2.${index}`),
      },
    };
    const healthy = await makeSnapshot(configPath, healthyConfig);

    // Seed the row exactly as the pre-change build persisted it: the same
    // columns (verified below) and the fingerprint shape the unchanged
    // promotion path writes. This change adds no schema or fingerprint
    // fields, so rows written by the previous version upgrade in place
    // without a migration.
    const legacyFingerprint = createConfigHealthFingerprint({
      raw: healthy.raw,
      parsed: healthy.parsed,
      resolved: healthy.resolved,
      stat: fs.statSync(configPath),
    });
    const legacyRow = JSON.stringify(legacyFingerprint);
    const databasePath = openOpenClawStateDatabase({ env: { HOME: home, USERPROFILE: home } }).path;
    closeOpenClawStateDatabaseForTest();
    const seeder = new DatabaseSync(databasePath);
    try {
      seeder
        .prepare(
          `INSERT INTO config_health_entries
             (config_path, last_known_good_json, last_promoted_good_json,
              last_observed_suspicious_signature, updated_at_ms)
           VALUES (?, ?, ?, NULL, ?)`,
        )
        .run(configPath, legacyRow, legacyRow, Date.now());
      expect(
        seeder
          .prepare("PRAGMA table_info(config_health_entries)")
          .all()
          .map((row) => row.name),
      ).toEqual([
        "config_path",
        "last_known_good_json",
        "last_promoted_good_json",
        "last_observed_suspicious_signature",
        "updated_at_ms",
      ]);
    } finally {
      seeder.close();
    }

    // The pre-upgrade baseline drives the new promotion guard: the matching
    // healthy config still promotes, the truncation stub is still refused.
    await expect(
      promoteConfigSnapshotToLastKnownGoodCore({ deps, snapshot: healthy, logger: deps.logger }),
    ).resolves.toBe(true);
    const truncated = await makeSnapshot(configPath, { gateway: { mode: "local", port: 19187 } });
    await expect(
      promoteConfigSnapshotToLastKnownGoodCore({
        deps,
        snapshot: truncated,
        logger: deps.logger,
      }),
    ).resolves.toBe(false);

    // The accepted-write baseline advance reads the legacy row and overwrites
    // it in place, publishing the legacy fingerprint as the compensation.
    const grown = await makeSnapshot(configPath, {
      ...healthyConfig,
      gateway: {
        mode: "local" as const,
        trustedProxies: Array.from({ length: 400 }, (_, index) => `192.0.2.${index}`),
      },
    });
    const capture = await captureConfigHealthBaselineForWrite(deps, configPath);
    const compensation = await advanceConfigHealthBaselineForAcceptedWrite(deps, capture, {
      raw: grown.raw,
      parsed: grown.parsed,
      resolved: grown.resolved,
    });
    expect(compensation?.previousLastKnownGood.hash).toBe(legacyFingerprint.hash);

    // The rolled-back-write restore rewinds to the pre-upgrade baseline.
    await restoreConfigHealthBaselineForRolledBackWrite(deps, compensation);
    expect(readConfigHealthStateFromStore(deps).entries?.[configPath]?.lastKnownGood?.hash).toBe(
      legacyFingerprint.hash,
    );

    // The persisted shape stays legacy-compatible: the fingerprint JSON keys
    // match what the previous build wrote, so a downgraded build decodes the
    // row unchanged (the read contract is permissive and shared).
    const persistedRow = new DatabaseSync(databasePath);
    try {
      const row = persistedRow
        .prepare("SELECT last_known_good_json FROM config_health_entries WHERE config_path = ?")
        .get(configPath) as { last_known_good_json: string };
      expect(Object.keys(JSON.parse(row.last_known_good_json)).toSorted()).toEqual(
        Object.keys(legacyFingerprint).toSorted(),
      );
    } finally {
      persistedRow.close();
    }
  });
});

describe("last-known-good promotion after accepted writes", () => {
  function acceptedWriteFixture() {
    const root = tempDirs.make("openclaw-config-lgg-accepted-write-");
    const configPath = path.join(root, ".openclaw", "openclaw.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const env = {
      HOME: root,
      USERPROFILE: root,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_STATE_DIR: root,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      VITEST: "true",
    } as NodeJS.ProcessEnv;
    const io = createConfigIO({
      env,
      configPath,
      homedir: () => root,
      observe: false,
      logger: { warn: vi.fn(), error: vi.fn() },
    });
    return { configPath, env, io, root };
  }

  function seedConfig(configPath: string, config: Record<string, unknown>): string {
    const raw = `${JSON.stringify(config, null, 2)}\n`;
    fs.writeFileSync(configPath, raw, "utf8");
    return raw;
  }

  it("advances last-known-good after an accepted intentional size-drop write", async () => {
    const { configPath, io } = acceptedWriteFixture();
    const lastGoodPath = `${configPath}.last-good`;
    seedConfig(configPath, {
      meta: { lastTouchedVersion: "2026.4.22" },
      gateway: { mode: "local" as const },
      channels: {
        telegram: {
          enabled: true,
          allowFrom: Array.from({ length: 80 }, (_, index) => `telegram:${index}`),
        },
      },
    });

    const healthySnapshot = await io.readConfigFileSnapshot();
    await expect(io.promoteConfigSnapshotToLastKnownGood(healthySnapshot)).resolves.toBe(true);
    expect(fs.readFileSync(lastGoodPath, "utf8")).toBe(healthySnapshot.raw);

    const acceptedWrite = await io.writeConfigFile(
      { meta: { lastTouchedVersion: "2026.4.22" }, gateway: { mode: "local" } },
      { allowConfigSizeDrop: true, baseSnapshot: healthySnapshot },
    );
    expect(acceptedWrite.persistedConfig.gateway).toEqual({ mode: "local" });

    const reducedSnapshot = await io.readConfigFileSnapshot();
    await expect(io.promoteConfigSnapshotToLastKnownGood(reducedSnapshot)).resolves.toBe(true);
    expect(fs.readFileSync(lastGoodPath, "utf8")).toBe(reducedSnapshot.raw);

    seedConfig(configPath, { gateway: { mode: "local", port: 19187 } });
    const truncatedSnapshot = await io.readConfigFileSnapshot();
    await expect(io.promoteConfigSnapshotToLastKnownGood(truncatedSnapshot)).resolves.toBe(false);
    expect(fs.readFileSync(lastGoodPath, "utf8")).toBe(reducedSnapshot.raw);
  });

  it("promotes an accepted formatting normalization over the verbose baseline", async () => {
    const { configPath, io } = acceptedWriteFixture();
    const lastGoodPath = `${configPath}.last-good`;
    const original = {
      meta: { lastTouchedVersion: "2026.4.23" },
      gateway: { mode: "local" },
      channels: {
        telegram: {
          enabled: true,
          allowFrom: Array.from({ length: 80 }, (_, index) => `telegram:${index}`),
        },
      },
    };
    // Verbose PowerShell formatting (BOM + 12-space indent): canonical writes
    // shrink raw bytes by more than half through serialization alone.
    const powerShellRaw = `\uFEFF${JSON.stringify(original, null, 12)}\n`;
    fs.writeFileSync(configPath, powerShellRaw, "utf8");

    const verboseSnapshot = await io.readConfigFileSnapshot();
    await expect(io.promoteConfigSnapshotToLastKnownGood(verboseSnapshot)).resolves.toBe(true);
    expect(fs.readFileSync(lastGoodPath, "utf8")).toBe(powerShellRaw);

    // An ordinary accepted edit without allowConfigSizeDrop: the writer's
    // canonicalized size baseline records no drop, so the raw-byte shrink comes
    // purely from formatting normalization.
    await io.writeConfigFile(
      { ...original, gateway: { mode: "local", port: 18789 } },
      { baseSnapshot: verboseSnapshot },
    );
    const canonicalRaw = fs.readFileSync(configPath, "utf8");
    expect(Buffer.byteLength(powerShellRaw, "utf8")).toBeGreaterThan(
      Buffer.byteLength(canonicalRaw, "utf8") * 2,
    );

    // The accepted write advanced the last-known-good baseline, so the next
    // startup promotes the edited canonical config instead of freezing the
    // verbose one as the recovery target.
    const editedSnapshot = await io.readConfigFileSnapshot();
    await expect(io.promoteConfigSnapshotToLastKnownGood(editedSnapshot)).resolves.toBe(true);
    expect(fs.readFileSync(lastGoodPath, "utf8")).toBe(canonicalRaw);

    // An external truncation afterwards never advances the baseline: promotion
    // keeps refusing it, and recovery restores the edited canonical config.
    fs.writeFileSync(
      configPath,
      `${JSON.stringify({ gateway: { mode: "local", port: 18789 } }, null, 2)}\n`,
      "utf8",
    );
    const truncatedSnapshot = await io.readConfigFileSnapshot();
    await expect(io.promoteConfigSnapshotToLastKnownGood(truncatedSnapshot)).resolves.toBe(false);
    expect(fs.readFileSync(lastGoodPath, "utf8")).toBe(canonicalRaw);

    fs.writeFileSync(configPath, "{ gateway: { mode: 123 } }\n", "utf8");
    const brokenSnapshot = await io.readConfigFileSnapshot();
    await expect(
      io.recoverConfigFromLastKnownGood({
        snapshot: brokenSnapshot,
        reason: "test-formatting-baseline",
      }),
    ).resolves.toBe(true);
    expect(fs.readFileSync(configPath, "utf8")).toBe(canonicalRaw);
  });

  it("settles last-known-good advancement superseded by an observed read", async () => {
    const { configPath, env, io, root } = acceptedWriteFixture();
    const lastGoodPath = `${configPath}.last-good`;
    const original = {
      meta: { lastTouchedVersion: "2026.4.24" },
      gateway: { mode: "local" },
      channels: {
        telegram: {
          enabled: true,
          allowFrom: Array.from({ length: 80 }, (_, index) => `telegram:${index}`),
        },
      },
    };
    const verboseRaw = `\uFEFF${JSON.stringify(original, null, 12)}\n`;
    fs.writeFileSync(configPath, verboseRaw, "utf8");
    const verboseSnapshot = await io.readConfigFileSnapshot();
    await expect(io.promoteConfigSnapshotToLastKnownGood(verboseSnapshot)).resolves.toBe(true);
    expect(fs.readFileSync(lastGoodPath, "utf8")).toBe(verboseRaw);

    const healthDeps = normalizeConfigIoDeps({
      env,
      homedir: () => root,
      logger: { warn: vi.fn(), error: vi.fn() },
    });
    const capture = healthOwner.captureConfigHealthStateStore;
    let superseded = false;
    const spy = vi
      .spyOn(healthOwner, "captureConfigHealthStateStore")
      .mockImplementation((...args) => {
        const store = capture(...args);
        return {
          ...store,
          async read() {
            // An ordinary observed read lands while the writer's baseline
            // advance awaits its worker read: it records the published canonical
            // candidate as a size-drop anomaly and supersedes the advance's scope.
            if (
              !superseded &&
              args[1] === configPath &&
              fs.readFileSync(configPath, "utf8") !== verboseRaw
            ) {
              superseded = true;
              observeConfigSnapshotSync(healthDeps, await io.readConfigFileSnapshot());
            }
            return store.read();
          },
        };
      });
    try {
      await io.writeConfigFile(
        { ...original, gateway: { mode: "local", port: 18789 } },
        { baseSnapshot: verboseSnapshot },
      );
    } finally {
      spy.mockRestore();
    }

    const canonicalRaw = fs.readFileSync(configPath, "utf8");
    expect(superseded).toBe(true);
    // The superseded advance settled on a fresh scope, so the next startup
    // promotes the accepted edit instead of freezing the verbose baseline.
    const editedSnapshot = await io.readConfigFileSnapshot();
    await expect(io.promoteConfigSnapshotToLastKnownGood(editedSnapshot)).resolves.toBe(true);
    expect(fs.readFileSync(lastGoodPath, "utf8")).toBe(canonicalRaw);
  });

  it("restores the last-known-good baseline when a committed write rolls back", async () => {
    const initialConfig = {
      meta: { lastTouchedVersion: "2026.4.22" },
      gateway: {
        mode: "local" as const,
        trustedProxies: Array.from({ length: 40 }, (_, index) => `192.0.2.${index}`),
      },
    };
    await withTempHomeConfig(initialConfig, async ({ home, configPath }) => {
      const lastGoodPath = `${configPath}.last-good`;
      const originalRaw = await fsp.readFile(configPath, "utf-8");
      const io = createConfigIO({ observe: false });
      const healthDeps = { env: io.env, homedir: () => home, logger: console };
      const readLastKnownGood = () =>
        readConfigHealthStateFromStore(healthDeps).entries?.[configPath]?.lastKnownGood;

      const healthySnapshot = await io.readConfigFileSnapshot();
      await expect(io.promoteConfigSnapshotToLastKnownGood(healthySnapshot)).resolves.toBe(true);
      expect(fs.readFileSync(lastGoodPath, "utf8")).toBe(originalRaw);
      const baselineBefore = readLastKnownGood();
      expect(baselineBefore?.bytes).toBe(Buffer.byteLength(originalRaw, "utf-8"));

      // Grow the config beyond twice its size, then fail runtime activation after
      // the commit so the write rolls back to the original bytes.
      const failure = new Error("synthetic overlay failure");
      const grownConfig = {
        ...initialConfig,
        gateway: {
          mode: "local" as const,
          trustedProxies: Array.from({ length: 400 }, (_, index) => `192.0.2.${index}`),
        },
      };
      expect(
        Buffer.byteLength(`${JSON.stringify(grownConfig, null, 2)}\n`, "utf-8"),
      ).toBeGreaterThan(Buffer.byteLength(originalRaw, "utf-8") * 2);
      const unsubscribe = registerConfigWriteListener(vi.fn(), {
        ownsRuntimeActivationFor: configPath,
        preCommitRuntimePreflight: async (sourceConfig) => ({
          runtimeConfig: sourceConfig,
          compareConfig: sourceConfig,
          reapplyRuntimeOverlays() {
            throw failure;
          },
          reapplyCompareOverlays: (config) => config,
        }),
      });
      try {
        setRuntimeConfigSnapshot(initialConfig, initialConfig);
        await expect(writeConfigFile(grownConfig)).rejects.toMatchObject({
          name: "ConfigWritePostCommitError",
          rollbackStatus: "restored",
          cause: failure,
        });
      } finally {
        unsubscribe();
        resetConfigRuntimeState();
      }

      // The rollback restored the original bytes and the pre-write baseline, so
      // the restored config is not a size drop against the baseline.
      await expect(fsp.readFile(configPath, "utf-8")).resolves.toBe(originalRaw);
      const baselineAfter = readLastKnownGood();
      expect(baselineAfter?.hash).toBe(baselineBefore?.hash);
      expect(baselineAfter?.bytes).toBe(Buffer.byteLength(originalRaw, "utf-8"));

      const restoredSnapshot = await io.readConfigFileSnapshot();
      await expect(io.promoteConfigSnapshotToLastKnownGood(restoredSnapshot)).resolves.toBe(true);
      expect(fs.readFileSync(lastGoodPath, "utf8")).toBe(originalRaw);
    });
  });

  it("restores the pre-write baseline when an intervening read records the published candidate", async () => {
    const initialConfig = {
      meta: { lastTouchedVersion: "2026.4.22" },
      gateway: {
        mode: "local" as const,
        trustedProxies: Array.from({ length: 40 }, (_, index) => `192.0.2.${index}`),
      },
    };
    await withTempHomeConfig(initialConfig, async ({ home, configPath }) => {
      const lastGoodPath = `${configPath}.last-good`;
      const originalRaw = await fsp.readFile(configPath, "utf-8");
      const io = createConfigIO({ observe: false });
      const healthDeps = normalizeConfigIoDeps({
        env: io.env,
        homedir: () => home,
        logger: { warn: vi.fn(), error: vi.fn() },
      });
      const readLastKnownGood = () =>
        readConfigHealthStateFromStore(healthDeps).entries?.[configPath]?.lastKnownGood;

      const healthySnapshot = await io.readConfigFileSnapshot();
      await expect(io.promoteConfigSnapshotToLastKnownGood(healthySnapshot)).resolves.toBe(true);
      expect(fs.readFileSync(lastGoodPath, "utf8")).toBe(originalRaw);
      const baselineBefore = readLastKnownGood();
      expect(baselineBefore?.bytes).toBe(Buffer.byteLength(originalRaw, "utf-8"));

      // Grow the config beyond twice its size, then fail runtime activation after
      // the commit so the write rolls back to the original bytes.
      const failure = new Error("synthetic overlay failure");
      const grownConfig = {
        ...initialConfig,
        gateway: {
          mode: "local" as const,
          trustedProxies: Array.from({ length: 400 }, (_, index) => `192.0.2.${index}`),
        },
      };
      expect(
        Buffer.byteLength(`${JSON.stringify(grownConfig, null, 2)}\n`, "utf-8"),
      ).toBeGreaterThan(Buffer.byteLength(originalRaw, "utf-8") * 2);

      // An observed read lands between the file publication and the writer's
      // baseline advance (the writer asserts path ownership right after the
      // publication, before the awaited audit stat): the observer records the
      // published candidate as healthy before the advance settles its capture.
      let observedPublishedCandidate = false;
      const observePublishedConfig = () => {
        observedPublishedCandidate = true;
        const raw = fs.readFileSync(configPath, "utf-8");
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        observeConfigSnapshotSync(healthDeps, {
          path: configPath,
          exists: true,
          raw,
          parsed,
          sourceConfig: parsed,
          resolved: parsed,
          runtimeConfig: parsed,
          config: parsed,
          valid: true,
          issues: [],
          warnings: [],
          legacyIssues: [],
        } satisfies ConfigFileSnapshot);
      };
      const unsubscribe = registerConfigWriteListener(vi.fn(), {
        ownsRuntimeActivationFor: configPath,
        preCommitRuntimePreflight: async (sourceConfig) => ({
          runtimeConfig: sourceConfig,
          compareConfig: sourceConfig,
          reapplyRuntimeOverlays() {
            throw failure;
          },
          reapplyCompareOverlays: (config) => config,
        }),
      });
      try {
        setRuntimeConfigSnapshot(initialConfig, initialConfig);
        await expect(
          writeConfigFile(grownConfig, {
            assertConfigPathForWrite: () => {
              if (
                !observedPublishedCandidate &&
                fs.readFileSync(configPath, "utf-8") !== originalRaw
              ) {
                observePublishedConfig();
              }
            },
          }),
        ).rejects.toMatchObject({
          name: "ConfigWritePostCommitError",
          rollbackStatus: "restored",
          cause: failure,
        });
      } finally {
        unsubscribe();
        resetConfigRuntimeState();
      }

      // The intervening observation ran inside the post-publication window, but
      // the compensation retained the pre-write baseline, so the rollback
      // restores it instead of the candidate the observer recorded.
      expect(observedPublishedCandidate).toBe(true);
      await expect(fsp.readFile(configPath, "utf-8")).resolves.toBe(originalRaw);
      const baselineAfter = readLastKnownGood();
      expect(baselineAfter?.hash).toBe(baselineBefore?.hash);
      expect(baselineAfter?.bytes).toBe(Buffer.byteLength(originalRaw, "utf-8"));

      // The restored config is not a size drop against the restored baseline.
      const restoredSnapshot = await io.readConfigFileSnapshot();
      await expect(io.promoteConfigSnapshotToLastKnownGood(restoredSnapshot)).resolves.toBe(true);
      expect(fs.readFileSync(lastGoodPath, "utf8")).toBe(originalRaw);
    });
  });
});
