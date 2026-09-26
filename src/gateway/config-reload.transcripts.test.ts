import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readConfigFileSnapshotForWrite, registerConfigWriteListener } from "../config/config.js";
import { createConfigIO } from "../config/io.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createTranscriptsAutoStartService } from "../transcripts/auto-start.js";
import type {
  TranscriptSourceProvider,
  TranscriptStartRequest,
} from "../transcripts/provider-types.js";
import { readTranscriptLibraryStatus } from "../transcripts/status.js";
import { TranscriptsStore, transcriptSessionSelector } from "../transcripts/store.js";
import {
  type GatewayConfigReloadTransactionOwnership,
  type GatewayReloadPlan,
  startGatewayConfigReloader,
} from "./config-reload.js";
import { commitGatewayConfigWrite } from "./server-methods/config-write-flow.js";

const tempDirs = createTempDirTracker();
afterEach(async () => {
  resetConfigRuntimeState();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
});

it.for([false, true])(
  "keeps an admitted capture through a real title config commit (pending=%s) and applies the future title",
  async (pending, { signal }) => {
    const stateDir = await fs.realpath(tempDirs.make("transcripts-title-reload-"));
    const configPath = path.join(stateDir, "openclaw.json");
    const requests: TranscriptStartRequest[] = [];
    let providerEntered: ReturnType<typeof createDeferred<TranscriptStartRequest>> | undefined;
    const startupGate = createDeferred();
    if (!pending) {
      startupGate.resolve();
    }
    const stop = vi.fn(async ({ sessionId }: { sessionId: string }) => ({
      ok: true as const,
      sessionId,
    }));
    const provider: TranscriptSourceProvider = {
      id: "title-reload-fixture",
      name: "Title reload fixture",
      sourceKinds: ["live-caption"],
      async start(request) {
        requests.push(request);
        providerEntered?.resolve(request);
        await startupGate.promise;
        return { ok: true, session: request.session };
      },
      stop,
    };
    const registry = createEmptyPluginRegistry();
    registry.transcriptSourceProviders.push({
      pluginId: provider.id,
      provider,
      source: import.meta.url,
    });
    const initial: OpenClawConfig = {
      gateway: { mode: "local", reload: { mode: "hybrid" } },
      transcripts: {
        enabled: true,
        autoStart: [
          {
            providerId: provider.id,
            accountId: "demo",
            sessionId: "daily-proof",
            title: "Original title",
          },
        ],
      },
    };
    const logger = {
      warn: vi.fn((message: string) => {
        if (message.startsWith("transcripts autoStart")) {
          providerEntered?.reject(new Error(message));
        }
      }),
      info: vi.fn(),
      error: vi.fn(),
    };
    const store = new TranscriptsStore(path.join(stateDir, "transcripts"), {
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    await withEnvAsync(
      { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath },
      async () => {
        await withPluginRuntimeRegistryScope(registry, async () => {
          await fs.writeFile(configPath, "{}");
          const seed = await readConfigFileSnapshotForWrite();
          const created = await commitGatewayConfigWrite({ ...seed, nextConfig: initial });
          created.queueFollowUp();
          const io = createConfigIO({ configPath });
          const snapshot = await io.readConfigFileSnapshot();
          expect(snapshot.valid).toBe(true);
          let current = snapshot.config;
          setRuntimeConfigSnapshot(current, current);
          let service = createTranscriptsAutoStartService({
            stateDir,
            config: current,
            agentId: "notes",
            logger,
          });
          let startupSettled = Promise.resolve();
          const application = createDeferred();
          const startAndWaitForProvider = async () => {
            signal.throwIfAborted();
            const entered = createDeferred<TranscriptStartRequest>();
            const aborted = () =>
              entered.reject(
                new Error("Transcript fixture start aborted", { cause: signal.reason }),
              );
            providerEntered = entered;
            signal.addEventListener("abort", aborted, { once: true });
            try {
              startupSettled = service.start().settled;
              const request = await entered.promise;
              if (!pending) {
                await startupSettled;
              }
              return request;
            } finally {
              signal.removeEventListener("abort", aborted);
              providerEntered = undefined;
            }
          };
          const restart = vi.fn(async (_plan: GatewayReloadPlan, next: OpenClawConfig) => {
            application.resolve();
            current = next;
            await service.stop();
            service = createTranscriptsAutoStartService({
              stateDir,
              config: next,
              agentId: "notes",
              logger,
            });
            service.start();
          });
          const commit = vi.fn(
            async (
              plan: GatewayReloadPlan,
              next: OpenClawConfig,
              ownership: GatewayConfigReloadTransactionOwnership,
            ) => {
              ownership.markRuntimeCommitted(next, plan);
              setRuntimeConfigSnapshot(next, next);
              current = next;
            },
          );
          const applied = vi.fn(() => application.resolve());
          const hotReload = vi.fn(
            async (
              plan: GatewayReloadPlan,
              next: OpenClawConfig,
              ownership: GatewayConfigReloadTransactionOwnership,
            ) => {
              await service.stop(new Set(), next);
              await commit(plan, next, ownership);
              service.start(next);
              return "applied" as const;
            },
          );
          const reloader = startGatewayConfigReloader({
            initialConfig: current,
            initialCompareConfig: snapshot.sourceConfig ?? current,
            initialSnapshotRawHash: snapshot.hash ?? null,
            initialAuthoredConfig: initial,
            initialSnapshotValid: true,
            initialSnapshotIssues: [],
            testDebounceMs: 0,
            watchPath: configPath,
            readSnapshot: () => io.readConfigFileSnapshot(),
            initialPluginInstallRecords: {},
            readPluginInstallRecords: async () => ({}),
            subscribeToWrites: (listener) =>
              registerConfigWriteListener(listener, {
                ownsRuntimeActivationFor: configPath,
                preCommitRuntimePreflight: async (config) => ({
                  runtimeConfig: config,
                  compareConfig: config,
                }),
              }),
            onNoopConfigCommit: commit,
            onHotReload: hotReload,
            onRestart: restart,
            onConfigApplied: applied,
            log: logger,
          });
          await reloader.ready;
          try {
            const request = await startAndWaitForProvider();
            expect(
              pending ? requests : (await readTranscriptLibraryStatus(store, current)).active,
            ).toHaveLength(1);
            const admitted = structuredClone(request.session);
            const selector = transcriptSessionSelector(admitted);
            await request.onUtterance({ text: "Before title edit", final: true });
            const prepared = await readConfigFileSnapshotForWrite();
            const next = structuredClone(
              prepared.snapshot.sourceConfig ?? prepared.snapshot.config,
            );
            next.transcripts!.autoStart![0]!.title = "Future title";
            const write = await commitGatewayConfigWrite({ ...prepared, nextConfig: next });
            write.queueFollowUp();
            await racePromiseWithAbortSignal(application.promise, signal);
            expect(restart).not.toHaveBeenCalled();
            expect(hotReload).toHaveBeenCalledTimes(1);
            expect(commit).toHaveBeenCalledTimes(1);
            expect(stop).not.toHaveBeenCalled();
            expect(requests).toHaveLength(1);
            startupGate.resolve();
            await startupSettled;
            expect((await readTranscriptLibraryStatus(store, current)).active).toHaveLength(1);
            expect(current.transcripts?.autoStart?.[0]?.title).toBe("Future title");
            await expect(store.readSession(selector)).resolves.toEqual(admitted);
            await expect(store.readSummary(admitted)).resolves.toEqual({});
            await request.onUtterance({ text: "After title edit", final: true });
            expect((await store.readUtterancesForSession(admitted)).map((u) => u.text)).toEqual([
              "Before title edit",
              "After title edit",
            ]);
            expect(
              (await readTranscriptLibraryStatus(store, current)).configuredSources[0],
            ).toMatchObject({ state: "armed", activeSelectors: [selector] });
            await service.stop();
            const historical = await store.readSession(selector);
            const notes = await store.readUtterancesForSession(admitted);
            const summary = await store.readSummary(admitted);
            expect(historical?.stoppedAt).toEqual(expect.any(String));
            const { sessionId: _fixedId, ...generatedSource } = current.transcripts!.autoStart![0]!;
            const generated = {
              ...current,
              transcripts: { ...current.transcripts, autoStart: [generatedSource] },
            };
            for (let capture = 0; capture < 2; capture++) {
              await service.stop();
              service = createTranscriptsAutoStartService({
                stateDir,
                config: generated,
                agentId: "notes",
                logger,
              });
              await startAndWaitForProvider();
              await startupSettled;
              expect(
                (await readTranscriptLibraryStatus(store, generated)).configuredSources[0]?.state,
              ).toBe("armed");
              expect(requests.at(-1)?.session.title).toBe("Future title");
            }
            expect(new Set(requests.map((capture) => capture.session.sessionId)).size).toBe(3);
            await expect(store.readSession(selector)).resolves.toEqual(historical);
            await expect(store.readUtterancesForSession(admitted)).resolves.toEqual(notes);
            await expect(store.readSummary(admitted)).resolves.toEqual(summary);
          } finally {
            startupGate.resolve();
            await reloader.stop();
            await service.stop();
          }
        });
      },
    );
  },
);
