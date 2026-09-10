import fs from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { getAiTransportHost } from "@openclaw/ai";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../agents/prepared-model-runtime.test-support.js";
import { ModelRegistry } from "../agents/sessions/model-registry.js";
import {
  acquireSimpleCompletionModelForAgent,
  completeWithPreparedSimpleCompletionModel,
} from "../agents/simple-completion-runtime.js";
import { readConfigFileSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createColdPluginFixture } from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { classifySystemAgentApprovalIntent } from "./approval-intent.js";
import { resolveSystemAgentConfiguredRouteFromConfig } from "./inference-route.js";
import {
  createSystemAgentVerifiedInferenceBinding,
  resolveSystemAgentVerifiedInferenceRoute,
} from "./verified-inference.js";

it.each(["overlap", "cancel-drain", "route-drift"] as const)(
  "retains verified approval completion resources through %s",
  async (mode) => {
    await withOpenClawTestState(
      { label: "approval-owner", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
      async (state) => {
        const pluginRoot = state.path("provider");
        fs.mkdirSync(pluginRoot);
        const fixture = createColdPluginFixture({
          rootDir: pluginRoot,
          pluginId: "approval-fixture",
          providerId: "approval-provider",
        });
        fs.writeFileSync(
          fixture.runtimeSource,
          `module.exports = { id: "approval-fixture", register(api) {
        api.registerProvider({ id: "approval-provider", label: "Approval fixture", auth: [] });
      } };`,
        );
        const requests: ServerResponse[] = [];
        const arrivals = Array.from({ length: 4 }, () => createDeferred());
        let finishing = false;
        const finish = (response: ServerResponse) => {
          if (response.writableEnded || response.destroyed) {
            return;
          }
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(
            `data: ${JSON.stringify({ id: "approval-response", object: "chat.completion.chunk", model: "approval-model", choices: [{ index: 0, delta: { content: "approve" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
          );
        };
        const server = createServer((request, response) => {
          request.resume();
          const index = requests.push(response) - 1;
          arrivals[index]?.resolve();
          if (finishing || index === 0) {
            finish(response);
          }
        });
        await new Promise<void>((resolve) => {
          server.listen(0, "127.0.0.1", resolve);
        });
        const pending: Promise<unknown>[] = [];
        const finishCancel = createDeferred();
        const cancelStarted = createDeferred();
        const parent = new AsyncWorkScope();
        const spies: Array<{ mockRestore(): void }> = [];
        let drained = false;
        let drainage: Promise<void> | undefined;
        try {
          const address = server.address();
          if (!address || typeof address === "string") {
            throw new Error("Approval fixture has no TCP port");
          }
          const profileId = `${fixture.providerId}:verified`;
          const cfg: OpenClawConfig = {
            agents: {
              defaults: {
                workspace: state.workspaceDir,
                model: `${fixture.providerId}/approval-model@${profileId}`,
                models: {
                  [`${fixture.providerId}/approval-model`]: { agentRuntime: { id: "openclaw" } },
                },
              },
            },
            auth: { profiles: { [profileId]: { provider: fixture.providerId, mode: "api_key" } } },
            models: {
              providers: {
                [fixture.providerId]: {
                  api: "openai-completions",
                  baseUrl: `http://127.0.0.1:${address.port}/v1`,
                  models: [
                    {
                      id: "approval-model",
                      name: "Approval model",
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
              allow: [fixture.pluginId],
              load: { paths: [fixture.rootDir] },
              slots: { memory: "none" },
              entries: { [fixture.pluginId]: { enabled: true } },
            },
          };
          await state.writeConfig(cfg);
          const authDatabase = await state.writeAuthProfiles({
            version: 1,
            profiles: {
              [profileId]: {
                type: "api_key",
                provider: fixture.providerId,
                key: "synthetic-approval-key",
              },
            },
          });
          expect(fs.existsSync(authDatabase)).toBe(true);
          const snapshot = await readConfigFileSnapshot();
          if (!snapshot.valid) {
            throw new Error("Approval fixture config is invalid");
          }
          const route = await resolveSystemAgentConfiguredRouteFromConfig(
            snapshot.runtimeConfig ?? snapshot.config,
            undefined,
            {},
            snapshot,
          );
          if (
            !route ||
            route.runner !== "embedded" ||
            route.agentHarnessRuntimeOverride !== "openclaw"
          ) {
            throw new Error("Approval fixture did not select the embedded OpenClaw route");
          }
          const probe = await acquireSimpleCompletionModelForAgent({
            cfg: route.runConfig,
            agentId: route.agentId,
            agentDir: route.agentDir,
            modelRef: `${route.modelLabel}@${profileId}`,
            preferredProfile: profileId,
            bindAuthOwner: true,
          });
          if ("error" in probe) {
            throw new Error(probe.error);
          }
          const verifiedInference = await (async () => {
            try {
              const response = await completeWithPreparedSimpleCompletionModel({
                model: probe.model,
                auth: probe.auth,
                cfg: route.runConfig,
                context: {
                  messages: [{ role: "user", content: "verify synthetic inference", timestamp: 0 }],
                },
              });
              expect(
                response.content.some((part) => part.type === "text" && part.text === "approve"),
              ).toBe(true);
              if (!probe.sourceAuthFingerprint) {
                throw new Error("Probe has no bound auth fingerprint");
              }
              return await createSystemAgentVerifiedInferenceBinding({
                configuredRoute: route,
                executionRoute: route,
                auth: {
                  authProfileId: profileId,
                  authFingerprint: probe.sourceAuthFingerprint,
                  agentHarnessId: "openclaw",
                  modelId: probe.model.id,
                  modelApi: probe.model.api,
                },
              });
            } finally {
              probe.release();
            }
          })();
          expect(
            (await resolveSystemAgentVerifiedInferenceRoute(verifiedInference))?.provider,
          ).toBe(fixture.providerId);
          const builds = vi.spyOn(ModelRegistry, "create");
          spies.push(builds);
          if (mode === "cancel-drain") {
            const plugin = getAiTransportHost().plugin;
            const wrap = plugin.wrapSimpleCompletionStream;
            let first = true;
            spies.push(
              vi.spyOn(plugin, "wrapSimpleCompletionStream").mockImplementation((params) => {
                const stream = wrap(params) ?? params.context.streamFn;
                return (model, context, options) =>
                  stream(model, context, {
                    ...options,
                    onResponse: async (response, responseModel) => {
                      await options?.onResponse?.(response, responseModel);
                      if (first) {
                        first = false;
                        throw new Error("fixture response rejected");
                      }
                    },
                  });
              }),
            );
            const fetch = globalThis.fetch;
            let wrapped = false;
            spies.push(
              vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
                const response = await fetch(...args);
                if (wrapped || !response.url.startsWith(`http://127.0.0.1:${address.port}/`)) {
                  return response;
                }
                wrapped = true;
                const reader = response.body?.getReader();
                if (!reader) {
                  throw new Error("Approval response has no body");
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
            const run = () =>
              classifySystemAgentApprovalIntent({
                message: "alright, ship that change",
                proposal: "a synthetic pending change",
                verifiedInference,
              });
            const result = managed ? parent.track(run) : run();
            pending.push(result);
            return result;
          };
          const arrive = (index: number, result: Promise<unknown>) =>
            Promise.race([
              arrivals[index]!.promise,
              result.then(() => {
                throw new Error("Classifier settled before its provider request");
              }),
            ]);
          const started = performance.now();
          const first = start(true);
          await arrive(1, first);
          const coldMs = performance.now() - started;
          const firstBuilds = builds.mock.calls.length;
          expect(firstBuilds).toBeGreaterThan(0);
          if (mode === "cancel-drain") {
            finish(requests[1]!);
            await Promise.race([cancelStarted.promise, first]);
            await expect(first).resolves.toBe("other");
            drainage = parent.drain().then(() => {
              drained = true;
            });
          }
          const secondStarted = performance.now();
          const second = start();
          await arrive(2, second);
          console.info("approval completion preparation", {
            mode,
            coldMs,
            overlapMs: performance.now() - secondStarted,
          });
          expect.soft(builds.mock.calls.length).toBe(firstBuilds);
          if (mode === "cancel-drain") {
            expect.soft(drained).toBe(false);
          }
          if (mode === "route-drift") {
            await state.writeAuthProfiles({
              version: 1,
              profiles: {
                [profileId]: {
                  type: "api_key",
                  provider: fixture.providerId,
                  key: "rotated-synthetic-key",
                },
              },
            });
          }
          finishCancel.resolve();
          requests.forEach(finish);
          if (mode !== "cancel-drain") {
            await expect(first).resolves.toBe(mode === "route-drift" ? "other" : "approve");
          }
          await expect(second).resolves.toBe(mode === "route-drift" ? "other" : "approve");
          await drainage;
          if (mode === "route-drift") {
            const count = requests.length;
            await expect(start()).resolves.toBe("other");
            expect(requests).toHaveLength(count);
          } else {
            const beforeThird = builds.mock.calls.length;
            const third = start();
            await arrive(3, third);
            expect(builds.mock.calls.length).toBe(beforeThird + 1);
            finish(requests[3]!);
            await expect(third).resolves.toBe("approve");
          }
        } finally {
          finishCancel.resolve();
          finishing = true;
          requests.forEach(finish);
          await Promise.allSettled(pending);
          await parent.drain();
          for (const spy of spies) {
            spy.mockRestore();
          }
          await resetPreparedModelRuntimeSnapshotsForTest();
          clearPluginMetadataLifecycleCaches();
          resetPluginLoaderTestStateForTest();
          server.closeAllConnections();
          await new Promise<void>((resolve) => {
            server.close(() => resolve());
          });
        }
      },
    );
  },
);
