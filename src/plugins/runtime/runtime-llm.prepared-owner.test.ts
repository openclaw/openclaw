import fs from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { getAiTransportHost } from "@openclaw/ai";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { resolveAgentDir } from "../../agents/agent-scope-config.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  setRuntimeAuthProfileStoreSnapshot,
} from "../../agents/auth-profiles/runtime-snapshots.js";
import * as modelResolution from "../../agents/embedded-agent-runner/model.js";
import {
  acquireAgentRunPreparedModelRuntime,
  prepareModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "../../agents/prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../../agents/prepared-model-runtime.test-support.js";
import { AuthStorage } from "../../agents/sessions/auth-storage.js";
import { ModelRegistry } from "../../agents/sessions/model-registry.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { bindModelLlmRuntime, getModelLlmRuntime } from "../../llm/model-runtime-binding.js";
import {
  completeWithPreparedSimpleCompletionModel,
  extractAssistantText,
  prepareSimpleCompletionModelForAgent,
} from "../../plugin-sdk/simple-completion-runtime.js";
import { AsyncWorkScope, getAsyncWorkSignal } from "../../shared/async-work-scope.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { LegacyPluginSdkResourceHost } from "../legacy-sdk-resource-host.js";
import { resetPluginLoaderTestStateForTest } from "../loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../plugin-metadata-lifecycle.js";
import {
  createColdPluginFixture,
  createColdPluginHermeticEnv,
} from "../test-helpers/cold-plugin-fixtures.js";
import { createSyncSuiteTempRootTracker } from "../test-helpers/fs-fixtures.js";
import { createRuntimeLlm } from "./runtime-llm.runtime.js";

it.each([
  "overlap",
  "config",
  "auth",
  "lru",
  "fork",
  "prepare-error",
  "prepare-throw",
  "provider-error",
  "abort",
  "callback-drain",
  "cancel-drain",
  "sdk-overlap",
  "sdk-config",
  "sdk-auth",
  "sdk-late-prepare",
  "sdk-dispatch-close",
  "sdk-current-check",
  "sdk-nested-prepare",
  "sdk-callback-drain",
  "sdk-cancel-drain",
  "anthropic-read-cancel",
] as const)("keeps completion ownership coherent: %s", async (testCase) => {
  const sdk = testCase.startsWith("sdk-");
  const mode = testCase.replace(/^sdk-/, "");
  const anthropicReadCancel = mode === "anthropic-read-cancel";
  const roots = createSyncSuiteTempRootTracker("runtime-llm-prepared-owner");
  const root = fs.realpathSync(roots.makeTempDir());
  fs.mkdirSync(path.join(root, "provider"));
  const fixture = createColdPluginFixture({
    rootDir: path.join(root, "provider"),
    pluginId: "completion-lease-fixture",
    providerId: "completion-lease-provider",
  });
  fs.writeFileSync(
    fixture.runtimeSource,
    `module.exports = {
      id: ${JSON.stringify(fixture.pluginId)},
      register(api) {
        api.registerProvider({ id: ${JSON.stringify(fixture.providerId)}, label: "Lease fixture", auth: [] });
      },
    };`,
  );
  const requests: ServerResponse[] = [];
  const requestFacts: Array<{ url: string; authorization: string | undefined }> = [];
  const arrivals = [createDeferred(), createDeferred(), createDeferred()];
  let finishing = false;
  const finish = (response: ServerResponse, index: number) => {
    if (response.writableEnded || response.destroyed) {
      return;
    }
    if (!response.headersSent) {
      response.writeHead(200, { "content-type": "text/event-stream" });
    }
    if (anthropicReadCancel) {
      const events = [
        {
          type: "message_start",
          message: {
            id: "lease-response",
            role: "assistant",
            model: "lease-model",
            content: [],
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: `result-${index}|${requestFacts[index]?.url}|${requestFacts[index]?.authorization}`,
          },
        },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ];
      if (index === 0 && !finishing) {
        response.write(`data: ${JSON.stringify(events[0])}\n\n`);
      } else {
        response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
      }
      return;
    }
    response.end(
      `data: ${JSON.stringify({
        id: "completion-lease-response",
        object: "chat.completion.chunk",
        model: "lease-model",
        choices: [
          {
            index: 0,
            delta: {
              content: `result-${index}|${requestFacts[index]?.url}|${requestFacts[index]?.authorization}`,
            },
            finish_reason: "stop",
          },
        ],
      })}\n\ndata: [DONE]\n\n`,
    );
  };
  const server = createServer((request, response) => {
    request.resume();
    const index = requests.push(response) - 1;
    const apiKey = request.headers["x-api-key"];
    requestFacts.push({
      url: request.url ?? "/",
      authorization:
        request.headers.authorization ?? (typeof apiKey === "string" ? apiKey : undefined),
    });
    arrivals[index]?.resolve();
    if (finishing) {
      finish(response, index);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const pending: Promise<unknown>[] = [];
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Completion fixture did not expose a TCP port");
    }
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: root,
          model: `${fixture.providerId}/lease-model${mode === "auth" ? `@${fixture.providerId}:control` : ""}`,
        },
      },
      models: {
        providers: {
          [fixture.providerId]: {
            api: anthropicReadCancel ? "anthropic-messages" : "openai-completions",
            ...(anthropicReadCancel ? { request: { tls: { insecureSkipVerify: false } } } : {}),
            ...(mode === "auth" ? {} : { apiKey: "fixture-auth-A" }),
            baseUrl: `http://127.0.0.1:${address.port}/A/v1`,
            models: [
              "lease-model",
              ...Array.from({ length: 9 }, (_, index) => `churn-${index}`),
            ].map((id) => ({
              id,
              name: "Lease model",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 8192,
              maxTokens: 1024,
            })),
          },
        },
      },
      plugins: {
        load: { paths: [fixture.rootDir] },
        slots: { memory: "none" },
        entries: { [fixture.pluginId]: { enabled: true } },
      },
    };
    const env = {
      ...createColdPluginHermeticEnv(root, { bundledPluginsDir: roots.makeTempDir() }),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: path.join(root, "state"),
    };
    await withEnvAsync(env, async () => {
      const create = vi.spyOn(ModelRegistry, "create");
      const fork = vi.spyOn(ModelRegistry.prototype, "fork");
      const setRuntimeKey = vi.spyOn(AuthStorage.prototype, "setRuntimeApiKey");
      const resolveModel = modelResolution.resolveModelAsync;
      const resolver = vi.spyOn(modelResolution, "resolveModelAsync");
      const drainMode = mode === "callback-drain" || mode === "cancel-drain" || anthropicReadCancel;
      const bodyReadStarted = createDeferred();
      const foreignWork = new AsyncWorkScope();
      let cancelledInOrigin = false;
      const workStarted = createDeferred();
      let acceptedWorkStarted = false;
      let nestedPreparationCompleted = false;
      let nestedPreparationFailure: string | undefined;
      const finishWork = createDeferred();
      const workSettled = createDeferred();
      const parentWork = new AsyncWorkScope();
      let parentDrain: Promise<void> | undefined;
      let parentDrained = false;
      const sdkHosts = [
        new LegacyPluginSdkResourceHost(),
        new LegacyPluginSdkResourceHost(),
        new LegacyPluginSdkResourceHost(),
        new LegacyPluginSdkResourceHost(),
      ] as const;
      const prepareStarted = createDeferred();
      const finishPrepare = createDeferred();
      const responseFailure = new Error("fixture response callback failure");
      const cancellationFailure = new Error("fixture cancellation failure");
      const transportSpies: Array<{ mockRestore: () => void }> = [];
      if (drainMode || mode === "nested-prepare") {
        const { configureAiTransportRuntimeHost } =
          await import("../../agents/ai-transport-runtime-host.js");
        configureAiTransportRuntimeHost();
        const pluginHost = getAiTransportHost().plugin;
        const wrap = pluginHost.wrapSimpleCompletionStream;
        let responses = 0;
        transportSpies.push(
          vi.spyOn(pluginHost, "wrapSimpleCompletionStream").mockImplementation((params) => {
            const stream = wrap(params) ?? params.context.streamFn;
            return (model, context, options) =>
              stream(model, context, {
                ...options,
                onResponse: async (response, responseModel) => {
                  await options?.onResponse?.(response, responseModel);
                  if (++responses !== 1 || anthropicReadCancel) {
                    return;
                  }
                  if (mode === "nested-prepare") {
                    const nested = await prepareSimpleCompletionModelForAgent({
                      cfg,
                      agentId: "main",
                    }).catch((error: unknown) => {
                      nestedPreparationFailure =
                        error instanceof Error ? error.message : "Non-Error preparation failure";
                      throw error;
                    });
                    if ("error" in nested) {
                      throw new Error(nested.error);
                    }
                    nestedPreparationCompleted = true;
                    return;
                  }
                  if (mode === "cancel-drain") {
                    throw responseFailure;
                  }
                  acceptedWorkStarted = true;
                  workStarted.resolve();
                  try {
                    await finishWork.promise;
                  } finally {
                    workSettled.resolve();
                  }
                },
              });
          }),
        );
        if (mode === "cancel-drain" || anthropicReadCancel) {
          const realFetch = globalThis.fetch;
          let wrappedResponse = false;
          transportSpies.push(
            vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
              const origin = getAsyncWorkSignal();
              const response = await realFetch(...args);
              if (
                wrappedResponse ||
                !response.url.startsWith(`http://127.0.0.1:${address.port}/`)
              ) {
                return response;
              }
              wrappedResponse = true;
              const reader = response.body?.getReader();
              if (!reader) {
                throw new Error("Fixture provider response has no body");
              }
              let reads = 0;
              return new Response(
                new ReadableStream<Uint8Array>({
                  async pull(controller) {
                    if (++reads === 2) {
                      bodyReadStarted.resolve();
                    }
                    const { value, done } = await reader.read();
                    if (done) {
                      controller.close();
                    } else {
                      controller.enqueue(value);
                    }
                  },
                  async cancel(reason) {
                    cancelledInOrigin = getAsyncWorkSignal() === origin;
                    acceptedWorkStarted = true;
                    workStarted.resolve();
                    try {
                      await finishWork.promise;
                      throw cancellationFailure;
                    } finally {
                      try {
                        await reader.cancel(reason);
                      } finally {
                        workSettled.resolve();
                      }
                    }
                  },
                }),
                { status: response.status, headers: response.headers },
              );
            }),
          );
        }
      }
      let currentConfig = cfg;
      const llm = createRuntimeLlm({ getConfig: () => currentConfig });
      const input = (modelId = "lease-model") => ({
        config: cfg,
        agentId: "main",
        agentDir: resolveAgentDir(cfg, "main"),
        workspaceDir: root,
        loadRuntimePlugins: true,
        runtimePluginSelections: [{ provider: fixture.providerId, modelId, agentId: "main" }],
      });
      const publishAuth = (key: string) =>
        setRuntimeAuthProfileStoreSnapshot(
          {
            version: 1,
            profiles: {
              [`${fixture.providerId}:control`]: {
                type: "api_key",
                provider: fixture.providerId,
                key,
              },
            },
          },
          input().agentDir,
        );
      if (mode === "auth") {
        publishAuth("fixture-auth-A");
      }
      if (mode === "lru") {
        await refreshPreparedModelRuntimeSnapshots(cfg, {
          gatewayLifecycle: true,
          catalogMode: "static",
        });
      }
      const retained =
        mode === "config" || mode === "auth"
          ? await acquireAgentRunPreparedModelRuntime(input(), { catalogMode: "static" })
          : undefined;
      const start = (index: number, signal?: AbortSignal) => {
        const completion = llm.complete({
          messages: [{ role: "user", content: `request-${index}` }],
          ...(signal ? { signal } : {}),
        });
        pending.push(completion);
        return completion;
      };
      const waitForRequest = (index: number, completion: Promise<unknown>) =>
        Promise.race([
          arrivals[index]!.promise,
          completion.then(() => {
            throw new Error(`Completion ${index} settled before its provider request`);
          }),
        ]);
      try {
        if (sdk) {
          const [firstHost, secondHost, thirdHost, foreignHost] = sdkHosts;
          await foreignHost.close();
          const prepare = (host: LegacyPluginSdkResourceHost, gated = false) =>
            host.run(() =>
              prepareSimpleCompletionModelForAgent({
                cfg: currentConfig,
                agentId: "main",
                ...(gated
                  ? {
                      modelResolver: async (...args) => {
                        const resolved = await resolveModel(...args);
                        prepareStarted.resolve();
                        await finishPrepare.promise;
                        return resolved;
                      },
                    }
                  : {}),
              }),
            );
          if (mode === "late-prepare") {
            const preparing = prepare(firstHost, true);
            pending.push(preparing);
            await Promise.race([
              prepareStarted.promise,
              preparing.then(() => {
                throw new Error("SDK preparation did not enter the real model resolver");
              }),
            ]);
            const firstBuilds = create.mock.calls.length;
            expect(firstBuilds).toBeGreaterThan(0);
            let closed = false;
            const closing = firstHost.close().then(() => {
              closed = true;
            });
            const overlapping = await prepare(secondHost);
            expect(overlapping).not.toHaveProperty("error");
            await secondHost.close();
            expect.soft(closed).toBe(false);
            finishPrepare.resolve();
            await expect(preparing.then(() => undefined)).rejects.toThrow(
              "Plugin SDK resource host is closed",
            );
            await closing;
            const next = await prepare(thirdHost);
            expect(next).not.toHaveProperty("error");
            expect(create.mock.calls.length).toBe(firstBuilds + 1);
            expect(requests).toHaveLength(0);
            return;
          }
          if (mode === "dispatch-close" || mode === "current-check") {
            const prepared = await prepare(firstHost);
            if ("error" in prepared) {
              throw new Error(prepared.error);
            }
            const callerFailure = new Error("Caller completion authority closed");
            const completion = completeWithPreparedSimpleCompletionModel({
              ...prepared,
              context: { messages: [{ role: "user", content: "check dispatch", timestamp: 0 }] },
              assertCurrent:
                mode === "current-check"
                  ? () => {
                      throw callerFailure;
                    }
                  : undefined,
            });
            pending.push(completion);
            const closing = mode === "dispatch-close" ? firstHost.close() : undefined;
            await Promise.race([
              mode === "current-check"
                ? expect(completion).rejects.toBe(callerFailure)
                : expect(completion).rejects.toThrow("Plugin SDK resource host is closed"),
              arrivals[0]!.promise.then(() => {
                throw new Error("Closed completion reached the provider");
              }),
            ]);
            await closing;
            expect(requests).toHaveLength(0);
            return;
          }
          const preparedModels: Array<
            Parameters<typeof completeWithPreparedSimpleCompletionModel>[0]
          > = [];
          const startSdk = (
            index: number,
            host: LegacyPluginSdkResourceHost,
            signal?: AbortSignal,
          ) => {
            const completion = (async () => {
              const prepared = await prepare(host);
              if ("error" in prepared) {
                throw new Error(prepared.error);
              }
              expect(Object.keys(prepared).toSorted()).toEqual(["auth", "model", "selection"]);
              const runtime = getModelLlmRuntime(prepared.model);
              if (!runtime) {
                throw new Error("SDK preparation did not bind its real model runtime");
              }
              const execution = {
                ...prepared,
                // Legitimate transport copies must carry the original completion owner.
                model: bindModelLlmRuntime(prepared.model, runtime),
                context: {
                  messages: [{ role: "user" as const, content: `request-${index}`, timestamp: 0 }],
                },
                options: { signal },
              };
              preparedModels.push(execution);
              const message = await foreignHost.run(() =>
                completeWithPreparedSimpleCompletionModel(execution),
              );
              return { text: extractAssistantText(message) };
            })();
            pending.push(completion);
            return completion;
          };
          const controller = mode === "callback-drain" ? new AbortController() : undefined;
          const first = startSdk(0, firstHost, controller?.signal);
          await waitForRequest(0, first);
          const firstBuilds = create.mock.calls.length;
          expect(firstBuilds).toBeGreaterThan(0);
          let closed = false;
          let closing: Promise<void> | undefined;
          if (drainMode) {
            finish(requests[0]!, 0);
            await Promise.race([
              workStarted.promise,
              first.then(() => {
                throw new Error("SDK completion settled before accepted work");
              }),
            ]);
            controller?.abort();
            await expect(first).resolves.toMatchObject({ text: "" });
            closing = firstHost.close().then(() => {
              closed = true;
            });
          }
          if (mode === "config") {
            currentConfig = {
              ...cfg,
              models: {
                providers: {
                  [fixture.providerId]: {
                    ...cfg.models!.providers![fixture.providerId]!,
                    baseUrl: `http://127.0.0.1:${address.port}/B/v1`,
                    apiKey: "fixture-auth-B",
                  },
                },
              },
            };
          }
          if (mode === "auth") {
            publishAuth("fixture-auth-B");
            await prepareModelRuntimeSnapshot(input());
          }
          const second = startSdk(1, secondHost);
          await waitForRequest(1, second);
          if (mode === "overlap" || drainMode) {
            expect.soft(create.mock.calls.length).toBe(firstBuilds);
          }
          expect(fork.mock.calls).toHaveLength(2);
          expect(fork.mock.calls[0]![0]).not.toBe(fork.mock.calls[1]![0]);
          if (drainMode) {
            expect.soft(closed).toBe(false);
            finishWork.resolve();
            await workSettled.promise;
            await closing;
          } else {
            finish(requests[0]!, 0);
            const firstResult = await first;
            expect(nestedPreparationFailure).toBeUndefined();
            expect(firstResult).toMatchObject({
              text: "result-0|/A/v1/chat/completions|Bearer fixture-auth-A",
            });
          }
          if (mode === "nested-prepare") {
            expect(nestedPreparationCompleted).toBe(true);
          }
          finish(requests[1]!, 1);
          await expect(second).resolves.toMatchObject({
            text: `result-1|/${mode === "config" ? "B" : "A"}/v1/chat/completions|Bearer fixture-auth-${mode === "config" || mode === "auth" ? "B" : "A"}`,
          });
          await firstHost.close();
          await secondHost.close();
          const staleCompletion = completeWithPreparedSimpleCompletionModel({
            ...preparedModels[0]!,
            options: {},
          });
          pending.push(staleCompletion);
          await Promise.race([
            expect(staleCompletion).rejects.toThrow("Plugin SDK resource host is closed"),
            arrivals[2]!.promise.then(() => {
              throw new Error("Closed SDK model reached the provider");
            }),
          ]);
          expect(requests).toHaveLength(2);
          if (mode === "config" || mode === "auth") {
            return;
          }
          const beforeThird = create.mock.calls.length;
          const third = startSdk(2, thirdHost);
          await waitForRequest(2, third);
          expect(create.mock.calls.length).toBe(beforeThird + 1);
          finish(requests[2]!, 2);
          await third;
          return;
        }
        if (mode === "fork" || mode === "prepare-error" || mode === "prepare-throw") {
          if (mode === "fork") {
            fork.mockImplementationOnce(() => {
              throw new Error("fixture store fork failure");
            });
          }
          if (mode === "prepare-throw") {
            setRuntimeKey.mockImplementationOnce(() => {
              throw new Error("fixture preparation failure");
            });
          }
          if (mode === "prepare-error") {
            resolver.mockImplementationOnce(async (...args) => ({
              ...(await resolveModel(...args)),
              model: undefined,
              error: "fixture model preparation unavailable",
            }));
          }
          const unexpectedRequest = createDeferred<never>();
          const rejectProviderRequest = () =>
            unexpectedRequest.reject(
              new Error("Preparation failure unexpectedly reached the provider"),
            );
          server.once("request", rejectProviderRequest);
          const failed = start(0);
          try {
            await Promise.race([
              expect(failed).rejects.toThrow(
                mode === "fork"
                  ? "fixture store fork failure"
                  : mode === "prepare-throw"
                    ? "fixture preparation failure"
                    : "Plugin LLM completion failed:",
              ),
              unexpectedRequest.promise,
            ]);
          } finally {
            server.removeListener("request", rejectProviderRequest);
          }
          expect(requests).toHaveLength(0);
          const buildsAfterFailure = create.mock.calls.length;
          expect(buildsAfterFailure).toBeGreaterThan(0);
          const next = start(0);
          await waitForRequest(0, next);
          expect.soft(create.mock.calls.length).toBe(buildsAfterFailure + 1);
          finish(requests[0]!, 0);
          await expect(next).resolves.toMatchObject({
            text: "result-0|/A/v1/chat/completions|Bearer fixture-auth-A",
          });
          return;
        }
        const abortController =
          mode === "abort" || mode === "callback-drain" || anthropicReadCancel
            ? new AbortController()
            : undefined;
        const firstStarted = performance.now();
        const first = drainMode
          ? parentWork.track(() => start(0, abortController?.signal))
          : start(0, abortController?.signal);
        await waitForRequest(0, first);
        const firstPreparationMs = performance.now() - firstStarted;
        const firstBuilds = create.mock.calls.length;
        expect(firstBuilds).toBeGreaterThan(0);
        if (drainMode) {
          finish(requests[0]!, 0);
          if (anthropicReadCancel) {
            await bodyReadStarted.promise;
            await new Promise<void>((resolve) => {
              setImmediate(resolve);
            });
            foreignWork.run(() => abortController?.abort(new Error("foreign cancellation")));
          }
          await Promise.race([
            workStarted.promise,
            first.then(() => {
              throw new Error("Completion settled before accepted fixture work");
            }),
          ]);
          abortController?.abort();
          await expect(first).resolves.toMatchObject({ text: "" });
          parentDrain = parentWork.drain().then(() => {
            parentDrained = true;
          });
          const second = start(1);
          await waitForRequest(1, second);
          expect.soft(parentDrained).toBe(false);
          if (anthropicReadCancel) {
            expect.soft(cancelledInOrigin).toBe(true);
            await foreignWork.drain();
          }
          expect.soft(create.mock.calls.length).toBe(firstBuilds);
          expect(fork.mock.calls).toHaveLength(2);
          expect(fork.mock.calls[0]![0]).not.toBe(fork.mock.calls[1]![0]);
          finishWork.resolve();
          await workSettled.promise;
          await parentDrain;
          expect(parentDrained).toBe(true);
          finish(requests[1]!, 1);
          await expect(second).resolves.toMatchObject({
            text: anthropicReadCancel
              ? "result-1|/A/v1/messages|fixture-auth-A"
              : "result-1|/A/v1/chat/completions|Bearer fixture-auth-A",
          });
          const buildsAfterSecond = create.mock.calls.length;
          const third = start(2);
          await waitForRequest(2, third);
          expect(create.mock.calls.length).toBe(buildsAfterSecond + 1);
          finish(requests[2]!, 2);
          await expect(third).resolves.toMatchObject({
            text: anthropicReadCancel
              ? "result-2|/A/v1/messages|fixture-auth-A"
              : "result-2|/A/v1/chat/completions|Bearer fixture-auth-A",
          });
          return;
        }
        if (mode === "provider-error" || mode === "abort") {
          if (abortController) {
            abortController.abort();
          } else {
            requests[0]!.writeHead(400, { "content-type": "application/json" });
            requests[0]!.end(
              JSON.stringify({
                error: { message: "fixture provider rejection", type: "invalid_request_error" },
              }),
            );
          }
          await expect(first).resolves.toMatchObject({ text: "" });
          const next = start(1);
          await waitForRequest(1, next);
          expect(create.mock.calls.length).toBe(firstBuilds + 1);
          finish(requests[1]!, 1);
          await expect(next).resolves.toMatchObject({
            text: "result-1|/A/v1/chat/completions|Bearer fixture-auth-A",
          });
          return;
        }
        if (mode === "config") {
          currentConfig = {
            ...cfg,
            models: {
              providers: {
                ...cfg.models?.providers,
                [fixture.providerId]: {
                  ...cfg.models!.providers![fixture.providerId]!,
                  baseUrl: `http://127.0.0.1:${address.port}/B/v1`,
                  apiKey: "fixture-auth-B",
                },
              },
            },
          };
        }
        if (mode === "auth") {
          publishAuth("fixture-auth-B");
          await prepareModelRuntimeSnapshot(input());
        }
        if (mode === "lru") {
          for (let index = 0; index < 9; index += 1) {
            const other = await acquireAgentRunPreparedModelRuntime(input(`churn-${index}`), {
              catalogMode: "static",
            });
            other.release();
          }
        }
        const buildsBeforeSecond = create.mock.calls.length;
        const forksBeforeSecond = fork.mock.calls.length;
        const secondStarted = performance.now();
        const second = start(1);
        await waitForRequest(1, second);
        const secondPreparationMs = performance.now() - secondStarted;
        const secondBuilds = create.mock.calls.length;
        console.info("direct completion owner reuse", {
          mode,
          firstBuilds,
          buildsBeforeSecond,
          secondBuilds,
          firstPreparationMs,
          secondPreparationMs,
        });
        if (mode === "overlap" || mode === "lru") {
          expect.soft(secondBuilds).toBe(buildsBeforeSecond);
        }
        expect(fork.mock.calls.length).toBe(forksBeforeSecond + 1);
        expect(fork.mock.calls[forksBeforeSecond - 1]![0]).not.toBe(
          fork.mock.calls[forksBeforeSecond]![0],
        );
        finish(requests[0]!, 0);
        await expect(first).resolves.toMatchObject({
          text: "result-0|/A/v1/chat/completions|Bearer fixture-auth-A",
        });
        finish(requests[1]!, 1);
        await expect(second).resolves.toMatchObject({
          text: `result-1|/${mode === "config" ? "B" : "A"}/v1/chat/completions|Bearer fixture-auth-${mode === "config" || mode === "auth" ? "B" : "A"}`,
        });
        if (mode === "overlap") {
          const third = start(2);
          await waitForRequest(2, third);
          expect(create.mock.calls.length).toBe(secondBuilds + 1);
          finish(requests[2]!, 2);
          await expect(third).resolves.toMatchObject({
            text: "result-2|/A/v1/chat/completions|Bearer fixture-auth-A",
          });
        }
      } finally {
        finishPrepare.resolve();
        finishWork.resolve();
        finishing = true;
        requests.forEach(finish);
        await Promise.allSettled(pending);
        if (acceptedWorkStarted) {
          await workSettled.promise;
        }
        await parentDrain;
        await parentWork.drain();
        await Promise.all(sdkHosts.map((host) => host.close()));
        await foreignWork.drain();
        for (const spy of transportSpies) {
          spy.mockRestore();
        }
        retained?.release();
        create.mockRestore();
        fork.mockRestore();
        setRuntimeKey.mockRestore();
        resolver.mockRestore();
        await resetPreparedModelRuntimeSnapshotsForTest();
        clearRuntimeAuthProfileStoreSnapshots();
        clearPluginMetadataLifecycleCaches();
        resetPluginLoaderTestStateForTest();
      }
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    roots.cleanup();
  }
});
