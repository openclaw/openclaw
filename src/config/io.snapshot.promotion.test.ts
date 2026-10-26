import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import * as worker from "../state/openclaw-state-worker-store.js";
import { createConfigIO } from "./io.factory.js";
import { readConfigHealthStateFromStore } from "./io.health-state.js";
import * as healthOwner from "./io.health-state.js";
import {
  registerConfigWriteListener,
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
  writeConfigFile,
} from "./io.js";
import { recoverConfigFromLastKnownGoodCore } from "./io.observe-recovery.js";
import {
  approveRecoveryCandidate,
  createRecoveryBaselineConfig,
  createRecoveryConfigEnv,
  largeRecoverableCoreConfig,
  makeDeps,
  makeSnapshot,
  resolveLastKnownGoodConfigPath,
} from "./io.observe-recovery.test-support.js";
import { createConfigHealthFingerprint } from "./io.observe-state.js";
import {
  advanceConfigHealthBaselineForAcceptedWrite,
  captureConfigHealthBaselineForWrite,
  observeConfigSnapshotSync,
  restoreConfigHealthBaselineForRolledBackWrite,
} from "./io.observe.js";
import { normalizeConfigIoDeps } from "./io.read-helpers.js";
import { createSnapshot } from "./mutate.test-support.js";
import { withTempHomeConfig } from "./test-helpers.js";

// Split from io.snapshot.recovery.test.ts when main's growth left that file
// over the 1000-line test budget; the promotion suites keep their own home.
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    clearPluginMetadataLifecycleCaches();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

