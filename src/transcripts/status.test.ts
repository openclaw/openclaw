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
import { loadPluginManifestRegistryForInstalledIndex } from "../plugins/manifest-registry-installed.js";
import { restorePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  createPluginRegistryOwner,
  getActivePluginRegistry,
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
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createTranscriptsAutoStartService } from "./auto-start.js";
import { createTranscriptCaptureAppends } from "./capture-appends.js";
import { activeSessions } from "./capture-startup.js";
import type { TranscriptOccupancyWatchRequest, TranscriptStartRequest } from "./provider-types.js";
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

function createStore() {
  const stateDir = tempDirs.make("transcript-status-");
  return new TranscriptsStore(path.join(stateDir, "transcripts"), {
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });
}

describe("transcript library capture health", () => {
  it("uses the successful capture's requested alias even when its provider is absent from the active registry", async () => {
    const store = createStore();
    const source = { providerId: "caption-alias", channelId: "room" };
    const session = { sessionId: "alias-capture", startedAt: "2026-08-20T10:00:00.000Z", source };
    await store.writeSession(session);
    activeSessions.set(session.sessionId, {
      appends: createTranscriptCaptureAppends(() => {}),
      session,
      providerId: "canonical-captions",
      stopProvider: async () => {
        throw new Error("Reading transcript status must not stop capture");
      },
      releaseProvider: async () => {},
      phase: "active",
    });
    const result = await readTranscriptLibraryStatus(store, {
      transcripts: { autoStart: [source] },
    });
    expect(result.configuredSources[0]).toMatchObject({
      state: "armed",
      activeSelectors: [transcriptSessionSelector(session)],
    });
  });

  it("reports a durable source timestamp without inventing persistence time or recording from unstopped rows", async () => {
    const store = createStore();
    const source = {
      providerId: "fixture-voice",
      guildId: "guild",
      channelId: "room",
      accountId: "work",
    };
    const cfg: OpenClawConfig = { transcripts: { autoStart: [source] } };
    const session = { sessionId: "persistent-room", startedAt: "2026-08-20T10:00:00.000Z", source };
    await store.writeSession(session);
    await store.appendUtteranceForSession(session, {
      text: "Saved before restart",
      endedAt: "2026-08-20T10:10:00.000Z",
    });
    let result = await readTranscriptLibraryStatus(store, cfg);
    expect(result.active).toEqual([]);
    expect(result.configuredSources[0]?.state).not.toBe("armed");
    expect(result.latestTranscript).toMatchObject({
      lastUtteranceAt: "2026-08-20T10:10:00.000Z",
      activeSubscription: false,
    });
    activeSessions.set(session.sessionId, {
      appends: createTranscriptCaptureAppends(() => {}),
      session,
      providerId: source.providerId,
      phase: "active",
      stopProvider: async () => {
        throw new Error("Reading transcript status must not stop capture");
      },
      releaseProvider: async () => {},
    });
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
    expect(
      (
        await readTranscriptLibraryStatus(store, {
          transcripts: { enabled: false, autoStart: [source] },
        })
      ).configuredSources[0]?.state,
    ).toBe("disabled");
  });

  it("reads declared, disabled and unavailable providers from prepared metadata without calling provider runtime", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg: OpenClawConfig = {
        transcripts: { autoStart: [{ providerId: "absent" }, { providerId: "disabled-source" }] },
      };
      const manifests = makeRegistry([
        { id: "fixture-plugin", channels: [] },
        { id: "disabled-plugin", channels: [] },
      ]);
      manifests.plugins[0]!.contracts = { transcriptSourceProviders: ["declared-source"] };
      manifests.plugins[1]!.contracts = { transcriptSourceProviders: ["disabled-source"] };
      const metadata = createPluginMetadataSnapshot({ config: cfg, manifestRegistry: manifests });
      metadata.index = {
        ...metadata.index,
        plugins: manifests.plugins.map((plugin) => ({
          pluginId: plugin.id,
          manifestPath: plugin.manifestPath,
          manifestHash: "fixture",
          rootDir: plugin.rootDir,
          origin: plugin.origin,
          enabled: plugin.id !== "disabled-plugin",
          startup: { sidecar: false, memory: false, agentHarnesses: [] },
          compat: [],
        })),
      };
      const previous = captureActivePluginRegistrySnapshot();
      const registry = createEmptyPluginRegistry();
      const start = vi.fn();
      const stop = vi.fn();
      const status = vi.fn();
      registry.plugins.push(createPluginRecord({ id: "live-plugin" }));
      registry.transcriptSourceProviders.push({
        pluginId: "live-plugin",
        source: "fixture",
        provider: {
          id: "live-source",
          name: "Fixture source",
          sourceKinds: ["live-caption"],
          start,
          stop,
          status,
        },
      });
      setActivePluginRegistry(registry);
      try {
        const store = new TranscriptsStore(path.join(state.stateDir, "transcripts"));
        const importedBefore = listImportedRuntimePluginIds();
        const result = await withPluginMetadataSnapshotScope(
          metadata,
          () => readTranscriptLibraryStatus(store, cfg),
          { config: cfg },
        );
        expect(result.providers).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ providerId: "declared-source", availability: "enabled" }),
            expect.objectContaining({ providerId: "disabled-source", availability: "disabled" }),
            expect.objectContaining({ providerId: "absent", availability: "unavailable" }),
            expect.objectContaining({
              providerId: "live-source",
              sourceKinds: ["live-caption"],
              canStart: true,
              canStop: true,
              canImport: false,
            }),
          ]),
        );
        expect(
          result.providers.find((provider) => provider.providerId === "declared-source"),
        ).not.toHaveProperty("canStart");
        expect(
          result.providers.find((provider) => provider.providerId === "declared-source"),
        ).not.toHaveProperty("autoStart");
        expect(
          result.providers.find((provider) => provider.providerId === "manual-transcript"),
        ).not.toHaveProperty("autoStart");
        expect(result.configuredSources.map((source) => source.state)).toEqual([
          "not-active",
          "not-active",
        ]);
        expect(start).not.toHaveBeenCalled();
        expect(stop).not.toHaveBeenCalled();
        expect(status).not.toHaveBeenCalled();
        expect(listImportedRuntimePluginIds()).toEqual(importedBefore);
      } finally {
        restoreActivePluginRegistrySnapshot(previous);
      }
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
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg: OpenClawConfig = {};
    const manifests = makeRegistry([{ id: "request-plugin", channels: [] }]);
    manifests.plugins[0]!.contracts = { transcriptSourceProviders: ["request-source"] };
    const metadata = createPluginMetadataSnapshot({ config: cfg, manifestRegistry: manifests });
    const previous = captureActivePluginRegistrySnapshot();
    const requestRegistry = createEmptyPluginRegistry();
    const unrelatedRegistry = createEmptyPluginRegistry();
    const start = vi.fn();
    const unrelatedStart = vi.fn();
    requestRegistry.plugins.push(createPluginRecord({ id: "request-plugin" }));
    unrelatedRegistry.plugins.push(createPluginRecord({ id: "unrelated-plugin" }));
    requestRegistry.transcriptSourceProviders.push({
      pluginId: "request-plugin",
      source: "fixture",
      provider: {
        id: "request-source",
        name: "Request source",
        sourceKinds: ["live-caption"],
        start,
      },
    });
    unrelatedRegistry.transcriptSourceProviders.push({
      pluginId: "unrelated-plugin",
      source: "fixture",
      provider: {
        id: "unrelated-source",
        name: "Unrelated source",
        sourceKinds: ["live-audio"],
        start: unrelatedStart,
      },
    });
    setActivePluginRegistry(requestRegistry);
    const requestOwner = createPluginRegistryOwner(requestRegistry);
    setActivePluginRegistry(unrelatedRegistry);
    const failures: unknown[] = [];
    try {
      const store = new TranscriptsStore(path.join(state.stateDir, "transcripts"));
      const importedBefore = listImportedRuntimePluginIds();
      const result = await withPluginMetadataSnapshotScope(
        metadata,
        () =>
          withPluginRuntimeGatewayRequestScope(
            { pluginRegistry: requestOwner.registry, isWebchatConnect: () => false },
            () => readTranscriptLibraryStatus(store, cfg),
          ),
        { config: cfg },
      );
      expect(result.providers.filter((provider) => provider.pluginId)).toMatchObject([
        {
          providerId: "request-source",
          pluginId: "request-plugin",
          availability: "enabled",
          sourceKinds: ["live-caption"],
          canStart: true,
          canStop: false,
          canImport: false,
        },
      ]);
      expect(start).not.toHaveBeenCalled();
      expect(unrelatedStart).not.toHaveBeenCalled();
      expect(listImportedRuntimePluginIds()).toEqual(importedBefore);
    } catch (error) {
      failures.push(error);
    } finally {
      const results = await Promise.allSettled([requestOwner.close()]);
      restoreActivePluginRegistrySnapshot(previous);
      failures.push(
        ...results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
      );
    }
    if (failures.length) {
      throw new AggregateError(failures, "Transcript status assertion or registry cleanup failed");
    }
  });
});

