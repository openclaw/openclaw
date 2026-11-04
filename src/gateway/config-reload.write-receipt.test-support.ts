import { writeFile } from "node:fs/promises";
import nodePath from "node:path";
import { expect, it, vi, type Mock } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import type { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { initializePublishedConfigRuntimeEnv } from "../config/config-env-vars.js";
import {
  readConfigFileSnapshotForWrite,
  registerConfigWriteListener,
  type OpenClawConfig,
} from "../config/config.js";
import type { appendConfigAuditRecord } from "../config/io.audit.js";
import { createConfigIO, readConfigFileSnapshotForRuntimeTransaction } from "../config/io.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { PluginRuntimeApplicationError } from "../plugins/lifecycle.js";
import {
  getActiveGatewayRootWorkCount,
  runWithGatewayIndependentRootWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { withEnvAsync } from "../test-utils/env.js";
import type {
  GatewayConfigReloadTransactionOwnership,
  GatewayReloadPlan,
} from "./config-reload.js";
import {
  createConfigReloadTestClock,
  startGatewayConfigReloader,
} from "./config-reload.test-support.js";
import { installWatcherMock } from "./config-reload.watcher.test-support.js";
import { commitGatewayConfigWrite } from "./server-methods/config-write-flow.js";
import { GatewayConfigReloadSupersededError } from "./server-reload-contracts.js";

export function registerConfigWriteReceiptTests({
  tempDirs,
  configAuditMocks,
}: {
  tempDirs: Pick<ReturnType<typeof useAutoCleanupTempDirTracker>, "make">;
  configAuditMocks: { append: Mock<typeof appendConfigAuditRecord> };
}) {
  const writeReceiptScenarios = [
    "direct",
    "watcher-first",
    "watcher-echo",
    "failed-cleanup",
    "committed",
    "carried-successor",
  ] as const;
  it.each(writeReceiptScenarios)(
    "settles an RPC write inside its originating gateway root (%s)",
    async (scenario) => {
      const { clock, scheduler } = createConfigReloadTestClock();
      const root = tempDirs.make("openclaw-config-receipt-");
      const bundledPluginsDir = tempDirs.make("openclaw-config-receipt-bundled-");
      const configPath = nodePath.join(root, "openclaw.json");
      // Reloads discover plugins per operation; this admission fixture declares none.
      const configEnv = {
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      };
      const initialConfig = {
        gateway: { reload: {} },
        hooks: { enabled: false },
      } satisfies OpenClawConfig;
      const nextConfig = {
        gateway: { reload: {} },
        hooks: { enabled: true },
      } satisfies OpenClawConfig;
      await writeFile(configPath, `${JSON.stringify(initialConfig, null, 2)}\n`);
      resetConfigRuntimeState();
      setRuntimeConfigSnapshot(initialConfig, initialConfig);
      initializePublishedConfigRuntimeEnv(initialConfig);

      const watcher = installWatcherMock();
      const hotReloadGate = createDeferred();
      const hotReloadStarted = createDeferred();
      const hotReloadChecked = createDeferred();
      const writeAuditStarted = createDeferred();
      const writeAuditGate = createDeferred();
      let ownWriteStillBlocks = false;
      if (scenario === "watcher-first") {
        configAuditMocks.append.mockImplementation(async ({ record }) => {
          if (record.event === "config.write") {
            writeAuditStarted.resolve();
            await writeAuditGate.promise;
          }
        });
      }
      const competingRootCounts: number[] = [];
      const onHotReload = vi.fn(
        async (
          plan: GatewayReloadPlan,
          runtimeConfig: OpenClawConfig,
          ownership: GatewayConfigReloadTransactionOwnership,
        ) => {
          competingRootCounts.push(getActiveGatewayRootWorkCount({ excludeCurrent: true }));
          hotReloadStarted.resolve();
          await hotReloadGate.promise;
          if (scenario === "watcher-first") {
            ownWriteStillBlocks =
              ownership.isCurrent() && getActiveGatewayRootWorkCount({ excludeCurrent: true }) > 0;
            hotReloadChecked.resolve();
            if (!ownership.isCurrent()) {
              throw new GatewayConfigReloadSupersededError();
            }
          }
          if (
            scenario !== "direct" &&
            scenario !== "watcher-first" &&
            scenario !== "carried-successor" &&
            competingRootCounts.length === 1
          ) {
            if (scenario === "committed") {
              ownership.markRuntimeCommitted(runtimeConfig, plan);
            }
            watcher.emit("change", configPath);
            const superseded = new GatewayConfigReloadSupersededError();
            throw new PluginRuntimeApplicationError(
              "Plugin replacement superseded",
              {
                operationId: "config-write",
                generation: 1,
                pluginIds: ["notes"],
                phase: scenario === "committed" ? "activate" : "drain",
                committed: scenario === "committed",
              },
              {
                cause:
                  scenario === "failed-cleanup"
                    ? new AggregateError([superseded, new Error("cleanup failed")])
                    : superseded,
              },
            );
          }
          ownership.markRuntimeCommitted(runtimeConfig, plan);
          return "applied" as const;
        },
      );
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

      try {
        await withEnvAsync(configEnv, async () => {
          const configIo = createConfigIO({ configPath, pluginValidation: "skip" });
          const reloader = startGatewayConfigReloader({
            scheduler,
            testDebounceMs: 0,
            initialConfig,
            initialSnapshotRawHash: (await configIo.readConfigFileSnapshot()).hash ?? null,
            initialAuthoredConfig: initialConfig,
            initialSnapshotValid: true,
            initialSnapshotIssues: [],
            readSnapshot: readConfigFileSnapshotForRuntimeTransaction,
            promoteSnapshot: async () => true,
            initialPluginInstallRecords: {},
            readPluginInstallRecords: async () => ({}),
            subscribeToWrites: (listener) =>
              registerConfigWriteListener(listener, {
                ownsRuntimeActivationFor: configPath,
                preCommitRuntimePreflight: async (sourceConfig) => ({
                  runtimeConfig: sourceConfig,
                  compareConfig: sourceConfig,
                }),
              }),
            onConfigChange: async () => {},
            onConfigApplied: async () => {},
            onConfigRevisionApplied: () => {},
            onConfigAccepted: async () => {},
            onEffectiveConfigUnchanged: async () => ({ rollback: async () => {} }),
            onNoopConfigCommit: async (plan, runtimeConfig, ownership) => {
              ownership.markRuntimeCommitted(runtimeConfig, plan);
            },
            onHotReload,
            onRestart: async () => {
              throw new Error("unexpected restart");
            },
            runTransaction: runWithGatewayIndependentRootWorkAdmission,
            log,
            watchPath: configPath,
          });
          await reloader.ready;

          try {
            const request = tryBeginGatewayRootWorkAdmission();
            if (!request) {
              throw new Error("expected gateway request admission");
            }
            let successorRequest: ReturnType<typeof tryBeginGatewayRootWorkAdmission> = null;
            try {
              const writing = request.run(async () => {
                const prepared = await readConfigFileSnapshotForWrite();
                return await commitGatewayConfigWrite({
                  snapshot: prepared.snapshot,
                  writeOptions: prepared.writeOptions,
                  nextConfig,
                  awaitRuntimeApplication: true,
                });
              });
              let fileApplication: Promise<void> | undefined;
              if (scenario === "watcher-first") {
                // The physical rename is visible before the writer finishes its audit.
                await awaitGateBeforeSettlement(
                  writeAuditStarted.promise,
                  writing,
                  "write completed before its audit gate",
                );
                watcher.emit("change", configPath);
                fileApplication = Promise.resolve(clock.wake());
                await awaitGateBeforeSettlement(
                  hotReloadStarted.promise,
                  fileApplication,
                  "file observation finished before hot reload",
                );
                writeAuditGate.resolve();
              }
              const writeResult = await writing;
              let successorWrite: typeof writeResult | undefined;
              let settled = false;
              void writeResult.application?.then(() => {
                settled = true;
                request.release();
              });

              const applying = fileApplication ?? clock.wake();
              await hotReloadStarted.promise;
              expect(onHotReload).toHaveBeenCalledOnce();
              expect(settled).toBe(false);

              if (scenario === "carried-successor") {
                successorRequest = tryBeginGatewayRootWorkAdmission();
                if (!successorRequest) {
                  throw new Error("expected successor writer admission");
                }
                successorWrite = await successorRequest.run(async () => {
                  const prepared = await readConfigFileSnapshotForWrite();
                  return await commitGatewayConfigWrite({
                    snapshot: prepared.snapshot,
                    writeOptions: prepared.writeOptions,
                    nextConfig: { ...prepared.snapshot.sourceConfig, logging: { level: "debug" } },
                    awaitRuntimeApplication: true,
                  });
                });
                void successorWrite.application?.then(successorRequest.release);
                expect(settled).toBe(false);
              }

              hotReloadGate.resolve();
              if (scenario === "watcher-first") {
                await hotReloadChecked.promise;
                expect(ownWriteStillBlocks).toBe(false);
              }
              await applying;
              await clock.wake();
              await writeResult.application;
              expect(settled).toBe(true);
              const applied =
                scenario === "direct" ||
                scenario === "watcher-first" ||
                scenario === "watcher-echo" ||
                scenario === "carried-successor";
              await expect(writeResult.application).resolves.toBe(applied ? "applied" : "failed");
              if (successorWrite) {
                await expect(successorWrite.application).resolves.toBe("applied");
              }
              if (scenario === "watcher-first") {
                expect(competingRootCounts).toEqual([1, 0]);
              } else {
                expect(competingRootCounts).toEqual(
                  scenario === "watcher-echo" || scenario === "failed-cleanup" ? [0, 0] : [0],
                );
              }
              if (applied) {
                expect(log.error).not.toHaveBeenCalled();
              } else {
                expect(log.error).toHaveBeenCalledOnce();
              }
            } finally {
              hotReloadGate.resolve();
              writeAuditGate.resolve();
              request.release();
              successorRequest?.release();
            }
          } finally {
            await reloader.stop();
          }
        });
      } finally {
        resetConfigRuntimeState();
      }
    },
  );
}
