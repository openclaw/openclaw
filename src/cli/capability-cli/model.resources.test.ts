import fs from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { getAiTransportHost } from "@openclaw/ai";
import { Command } from "commander";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../../agents/prepared-model-runtime.test-support.js";
import { ModelRegistry } from "../../agents/sessions/model-registry.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
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
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({
          id: "cli-response",
          object: "chat.completion.chunk",
          model: "cli-model",
          choices: [{ index: 0, delta: { content: `reply-${index}` }, finish_reason: "stop" }],
        })}\n\ndata: [DONE]\n\n`,
      );
    };
    const server = createServer((request, response) => {
      request.resume();
      const index = requests.push(response) - 1;
      arrivals[index]?.resolve();
      if (finishing) {
        finish(response, index);
      }
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("CLI fixture has no TCP port");
      }
      const cfg: OpenClawConfig = {
        agents: { defaults: { workspace: root, model: `${fixture.providerId}/cli-model` } },
        models: {
          providers: {
            [fixture.providerId]: {
              api: "openai-completions",
              apiKey: "synthetic-cli-key",
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              models: [
                {
                  id: "cli-model",
                  name: "CLI model",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 8192,
                  maxTokens: 1024,
                },
              ],
            },
          },
        },
        plugins: {
          load: { paths: [fixture.rootDir] },
          slots: { memory: "none" },
          entries: { [fixture.pluginId]: { enabled: true } },
        },
      };
      await withEnvAsync(
        {
          ...createColdPluginHermeticEnv(root, { bundledPluginsDir: roots.makeTempDir() }),
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_STATE_DIR: path.join(root, "state"),
        },
        async () => {
          const config = vi
            .spyOn(shared, "resolveLocalCapabilityRuntimeConfig")
            .mockResolvedValue(cfg);
          const builds = vi.spyOn(ModelRegistry, "create");
          const output = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
          const errors = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
          const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => {
            throw new Error("CLI failed");
          });
          const finishCancel = createDeferred();
          const callbackStarted = createDeferred();
          const cancelStarted = createDeferred();
          const parent = new AsyncWorkScope();
          const pending: Promise<unknown>[] = [];
          const transportSpies: Array<{ mockRestore(): void }> = [];
          let drained = false;
          let drainage: Promise<void> | undefined;
          if (mode === "callback-drain" || mode === "cancel-drain") {
            const { configureAiTransportRuntimeHost } =
              await import("../../agents/ai-transport-runtime-host.js");
            configureAiTransportRuntimeHost();
            const plugin = getAiTransportHost().plugin;
            const wrap = plugin.wrapSimpleCompletionStream;
            let first = true;
            transportSpies.push(
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
                        callbackStarted.resolve();
                        await finishCancel.promise;
                      }
                    },
                  });
              }),
            );
          }
          if (mode === "cancel-drain") {
            const fetch = globalThis.fetch;
            let wrapped = false;
            transportSpies.push(
              vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
                const response = await fetch(...args);
                if (wrapped || !response.url.startsWith(`http://127.0.0.1:${address.port}/`)) {
                  return response;
                }
                wrapped = true;
                const reader = response.body?.getReader();
                if (!reader) {
                  throw new Error("Fixture response has no body");
                }
                return new Response(
                  new ReadableStream<Uint8Array>({
                    async pull(controller) {
                      const { value, done } = await reader.read();
                      if (done) {
                        controller.close();
                      } else {
                        controller.enqueue(value);
                      }
                    },
                    async cancel(reason) {
                      cancelStarted.resolve();
                      await finishCancel.promise;
                      await reader.cancel(reason);
                    },
                  }),
                  { status: response.status, headers: response.headers },
                );
              }),
            );
          }
          const start = (managed = false) => {
            const command = new Command();
            registerModelCapabilityCommands(command);
            const execute = async () => {
              await command.parseAsync(["model", "run", "--prompt", "hello", "--json"], {
                from: "user",
              });
            };
            const run = managed ? parent.track(execute) : execute();
            pending.push(run);
            return run;
          };
          const arrive = (index: number, run: Promise<void>) =>
            Promise.race([
              arrivals[index]!.promise,
              run.then(() => {
                throw new Error("CLI settled before provider request");
              }),
            ]);
          try {
            const started = performance.now();
            const first = start(true);
            await arrive(0, first);
            const coldMs = performance.now() - started;
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
              await Promise.race([callbackStarted.promise, first]);
            } else if (mode === "cancel-drain") {
              finish(requests[0]!, 0);
              await Promise.race([cancelStarted.promise, first]);
              await expect(first).rejects.toThrow("CLI failed");
              drainage = parent.drain().then(() => {
                drained = true;
              });
            }
            const nextStarted = performance.now();
            const second = start();
            await arrive(1, second);
            console.info("CLI completion preparation", {
              mode,
              coldMs,
              overlapMs: performance.now() - nextStarted,
            });
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
            expect(
              output.mock.calls.some(([value]) => JSON.stringify(value).includes("reply-1")),
            ).toBe(true);
            const buildsBeforeThird = builds.mock.calls.length;
            const third = start();
            await arrive(2, third);
            expect(builds.mock.calls.length).toBe(buildsBeforeThird + 1);
            finish(requests[2]!, 2);
            await third;
          } finally {
            finishCancel.resolve();
            finishing = true;
            requests.forEach(finish);
            await Promise.allSettled(pending);
            await parent.drain();
            for (const spy of transportSpies) {
              spy.mockRestore();
            }
            config.mockRestore();
            builds.mockRestore();
            output.mockRestore();
            errors.mockRestore();
            exit.mockRestore();
            await resetPreparedModelRuntimeSnapshotsForTest();
            clearPluginMetadataLifecycleCaches();
            resetPluginLoaderTestStateForTest();
          }
        },
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      roots.cleanup();
    }
  },
);