describe("transcript setup metadata boundary", () => {
  it("offers a cold manifest source before and after a provider-only scoped registration without discovering runtime in status", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const pluginId = "fixture-captions";
      const providerId = "fixture-caption-source";
      const rootDir = state.statePath("fixture-plugin");
      const source = await state.writeText(
        "fixture-plugin/index.cjs",
        `module.exports = {
        id: "fixture-captions", register(api) {
          api.registerTranscriptSourceProvider({ id: "fixture-caption-source", name: "Runtime captions", sourceKinds: ["live-caption"],
            async start() { throw new Error("status must not start capture"); }
          });
        }
      };`,
      );
      const descriptor = {
        name: "Fixture captions",
        autoStart: { accountId: "optional", meetingUrl: "required" },
      };
      const manifestPath = await state.writeJson("fixture-plugin/openclaw.plugin.json", {
        id: pluginId,
        configSchema: { type: "object", additionalProperties: false, properties: {} },
        contracts: { transcriptSourceProviders: [providerId] },
        transcriptSources: { [providerId]: descriptor },
      });
      const cfg: OpenClawConfig = {
        plugins: {
          allow: [pluginId],
          entries: { [pluginId]: { enabled: true } },
          load: { paths: [rootDir] },
          slots: { memory: "none" },
        },
      };
      const initial = createPluginMetadataSnapshot({
        config: cfg,
        manifestRegistry: { plugins: [], diagnostics: [] },
      });
      initial.index.plugins = [
        {
          pluginId,
          source,
          manifestPath,
          rootDir,
          manifestHash: "fixture",
          origin: "config",
          enabled: true,
          startup: { sidecar: false, memory: false, agentHarnesses: [] },
          compat: [],
        },
      ];
      const manifestRegistry = loadPluginManifestRegistryForInstalledIndex({
        index: initial.index,
        config: cfg,
        env: state.env,
      });
      const metadata = restorePluginMetadataSnapshot({
        ...initial,
        manifestRegistry,
        plugins: manifestRegistry.plugins,
        byPluginId: new Map(manifestRegistry.plugins.map((plugin) => [plugin.id, plugin])),
      });
      const previous = captureActivePluginRegistrySnapshot();
      const active = createEmptyPluginRegistry();
      setActivePluginRegistry(active);
      const store = new TranscriptsStore(state.statePath("transcripts"));
      const readStatus = async () => {
        const discover = vi.spyOn(discovery, "discoverOpenClawPlugins").mockImplementation(() => {
          throw new Error("status must not discover plugins");
        });
        const resolve = vi.spyOn(loader, "resolveRuntimePluginRegistry").mockImplementation(() => {
          throw new Error("status must not resolve runtime");
        });
        const read = vi.spyOn(fs, "readFileSync");
        try {
          const result = await withPluginMetadataSnapshotScope(
            metadata,
            () => readTranscriptLibraryStatus(store, cfg),
            { config: cfg },
          );
          expect(discover).not.toHaveBeenCalled();
          expect(resolve).not.toHaveBeenCalled();
          expect(
            read.mock.calls.some(
              ([file]) => String(file) === manifestPath || String(file) === source,
            ),
          ).toBe(false);
          return result;
        } finally {
          read.mockRestore();
          resolve.mockRestore();
          discover.mockRestore();
        }
      };
      try {
        const before = await readStatus();
        const scoped = loader.loadPluginRegistryHandle({
          config: cfg,
          env: state.env,
          onlyPluginIds: [pluginId],
          manifestRegistry,
          discovery: {
            candidates: [{ idHint: pluginId, source, rootDir, origin: "config" }],
            diagnostics: [],
          },
          cache: false,
        });
        expect(scoped.transcriptSourceProviders.map((entry) => entry.provider.id)).toEqual([
          providerId,
        ]);
        expect(getActivePluginRegistry()).toBe(active);
        expect(active.transcriptSourceProviders).toEqual([]);
        const after = await readStatus();
        for (const result of [before, after]) {
          expect(result.providers.find((provider) => provider.providerId === providerId)).toEqual({
            providerId,
            pluginId,
            name: descriptor.name,
            availability: "enabled",
            autoStart: descriptor.autoStart,
          });
        }
      } finally {
        restoreActivePluginRegistrySnapshot(previous);
      }
    });
  });
});

