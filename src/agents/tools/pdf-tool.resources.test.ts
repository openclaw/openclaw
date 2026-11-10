import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getModelLlmRuntime } from "../../llm/model-runtime-binding.js";
import * as llmStream from "../../llm/stream.js";
import type { Model } from "../../llm/types.js";
import { createAssistantMessageEventStream } from "../../llm/utils/event-stream.js";
import * as webMedia from "../../media/web-media.js";
import { writeFixtureJson } from "../../plugins/loader-fixture-builders.test-support.js";
import { loadPluginRegistryHandle } from "../../plugins/loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "../../plugins/loader.test-fixtures.js";
import {
  cleanupNativeFixture,
  nativeFixtureEnv,
} from "../../plugins/native-resource.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import {
  getPluginRuntimeGenerationRegistry,
  withPluginRuntimeGenerationScope,
} from "../../plugins/runtime/generation-scope.js";
import { AsyncWorkScope, trackAsyncWork } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { getSessionMcpRequestSignal } from "../agent-bundle-mcp-request-context.js";
import { makeModel } from "../embedded-agent-runner/model.test-harness.js";
import * as modelAuth from "../model-auth.js";
import * as preparedRuntime from "../prepared-model-runtime.js";
import { closePreparedModelRuntimeSnapshots } from "../prepared-model-runtime.lifecycle.js";
import { closeEphemeralPreparedModelRuntimeResources } from "../prepared-model-runtime.resources.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { FAKE_PDF_MEDIA, requirePdfTool, stubPdfInput } from "./pdf-tool.test-support.js";

type Connection = {
  dbPath: string;
  database: DatabaseSync;
  disposals: number;
  lateReads: number;
  cleanupReads: number;
};

