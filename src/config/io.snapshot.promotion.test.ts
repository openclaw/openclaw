import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
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
import {
  createRecoveryBaselineConfig,
  createRecoveryConfigEnv,
  makeSnapshot,
  resolveLastKnownGoodConfigPath,
} from "./io.observe-recovery.test-support.js";
import {
  advanceConfigHealthBaselineForAcceptedWrite,
  captureConfigHealthBaselineForWrite,
  observeConfigSnapshotSync,
  restoreConfigHealthBaselineForRolledBackWrite,
} from "./io.observe.js";
import { normalizeConfigIoDeps } from "./io.read-helpers.js";
import { createSnapshot } from "./mutate.test-support.js";
import { withTempHomeConfig } from "./test-helpers.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    clearPluginMetadataLifecycleCaches();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

const expectRaw = (file: string, raw: string | null) =>
  expect(fsp.readFile(file, "utf8")).resolves.toBe(raw);
const expectPromotion = (
  io: ReturnType<typeof createConfigIO>,
  snapshot: ConfigFileSnapshot,
  accepted = true,
) => expect(io.promoteConfigSnapshotToLastKnownGood(snapshot)).resolves.toBe(accepted);
async function promoteCurrent(io: ReturnType<typeof createConfigIO>) {
  const snapshot = await io.readConfigFileSnapshot();
  await expectPromotion(io, snapshot);
  return snapshot;
}
const grownConfig = (config: OpenClawConfig, count = 400): OpenClawConfig => ({
  ...config,
  gateway: {
    mode: "local",
    trustedProxies: Array.from({ length: count }, (_, index) => `192.0.2.${index}`),
  },
});
const verboseConfig = () => ({
  meta: { lastTouchedVersion: "2026.4.23" },
  gateway: { mode: "local" },
  channels: {
    telegram: {
      enabled: true,
      allowFrom: Array.from({ length: 80 }, (_, index) => `telegram:${index}`),
    },
  },
});