describe("configured transcript shutdown cleanup", () => {
  const fixture = useTranscriptStatusFixture();
  it.each([
    { whenOccupied: false, fault: "returned-stop" },
    { whenOccupied: true, fault: "thrown-stop" },
    { whenOccupied: false, fault: "session-write" },
    { whenOccupied: true, fault: "summary-write" },
  ])(
    "retains and drains late $fault after shutdown (occupied=$whenOccupied)",
    async ({ whenOccupied, fault }) => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
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
        await request.onUtterance({ text: "Before shutdown" });
        // Shutdown starts only after the pre-shutdown note is durably recorded.
        started.resolve(request);
        await gate.promise;
        await request.onUtterance({ text: "After shutdown" });
        return { ok: true as const, session: { ...request.session, title: "Late title" } };
      });
      f.provider.start = start;
      let cleanupFails = true;
      const stop = vi.spyOn(f.provider, "stop").mockImplementation(async ({ sessionId }) => {
        if (cleanupFails && fault === "returned-stop") {
          return { ok: false, error: "cleanup unavailable" };
        }
        if (cleanupFails && fault === "thrown-stop") {
          throw new Error("cleanup unavailable");
        }
        return { ok: true, sessionId };
      });
      const writeSession = f.store.writeSession.bind(f.store);
      vi.spyOn(TranscriptsStore.prototype, "writeSession").mockImplementation(
        async (session, condition) => {
          if (cleanupFails && fault === "session-write" && session.stoppedAt) {
            throw new Error("final session unavailable");
          }
          await writeSession(session, condition);
        },
      );
      const writeSummary = f.store.writeSummary.bind(f.store);
      vi.spyOn(TranscriptsStore.prototype, "writeSummary").mockImplementation(async (...args) => {
        if (cleanupFails && fault === "summary-write") {
          throw new Error("summary unavailable");
        }
        return writeSummary(...args);
      });
      const service = createTranscriptsAutoStartService(f.ctx);
      try {
        service.start();
        const request = await started.promise;
        expect(start).toHaveBeenCalledOnce();
        const session = request.session;
        const stopping = service.stop();
        await vi.advanceTimersByTimeAsync(5_000);
        await stopping;
        expect(f.ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining("stop timed out"));
        expect(unwatch).toHaveBeenCalledTimes(whenOccupied ? 1 : 0);
        expect(request.abortSignal?.aborted).toBe(true);
        gate.resolve();
        // A failed late drain must be visible and still owned after startup settles.
        await lateDrain.promise;
        expect(f.ctx.logger.warn).toHaveBeenCalledWith(
          expect.stringContaining("transcripts autoStart session="),
        );
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
          other.start();
          await conflict.promise;
          expect(
            (await readTranscriptLibraryStatus(f.store, otherConfig)).configuredSources[0]
              ?.startDiagnostic,
          ).toBe("id-conflict");
        } finally {
          await other.stop();
        }
        expect(stop).toHaveBeenCalledTimes(terminal ? 1 : 2);
        cleanupFails = false;
        await service.stop();
        expect(stop).toHaveBeenCalledTimes(terminal ? 1 : 3);
        expect(activeSessions.has(session.sessionId)).toBe(false);
        expect((await f.store.readSession(session.sessionId))?.stoppedAt).toEqual(
          expect.any(String),
        );
        expect(await f.store.readSummary(session)).toMatchObject({
          summary: { transcript: ["Before shutdown"] },
        });
        watches[0]?.onEmpty();
        watches[0]?.onOccupied();
        await request.onUtterance({ text: "Retired callback" });
        await request.onStatus?.({ active: false });
        await vi.advanceTimersByTimeAsync(65_000);
        expect(start).toHaveBeenCalledOnce();
        expect(await f.store.listSessionEntries()).toHaveLength(1);
        expect(await f.store.readUtterancesForSession(session)).toMatchObject([
          { text: "Before shutdown" },
        ]);
        // Even the same raw ID on a later day belongs to a distinct lifecycle.
        vi.setSystemTime(new Date(Date.parse(session.startedAt) + 86_400_000));
        await f.start({ ...room, sessionId: session.sessionId });
        await service.stop();
        expect(stop).toHaveBeenCalledTimes(terminal ? 1 : 3);
        expect((await f.read()).active).toMatchObject([
          { sessionId: session.sessionId, activeSubscription: true },
        ]);
      } finally {
        cleanupFails = false;
        gate.resolve();
        await service.stop();
        for (const [request] of start.mock.calls) {
          await f.tool.execute("cleanup", {
            action: "stop",
            selector: transcriptSessionSelector(request.session),
          });
        }
      }
    },
  );
});