function nativePdfFixture(api: "openai-responses" | "openai-completions" = "openai-responses") {
  const dir = makePluginLoaderTempDir();
  const id = "pdf-resource-fixture";
  const stateKey = `__pdf_resources_${path.basename(dir)}`;
  const connections: Connection[] = [];
  const cancellation: {
    signal?: AbortSignal;
    cleanupSignal?: AbortSignal;
    registry?: PluginRegistry;
    afterRegistry?: PluginRegistry;
    failure?: unknown;
  } = {};
  const state = {
    connections,
    started: createDeferredCore(),
    finish: createDeferredCore(),
    settled: createDeferredCore(),
    cleanupStarted: createDeferredCore(),
    finishCleanup: createDeferredCore(),
    holdCreation: true,
    reject: false,
    watchCancellation: false,
    cancellation,
    async stream(model: Model, read: () => number, connection: Connection) {
      read();
      if (state.watchCancellation) {
        const signal = (cancellation.signal = getSessionMcpRequestSignal());
        const cancel = () => {
          cancellation.cleanupSignal = getSessionMcpRequestSignal();
          cancellation.registry = getPluginRuntimeGenerationRegistry();
          void trackAsyncWork(async () => {
            state.cleanupStarted.resolve();
            await state.finishCleanup.promise;
            read();
            connection.cleanupReads++;
            cancellation.afterRegistry = getPluginRuntimeGenerationRegistry();
          }).catch((error: unknown) => {
            cancellation.failure = error;
          });
        };
        signal?.addEventListener("abort", cancel, { once: true });
        if (signal?.aborted) {
          cancel();
        }
      }
      const stream = createAssistantMessageEventStream();
      const produce = async () => {
        state.started.resolve();
        try {
          await state.finish.promise;
          const value = read();
          connection.lateReads++;
          if (state.reject) {
            throw new Error("synthetic late PDF failure");
          }
          stream.push({
            type: "done",
            reason: "stop",
            message: makeAssistantMessageFixture({
              content: [{ type: "text", text: `PDF value ${value}` }],
              api: model.api,
              provider: model.provider,
              model: model.id,
              stopReason: "stop",
              errorMessage: undefined,
            }),
          });
          stream.end();
        } finally {
          state.settled.resolve();
        }
      };
      if (state.holdCreation) {
        await produce();
      } else {
        void produce().catch((error: unknown) => {
          cancellation.failure = error;
          stream.end();
        });
      }
      return stream;
    },
    databasePath: () => path.join(dir, `provider-${connections.length}.sqlite`),
  };
  Object.defineProperty(globalThis, stateKey, { configurable: true, value: state });
  const plugin = writePlugin({
    dir,
    id,
    body: `const { DatabaseSync } = require("node:sqlite");
module.exports = { id: ${JSON.stringify(id)}, register(api) {
  const state = globalThis[${JSON.stringify(stateKey)}];
  const dbPath = state.databasePath();
  const database = new DatabaseSync(dbPath);
  database.exec("CREATE TABLE proof (value INTEGER); INSERT INTO proof VALUES (42)");
  const connection = { dbPath, database, disposals: 0, lateReads: 0, cleanupReads: 0 };
  state.connections.push(connection);
  const read = () => database.prepare("SELECT value FROM proof").get().value;
  api.lifecycle.registerRuntimeLifecycle({ id: "native-pdf", dispose() {
    connection.disposals++;
    database.close();
  }});
  api.registerProvider({ id: ${JSON.stringify(id)}, label: "Native PDF fixture", auth: [],
    createStreamFn() { return (model) => state.stream(model, read, connection); }
  });
}};`,
  });
  writeFixtureJson(dir, "openclaw.plugin.json", {
    id,
    providers: [id],
    configSchema: { type: "object", properties: {}, additionalProperties: false },
  });
  const config: OpenClawConfig = {
    agents: { defaults: { pdfModel: { primary: `${id}/pdf-model` } } },
    models: {
      providers: {
        [id]: {
          api,
          baseUrl: "https://pdf-fixture.invalid/v1",
          apiKey: "synthetic-fixture",
          models: [
            {
              ...makeModel("pdf-model"),
              name: "PDF model",
              input: ["text", "image"],
              contextWindow: 8192,
              maxTokens: 1024,
            },
          ],
        },
      },
    },
    plugins: { allow: [id], load: { paths: [plugin.file] }, slots: { memory: "none" } },
  };
  const agentDir = path.join(dir, "agent");
  const parent = new AsyncWorkScope();
  let lease: Awaited<ReturnType<typeof preparedRuntime.acquireReadOnlyPreparedModelRuntime>>;
  let outcome: Promise<unknown> | undefined;
  return {
    config,
    state,
    parent,
    async run(test: () => Promise<void>) {
      try {
        await withEnvAsync(nativeFixtureEnv(dir, path.join(dir, "state")), async () => {
          useNoBundledPlugins();
          stubPdfInput("Synthetic PDF text");
          lease = await preparedRuntime.acquireReadOnlyPreparedModelRuntime(
            {
              config,
              agentId: "main",
              agentDir,
              workspaceDir: dir,
              loadRuntimePlugins: true,
              skipCredentials: true,
              runtimePluginSelections: [{ provider: id, modelId: "pdf-model" }],
            },
            { catalogMode: "static" },
          );
          try {
            await test();
          } finally {
            state.finish.resolve();
            state.finishCleanup.resolve();
            await outcome;
            await parent.drain();
            await lease[Symbol.asyncDispose]();
            await closePreparedModelRuntimeSnapshots();
          }
        });
      } finally {
        cleanupNativeFixture(stateKey, connections);
      }
    },
    get lease() {
      return lease;
    },
    execute(options: { signal?: AbortSignal; supplied?: boolean; raw?: PluginRegistry } = {}) {
      const snapshot = options.raw
        ? { ...lease.snapshot, pluginRegistry: options.raw }
        : lease.snapshot;
      const tool = requirePdfTool({
        config,
        agentDir,
        workspaceDir: dir,
        ...(options.supplied !== false ? { preparedModelRuntime: snapshot } : {}),
      });
      outcome = parent
        .track(() =>
          withPluginRuntimeGenerationScope(snapshot, () =>
            tool.execute(
              "pdf-fixture",
              { pdf: "https://pdf-fixture.invalid/document.pdf" },
              options.signal,
            ),
          ),
        )
        .catch((error: unknown) => error);
      return outcome;
    },
    async assertClosed() {
      await parent.drain();
      await closePreparedModelRuntimeSnapshots();
      for (const connection of connections) {
        expect(connection).toMatchObject({ disposals: 1, database: { isOpen: false } });
        using reopened = new DatabaseSync(connection.dbPath, { readOnly: true });
        expect(reopened.prepare("SELECT value FROM proof").get()?.value).toBe(42);
      }
    },
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await closePreparedModelRuntimeSnapshots();
  resetPluginLoaderTestStateForTest();
});
afterAll(cleanupPluginLoaderFixturesForTest);

it("does not dispatch a PDF completion retired during transport initialization", async () => {
  const fixture = nativePdfFixture();
  await fixture.run(async () => {
    const dispatch = vi.fn(() => {
      throw new Error("Unexpected retired PDF provider dispatch");
    });
    const complete = llmStream.completeSimple;
    let retirement: Promise<void> | undefined;
    vi.spyOn(llmStream, "completeSimple").mockImplementationOnce((model, ...args) => {
      getModelLlmRuntime(model)?.registry.registerApiProvider({
        api: model.api,
        stream: dispatch,
        streamSimple: dispatch,
      });
      const completion = complete(model, ...args);
      retirement = closeEphemeralPreparedModelRuntimeResources();
      return completion;
    });

    expect(await fixture.execute()).toMatchObject({
      message: expect.stringContaining("Prepared plugin registry resources have been released"),
    });
    expect(dispatch).not.toHaveBeenCalled();
    await fixture.lease[Symbol.asyncDispose]();
    await fixture.assertClosed();
    await retirement;
  });
});

