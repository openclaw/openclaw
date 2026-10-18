import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readConfigFileSnapshotForWrite } from "../config/config.js";
import { createConfigIO } from "../config/io.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import { captureGatewayStateOwner } from "../infra/gateway-state-owner.js";
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
import { startGatewayConfigReloader } from "./config-reload.js";
import { ownedConfigReloadOptions } from "./config-reload.test-support.js";
import { commitGatewayConfigWrite } from "./server-methods/config-write-flow.js";

const tempDirs = createTempDirTracker();
type ReloadOptions = Parameters<typeof startGatewayConfigReloader>[0];
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
      stop: vi.fn<NonNullable<TranscriptSourceProvider["stop"]>>(async ({ sessionId }) => ({
        ok: true,
        sessionId,
      })),
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
    const library = (config: OpenClawConfig) => readTranscriptLibraryStatus(store, config);
    await withEnvAsync(
      { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath },
      async () => {
        const owner = await acquireGatewayLock({ allowInTests: true });
        if (!owner) {
          throw new Error("Expected Gateway state ownership");
        }
        await using gatewayOwnership = {
          assertCurrent: owner.assertCurrent,
          async [Symbol.asyncDispose]() {
            await closeOpenClawStateDatabaseAsync();
            await owner.release();
          },
        };
        const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
        const initialOwner = captureGatewayStateOwner(databasePath);
        expect(initialOwner?.role).toBe("gateway");
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
          const createService = (config: OpenClawConfig) =>
            createTranscriptsAutoStartService({ stateDir, config, agentId: "notes", logger });
          let service = createService(current);
          let startupSettled = Promise.resolve();
          const application = createDeferred();
          const startAndWaitForProvider = async () => {
            signal.throwIfAborted();
            const entered = createDeferred<TranscriptStartRequest>();
            providerEntered = entered;
            try {
              startupSettled = service.start().settled;
              const request = await withinTest(entered.promise, signal);
              if (!pending) {
                await startupSettled;
              }
              return request;
            } finally {
              providerEntered = undefined;
            }
          };
          const restart = vi.fn(() => application.resolve());
          const commit = vi.fn<ReloadOptions["onNoopConfigCommit"]>(
            async (plan, next, ownership) => {
              ownership.markRuntimeCommitted(next, plan);
              setRuntimeConfigSnapshot(next, next);
              current = next;
            },
          );
          const hotReload = vi.fn<ReloadOptions["onHotReload"]>(
            async (plan, next, ownership, source) => {
              await service.stop(new Set(), next);
              await commit(plan, next, ownership, source);
              service.start(next);
              return "applied";
            },
          );
          const reloader = startGatewayConfigReloader({
            ...(await ownedConfigReloadOptions(snapshot, configPath)),
            initialAuthoredConfig: initial,
            readSnapshot: () => io.readConfigFileSnapshot(),
            onNoopConfigCommit: commit,
            onHotReload: hotReload,
            onRestart: restart,
            onConfigApplied: vi.fn(() => application.resolve()),
            log: logger,
          });
          await reloader.ready;
          try {
            const request = await startAndWaitForProvider();
            expect(pending ? requests : (await library(current)).active).toHaveLength(1);
            const admitted = structuredClone(request.session);
            const selector = transcriptSessionSelector(admitted);
            const readCapture = () =>
              Promise.all([
                store.readSession(selector),
                store.readUtterancesForSession(admitted),
                store.readSummary(admitted),
              ]);
            await request.onUtterance({ text: "Before title edit", final: true });
            const prepared = await readConfigFileSnapshotForWrite();
            const next = structuredClone(
              prepared.snapshot.sourceConfig ?? prepared.snapshot.config,
            );
            next.transcripts!.autoStart![0]!.title = "Future title";
            const write = await commitGatewayConfigWrite({ ...prepared, nextConfig: next });
            write.queueFollowUp();
            await racePromiseWithAbortSignal(application.promise, signal);
            gatewayOwnership.assertCurrent();
            expect(captureGatewayStateOwner(databasePath)?.ownerId).toBe(initialOwner?.ownerId);
            expect(restart).not.toHaveBeenCalled();
            expect(hotReload).toHaveBeenCalledTimes(1);
            expect(commit).toHaveBeenCalledTimes(1);
            expect(provider.stop).not.toHaveBeenCalled();
            expect(requests).toHaveLength(1);
            startupGate.resolve();
            await startupSettled;
            expect((await library(current)).active).toHaveLength(1);
            expect(current.transcripts?.autoStart?.[0]?.title).toBe("Future title");
            await expect(store.readSession(selector)).resolves.toEqual(admitted);
            await expect(store.readSummary(admitted)).resolves.toEqual({});
            await request.onUtterance({ text: "After title edit", final: true });
            expect((await store.readUtterancesForSession(admitted)).map((u) => u.text)).toEqual([
              "Before title edit",
              "After title edit",
            ]);
            expect((await library(current)).configuredSources[0]).toMatchObject({
              state: "armed",
              activeSelectors: [selector],
            });
            await service.stop();
            const historical = await readCapture();
            expect(historical[0]?.stoppedAt).toEqual(expect.any(String));
            const { sessionId: _fixedId, ...generatedSource } = current.transcripts!.autoStart![0]!;
            const generated = {
              ...current,
              transcripts: { ...current.transcripts, autoStart: [generatedSource] },
            };
            for (let capture = 0; capture < 2; capture++) {
              await service.stop();
              service = createService(generated);
              await startAndWaitForProvider();
              await startupSettled;
              expect((await library(generated)).configuredSources[0]?.state).toBe("armed");
              expect(requests.at(-1)?.session.title).toBe("Future title");
            }
            expect(new Set(requests.map((capture) => capture.session.sessionId)).size).toBe(3);
            await expect(readCapture()).resolves.toEqual(historical);
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
