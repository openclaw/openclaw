import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withPluginMetadataSnapshotScope } from "../plugins/current-plugin-metadata-snapshot.js";
import * as discovery from "../plugins/discovery.js";
import * as loader from "../plugins/loader.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  createPluginRegistryOwner,
  listImportedRuntimePluginIds,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createTranscriptsAutoStartService } from "./auto-start.js";
import { createTranscriptCaptureAppends } from "./capture-appends.js";
import { activeSessions } from "./capture-startup.js";
import type {
  TranscriptOccupancyWatchRequest,
  TranscriptSessionDescriptor,
  TranscriptSourceProvider,
  TranscriptStartRequest,
} from "./provider-types.js";
import { readTranscriptLibraryStatus } from "./status.js";
import {
  transcriptStatusRoom as room,
  useTranscriptStatusFixture,
} from "./status.producer.test-harness.js";
import { TranscriptsStore, transcriptSessionSelector } from "./store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  activeSessions.clear();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
});

function withStatusState(run: (state: OpenClawTestState) => Promise<void>) {
  return withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const previous = captureActivePluginRegistrySnapshot();
    try {
      await run(state);
    } finally {
      restoreActivePluginRegistrySnapshot(previous);
    }
  });
}

function createStore() {
  const stateDir = tempDirs.make("transcript-status-");
  return new TranscriptsStore(path.join(stateDir, "transcripts"), {
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });
}

function recordCapture(
  session: TranscriptSessionDescriptor,
  providerId = session.source.providerId,
) {
  activeSessions.set(session.sessionId, {
    appends: createTranscriptCaptureAppends(() => {}),
    session,
    providerId,
    phase: "active",
    stopProvider: async () => {
      throw new Error("Reading transcript status must not stop capture");
    },
    releaseProvider: async () => {},
  });
}

function providerRegistry(
  pluginId: string,
  id: string,
  overrides: Partial<TranscriptSourceProvider> = {},
) {
  const registry = createEmptyPluginRegistry();
  registry.plugins.push(createPluginRecord({ id: pluginId }));
  registry.transcriptSourceProviders.push({
    pluginId,
    source: "fixture",
    provider: { id, name: id, sourceKinds: ["live-caption"], ...overrides },
  });
  return registry;
}

function metadataFixture(cfg: OpenClawConfig, sources: Record<string, string>) {
  const manifestRegistry = makeRegistry(Object.keys(sources).map((id) => ({ id, channels: [] })));
  for (const plugin of manifestRegistry.plugins) {
    plugin.contracts = { transcriptSourceProviders: [sources[plugin.id]!] };
  }
  return createPluginMetadataSnapshot({ config: cfg, manifestRegistry });
}

const installedDefaults = {
  manifestHash: "fixture",
  origin: "config" as const,
  enabled: true,
  startup: { sidecar: false, memory: false, agentHarnesses: [] },
  compat: [],
};

function readMetadata(
  store: TranscriptsStore,
  cfg: OpenClawConfig,
  metadata: PluginMetadataSnapshot,
) {
  return withPluginMetadataSnapshotScope(metadata, () => readTranscriptLibraryStatus(store, cfg), {
    config: cfg,
  });
}

