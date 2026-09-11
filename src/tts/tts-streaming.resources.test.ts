import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { acquirePluginRegistryForInspection, loadPluginRegistryHandle } from "../plugins/loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withEnvAsync } from "../test-utils/env.js";
import { textToSpeechStream } from "./tts-streaming.js";

const pcm = new Uint8Array([0, 0, 32, 0]);

function createFixture(
  options: {
    id?: string;
    explicitRelease?: boolean;
    ending?: "eof" | "error" | "blocked";
    initialState?: "empty" | "error" | "chunk";
    projectionFailure?: "result" | "config-model" | "config-voice" | "audioStream" | "release";
    holdRelease?: boolean;
    invalidMetadata?: boolean;
    releaseFailure?: boolean;
  } = {},
) {
  const id = options.id ?? "native-stream";
  const dir = makePluginLoaderTempDir();
  const key = `__speech_stream_${path.basename(dir)}`;
  const context = new AsyncLocalStorage<string>();
  const started = createDeferredCore();
  const aborted = createDeferredCore();
  const tail = createDeferredCore();
  const released = createDeferredCore();
  const releaseResume = createDeferredCore();
  if (!options.holdRelease) {
    releaseResume.resolve();
  }
  const connections: Array<{ database: DatabaseSync; file: string; disposals: number }> = [];
  const events: Array<{ phase: string; context: string | undefined }> = [];
  const work: Promise<void>[] = [];
  const state = {
    dir,
    options,
    pcm,
    context,
    started,
    aborted,
    tail,
    released,
    releaseResume,
    connections,
    events,
    work,
    trackAsyncWork,
    calls: 0,
  };
  Object.defineProperty(globalThis, key, { configurable: true, value: state });
  const plugin = writePlugin({
    dir,
    id,
    body: `const { DatabaseSync } = require("node:sqlite");
module.exports = { id: ${JSON.stringify(id)}, register(api) {
  const state = globalThis[${JSON.stringify(key)}];
  const file = require("node:path").join(state.dir, "stream-" + state.connections.length + ".sqlite");
  const database = new DatabaseSync(file);
  database.exec("CREATE TABLE fixture(value INTEGER); INSERT INTO fixture VALUES(42)");
  const connection = { database, file, disposals: 0 }; state.connections.push(connection);
  const record = (phase) => { database.prepare("SELECT value FROM fixture").get(); state.events.push({phase, context: state.context.getStore()}); };
  api.lifecycle.registerRuntimeLifecycle({ id: "stream-db", dispose() { record("dispose"); connection.disposals++; database.close(); } });
  api.registerSpeechProvider({ id: ${JSON.stringify(id)}, label: "Native stream", autoSelectOrder: 10,
    resolveConfig() { record("config"); return { model: "native-model", voiceId: "native-voice" }; },
    isConfigured() { record("configured"); return true; },
    async synthesize() { throw new Error("Unexpected buffered speech"); },
    async streamSynthesize(request) {
      state.calls++; record("synthesis");
      let index = 0;
      let canceled = false;
      const audioStream = new ReadableStream({
        start(controller) {
          if (state.options.initialState === "error") controller.error(new Error("native initial failure"));
          else if (state.options.initialState) { if (state.options.initialState === "chunk") controller.enqueue(state.pcm); controller.close(); }
        },
        async pull(controller) {
          record("pull"); state.started.resolve();
          if (state.options.ending === "blocked") {
            const pending = state.trackAsyncWork(async () => { await state.aborted.promise; await state.tail.promise; record("tail"); });
            state.work.push(pending); await pending; if (!canceled) controller.close(); return;
          }
          if (index++ === 0) { controller.enqueue(state.pcm); return; }
          if (state.options.ending === "error") { controller.error(new Error("native read failure")); return; }
          controller.close();
        },
        async cancel() { canceled = true; record("cancel"); if (state.options.explicitRelease === false || state.options.projectionFailure === "release") state.aborted.resolve(); await state.aborted.promise; }
      }, { highWaterMark: 0 });
      let cleanup;
      const release = () => cleanup ??= (async () => {
        record("release"); state.released.resolve(); state.aborted.resolve();
        await state.releaseResume.promise; record("released"); if (state.options.releaseFailure) throw new Error("native cleanup failure");
      })();
      if (state.options.projectionFailure?.startsWith("config-")) {
        Object.defineProperty(request.providerConfig, state.options.projectionFailure === "config-model" ? "modelId" : "speakerVoiceId", { get() { throw new Error("native config projection failure"); } });
      }
      if (["audioStream", "release"].includes(state.options.projectionFailure)) {
        state.work.push(state.trackAsyncWork(async () => { await state.aborted.promise; record("capture-tail"); }));
        state.started.resolve();
      }
      return {
        get audioStream() { if (state.options.projectionFailure === "audioStream") throw new Error("native audioStream projection failure"); return audioStream; },
        get outputFormat() { record("metadata"); if (state.options.projectionFailure === "result") throw new Error("native result projection failure"); return "pcm"; },
        fileExtension: state.options.invalidMetadata ? "" : ".pcm", voiceCompatible: false,
        get release() { if (state.options.projectionFailure === "release") throw new Error("native release projection failure"); return state.options.explicitRelease === false ? undefined : release; },
      };
    }
  });
} };`,
  });
  fs.writeFileSync(
    path.join(dir, "openclaw.plugin.json"),
    JSON.stringify({
      id,
      contracts: { speechProviders: [id] },
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
  );
  const cfg: OpenClawConfig = {
    plugins: { allow: [id], load: { paths: [plugin.file] }, slots: { memory: "none" } },
    tts: { provider: id, providers: { [id]: {} } },
  };
  const prefsPath = path.join(dir, "prefs.json");
  fs.writeFileSync(prefsPath, "{}");
  const run = () =>
    context.run("source", () => textToSpeechStream({ text: "**native speech**", cfg, prefsPath }));
  return {
    id,
    cfg,
    prefsPath,
    plugin,
    state,
    run,
    withEnvironment: (operation: () => Promise<void>) =>
      withEnvAsync(
        {
          OPENCLAW_HOME: dir,
          OPENCLAW_STATE_DIR: dir,
          OPENCLAW_CONFIG_PATH: path.join(dir, "config.json"),
        },
        async () => {
          useNoBundledPlugins();
          await operation();
        },
      ),
    async cleanup() {
      aborted.resolve();
      tail.resolve();
      releaseResume.resolve();
      await Promise.allSettled(work);
      for (const { database } of connections) {
        if (database.isOpen) {
          database.close();
        }
      }
      Reflect.deleteProperty(globalThis, key);
    },
  };
}

function expectClosed(fixture: ReturnType<typeof createFixture>) {
  expect(fixture.state.connections.length).toBeGreaterThan(0);
  for (const entry of fixture.state.connections) {
    expect(entry.database.isOpen).toBe(false);
    expect(entry.disposals).toBe(1);
    const database = new DatabaseSync(entry.file, { readOnly: true });
    try {
      expect(database.prepare("SELECT value FROM fixture").get()?.value).toBe(42);
    } finally {
      database.close();
    }
  }
}

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
});
afterAll(cleanupPluginLoaderFixturesForTest);