// Covers last-known-good promotion admission for suspicious snapshots (#152509).
describe("config observe recovery promotion", () => {
  it("keeps a newer last-known-good observation when a rolled-back write restores its baseline", async () => {
    const home = tempDirs.make("openclaw-config-lgg-rollback-newer-");
    const warn = vi.fn();
    const error = vi.fn();
    const deps = normalizeConfigIoDeps({ env: {}, homedir: () => home, logger: { warn, error } });
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const healthyConfig = createRecoveryBaselineConfig();
    const healthy = await makeSnapshot(configPath, healthyConfig);
    await expectPromotion(createConfigIO(deps), healthy);

    // An accepted write grows the file beyond twice its size and advances the
    // last-known-good baseline, publishing the compensation record.
    const grown = await makeSnapshot(configPath, grownConfig(healthyConfig));
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
    const newer = await makeSnapshot(configPath, grownConfig(healthyConfig, 300));
    await expectPromotion(createConfigIO(deps), newer);
    await expectRaw(resolveLastKnownGoodConfigPath(configPath), newer.raw);
    expect(warn.mock.calls.map(([message]) => String(message)).join("\n")).not.toContain(
      "Config last-known-good promotion skipped",
    );
    const newerBaseline = readConfigHealthStateFromStore(deps).entries?.[configPath]?.lastKnownGood;
    expect(newerBaseline?.hash).not.toBe(compensation.candidate.hash);

    await restoreConfigHealthBaselineForRolledBackWrite(deps, compensation);

    const restoredEntry = readConfigHealthStateFromStore(deps).entries?.[configPath];
    expect(restoredEntry?.lastKnownGood?.hash).toBe(newerBaseline?.hash);
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

  it.each([
    { anomaly: "size", proxies: 80 },
    { anomaly: "gateway-mode", proxies: 1 },
  ])(
    "does not bless a pre-existing $anomaly truncation through an ordinary accepted edit",
    async ({ anomaly, proxies }) => {
      const { configPath, env, root } = acceptedWriteFixture();
      const warn = vi.fn();
      const io = createConfigIO({
        env,
        configPath,
        homedir: () => root,
        observe: true,
        logger: { warn, error: vi.fn() },
      });
      const healthyRaw = seedConfig(configPath, {
        meta: { lastTouchedVersion: "2026.4.22" },
        gateway: {
          mode: "local",
          trustedProxies: Array.from({ length: proxies }, (_, index) => `192.0.2.${index}`),
        },
      });
      expect(Buffer.byteLength(healthyRaw) < 512).toBe(anomaly === "gateway-mode");
      await promoteCurrent(io);

      // Missing gateway mode must survive writer stamping below the size-drop
      // threshold; an ordinary edit is not approval of either earlier anomaly.
      seedConfig(configPath, {
        meta: { lastTouchedVersion: "2026.4.22" },
        gateway: { ...(anomaly === "size" ? { mode: "local" } : {}), port: 18789 },
      });
      const truncated = await io.readConfigFileSnapshot();
      await expectPromotion(io, truncated, false);
      expect(warn.mock.calls.flat().join("\n")).toContain(
        "Config last-known-good promotion skipped",
      );
      if (anomaly === "size") {
        expect(warn.mock.calls.flat().join("\n")).toContain("size-drop-vs-last-good");
      }
      await io.writeConfigFile(
        { ...truncated.config, gateway: { ...truncated.config.gateway, port: 19187 } },
        { baseSnapshot: truncated },
      );
      const edited = await io.readConfigFileSnapshot();
      expect(edited.config.gateway?.port).toBe(19187);
      await expectPromotion(io, edited, false);
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
    seedConfig(configPath, verboseConfig());

    const healthySnapshot = await promoteCurrent(io);
    expect(fs.readFileSync(lastGoodPath, "utf8")).toBe(healthySnapshot.raw);

    const acceptedWrite = await io.writeConfigFile(
      { meta: { lastTouchedVersion: "2026.4.22" }, gateway: { mode: "local" } },
      { allowConfigSizeDrop: true, baseSnapshot: healthySnapshot },
    );
    expect(acceptedWrite.persistedConfig.gateway).toEqual({ mode: "local" });

    const reducedSnapshot = await promoteCurrent(io);
    expect(fs.readFileSync(lastGoodPath, "utf8")).toBe(reducedSnapshot.raw);

    seedConfig(configPath, { gateway: { port: 19187 } });
    const truncatedSnapshot = await io.readConfigFileSnapshot();
    await expectPromotion(io, truncatedSnapshot, false);
    expect(fs.readFileSync(lastGoodPath, "utf8")).toBe(reducedSnapshot.raw);
  });

  it.each(["read failure", "write failure", "lost reply"] as const)(
    "keeps the file committed and reconciles health after %s",
    async (fault) => {
      const { configPath, env, io, root } = acceptedWriteFixture();
      seedConfig(configPath, {
        meta: { lastTouchedVersion: "2026.4.22" },
        gateway: { mode: "local", port: 18789 },
      });
      const before = await promoteCurrent(io);
      const deps = { env, homedir: () => root, logger: console };
      const prior = readConfigHealthStateFromStore(deps).entries?.[configPath];
      const capture = healthOwner.captureConfigHealthStateStore;
      vi.spyOn(healthOwner, "captureConfigHealthStateStore").mockImplementation((...args) => {
        const store = capture(...args);
        return {
          ...store,
          async read() {
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
              return await store.updateAfterFileCommit(...updateArgs);
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
      const after = readConfigHealthStateFromStore(deps).entries?.[configPath];
      if (fault === "lost reply") {
        expect(after?.lastKnownGood?.hash).not.toBe(prior?.lastKnownGood?.hash);
      } else {
        expect(after).toEqual(prior);
      }
    },
  );

  it.each([false, true])(
    "promotes formatting normalization (intervening observation=%s)",
    async (observe) => {
      const { configPath, env, io, root } = acceptedWriteFixture();
      const lastGoodPath = `${configPath}.last-good`;
      const original = verboseConfig();
      const verboseRaw = `\uFEFF${JSON.stringify(original, null, 12)}\n`;
      fs.writeFileSync(configPath, verboseRaw, "utf8");
      const verboseSnapshot = await promoteCurrent(io);
      expect(fs.readFileSync(lastGoodPath, "utf8")).toBe(verboseRaw);

      const healthDeps = normalizeConfigIoDeps({
        env,
        homedir: () => root,
        logger: { warn: vi.fn(), error: vi.fn() },
      });
      const capture = healthOwner.captureConfigHealthStateStore;
      let observedDuringAdvance = false;
      const outcomes: unknown[] = [];
      const spy = observe
        ? vi.spyOn(healthOwner, "captureConfigHealthStateStore").mockImplementation((...args) => {
            const store = capture(...args);
            return {
              ...store,
              async read() {
                const snapshot = await store.read();
                // Commit an ordinary observation after the actual snapshot, forcing
                // the worker's conditional patch to miss rather than faking a conflict.
                if (
                  observe &&
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
          })
        : undefined;
      try {
        await io.writeConfigFile(
          { ...original, gateway: { mode: "local", port: 18789 } },
          { baseSnapshot: verboseSnapshot },
        );
      } finally {
        spy?.mockRestore();
      }

      const canonicalRaw = fs.readFileSync(configPath, "utf8");
      expect(observedDuringAdvance).toBe(observe);
      if (observe) {
        expect(outcomes).toEqual([{ status: "conflict" }, { status: "applied" }]);
      }
      expect(Buffer.byteLength(verboseRaw)).toBeGreaterThan(Buffer.byteLength(canonicalRaw) * 2);
      // The accepted edit stays promotable despite the intervening observation.
      await promoteCurrent(io);
      expect(fs.readFileSync(lastGoodPath, "utf8")).toBe(canonicalRaw);
      fs.writeFileSync(
        configPath,
        `${JSON.stringify({ gateway: { mode: "local", port: 18789 } }, null, 2)}\n`,
        "utf8",
      );
      const truncatedSnapshot = await io.readConfigFileSnapshot();
      await expectPromotion(io, truncatedSnapshot, false);
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
    },
  );

  it("restores the inherited anomaly when a later accepted edit rolls back", async () => {
    const initial = createRecoveryBaselineConfig();
    await withTempHomeConfig(initial, async ({ configPath }) => {
      const io = createConfigIO({ observe: true });
      const healthy = await promoteCurrent(io);
      fs.writeFileSync(configPath, JSON.stringify({ gateway: { mode: "local", port: 18789 } }));
      const truncated = await io.readConfigFileSnapshot();
      await io.writeConfigFile(
        { ...truncated.config, gateway: { ...truncated.config.gateway, port: 19187 } },
        { baseSnapshot: truncated },
      );
      const edited = await io.readConfigFileSnapshot();
      await expectPromotion(io, edited, false);
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

  it.each([false, true])(
    "restores the pre-write baseline on rollback (intervening read=%s)",
    async (interveningRead) => {
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

        await promoteCurrent(io);
        expect(fs.readFileSync(lastGoodPath, "utf8")).toBe(originalRaw);
        const baselineBefore = readLastKnownGood();
        expect(baselineBefore?.bytes).toBe(Buffer.byteLength(originalRaw, "utf-8"));

        const failure = new Error("synthetic overlay failure");
        const grown = grownConfig(initialConfig);
        expect(Buffer.byteLength(`${JSON.stringify(grown, null, 2)}\n`, "utf-8")).toBeGreaterThan(
          Buffer.byteLength(originalRaw, "utf-8") * 2,
        );

        // Observe between publication and baseline advancement, before compensation settles.
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
            writeConfigFile(
              grown,
              interveningRead
                ? {
                    assertConfigPathForWrite: () => {
                      if (
                        !observedPublishedCandidate &&
                        fs.readFileSync(configPath, "utf-8") !== originalRaw
                      ) {
                        observePublishedConfig();
                      }
                    },
                  }
                : undefined,
            ),
          ).rejects.toMatchObject({
            name: "ConfigWritePostCommitError",
            rollbackStatus: "restored",
            cause: failure,
          });
        } finally {
          unsubscribe();
          resetConfigRuntimeState();
        }

        expect(observedPublishedCandidate).toBe(interveningRead);
        await expectRaw(configPath, originalRaw);
        const baselineAfter = readLastKnownGood();
        expect(baselineAfter?.hash).toBe(baselineBefore?.hash);
        expect(baselineAfter?.bytes).toBe(Buffer.byteLength(originalRaw, "utf-8"));

        await promoteCurrent(io);
        expect(fs.readFileSync(lastGoodPath, "utf8")).toBe(originalRaw);
      });
    },
  );
});
