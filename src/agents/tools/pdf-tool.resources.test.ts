import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { Model } from "../../llm/types.js";
import { createAssistantMessageEventStream } from "../../llm/utils/event-stream.js";
import * as pdfExtract from "../../media/pdf-extract.js";
import * as webMedia from "../../media/web-media.js";
import { loadPluginRegistryHandle } from "../../plugins/loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "../../plugins/loader.test-fixtures.js";
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
import * as modelAuth from "../model-auth.js";
import * as preparedRuntime from "../prepared-model-runtime.js";
import { closePreparedModelRuntimeSnapshots } from "../prepared-model-runtime.lifecycle.js";
import { createPdfTool } from "./pdf-tool.js";
import { FAKE_PDF_MEDIA } from "./pdf-tool.test-support.js";

type Connection = {
  database: DatabaseSync;
  dbPath: string;
  disposals: number;
  lateReads: number;
  cleanupReads: number;
};

function nativePdfFixture() {
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
    finishSetupTail: createDeferredCore(),
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
            message: {
              role: "assistant",
              content: [{ type: "text", text: `PDF value ${value}` }],
              api: model.api,
              provider: model.provider,
              model: model.id,
              stopReason: "stop",
              timestamp: 0,
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
            },
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
  const connection = { database, dbPath, disposals: 0, lateReads: 0, cleanupReads: 0 };
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
  fs.writeFileSync(
    path.join(dir, "openclaw.plugin.json"),
    JSON.stringify({
      id,
      providers: [id],
      configSchema: { type: "object", properties: {}, additionalProperties: false },
    }),
  );
  const config: OpenClawConfig = {
    agents: { defaults: { pdfModel: { primary: `${id}/pdf-model` } } },
    models: {
      providers: {
        [id]: {
          api: "openai-responses",
          baseUrl: "https://pdf-fixture.invalid/v1",
          apiKey: "synthetic-fixture",
          models: [
            {
              id: "pdf-model",
              name: "PDF model",
              reasoning: false,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
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
    dir,
    config,
    agentDir,
    state,
    parent,
    async run(test: () => Promise<void>) {
      try {
        await withEnvAsync(
          {
            OPENCLAW_HOME: dir,
            OPENCLAW_STATE_DIR: path.join(dir, "state"),
            OPENCLAW_CONFIG_PATH: path.join(dir, "config.json"),
          },
          async () => {
            useNoBundledPlugins();
            vi.spyOn(webMedia, "loadWebMediaRaw").mockResolvedValue(FAKE_PDF_MEDIA);
            vi.spyOn(pdfExtract, "extractPdfContent").mockResolvedValue({
              text: "Synthetic PDF text",
              images: [],
            });
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
              undefined,
              "static",
            );
            try {
              await test();
            } finally {
              state.finish.resolve();
              state.finishCleanup.resolve();
              state.finishSetupTail.resolve();
              await outcome;
              await parent.drain();
              lease.release();
              await closePreparedModelRuntimeSnapshots();
            }
          },
        );
      } finally {
        for (const connection of connections) {
          if (connection.database.isOpen) {
            connection.database.close();
          }
        }
        Reflect.deleteProperty(globalThis, stateKey);
      }
    },
    get lease() {
      return lease;
    },
    execute(options: { signal?: AbortSignal; supplied?: boolean; raw?: PluginRegistry } = {}) {
      const snapshot = options.raw
        ? { ...lease.snapshot, pluginRegistry: options.raw }
        : lease.snapshot;
      const tool = createPdfTool({
        config,
        agentDir,
        workspaceDir: dir,
        ...(options.supplied !== false ? { preparedModelRuntime: snapshot } : {}),
      });
      if (!tool) {
        throw new Error("PDF fixture tool was unavailable");
      }
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
        expect(connection.disposals).toBe(1);
        expect(connection.database.isOpen).toBe(false);
        const reopened = new DatabaseSync(connection.dbPath, { readOnly: true });
        try {
          expect(reopened.prepare("SELECT value FROM proof").get()?.value).toBe(42);
        } finally {
          reopened.close();
        }
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

it("retains a supplied runtime before the first PDF download awaits", async () => {
  const fixture = nativePdfFixture();
  await fixture.run(async () => {
    const downloading = createDeferredCore();
    const finishDownload = createDeferredCore();
    vi.mocked(webMedia.loadWebMediaRaw).mockImplementationOnce(async () => {
      downloading.resolve();
      await finishDownload.promise;
      return FAKE_PDF_MEDIA;
    });
    try {
      const result = fixture.execute();
      await downloading.promise;
      fixture.lease.release();
      await setImmediate();
      expect(fixture.state.connections[0]?.database.isOpen).toBe(true);
      finishDownload.resolve();
      fixture.state.finish.resolve();
      expect(await result).toMatchObject({ details: { text: "PDF value 42", native: false } });
      await fixture.assertClosed();
    } finally {
      finishDownload.resolve();
    }
  });
});

it.each(["creation", "result", "late-rejection"] as const)(
  "keeps PDF provider resources until cancelled %s work actually settles",
  async (mode) => {
    const fixture = nativePdfFixture();
    await fixture.run(async () => {
      fixture.state.holdCreation = mode !== "result";
      fixture.state.reject = mode === "late-rejection";
      const abort = new AbortController();
      const result = fixture.execute({ signal: abort.signal });
      await Promise.race([
        fixture.state.started.promise,
        result.then(() => {
          throw new Error("PDF provider never started");
        }),
      ]);
      abort.abort(new Error("synthetic PDF cancellation"));
      expect(await result).toMatchObject({ message: "synthetic PDF cancellation" });
      fixture.lease.release();
      await setImmediate();
      expect(fixture.state.connections[0]?.database.isOpen).toBe(true);
      expect(fixture.state.connections[0]?.disposals).toBe(0);
      fixture.state.finish.resolve();
      await fixture.state.settled.promise;
      await fixture.assertClosed();
      expect(fixture.state.connections[0]?.lateReads).toBe(1);
    });
  },
);

it.each(["normal", "parent"] as const)(
  "drains PDF cleanup with its captured %s context",
  async (mode) => {
    const fixture = nativePdfFixture();
    await fixture.run(async () => {
      fixture.state.watchCancellation = true;
      const result = fixture.execute();
      await Promise.race([
        fixture.state.started.promise,
        result.then(() => {
          throw new Error("PDF provider never started");
        }),
      ]);
      if (mode === "parent") {
        const reason = new Error("synthetic parent shutdown");
        withPluginRuntimeGenerationScope(
          {
            metadataSnapshot: fixture.lease.snapshot.metadataSnapshot,
            pluginRegistry: createEmptyPluginRegistry(),
          },
          () => fixture.parent.beginClose(reason),
        );
        expect(fixture.state.cancellation.signal?.reason).toBe(reason);
      } else {
        fixture.state.finish.resolve();
        expect(await result).toMatchObject({ details: { text: "PDF value 42" } });
      }
      await setImmediate();
      expect(fixture.state.cancellation.signal?.aborted).toBe(true);
      await fixture.state.cleanupStarted.promise;
      expect(fixture.state.cancellation.cleanupSignal?.aborted).toBe(true);
      expect(fixture.state.cancellation.registry).toBe(fixture.lease.snapshot.pluginRegistry);
      fixture.lease.release();
      expect(fixture.state.connections[0]?.database.isOpen).toBe(true);
      fixture.state.finish.resolve();
      expect(await result).toMatchObject({ details: { text: "PDF value 42" } });
      fixture.state.finishCleanup.resolve();
      await fixture.assertClosed();
      expect(fixture.state.cancellation.failure).toBeUndefined();
      expect(fixture.state.cancellation.afterRegistry).toBe(fixture.lease.snapshot.pluginRegistry);
      expect(fixture.state.connections[0]?.cleanupReads).toBe(1);
    });
  },
);

it("adopts a default runtime before failed auth setup leaves a descendant", async () => {
  const fixture = nativePdfFixture();
  await fixture.run(async () => {
    vi.spyOn(preparedRuntime, "acquireAgentRunPreparedModelRuntime").mockResolvedValueOnce(
      fixture.lease,
    );
    let failure: unknown;
    let reads = 0;
    vi.spyOn(modelAuth, "getApiKeyForModelCore").mockImplementationOnce(async () => {
      void trackAsyncWork(async () => {
        await fixture.state.finishSetupTail.promise;
        expect(
          fixture.state.connections[0]?.database.prepare("SELECT value FROM proof").get()?.value,
        ).toBe(42);
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
    expect(fixture.state.connections[0]?.database.isOpen).toBe(true);
    fixture.state.finishSetupTail.resolve();
    await fixture.assertClosed();
    expect(reads).toBe(1);
    expect(failure).toBeUndefined();
  });
});

it("leaves raw supplied registry disposal to its owner", async () => {
  const fixture = nativePdfFixture();
  await fixture.run(async () => {
    const raw = loadPluginRegistryHandle({ config: fixture.config });
    fixture.state.finish.resolve();
    expect(await fixture.execute({ raw })).toMatchObject({ details: { text: "PDF value 42" } });
    await fixture.parent.drain();
    const rawConnection = fixture.state.connections.at(-1);
    expect(rawConnection?.lateReads).toBe(1);
    expect(rawConnection?.disposals).toBe(0);
    expect(rawConnection?.database.isOpen).toBe(true);
  });
});