describe("transcript library capture health", () => {
  it("reports a durable source timestamp without inventing persistence time or recording from unstopped rows", async () => {
    const store = createStore();
    const source = { providerId: "caption-alias", channelId: "room" };
    const cfg: OpenClawConfig = { transcripts: { autoStart: [source] } };
    const session = { sessionId: "persistent-room", startedAt: "2026-08-20T10:00:00.000Z", source };
    await store.writeSession(session);
    await store.appendUtteranceForSession(session, {
      text: "Saved before restart",
      endedAt: "2026-08-20T10:10:00.000Z",
    });
    let result = await readTranscriptLibraryStatus(store, cfg);
    expect(result.configuredSources[0]?.state).not.toBe("armed");
    expect(result).toMatchObject({
      active: [],
      latestTranscript: {
        lastUtteranceAt: "2026-08-20T10:10:00.000Z",
        activeSubscription: false,
      },
    });
    recordCapture(session, "canonical-captions");
    result = await readTranscriptLibraryStatus(store, cfg);
    expect(result.configuredSources[0]).toMatchObject({
      state: "armed",
      activeSelectors: [transcriptSessionSelector(session)],
    });
    expect(result.active[0]?.activeSubscription).toBe(true);
    activeSessions.get(session.sessionId)!.cleanupPending = true;
    result = await readTranscriptLibraryStatus(store, cfg);
    expect(result.configuredSources[0]).toMatchObject({ state: "unknown", activeSelectors: [] });
    expect(result.active[0]?.activeSubscription).toBe(false);
    result = await readTranscriptLibraryStatus(store, {
      transcripts: { enabled: false, autoStart: [source] },
    });
    expect(result.configuredSources[0]?.state).toBe("disabled");
  });

  it("reads declared, disabled and unavailable providers from prepared metadata without calling provider runtime", async () => {
    await withStatusState(async (state) => {
      const cfg: OpenClawConfig = {
        transcripts: { autoStart: [{ providerId: "absent" }, { providerId: "disabled-source" }] },
      };
      const metadata = metadataFixture(cfg, {
        "fixture-plugin": "declared-source",
        "disabled-plugin": "disabled-source",
      });
      const descriptor = {
        name: "Fixture captions",
        autoStart: { accountId: "optional" as const, meetingUrl: "required" as const },
      };
      metadata.plugins.find((plugin) => plugin.id === "fixture-plugin")!.transcriptSources = {
        "declared-source": descriptor,
      };
      metadata.index.plugins = metadata.plugins.map((plugin) => ({
        ...installedDefaults,
        pluginId: plugin.id,
        manifestPath: plugin.manifestPath,
        rootDir: plugin.rootDir,
        enabled: plugin.id !== "disabled-plugin",
      }));
      const hooks = { start: vi.fn(), stop: vi.fn(), status: vi.fn() };
      setActivePluginRegistry(providerRegistry("live-plugin", "live-source", hooks));
      const store = new TranscriptsStore(path.join(state.stateDir, "transcripts"));
      const importedBefore = listImportedRuntimePluginIds();
      const discover = vi.spyOn(discovery, "discoverOpenClawPlugins").mockImplementation(() => {
        throw new Error("status must not discover plugins");
      });
      const resolve = vi.spyOn(loader, "resolveRuntimePluginRegistry").mockImplementation(() => {
        throw new Error("status must not resolve runtime");
      });
      const read = vi.spyOn(fs, "readFileSync");
      let result;
      try {
        result = await readMetadata(store, cfg, metadata);
        expect(
          read.mock.calls.some(([file]) =>
            metadata.plugins.some(
              (plugin) =>
                String(file) === plugin.manifestPath ||
                String(file).startsWith(`${plugin.rootDir}${path.sep}`),
            ),
          ),
        ).toBe(false);
      } finally {
        read.mockRestore();
        resolve.mockRestore();
        discover.mockRestore();
      }
      const providers = Object.fromEntries(result.providers.map((p) => [p.providerId, p]));
      expect(providers).toMatchObject({
        "declared-source": { availability: "enabled", ...descriptor },
        "disabled-source": { availability: "disabled" },
        absent: { availability: "unavailable" },
        "live-source": {
          sourceKinds: ["live-caption"],
          canStart: true,
          canStop: true,
          canImport: false,
        },
      });
      const declared = providers["declared-source"];
      expect(declared).not.toHaveProperty("canStart");
      expect(providers["disabled-source"]).not.toHaveProperty("autoStart");
      expect(providers["manual-transcript"]).not.toHaveProperty("autoStart");
      expect(result.configuredSources.map((source) => source.state)).toEqual([
        "not-active",
        "not-active",
      ]);
      for (const hook of Object.values(hooks)) {
        expect(hook).not.toHaveBeenCalled();
      }
      expect(listImportedRuntimePluginIds()).toEqual(importedBefore);
    });
  });

  it.each([false, true])(
    "bounds settings rows and treats scoped omissions as unknown (immutable=%s)",
    async (immutable) => {
      const store = createStore();
      const cfg: OpenClawConfig = {
        transcripts: {
          autoStart: Array.from({ length: 102 }, (_, index) => ({
            providerId: `missing-${index}`,
          })),
        },
      };
      const metadata = createPluginMetadataSnapshot({
        config: cfg,
        manifestRegistry: { plugins: [], diagnostics: [] },
      });
      const scoped = { ...metadata, pluginIds: ["limited-scope"] };
      // An agent-scoped metadata generation cannot establish Gateway-wide absence.
      const result = await withPluginMetadataSnapshotScope(
        scoped,
        () => readTranscriptLibraryStatus(store, cfg),
        { config: cfg, trustConfigIdentity: immutable },
      );
      expect(result.configuredSources).toHaveLength(100);
      expect(result.providers).toHaveLength(100);
      expect(result.omitted).toMatchObject({
        configuredSources: 2,
        providers: expect.any(Number),
      });
      expect(
        result.providers
          .filter((provider) => provider.providerId.startsWith("missing-"))
          .every((provider) => provider.availability === "unknown"),
      ).toBe(true);
      expect(result.latestTranscript).toBeNull();
    },
  );
});