describe("streaming speech registration ownership", () => {
  it.each(["eof", "error"] as const)(
    "keeps explicit cleanup after %s and closes on release",
    async (ending) => {
      const fixture = createFixture({ ending });
      try {
        await fixture.withEnvironment(async () => {
          const result = await fixture.run();
          expect(result.success).toBe(true);
          const reader = result.audioStream!.getReader();
          try {
            expect((await reader.read()).value).toEqual(pcm);
            if (ending === "error") {
              await expect(reader.read()).rejects.toThrow("native read failure");
            } else {
              expect((await reader.read()).done).toBe(true);
            }
            expect(fixture.state.events.some((event) => event.phase === "release")).toBe(false);
            expect(fixture.state.connections.every((entry) => entry.database.isOpen)).toBe(true);
            await result.release?.();
            await result.release?.();
            expect(fixture.state.events.filter((event) => event.phase === "release").length).toBe(
              1,
            );
            expectClosed(fixture);
          } finally {
            reader.releaseLock();
            await result.release?.();
          }
        });
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it.each(["eof", "error"] as const)(
    "releases a provider with no release callback after %s",
    async (ending) => {
      const fixture = createFixture({ ending, explicitRelease: false });
      try {
        await fixture.withEnvironment(async () => {
          const result = await fixture.run();
          const reader = result.audioStream!.getReader();
          try {
            expect((await reader.read()).value).toEqual(pcm);
            if (ending === "error") {
              await expect(reader.read()).rejects.toThrow("native read failure");
            } else {
              expect((await reader.read()).done).toBe(true);
            }
            expectClosed(fixture);
          } finally {
            reader.releaseLock();
            await result.release?.();
          }
        });
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it("releases an unopened stream without requiring a reader", async () => {
    const fixture = createFixture();
    try {
      await fixture.withEnvironment(async () => {
        const result = await fixture.run();
        await result.release?.();
        expect(fixture.state.events.some((event) => event.phase === "pull")).toBe(false);
        expectClosed(fixture);
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it.each(["managed", "raw"] as const)(
    "preserves %s registration custody after stream handoff",
    async (kind) => {
      const fixture = createFixture();
      try {
        await fixture.withEnvironment(async () => {
          const inspection =
            kind === "managed"
              ? await acquirePluginRegistryForInspection({ config: fixture.cfg })
              : undefined;
          const registry =
            inspection?.registry ?? loadPluginRegistryHandle({ config: fixture.cfg });
          const result = await withPluginRuntimeRegistryScope(registry, fixture.run);
          await inspection?.release();
          const reader = result.audioStream!.getReader();
          try {
            expect((await reader.read()).value).toEqual(pcm);
            expect((await reader.read()).done).toBe(true);
            await result.release?.();
            if (kind === "managed") {
              expectClosed(fixture);
            } else {
              expect(fixture.state.connections.every((entry) => entry.database.isOpen)).toBe(true);
              expect(fixture.state.connections.every((entry) => entry.disposals === 0)).toBe(true);
            }
          } finally {
            reader.releaseLock();
            await result.release?.();
          }
        });
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it.each(["release", "cancel"] as const)(
    "%s aborts before joining the blocked pull and retains its actual tail/context",
    async (method) => {
      const fixture = createFixture({ ending: "blocked" });
      try {
        await fixture.withEnvironment(async () => {
          const result = await fixture.run();
          const reader = result.audioStream!.getReader();
          const read = reader.read();
          await fixture.state.started.promise;
          let settled = false;
          const closing = fixture.state.context
            .run("foreign", () => (method === "cancel" ? reader.cancel("stop") : result.release!()))
            .then(() => {
              settled = true;
            });
          try {
            await nextTurn();
            expect(fixture.state.events.some((event) => event.phase === "release")).toBe(true);
            expect(settled).toBe(false);
            expect(fixture.state.connections.every((entry) => entry.database.isOpen)).toBe(true);
            fixture.state.tail.resolve();
            await closing;
            await read;
            expect(
              fixture.state.events
                .filter((event) => ["cancel", "release", "tail"].includes(event.phase))
                .every((event) => event.context === "source"),
            ).toBe(true);
            expectClosed(fixture);
          } finally {
            fixture.state.aborted.resolve();
            fixture.state.tail.resolve();
            await closing;
            await read;
            reader.releaseLock();
            await result.release?.();
          }
        });
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it.each(["result", "config-model", "config-voice"] as const)(
    "closes a stream when %s metadata projection fails before fallback",
    async (projectionFailure) => {
      const primary = createFixture({ id: "primary-stream", projectionFailure, holdRelease: true });
      const fallback = createFixture({ id: "fallback-stream" });
      try {
        await primary.withEnvironment(async () => {
          const cfg: OpenClawConfig = {
            ...primary.cfg,
            plugins: {
              allow: [primary.id, fallback.id],
              load: { paths: [primary.plugin.file, fallback.plugin.file] },
              slots: { memory: "none" },
            },
            tts: { provider: primary.id, providers: { [primary.id]: {}, [fallback.id]: {} } },
          };
          const pending = textToSpeechStream({
            text: "projection fallback",
            cfg,
            prefsPath: primary.prefsPath,
          });
          try {
            await Promise.race([
              primary.state.released.promise,
              pending.then(() => {
                throw new Error("Fallback returned before failed stream cleanup");
              }),
            ]);
            expect(fallback.state.calls).toBe(0);
            primary.state.releaseResume.resolve();
            const result = await pending;
            expect(result.success).toBe(true);
            expect(result.provider).toBe(fallback.id);
            expect(primary.state.events.some((event) => event.phase === "released")).toBe(true);
            await result.release?.();
            expectClosed(primary);
            expectClosed(fallback);
          } finally {
            primary.state.releaseResume.resolve();
            const result = await pending;
            await result.release?.();
          }
        });
      } finally {
        await primary.cleanup();
        await fallback.cleanup();
      }
    },
  );
  it("releases a successful provider result rejected by the public metadata guard", async () => {
    const fixture = createFixture({ invalidMetadata: true });
    try {
      await fixture.withEnvironment(async () => {
        const result = await fixture.run();
        expect(result.success).toBe(false);
        expect(result.error).toBe("Streaming TTS conversion failed");
        expect(fixture.state.events.filter((event) => event.phase === "release").length).toBe(1);
        expectClosed(fixture);
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps a post-byte stream failure with the selected provider", async () => {
    const primary = createFixture({ id: "primary-stream", ending: "error" });
    const fallback = createFixture({ id: "fallback-stream" });
    try {
      await primary.withEnvironment(async () => {
        const cfg: OpenClawConfig = {
          ...primary.cfg,
          plugins: {
            allow: [primary.id, fallback.id],
            load: { paths: [primary.plugin.file, fallback.plugin.file] },
            slots: { memory: "none" },
          },
          tts: { provider: primary.id, providers: { [primary.id]: {}, [fallback.id]: {} } },
        };
        const result = await textToSpeechStream({
          text: "partial failure",
          cfg,
          prefsPath: primary.prefsPath,
        });
        const reader = result.audioStream!.getReader();
        try {
          expect((await reader.read()).value).toEqual(pcm);
          await expect(reader.read()).rejects.toThrow("native read failure");
          expect(fallback.state.calls).toBe(0);
        } finally {
          reader.releaseLock();
          await result.release?.();
        }
      });
    } finally {
      await primary.cleanup();
      await fallback.cleanup();
    }
  });

  it("preserves the projection error when its stream cleanup also fails", async () => {
    const fixture = createFixture({ projectionFailure: "result", releaseFailure: true });
    try {
      await fixture.withEnvironment(async () => {
        const result = await fixture.run();
        expect(result.success).toBe(false);
        expect(result.error).toContain("native result projection failure");
        expect(result.error).not.toContain("native cleanup failure");
        expectClosed(fixture);
      });
    } finally {
      await fixture.cleanup();
    }
  });
  it.each([
    { projectionFailure: "audioStream", releaseFailure: false },
    { projectionFailure: "audioStream", releaseFailure: true },
    { projectionFailure: "release", releaseFailure: false },
  ] as const)(
    "uses the other cleanup field when $projectionFailure fails (cleanup rejects: $releaseFailure)",
    async ({ projectionFailure, releaseFailure }) => {
      const fixture = createFixture({ projectionFailure, releaseFailure });
      try {
        await fixture.withEnvironment(async () => {
          const pending = fixture.run();
          try {
            await fixture.state.started.promise;
            await nextTurn();
            expect(
              fixture.state.events.some(
                (event) =>
                  event.phase === (projectionFailure === "audioStream" ? "release" : "cancel"),
              ),
            ).toBe(true);
            const result = await pending;
            expect(result.success).toBe(false);
            expect(result.error).toContain(`native ${projectionFailure} projection failure`);
            expect(fixture.state.events.some((event) => event.phase === "capture-tail")).toBe(true);
            expectClosed(fixture);
          } finally {
            fixture.state.aborted.resolve();
            await pending;
          }
        });
      } finally {
        await fixture.cleanup();
      }
    },
  );
  it.each(["empty", "error", "chunk"] as const)(
    "finishes a no-release source in initial state %s without an extra EOF read",
    async (initialState) => {
      const fixture = createFixture({ explicitRelease: false, initialState });
      try {
        await fixture.withEnvironment(async () => {
          const result = await fixture.run();
          const reader = result.audioStream!.getReader();
          let closed = false;
          void reader.closed.then(
            () => {
              closed = true;
            },
            () => {
              closed = true;
            },
          );
          try {
            if (initialState === "chunk") {
              expect((await reader.read()).value).toEqual(pcm);
            }
            await nextTurn();
            expect(closed).toBe(true);
            expectClosed(fixture);
            if (initialState === "error") {
              await expect(reader.read()).rejects.toThrow("native initial failure");
            } else {
              expect((await reader.read()).done).toBe(true);
            }
          } finally {
            reader.releaseLock();
            await result.release?.();
          }
        });
      } finally {
        await fixture.cleanup();
      }
    },
  );
});
