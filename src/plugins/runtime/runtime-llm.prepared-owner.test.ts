import fs from "node:fs";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getAiTransportHost } from "@openclaw/ai";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { resolveAgentDir } from "../../agents/agent-scope-config.js";
import { prepareSharedAuthStoreOwnershipForNative } from "../../agents/auth-profiles/path-resolve.native.js";
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
import * as preparedRuntimes from "../../agents/prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../../agents/prepared-model-runtime.test-support.js";
import { AuthStorage } from "../../agents/sessions/auth-storage.js";
import { ModelRegistry } from "../../agents/sessions/model-registry.js";
import { acquireSimpleCompletionModelForAgent } from "../../agents/simple-completion-runtime.js";
import {
  assertPrepared,
  completionContext,
  completionModelDefinition,
  startCompletionServer,
} from "../../agents/simple-completion.test-support.js";
import type { ModelProviderConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { bindModelLlmRuntime, getModelLlmRuntime } from "../../llm/model-runtime-binding.js";
import {
  completeWithPreparedSimpleCompletionModel,
  extractAssistantText,
  prepareSimpleCompletionModelForAgent,
} from "../../plugin-sdk/simple-completion-runtime.js";
import {
  AsyncWorkScope,
  captureAsyncWorkTracker,
  getAsyncWorkSignal,
} from "../../shared/async-work-scope.js";
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

function waitForWork(
  started: Promise<unknown>,
  completion: Promise<unknown>,
  message = "Completion settled before accepted work",
) {
  return Promise.race([
    started,
    completion.then(() => {
      throw new Error(message);
    }),
  ]);
}

const nextTurn = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

it.each([
  "setup-success",
  "setup-error",
  "sdk-setup-error",
  "sdk-setup-close",
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
  const setupMode = mode.startsWith("setup-");
  const setupKey = "__openclawCompletionSetupProof";
  const anthropicReadCancel = mode === "anthropic-read-cancel";
  const roots = createSyncSuiteTempRootTracker("runtime-llm-prepared-owner");
  const root = fs.realpathSync(roots.makeTempDir());
  fs.mkdirSync(path.join(root, "provider"));
  const fixture = createColdPluginFixture({
    rootDir: path.join(root, "provider"),
    pluginId: "completion-lease-fixture",
    providerId: "completion-lease-provider",
  });
  const profileId = `${fixture.providerId}:control`;
  fs.writeFileSync(
    fixture.runtimeSource,
    `module.exports = {
      id: ${JSON.stringify(fixture.pluginId)},
      register(api) {
        const setup = globalThis[${JSON.stringify(setupKey)}];
        if (setup) {
          const file = require("node:path").join(setup.stateDir, "setup-" + (++setup.count) + ".sqlite");
          const db = new (require("node:sqlite").DatabaseSync)(file);
          db.exec("CREATE TABLE observations (value INTEGER); INSERT INTO observations VALUES (42)");
          const record = { file, disposed: 0, read: () => db.prepare("SELECT value FROM observations").get().value, close: setup.deferred() };
          api.registerRuntimeLifecycle({ id: "setup-db", dispose() { record.disposed++; db.close(); record.close.resolve(); } });
          api.registerProvider({ id: ${JSON.stringify(fixture.providerId)}, label: "Lease fixture", auth: [], prepareRuntimeAuth: () => setup.run(record) });
        } else {
          api.registerProvider({ id: ${JSON.stringify(fixture.providerId)}, label: "Lease fixture", auth: [] });
        }
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
    const text = `result-${index}|${requestFacts[index]?.url}|${requestFacts[index]?.authorization}`;
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
          delta: { type: "text_delta", text },
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
    if (mode === "cancel-drain" && index === 0 && !finishing) {
      // EOF can close the source before cancellation reaches its accepted work.
      response.flushHeaders();
      return;
    }
    response.end(
      `data: ${JSON.stringify({
        id: "completion-lease-response",
        object: "chat.completion.chunk",
        model: "lease-model",
        choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }],
      })}\n\ndata: [DONE]\n\n`,
    );
  };
  const server = await startCompletionServer((request, response) => {
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
  const pending: Promise<unknown>[] = [];
  try {
    const provider: ModelProviderConfig = {
      api: anthropicReadCancel ? "anthropic-messages" : "openai-completions",
      ...(anthropicReadCancel ? { request: { tls: { insecureSkipVerify: false } } } : {}),
      ...(mode === "auth" ? {} : { apiKey: "fixture-auth-A" }),
      baseUrl: `${server.origin}/A/v1`,
      models: ["lease-model", ...Array.from({ length: 9 }, (_, index) => `churn-${index}`)].map(
        (id) => completionModelDefinition({ id, name: "Lease model" }),
      ),
    };
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: root,
          model: `${fixture.providerId}/lease-model${mode === "auth" ? `@${profileId}` : ""}`,
        },
      },
      models: { providers: { [fixture.providerId]: provider } },
      plugins: {
        load: { paths: [fixture.rootDir] },
        slots: { memory: "none" },
        entries: { [fixture.pluginId]: { enabled: true } },
      },
    };
    const completionInput = { cfg, agentId: "main" };
    const env = {
      ...createColdPluginHermeticEnv(root, { bundledPluginsDir: roots.makeTempDir() }),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: path.join(root, "state"),
    };
    await withEnvAsync(env, async () => {
      prepareSharedAuthStoreOwnershipForNative();
      const create = vi.spyOn(ModelRegistry, "fromCapturedSources");
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
      const acceptedWork = async (run: () => Promise<void>) => {
        acceptedWorkStarted = true;
        workStarted.resolve();
        try {
          await run();
        } finally {
          workSettled.resolve();
        }
      };
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
                    const nested = await prepareSimpleCompletionModelForAgent(
                      completionInput,
                    ).catch((error: unknown) => {
                      nestedPreparationFailure =
                        error instanceof Error ? error.message : "Non-Error preparation failure";
                      throw error;
                    });
                    assertPrepared(nested);
                    nestedPreparationCompleted = true;
                    return;
                  }
                  if (mode === "cancel-drain") {
                    throw responseFailure;
                  }
                  await acceptedWork(() => finishWork.promise);
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
              if (wrappedResponse || !response.url.startsWith(`${server.origin}/`)) {
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
                      if (anthropicReadCancel) {
                        // Exercise cancellation ownership without racing fetch's abort error.
                        await finishWork.promise;
                        return;
                      }
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
                    await acceptedWork(async () => {
                      try {
                        await finishWork.promise;
                        throw cancellationFailure;
                      } finally {
                        await reader.cancel(reason);
                      }
                    });
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
      const changeConfig = () => {
        currentConfig = {
          ...cfg,
          models: {
            providers: {
              ...cfg.models?.providers,
              [fixture.providerId]: {
                ...provider,
                baseUrl: `${server.origin}/B/v1`,
                apiKey: "fixture-auth-B",
              },
            },
          },
        };
      };
      const expectedResult = (index: number, changed = false) => ({
        text: `result-${index}|/${changed && mode === "config" ? "B" : "A"}/v1/${anthropicReadCancel ? "messages" : "chat/completions"}|${anthropicReadCancel ? "" : "Bearer "}fixture-auth-${changed && (mode === "config" || mode === "auth") ? "B" : "A"}`,
      });
      const finishResult = async (index: number, completion: Promise<unknown>, changed = false) => {
        finish(requests[index]!, index);
        await expect(completion).resolves.toMatchObject(expectedResult(index, changed));
      };
      const publishAuth = (key: string) =>
        setRuntimeAuthProfileStoreSnapshot(
          {
            version: 1,
            profiles: { [profileId]: { type: "api_key", provider: fixture.providerId, key } },
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
      const [firstHost, secondHost, thirdHost, foreignHost] = sdkHosts;
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
      const preparedModels: Array<Parameters<typeof completeWithPreparedSimpleCompletionModel>[0]> =
        [];
      const completeSdk = async (index: number, signal?: AbortSignal) => {
        const prepared = await prepare(sdkHosts[index]!);
        assertPrepared(prepared);
        expect(Object.keys(prepared).toSorted()).toEqual(["auth", "model", "selection"]);
        const runtime = getModelLlmRuntime(prepared.model);
        if (!runtime) {
          throw new Error("SDK preparation did not bind its real model runtime");
        }
        const execution = {
          ...prepared,
          // Legitimate transport copies must carry the original completion owner.
          model: bindModelLlmRuntime(prepared.model, runtime),
          context: completionContext(`request-${index}`, 0),
          options: { signal },
        };
        preparedModels.push(execution);
        const message = await foreignHost.run(() =>
          completeWithPreparedSimpleCompletionModel(execution),
        );
        return { text: extractAssistantText(message) };
      };
      const start = (index: number, signal?: AbortSignal) => {
        const completion = sdk
          ? completeSdk(index, signal)
          : llm.complete({
              messages: [{ role: "user", content: `request-${index}` }],
              ...(signal ? { signal } : {}),
            });
        pending.push(completion);
        return completion;
      };
      const waitForRequest = (index: number, completion: Promise<unknown>) =>
        waitForWork(
          arrivals[index]!.promise,
          completion,
          `Completion ${index} settled before its provider request`,
        );
      const expectNoRequest = async (rejection: Promise<unknown>, index = 0) => {
        await waitForWork(
          rejection,
          arrivals[index]!.promise,
          "Rejected completion reached provider",
        );
        expect(requests).toHaveLength(index);
      };
      try {
        if (setupMode) {
          type SetupRecord = {
            file: string;
            disposed: number;
            read: () => number;
            close: ReturnType<typeof createDeferred>;
          };
          let record: SetupRecord | undefined;
          let setupTail: Promise<void> | undefined;
          let calls = 0;
          // Use the real already-managed read-only producer; RUN activation is separate.
          transportSpies.push(
            vi
              .spyOn(preparedRuntimes, "acquireAgentRunPreparedModelRuntime")
              .mockImplementation((runtimeInput, options) =>
                preparedRuntimes.acquireReadOnlyPreparedModelRuntime(runtimeInput, {
                  abortSignal: options?.abortSignal,
                  catalogMode: options?.catalogMode ?? "static",
                }),
              ),
          );
          Object.defineProperty(globalThis, setupKey, {
            configurable: true,
            value: {
              stateDir: root,
              count: 0,
              deferred: createDeferred,
              run: async (source: SetupRecord) => {
                if (++calls === 1) {
                  record = source;
                  setupTail = captureAsyncWorkTracker()(async () => {
                    workStarted.resolve();
                    await finishWork.promise;
                    expect(source.read()).toBe(42);
                  });
                  void setupTail.catch(() => {});
                  if (mode === "setup-error") {
                    throw new Error("fixture setup failure");
                  }
                }
                return {};
              },
            },
          });
          const host = sdkHosts[0];
          const first =
            mode === "setup-success"
              ? acquireSimpleCompletionModelForAgent(completionInput).then((acquired) => {
                  assertPrepared(acquired);
                  pending.push(Promise.resolve(acquired[Symbol.asyncDispose]()));
                })
              : sdk
                ? host
                    .run(() => prepareSimpleCompletionModelForAgent(completionInput))
                    .then(() => undefined)
                : start(0).then(() => undefined);
          pending.push(first);
          await waitForWork(workStarted.promise, first);
          if (mode === "setup-error") {
            await expect(first).rejects.toThrow("fixture setup failure");
            expect(requests).toHaveLength(0);
          } else {
            await first;
          }
          if (!record || !setupTail) {
            throw new Error("Missing setup source or descendant");
          }
          await nextTurn();
          expect.soft(record.disposed).toBe(0);
          let hostClosed = false;
          const closing = sdk
            ? host.close().then(() => {
                hostClosed = true;
              })
            : undefined;
          await Promise.resolve();
          if (sdk) {
            expect.soft(hostClosed).toBe(false);
          }
          finishWork.resolve();
          await setupTail;
          await closing;
          await record.close.promise;
          expect(record.disposed).toBe(1);
          const reopened = new DatabaseSync(record.file, { readOnly: true });
          try {
            expect(reopened.prepare("SELECT value FROM observations").get()?.value).toBe(42);
          } finally {
            reopened.close();
          }
          return;
        }
        if (sdk) {
          await foreignHost.close();
          if (mode === "late-prepare") {
            const preparing = prepare(firstHost, true);
            pending.push(preparing);
            await waitForWork(prepareStarted.promise, preparing);
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
            assertPrepared(prepared);
            const callerFailure = new Error("Caller completion authority closed");
            const completion = completeWithPreparedSimpleCompletionModel({
              ...prepared,
              context: completionContext("check dispatch", 0),
              assertCurrent:
                mode === "current-check"
                  ? () => {
                      throw callerFailure;
                    }
                  : undefined,
            });
            pending.push(completion);
            const closing = mode === "dispatch-close" ? firstHost.close() : undefined;
            await expectNoRequest(
              mode === "current-check"
                ? expect(completion).rejects.toBe(callerFailure)
                : expect(completion).rejects.toThrow("Plugin SDK resource host is closed"),
            );
            await closing;
            return;
          }
        }
        if (mode === "fork" || mode === "prepare-error" || mode === "prepare-throw") {
          const failure =
            mode === "fork"
              ? "fixture store fork failure"
              : mode === "prepare-throw"
                ? "fixture preparation failure"
                : "Plugin LLM completion failed:";
          const fail = () => {
            throw new Error(failure);
          };
          if (mode === "fork") {
            fork.mockImplementationOnce(fail);
          }
          if (mode === "prepare-throw") {
            setRuntimeKey.mockImplementationOnce(fail);
          }
          if (mode === "prepare-error") {
            resolver.mockImplementationOnce(async (...args) => ({
              ...(await resolveModel(...args)),
              model: undefined,
              error: "fixture model preparation unavailable",
            }));
          }
          await expectNoRequest(expect(start(0)).rejects.toThrow(failure));
          const buildsAfterFailure = create.mock.calls.length;
          expect(buildsAfterFailure).toBeGreaterThan(0);
          const next = start(0);
          await waitForRequest(0, next);
          expect.soft(create.mock.calls.length).toBe(buildsAfterFailure + 1);
          await finishResult(0, next);
          return;
        }
        const abortController =
          mode === "abort" || mode === "callback-drain" || anthropicReadCancel
            ? new AbortController()
            : undefined;
        const first =
          drainMode && !sdk
            ? parentWork.track(() => start(0, abortController?.signal))
            : start(0, abortController?.signal);
        await waitForRequest(0, first);
        const firstResolved = await resolver.mock.results.at(-1)!.value;
        const firstBuilds = create.mock.calls.length;
        expect(firstBuilds).toBeGreaterThan(0);
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
          await finishResult(1, next);
          return;
        }
        if (drainMode) {
          finish(requests[0]!, 0);
          if (anthropicReadCancel) {
            await bodyReadStarted.promise;
            await nextTurn();
            foreignWork.run(() => abortController?.abort(new Error("foreign cancellation")));
          }
          await waitForWork(workStarted.promise, first);
          abortController?.abort();
          await expect(first).resolves.toMatchObject({ text: "" });
          parentDrain = (sdk ? firstHost.close() : parentWork.drain()).then(() => {
            parentDrained = true;
          });
        }
        if (mode === "config") {
          changeConfig();
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
            await other[Symbol.asyncDispose]();
          }
        }
        const buildsBeforeSecond = create.mock.calls.length;
        const second = start(1);
        await waitForRequest(1, second);
        const secondResolved = await resolver.mock.results.at(-1)!.value;
        const secondBuilds = create.mock.calls.length;
        if (mode === "overlap" || mode === "lru" || drainMode) {
          expect.soft(secondBuilds).toBe(sdk || drainMode ? firstBuilds : buildsBeforeSecond);
        }
        // Published catalog overlays may fork twice while retaining one completion's auth store.
        expect(firstResolved.authStorage).toBeDefined();
        expect(firstResolved.modelRegistry).toBeDefined();
        expect(secondResolved.authStorage).toBeDefined();
        expect(secondResolved.modelRegistry).toBeDefined();
        expect(secondResolved.authStorage).not.toBe(firstResolved.authStorage);
        expect(secondResolved.modelRegistry).not.toBe(firstResolved.modelRegistry);
        if (drainMode) {
          expect.soft(parentDrained).toBe(false);
          if (anthropicReadCancel) {
            expect.soft(cancelledInOrigin).toBe(true);
            await foreignWork.drain();
          }
          finishWork.resolve();
          await workSettled.promise;
          await parentDrain;
          expect(parentDrained).toBe(true);
        } else {
          await finishResult(0, first);
          expect(nestedPreparationFailure).toBeUndefined();
        }
        if (mode === "nested-prepare") {
          expect(nestedPreparationCompleted).toBe(true);
        }
        await finishResult(1, second, true);
        if (sdk) {
          await firstHost.close();
          await secondHost.close();
          const staleCompletion = completeWithPreparedSimpleCompletionModel({
            ...preparedModels[0]!,
            options: {},
          });
          pending.push(staleCompletion);
          await expectNoRequest(
            expect(staleCompletion).rejects.toThrow("Plugin SDK resource host is closed"),
            2,
          );
          if (mode === "config" || mode === "auth") {
            return;
          }
        }
        if (sdk || drainMode || mode === "overlap") {
          const beforeThird = create.mock.calls.length;
          const third = start(2);
          await waitForRequest(2, third);
          expect(create.mock.calls.length).toBe(
            sdk || drainMode ? beforeThird + 1 : secondBuilds + 1,
          );
          await finishResult(2, third);
        }
      } finally {
        Reflect.deleteProperty(globalThis, setupKey);
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
        await retained?.[Symbol.asyncDispose]();
        for (const spy of [create, fork, setRuntimeKey, resolver]) {
          spy.mockRestore();
        }
        await resetPreparedModelRuntimeSnapshotsForTest();
        clearRuntimeAuthProfileStoreSnapshots();
        clearPluginMetadataLifecycleCaches();
        resetPluginLoaderTestStateForTest();
      }
    });
  } finally {
    await server[Symbol.asyncDispose]();
    roots.cleanup();
  }
});