it("keeps transcript provider health bound to its live Gateway registry", async () => {
  await withStatusState(async (state) => {
    const cfg: OpenClawConfig = {};
    const metadata = metadataFixture(cfg, { "request-plugin": "request-source" });
    const start = vi.fn();
    const unrelatedStart = vi.fn();
    const requestRegistry = providerRegistry("request-plugin", "request-source", { start });
    const unrelatedRegistry = providerRegistry("unrelated-plugin", "unrelated-source", {
      sourceKinds: ["live-audio"],
      start: unrelatedStart,
    });
    setActivePluginRegistry(requestRegistry);
    const requestOwner = createPluginRegistryOwner(requestRegistry);
    setActivePluginRegistry(unrelatedRegistry);
    try {
      const store = new TranscriptsStore(path.join(state.stateDir, "transcripts"));
      const importedBefore = listImportedRuntimePluginIds();
      const result = await withPluginRuntimeGatewayRequestScope(
        { pluginRegistry: requestOwner.registry, isWebchatConnect: () => false },
        () => readMetadata(store, cfg, metadata),
      );
      expect(result.providers.filter((provider) => provider.pluginId)).toMatchObject([
        {
          providerId: "request-source",
          sourceKinds: ["live-caption"],
          canStart: true,
        },
      ]);
      expect(start).not.toHaveBeenCalled();
      expect(unrelatedStart).not.toHaveBeenCalled();
      expect(listImportedRuntimePluginIds()).toEqual(importedBefore);
    } finally {
      await requestOwner.close();
    }
  });
});