// Covers last-known-good promotion admission for suspicious snapshots (#152509).
describe("config observe recovery promotion", () => {
  it("refuses to promote a suspicious snapshot over last-known-good", async () => {
    const home = tempDirs.make("openclaw-config-lgg-promotion-");
    const { deps, configPath, warn } = makeDeps(home);
    const healthyConfig = structuredClone(largeRecoverableCoreConfig);
    const healthy = await makeSnapshot(configPath, healthyConfig);

    await expect(createConfigIO(deps).promoteConfigSnapshotToLastKnownGood(healthy)).resolves.toBe(
      true,
    );
    await expect(fsp.readFile(resolveLastKnownGoodConfigPath(configPath), "utf-8")).resolves.toBe(
      healthy.raw,
    );

    const truncated = await makeSnapshot(configPath, { gateway: { mode: "local", port: 19187 } });

    await expect(
      createConfigIO(deps).promoteConfigSnapshotToLastKnownGood(truncated),
    ).resolves.toBe(false);
    expect(warn.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
      "Config last-known-good promotion skipped",
    );
    expect(warn.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
      "size-drop-vs-last-good",
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
    const healthyConfig = createRecoveryBaselineConfig();
    const healthy = await makeSnapshot(configPath, healthyConfig);
    await expect(createConfigIO(deps).promoteConfigSnapshotToLastKnownGood(healthy)).resolves.toBe(
      true,
    );

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
      sourceSnapshot: healthy,
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
    await expect(createConfigIO(deps).promoteConfigSnapshotToLastKnownGood(newer)).resolves.toBe(
      true,
    );
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

    await expect(createConfigIO(deps).promoteConfigSnapshotToLastKnownGood(healthy)).resolves.toBe(
      true,
    );

    const edited = await makeSnapshot(configPath, {
      meta: { lastTouchedVersion: "2026.4.22" },
      update: { channel: "beta" },
      gateway: { mode: "local" as const, port: 19187 },
    });

    await expect(createConfigIO(deps).promoteConfigSnapshotToLastKnownGood(edited)).resolves.toBe(
      true,
    );
    expect(warn.mock.calls.map(([message]) => String(message)).join("\n")).not.toContain(
      "Config last-known-good promotion skipped",
    );
    await expect(fsp.readFile(resolveLastKnownGoodConfigPath(configPath), "utf-8")).resolves.toBe(
      edited.raw,
    );
  });

  it("preserves stored health rows through promotion and baseline compensation", async () => {
    const home = tempDirs.make("openclaw-config-lgg-compat-");
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const deps = normalizeConfigIoDeps({
      env: {},
      homedir: () => home,
      logger: { warn: vi.fn(), error: vi.fn() },
    });
    const healthyConfig = structuredClone(largeRecoverableCoreConfig);
    const healthy = await makeSnapshot(configPath, healthyConfig);

    // Seed a stored row with the current fingerprint producer. This exercises
    // row continuity, not a historical release's serialized fingerprint shape.
    const storedFingerprint = createConfigHealthFingerprint({
      raw: healthy.raw,
      parsed: healthy.parsed,
      resolved: healthy.resolved,
      stat: fs.statSync(configPath),
    });
    const storedRow = JSON.stringify(storedFingerprint);
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
        .run(configPath, storedRow, storedRow, Date.now());
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

    // The stored baseline permits matching healthy config and refuses truncation.
    await expect(createConfigIO(deps).promoteConfigSnapshotToLastKnownGood(healthy)).resolves.toBe(
      true,
    );
    const truncated = await makeSnapshot(configPath, { gateway: { mode: "local", port: 19187 } });
    await expect(
      createConfigIO(deps).promoteConfigSnapshotToLastKnownGood(truncated),
    ).resolves.toBe(false);

    // Advancing the stored baseline retains its prior fingerprint for compensation.
    const grown = await makeSnapshot(configPath, {
      ...healthyConfig,
      gateway: {
        mode: "local" as const,
        trustedProxies: Array.from({ length: 400 }, (_, index) => `192.0.2.${index}`),
      },
    });
    const capture = await captureConfigHealthBaselineForWrite(deps, configPath);
    const compensation = await advanceConfigHealthBaselineForAcceptedWrite(deps, capture, {
      sourceSnapshot: healthy,
      raw: grown.raw,
      parsed: grown.parsed,
      resolved: grown.resolved,
    });
    expect(compensation?.previousLastKnownGood.hash).toBe(storedFingerprint.hash);

    // Rollback restores the stored baseline.
    await restoreConfigHealthBaselineForRolledBackWrite(deps, compensation);
    expect(readConfigHealthStateFromStore(deps).entries?.[configPath]?.lastKnownGood?.hash).toBe(
      storedFingerprint.hash,
    );
  });
});

describe("last-known-good promotion after accepted writes", () => {
  function registerFailingRuntimeOverlay(configPath: string, failure: Error) {
    return registerConfigWriteListener(vi.fn(), {
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
  }

  function acceptedWriteFixture() {
    const root = tempDirs.make("openclaw-config-lgg-accepted-write-");
    const configPath = path.join(root, ".openclaw", "openclaw.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const env = createRecoveryConfigEnv(root, configPath, root);
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

  function trackHealthReads(configPath: string) {
    const capture = healthOwner.captureConfigHealthStateStore;
    const read = vi.fn();
    vi.spyOn(healthOwner, "captureConfigHealthStateStore").mockImplementation((...args) => {
      const store = capture(...args);
      return {
        ...store,
        read() {
          if (args[1] === configPath) {
            read();
          }
          return store.read();
        },
      };
    });
    return read;
  }

  it.each([
    { anomaly: "size", proxies: 80 },
    { anomaly: "gateway-mode", proxies: 1 },
  ])(
    "does not bless a pre-existing $anomaly truncation through an ordinary accepted edit",
    async ({ anomaly, proxies }) => {
      const { configPath, env, root } = acceptedWriteFixture();
      const io = createConfigIO({
        env,
        configPath,
        homedir: () => root,
        observe: true,
        logger: { warn: vi.fn(), error: vi.fn() },
      });
      const healthyRaw = seedConfig(configPath, {
        meta: { lastTouchedVersion: "2026.4.22" },
        gateway: {
          mode: "local",
          trustedProxies: Array.from({ length: proxies }, (_, index) => `192.0.2.${index}`),
        },
      });
      expect(Buffer.byteLength(healthyRaw) < 512).toBe(anomaly === "gateway-mode");
      const healthy = await io.readConfigFileSnapshot();
      await expect(io.promoteConfigSnapshotToLastKnownGood(healthy)).resolves.toBe(true);

      // Missing gateway mode must survive writer stamping below the size-drop
      // threshold; an ordinary edit is not approval of either earlier anomaly.
      seedConfig(configPath, {
        meta: { lastTouchedVersion: "2026.4.22" },
        gateway: { ...(anomaly === "size" ? { mode: "local" } : {}), port: 18789 },
      });
      const truncated = await io.readConfigFileSnapshot();
      await expect(io.promoteConfigSnapshotToLastKnownGood(truncated)).resolves.toBe(false);
      await io.writeConfigFile(
        { ...truncated.config, gateway: { ...truncated.config.gateway, port: 19187 } },
        { baseSnapshot: truncated },
      );
      const edited = await io.readConfigFileSnapshot();
      expect(edited.config.gateway?.port).toBe(19187);
      await expect(io.promoteConfigSnapshotToLastKnownGood(edited)).resolves.toBe(false);
      expect(fs.readFileSync(configPath + ".last-good", "utf8")).toBe(healthyRaw);

      await io.writeConfigFile(
        { ...edited.config, gateway: { ...edited.config.gateway, port: 19188 } },
        { baseSnapshot: edited },
      );
      await expect(
        io.promoteConfigSnapshotToLastKnownGood(await io.readConfigFileSnapshot()),
      ).resolves.toBe(false);

      fs.writeFileSync(configPath, "{ gateway: { mode: 123 } }\n", "utf8");
      await expect(
        io.recoverConfigFromLastKnownGood({
          snapshot: await io.readConfigFileSnapshot(),
          reason: "test-edited-truncation",
        }),
      ).resolves.toBe(true);
      expect(fs.readFileSync(configPath, "utf8")).toBe(healthyRaw);
    },
  );

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

    const healthReads = trackHealthReads(configPath);
    const acceptedWrite = await io.writeConfigFile(
      { meta: { lastTouchedVersion: "2026.4.22" }, gateway: { mode: "local" } },
      { allowConfigSizeDrop: true, baseSnapshot: healthySnapshot },
    );
    expect(acceptedWrite.persistedConfig.gateway).toEqual({ mode: "local" });
    // One pre-publication capture and one transition read; no read to certify the write.
    expect(healthReads).toHaveBeenCalledTimes(2);

    const reducedSnapshot = await io.readConfigFileSnapshot();
    await expect(io.promoteConfigSnapshotToLastKnownGood(reducedSnapshot)).resolves.toBe(true);
    expect(fs.readFileSync(lastGoodPath, "utf8")).toBe(reducedSnapshot.raw);

    seedConfig(configPath, { gateway: { port: 19187 } });
    const truncatedSnapshot = await io.readConfigFileSnapshot();
    await expect(io.promoteConfigSnapshotToLastKnownGood(truncatedSnapshot)).resolves.toBe(false);
    expect(fs.readFileSync(lastGoodPath, "utf8")).toBe(reducedSnapshot.raw);
  });

  it.each(["read failure", "write failure", "lost reply"] as const)(
    "does not retry accepted-write health bookkeeping after %s",
    async (fault) => {
      const { configPath, env, io, root } = acceptedWriteFixture();
      seedConfig(configPath, {
        meta: { lastTouchedVersion: "2026.4.22" },
        gateway: { mode: "local", port: 18789 },
      });
      const before = await io.readConfigFileSnapshot();
      await expect(io.promoteConfigSnapshotToLastKnownGood(before)).resolves.toBe(true);
      const deps = { env, homedir: () => root, logger: console };
      const prior = readConfigHealthStateFromStore(deps).entries?.[configPath];
      const capture = healthOwner.captureConfigHealthStateStore;
      let reads = 0;
      const outcomes: unknown[] = [];
      vi.spyOn(healthOwner, "captureConfigHealthStateStore").mockImplementation((...args) => {
        const store = capture(...args);
        return {
          ...store,
          async read() {
            reads += 1;
            const failure =
              fault === "read failure" && fs.readFileSync(configPath, "utf8") !== before.raw
                ? vi
                    .spyOn(stateReads, "getActiveOpenClawStateDatabaseReadSnapshotAsync")
                    .mockRejectedValueOnce(new Error("synthetic health read failure"))
                : undefined;
            try {
              return await store.read();
            } finally {
              failure?.mockRestore();
            }
          },
          async updateAfterFileCommit(...updateArgs) {
            const execute = worker.runOpenClawStateWorkerOperation;
            const failure = vi.spyOn(worker, "runOpenClawStateWorkerOperation").mockImplementation(
              new Proxy(execute, {
                async apply(target, receiver, operationArgs) {
                  if (fault === "lost reply") {
                    await Reflect.apply(target, receiver, operationArgs);
                  }
                  throw new Error("synthetic health write transport failure");
                },
              }),
            );
            try {
              const result = await store.updateAfterFileCommit(...updateArgs);
              outcomes.push(result);
              return result;
            } finally {
              failure.mockRestore();
            }
          },
        };
      });
      await io.writeConfigFile(
        { ...before.config, gateway: { mode: "local", port: 19187 } },
        { baseSnapshot: before },
      );
      expect(JSON.parse(fs.readFileSync(configPath, "utf8")).gateway.port).toBe(19187);
      expect(reads).toBe(2);
      expect(outcomes).toEqual(fault === "read failure" ? [] : [{ status: "unavailable" }]);
      const after = readConfigHealthStateFromStore(deps).entries?.[configPath];
      if (fault === "lost reply") {
        expect(after?.lastKnownGood?.hash).not.toBe(prior?.lastKnownGood?.hash);
      } else {
        expect(after).toEqual(prior);
      }
    },
  );

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

  it("keeps an accepted write promotable when observed during baseline advancement", async () => {
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
    let observedDuringAdvance = false;
    let transitionReads = 0;
    const outcomes: unknown[] = [];
    const spy = vi
      .spyOn(healthOwner, "captureConfigHealthStateStore")
      .mockImplementation((...args) => {
        const store = capture(...args);
        return {
          ...store,
          async read() {
            const snapshot = await store.read();
            if (fs.readFileSync(configPath, "utf8") !== verboseRaw) {
              transitionReads += 1;
            }
            // Commit an ordinary observation after the actual snapshot, forcing
            // the worker's conditional patch to miss rather than faking a conflict.
            if (
              !observedDuringAdvance &&
              args[1] === configPath &&
              fs.readFileSync(configPath, "utf8") !== verboseRaw
            ) {
              observedDuringAdvance = true;
              observeConfigSnapshotSync(healthDeps, await io.readConfigFileSnapshot());
            }
            return snapshot;
          },
          async updateAfterFileCommit(...updateArgs) {
            const outcome = await store.updateAfterFileCommit(...updateArgs);
            outcomes.push(outcome);
            return outcome;
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
    expect(observedDuringAdvance).toBe(true);
    expect(outcomes).toEqual([{ status: "conflict" }, { status: "applied" }]);
    expect(transitionReads).toBe(2);
    // The accepted edit stays promotable despite the intervening observation.
    const editedSnapshot = await io.readConfigFileSnapshot();
    await expect(io.promoteConfigSnapshotToLastKnownGood(editedSnapshot)).resolves.toBe(true);
    expect(fs.readFileSync(lastGoodPath, "utf8")).toBe(canonicalRaw);
  });

  it("restores the inherited anomaly when a later accepted edit rolls back", async () => {
    const initial = createRecoveryBaselineConfig();
    await withTempHomeConfig(initial, async ({ configPath }) => {
      const io = createConfigIO({ observe: true });
      const healthy = await io.readConfigFileSnapshot();
      await expect(io.promoteConfigSnapshotToLastKnownGood(healthy)).resolves.toBe(true);
      fs.writeFileSync(configPath, JSON.stringify({ gateway: { mode: "local", port: 18789 } }));
      const truncated = await io.readConfigFileSnapshot();
      await io.writeConfigFile(
        { ...truncated.config, gateway: { ...truncated.config.gateway, port: 19187 } },
        { baseSnapshot: truncated },
      );
      const edited = await io.readConfigFileSnapshot();
      await expect(io.promoteConfigSnapshotToLastKnownGood(edited)).resolves.toBe(false);
      const acceptedRaw = fs.readFileSync(configPath, "utf8");
      const failure = new Error("synthetic overlay failure");
      const unsubscribe = registerFailingRuntimeOverlay(configPath, failure);
      try {
        setRuntimeConfigSnapshot(edited.config, edited.config);
        await expect(
          writeConfigFile({
            ...edited.config,
            gateway: { ...edited.config.gateway, port: 19188 },
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
      expect(fs.readFileSync(configPath, "utf8")).toBe(acceptedRaw);
      await expect(
        io.promoteConfigSnapshotToLastKnownGood(await io.readConfigFileSnapshot()),
      ).resolves.toBe(false);
      expect(fs.readFileSync(configPath + ".last-good", "utf8")).toBe(healthy.raw);
    });
  });

  it("restores the last-known-good baseline when a committed write rolls back", async () => {
    const initialConfig = createRecoveryBaselineConfig();
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
      const healthReads = trackHealthReads(configPath);

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
      const unsubscribe = registerFailingRuntimeOverlay(configPath, failure);
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

      // The runtime writer also observes its input and canonical reread. The
      // capture, advance, and restore each read once, without write verification.
      expect(healthReads).toHaveBeenCalledTimes(5);
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
    const initialConfig = createRecoveryBaselineConfig();
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
        observeConfigSnapshotSync(
          healthDeps,
          createSnapshot({ path: configPath, raw, sourceConfig: parsed }),
        );
      };
      const unsubscribe = registerFailingRuntimeOverlay(configPath, failure);
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
