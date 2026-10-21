import fs from "node:fs";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { getAiTransportHost } from "@openclaw/ai";
import { Command } from "commander";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../../agents/prepared-model-runtime.test-support.js";
import { ModelRegistry } from "../../agents/sessions/model-registry.js";
import {
  completionChunk,
  completionConfig,
  completionModelDefinition,
  startCompletionServer,
} from "../../agents/simple-completion.test-support.js";
import { resetPluginLoaderTestStateForTest } from "../../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import {
  createColdPluginFixture,
  createColdPluginHermeticEnv,
} from "../../plugins/test-helpers/cold-plugin-fixtures.js";
import { createSyncSuiteTempRootTracker } from "../../plugins/test-helpers/fs-fixtures.js";
import { defaultRuntime } from "../../runtime.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { registerModelCapabilityCommands } from "./model.js";
import * as shared from "./shared.js";

it.each(["overlap", "provider-error", "callback-drain", "cancel-drain"] as const)(
  "retains local CLI completion resources through %s",
  async (mode) => {
    const roots = createSyncSuiteTempRootTracker("cli-model-owner");
    const root = fs.realpathSync(roots.makeTempDir());
    fs.mkdirSync(path.join(root, "provider"));
    const fixture = createColdPluginFixture({
      rootDir: path.join(root, "provider"),
      pluginId: "cli-completion-fixture",
      providerId: "cli-completion-provider",
    });
    fs.writeFileSync(
      fixture.runtimeSource,
      `module.exports = { id: ${JSON.stringify(fixture.pluginId)}, register(api) {
        api.registerProvider({ id: ${JSON.stringify(fixture.providerId)}, label: "CLI fixture", auth: [] });
      } };`,
    );
    const requests: ServerResponse[] = [];
    const arrivals = [createDeferred(), createDeferred(), createDeferred()];
    let finishing = false;
    const finish = (response: ServerResponse, index: number) => {
      if (response.writableEnded || response.destroyed) {
        return;
      }
      if (!response.headersSent) {
        response.writeHead(200, { "content-type": "text/event-stream" });
      }
      response.end(completionChunk(`reply-${index}`, "cli-model"));
    };
    const server = await startCompletionServer((request, response) => {
      request.resume();
      const index = requests.push(response) - 1;
      arrivals[index]?.resolve();
      if (finishing) {
        finish(response, index);
      }
    });
    try {
      const cfg = completionConfig(
        fixture.providerId,
        {
          api: "openai-completions",
          apiKey: "synthetic-cli-key",
          baseUrl: server.baseUrl,
          models: [completionModelDefinition({ id: "cli-model", name: "CLI model" })],
        },
        {
          agents: { defaults: { workspace: root, model: `${fixture.providerId}/cli-model` } },
          plugins: {
            load: { paths: [fixture.rootDir] },
            slots: { memory: "none" },
            entries: { [fixture.pluginId]: { enabled: true } },
          },
        },
      );
      await withEnvAsync(
        {
          ...createColdPluginHermeticEnv(root, { bundledPluginsDir: roots.makeTempDir() }),
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_STATE_DIR: path.join(root, "state"),
        },
        async () => {
          vi.spyOn(shared, "resolveLocalCapabilityRuntimeConfig").mockResolvedValue(cfg);
          const builds = vi.spyOn(ModelRegistry, "fromCapturedSources");
          const output = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
          const errors = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
          vi.spyOn(defaultRuntime, "exit").mockImplementation(() => {
            throw new Error("CLI failed");
          });
          const finishCancel = createDeferred();
          const drainStarted = createDeferred();
          const parent = new AsyncWorkScope();
          const pending: Promise<unknown>[] = [];
          let drained = false;
          let drainage: Promise<void> | undefined;
          if (mode === "callback-drain" || mode === "cancel-drain") {
            const { configureAiTransportRuntimeHost } =
              await import("../../agents/ai-transport-runtime-host.js");
            configureAiTransportRuntimeHost();
            const plugin = getAiTransportHost().plugin;
            const wrap = plugin.wrapSimpleCompletionStream;
            let first = true;
            vi.spyOn(plugin, "wrapSimpleCompletionStream").mockImplementation((params) => {
              const stream = wrap(params) ?? params.context.streamFn;
              return (model, context, options) =>
                stream(model, context, {
                  ...options,
                  onResponse: async (response, responseModel) => {
                    await options?.onResponse?.(response, responseModel);
                    if (first) {
                      first = false;
                      if (mode === "cancel-drain") {
                        throw new Error("fixture response rejected");
                      }
                      drainStarted.resolve();
                      await finishCancel.promise;
                    }
                  },
                });
            });
          }
          if (mode === "cancel-drain") {
            const fetch = globalThis.fetch;
            let wrapped = false;
            vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
              const response = await fetch(...args);
              if (wrapped || !response.url.startsWith(`${server.origin}/`)) {
                return response;
              }
              wrapped = true;
              const body = response.body;
              if (!body) {
                throw new Error("Fixture response has no body");
              }
              return new Response(
                new ReadableStream<Uint8Array>({
                  // The rejecting response hook cancels before consuming the body.
                  async cancel(reason) {
                    drainStarted.resolve();
                    await finishCancel.promise;
                    await body.cancel(reason);
                  },
                }),
                { status: response.status, headers: response.headers },
              );
            });
          }
          const start = async (managed = false) => {
            const command = new Command();
            registerModelCapabilityCommands(command);
            const execute = async () => {
              await command.parseAsync(["model", "run", "--prompt", "hello", "--json"], {
                from: "user",
              });
            };
            const run = managed ? parent.track(execute) : execute();
            await awaitGateBeforeSettlement(
              arrivals[pending.push(run) - 1]!.promise,
              run,
              "CLI settled before provider request",
            );
            return { run };
          };
          try {
            const { run: first } = await start(true);
            const firstBuilds = builds.mock.calls.length;
            expect(firstBuilds).toBeGreaterThan(0);
            if (mode === "provider-error") {
              requests[0]!.writeHead(400, { "content-type": "application/json" });
              requests[0]!.end(
                JSON.stringify({ error: { message: "fixture provider rejection" } }),
              );
              await expect(first).rejects.toThrow("CLI failed");
              expect(errors.mock.calls.flat().join(" ")).toContain("fixture provider rejection");
            } else if (mode === "callback-drain") {
              finish(requests[0]!, 0);
              await Promise.race([drainStarted.promise, first]);
            } else if (mode === "cancel-drain") {
              // Keep the accepted body open so prefetch cannot settle it before cancellation.
              requests[0]!.writeHead(200, { "content-type": "text/event-stream" });
              requests[0]!.flushHeaders();
              await Promise.race([drainStarted.promise, first]);
              await expect(first).rejects.toThrow("CLI failed");
              drainage = parent.drain().then(() => {
                drained = true;
              });
            }
            const { run: second } = await start();
            expect
              .soft(builds.mock.calls.length)
              .toBe(firstBuilds + (mode === "provider-error" ? 1 : 0));
            if (mode === "cancel-drain") {
              expect.soft(drained).toBe(false);
            }
            finishCancel.resolve();
            finish(requests[0]!, 0);
            finish(requests[1]!, 1);
            if (mode === "overlap" || mode === "callback-drain") {
              await first;
            }
            await second;
            await drainage;
            const emitted = output.mock.calls.map(([value]) => value);
            expect(JSON.stringify(emitted)).toContain("reply-1");
            const buildsBeforeThird = builds.mock.calls.length;
            const { run: third } = await start();
            expect(builds.mock.calls.length).toBe(buildsBeforeThird + 1);
            finish(requests[2]!, 2);
            await third;
          } finally {
            finishCancel.resolve();
            finishing = true;
            requests.forEach(finish);
            await Promise.allSettled(pending);
            await parent.drain();
            vi.restoreAllMocks();
            await resetPreparedModelRuntimeSnapshotsForTest();
            clearPluginMetadataLifecycleCaches();
            resetPluginLoaderTestStateForTest();
          }
        },
      );
    } finally {
      await server[Symbol.asyncDispose]();
      roots.cleanup();
    }
  },
);