describe("configured transcript cleanup custody", () => {
  const fixture = useTranscriptStatusFixture();
  it.each([
    { phase: "adoption", whenOccupied: false, fault: "thrown-stop" },
    { phase: "adoption", whenOccupied: false, fault: "summary-write" },
    { phase: "shutdown", whenOccupied: false, fault: "returned-stop" },
    { phase: "shutdown", whenOccupied: true, fault: "thrown-stop" },
    { phase: "shutdown", whenOccupied: false, fault: "session-write" },
    { phase: "shutdown", whenOccupied: true, fault: "summary-write" },
  ])(
    "retains and drains $fault cleanup after $phase (occupied=$whenOccupied)",
    async ({ phase, fault, whenOccupied }) => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const adoption = phase === "adoption";
      const check = adoption ? expect.soft : expect;
      const text = adoption ? "Admitted note" : "Before shutdown";
      const f = fixture({ transcripts: { autoStart: [{ ...room, whenOccupied }] } });
      const watches: TranscriptOccupancyWatchRequest[] = [];
      const unwatch = vi.fn();
      f.provider.watchOccupancy = async (request) => {
        watches.push(request);
        request.onOccupied();
        return { ok: true, value: { stop: unwatch } };
      };
      const gate = createDeferred();
      const started = createDeferred<TranscriptStartRequest>();
      const lateDrain = createDeferred();
      const conflict = createDeferred();
      f.ctx.logger.warn.mockImplementation((message: string) => {
        if (message.startsWith("transcripts autoStart session=")) {
          lateDrain.resolve();
        }
        if (message.startsWith("transcripts autoStart source 1: id-conflict.")) {
          conflict.resolve();
        }
      });
      const start = vi.fn(async (request: TranscriptStartRequest) => {
        await request.onUtterance({ text, ...(adoption ? { final: true } : {}) });
        started.resolve(request);
        if (!adoption) {
          await gate.promise;
          await request.onUtterance({ text: "After shutdown" });
        }
        return {
          ok: true as const,
          session: { ...request.session, title: adoption ? "Room title" : "Late title" },
        };
      });
      f.provider.start = start;
      let cleanupFails = true;
      vi.spyOn(f.provider, "stop").mockImplementation(async ({ sessionId }) => {
        if (cleanupFails && fault === "returned-stop") {
          return { ok: false, error: "cleanup unavailable" };
        }
        if (cleanupFails && fault === "thrown-stop") {
          throw new Error("cleanup unavailable");
        }
        return { ok: true, sessionId };
      });
      const originalWrite = f.store.writeSession.bind(f.store);
      let titleFailed = false;
      vi.spyOn(TranscriptsStore.prototype, "writeSession").mockImplementation(
        async (session, condition) => {
          if (adoption && session.title === "Room title" && !titleFailed) {
            titleFailed = true;
            throw new Error("title write unavailable");
          }
          if (cleanupFails && fault === "session-write" && session.stoppedAt) {
            throw new Error("final session unavailable");
          }
          return originalWrite(session, condition);
        },
      );
      const originalSummary = f.store.writeSummary.bind(f.store);
      vi.spyOn(TranscriptsStore.prototype, "writeSummary").mockImplementation(async (...args) => {
        if (fault === "summary-write" && cleanupFails) {
          throw new Error("summary write unavailable");
        }
        return originalSummary(...args);
      });
      const service = createTranscriptsAutoStartService(f.ctx);
      try {
        const startup = service.start().settled;
        const request = await started.promise;
        const session = request.session;
        if (adoption) {
          await startup;
          await vi.advanceTimersByTimeAsync(65_000);
          expect.soft(await f.store.listSessionEntries()).toHaveLength(1);
          expect
            .soft((await f.read()).configuredSources[0]?.startDiagnostic)
            .toBe("admitted-start-failed");
          await request.onUtterance({ text: "Late failed-start note", final: true });
        } else {
          const stopping = service.stop();
          await vi.advanceTimersByTimeAsync(5_000);
          await stopping;
          expect(f.ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining("stop timed out"));
          expect(unwatch).toHaveBeenCalledTimes(whenOccupied ? 1 : 0);
          expect(request.abortSignal?.aborted).toBe(true);
          gate.resolve();
          await lateDrain.promise;
        }
        check(start).toHaveBeenCalledOnce();
        const terminal = fault === "session-write" || fault === "summary-write";
        await expect(f.tool.execute("status", { action: "status" })).resolves.toMatchObject({
          details: {
            [terminal ? "pendingFinalization" : "active"]: [
              expect.objectContaining({ sessionId: session.sessionId }),
            ],
          },
        });
        const otherConfig = {
          transcripts: { autoStart: [{ ...room, sessionId: session.sessionId }] },
        };
        const other = createTranscriptsAutoStartService({ ...f.ctx, config: otherConfig });
        try {
          const otherStarting = other.start().settled;
          if (!adoption) {
            await conflict.promise;
          }
          await otherStarting;
          expect(
            (await readTranscriptLibraryStatus(f.store, otherConfig)).configuredSources[0]
              ?.startDiagnostic,
          ).toBe("id-conflict");
        } finally {
          await other.stop();
        }
        if (adoption) {
          await service.stop();
        }
        cleanupFails = false;
        await service.stop();
        check(activeSessions.has(session.sessionId)).toBe(false);
        const stored = (await f.store.readSession(session.sessionId))!;
        check(stored.stoppedAt).toEqual(expect.any(String));
        if (adoption) {
          expect.soft(stored).toMatchObject({
            sessionId: session.sessionId,
            startedAt: session.startedAt,
            title: "Room title",
          });
          expect.soft(stored.source).toEqual(session.source);
        }
        check(await f.store.readSummary(stored)).toMatchObject({
          summary: { transcript: [text] },
        });
        if (!adoption) {
          watches[0]?.onEmpty();
          watches[0]?.onOccupied();
          await request.onUtterance({ text: "Retired callback" });
          await request.onStatus?.({ active: false });
          await vi.advanceTimersByTimeAsync(65_000);
          expect(start).toHaveBeenCalledOnce();
          expect(await f.store.listSessionEntries()).toHaveLength(1);
          expect(await f.store.readUtterancesForSession(session)).toMatchObject([{ text }]);
          // The same raw ID on a later day belongs to a distinct lifecycle.
          vi.setSystemTime(new Date(Date.parse(session.startedAt) + 86_400_000));
          await f.start({ ...room, sessionId: session.sessionId });
          await service.stop();
          expect((await f.read()).active).toMatchObject([
            { sessionId: session.sessionId, activeSubscription: true },
          ]);
        }
      } finally {
        cleanupFails = false;
        gate.resolve();
        await service.stop();
        for (const [request] of start.mock.calls) {
          await f.tool.execute("cleanup", {
            action: "stop",
            ...(adoption
              ? { sessionId: request.session.sessionId }
              : { selector: transcriptSessionSelector(request.session) }),
          });
        }
      }
    },
  );
});