it.each(["result", "late-rejection"] as const)(
  "retains the PDF runtime through download, cancelled %s, and cleanup",
  async (mode) => {
    const fixture = nativePdfFixture();
    await fixture.run(async () => {
      const { state, lease, parent } = fixture;
      state.holdCreation = mode === "late-rejection";
      state.reject = mode === "late-rejection";
      state.watchCancellation = true;
      const downloading = createDeferredCore();
      const finishDownload = createDeferredCore();
      vi.mocked(webMedia.loadWebMediaRaw).mockImplementationOnce(async () => {
        downloading.resolve();
        await finishDownload.promise;
        return FAKE_PDF_MEDIA;
      });
      const abort = new AbortController();
      try {
        const result = fixture.execute({ signal: abort.signal });
        await downloading.promise;
        await lease[Symbol.asyncDispose]();
        await setImmediate();
        expect(state.connections[0]?.database.isOpen).toBe(true);
        finishDownload.resolve();
        await Promise.race([
          state.started.promise,
          result.then(() => {
            throw new Error("PDF provider never started");
          }),
        ]);
        withPluginRuntimeGenerationScope(
          {
            metadataSnapshot: lease.snapshot.metadataSnapshot,
            pluginRegistry: createEmptyPluginRegistry(),
          },
          () => {
            const reason = new Error("synthetic PDF cancellation");
            if (mode === "result") {
              parent.beginClose(reason);
              expect(state.cancellation.signal?.reason).toBe(reason);
            }
            abort.abort(reason);
          },
        );
        expect(await result).toMatchObject({ message: "synthetic PDF cancellation" });
        expect(state.connections[0]?.disposals).toBe(0);
        state.finish.resolve();
        await state.settled.promise;
        await state.cleanupStarted.promise;
        expect(state.cancellation.signal?.aborted).toBe(true);
        expect(state.cancellation.cleanupSignal?.aborted).toBe(true);
        expect(state.cancellation.registry).toBe(lease.snapshot.pluginRegistry);
        expect(state.connections[0]?.lateReads).toBe(1);
        expect(state.connections[0]?.database.isOpen).toBe(true);
        state.finishCleanup.resolve();
        await fixture.assertClosed();
        expect(state.cancellation.failure).toBeUndefined();
        expect(state.cancellation.afterRegistry).toBe(lease.snapshot.pluginRegistry);
        expect(state.connections[0]?.cleanupReads).toBe(1);
      } finally {
        finishDownload.resolve();
      }
    });
  },
);

it("adopts a default runtime before failed auth setup leaves a descendant", async () => {
  const fixture = nativePdfFixture();
  await fixture.run(async () => {
    const { state } = fixture;
    vi.spyOn(preparedRuntime, "acquireAgentRunPreparedModelRuntime").mockResolvedValueOnce(
      fixture.lease,
    );
    let failure: unknown;
    let reads = 0;
    vi.spyOn(modelAuth, "getApiKeyForModelCore").mockImplementationOnce(async () => {
      void trackAsyncWork(async () => {
        await state.finishCleanup.promise;
        expect(state.connections[0]?.database.prepare("SELECT value FROM proof").get()?.value).toBe(
          42,
        );
        reads++;
      }).catch((error: unknown) => {
        failure = error;
      });
      throw new Error("synthetic PDF setup failure");
    });
    expect(await fixture.execute({ supplied: false })).toMatchObject({
      message: expect.stringContaining("synthetic PDF setup failure"),
    });
    await setImmediate();
    expect(state.connections[0]?.database.isOpen).toBe(true);
    state.finishCleanup.resolve();
    await fixture.assertClosed();
    expect(reads).toBe(1);
    expect(failure).toBeUndefined();
  });
});

it("leaves raw supplied registry disposal to its owner", async () => {
  const fixture = nativePdfFixture("openai-completions");
  await fixture.run(async () => {
    const raw = loadPluginRegistryHandle({ config: fixture.config });
    fixture.state.finish.resolve();
    expect(await fixture.execute({ raw })).toMatchObject({ details: { text: "PDF value 42" } });
    await fixture.parent.drain();
    const rawConnection = fixture.state.connections.at(-1);
    expect(rawConnection).toMatchObject({ lateReads: 1, disposals: 0, database: { isOpen: true } });
  });
});
