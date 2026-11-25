import path from "node:path";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { setHostToolFactoryForTest } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { patchSessionEntry, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { beforeEach, expect, it, vi } from "vitest";
import { loadCodexNativeWebSearchTestFixture } from "../extensions/codex/test-api.js";
import {
  disposeAllSessionMcpRuntimes,
  setSessionMcpRuntimeScheduler,
} from "../src/agents/agent-bundle-mcp-manager-api.js";
import { runBtwSideQuestion } from "../src/agents/btw.js";
import {
  createModelGenerationFixture,
  publishCurrentModelGeneration,
} from "../src/agents/embedded-agent-runner/model.generation-scope.test-support.js";
import { preparePluginHarnessParams } from "../src/agents/harness/plugin-attempt-params.js";
import { registerAgentHarness } from "../src/agents/harness/registry.js";
import * as preparedRuntime from "../src/agents/prepared-model-runtime.js";
import {
  createSubagentSessionStore,
  withPreparedSessionCapabilityRead,
  type SessionCapabilitySnapshot,
} from "../src/agents/subagents/spawn/subagent-session-store.js";
import * as webSearchPolicy from "../src/agents/web-search-tool-policy.js";
import { upsertSessionEntryCore } from "../src/config/sessions/session-accessor.entry.js";
import { replaceSessionEntrySync } from "../src/config/sessions/session-accessor.sqlite-entry.js";
import type { ModelDefinitionConfig } from "../src/config/types.models.js";
import { createDirectChatContext } from "../src/gateway/server-chat.agent-events.test-helpers.js";
import { SessionRowProjectionBinding } from "../src/gateway/session-row-projection-binding.js";
import { createSessionRowCapabilityReader } from "../src/gateway/session-row-projection-identities.js";
import { getTrackedWorkerPoolSnapshot } from "../src/infra/worker-cpu.js";
import { withPluginRuntimeGatewayContextResolver } from "../src/plugins/runtime/gateway-request-scope.js";
import { beginAgentDeletionJournal } from "../src/test-utils/agent-deletion-journal.js";
import { createTestGatewayScheduler } from "../src/test-utils/gateway-scheduler-clock.js";
import type { CodexAttemptRuntime } from "./types/vitest-codex-attempt-runtime.js";

const fixture = await loadCodexNativeWebSearchTestFixture();

beforeEach((context) => {
  let scheduler: ReturnType<typeof createTestGatewayScheduler> | undefined;
  const runtime: CodexAttemptRuntime = {
    readWorkerPools: getTrackedWorkerPoolSnapshot,
    async start() {
      scheduler = createTestGatewayScheduler();
      await setSessionMcpRuntimeScheduler(scheduler);
    },
    async stop() {
      scheduler?.beginClose();
      try {
        await disposeAllSessionMcpRuntimes();
      } finally {
        await scheduler?.stop();
      }
    },
  };
  context.codexAttemptRuntime = runtime;
});
fixture.setupRunAttemptTestHooks();

it.each([
  "unchanged",
  "changed",
  "requester-revoked",
  "requester-reassigned",
  "early-requester-revoked",
  "missing-requester-id-created",
  "late-requester-id-created",
  "late-requester-id-removed",
  "late-requester-id-reassigned",
  "btw-unchanged",
  "btw-requester-revoked",
  "btw-requester-reassigned",
  "model-less",
  "core-btw-host-unchanged",
  "core-btw-host-changed",
  "core-btw-native-only",
  "core-btw-native-unchanged",
  "core-btw-native-to-host",
  "core-btw-host-to-native",
] as const)(
  "binds prepared hosted search to current native authority for transition %s",
  async (scenario) => {
    const tempDir = fixture.tempDir;
    const localPath = (name: string) => path.join(tempDir, name);
    const coreDispatch = scenario.startsWith("core-btw-");
    const nativeOnly = scenario === "core-btw-native-only";
    const nativeAuth = nativeOnly || scenario.startsWith("core-btw-native-");
    const ownershipChanged = scenario.endsWith("-to-host") || scenario.endsWith("-to-native");
    const nativeModel = nativeOnly ? "native-only" : "search-allowed";
    const nativeProvider = nativeOnly ? "ollama" : "openai";
    const sideQuestion = coreDispatch || scenario.startsWith("btw-");
    const modelLess = scenario === "model-less";
    const transition = scenario.replace(/^btw-/, "");
    const params = fixture.createParams(localPath("session.jsonl"), tempDir, {
      sessionKey: `agent:main:dashboard:native-search-${scenario}`,
      sessionId: `native-search-${scenario}`,
      provider: "openai",
      prompt: "Synthetic native search policy proof.",
    });
    params.config = {
      tools: {
        web: { search: { enabled: true } },
        byProvider: { "openai/search-denied": { deny: ["web_search"] } },
      },
    };
    if (coreDispatch) {
      const models = ["search-outer", "search-allowed", "search-changed"].map(
        (id): ModelDefinitionConfig => ({
          id,
          name: id,
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32_000,
          maxTokens: 4_096,
        }),
      );
      params.config.agents = { defaults: { workspace: tempDir } };
      params.config.models = {
        providers: {
          openai: {
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            apiKey: "synthetic-native-dispatch-key",
            models,
          },
        },
      };
    }
    fixture.setCodexTestModelSupportsTools(params, true);
    fixture.setCodexTestToolFactory(params, () => []);
    params.agentDir = localPath("agent");
    const codexHome = localPath("native-codex-home");
    vi.stubEnv("CODEX_HOME", codexHome);
    const scope = {
      agentId: "main",
      sessionKey: params.sessionKey!,
      storePath: resolveStorePath(undefined, { agentId: "main" }),
    };
    await upsertSessionEntryCore(scope, { sessionId: params.sessionId, updatedAt: 1 });
    const close = await fixture.bindProductionHarnessHostCapabilitiesForTest(params);
    try {
      const pluginConfig = {
        appServer: { mode: "guardian" as const, command: process.execPath, args: ["app-server"] },
        supervision: { enabled: true },
      };
      const harness = fixture.createCodexAppServerAgentHarness({
        bindingStore: fixture.testCodexAppServerBindingStore,
        pluginConfig,
      });
      const bindingScope = {
        kind: "session" as const,
        agentId: "main",
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
      };
      const requesterPolicy = {
        spawnedBy: "agent:main:parent",
        spawnDepth: 1,
        inheritedToolPolicyVersion: 1 as const,
        inheritedToolDeny: ["web_search"],
      };
      const revokeRequester = () =>
        patchSessionEntry({
          ...scope,
          update: () => ({
            ...requesterPolicy,
            spawnedBy:
              transition === "requester-reassigned"
                ? "agent:main:other-parent"
                : requesterPolicy.spawnedBy,
            inheritedToolAllow: [],
            inheritedToolDeny: transition === "requester-reassigned" ? [] : ["web_search"],
          }),
        });
      const binding = {
        threadId: "thread-native-search",
        cwd: tempDir,
        historyCoveredThrough: "2026-01-01T00:00:00.000Z",
        ...(coreDispatch && !nativeAuth
          ? {}
          : {
              connectionScope: "supervision" as const,
              supervisionSourceThreadId: "thread-native-search",
            }),
        model: nativeModel,
        modelProvider: nativeProvider,
        preserveNativeModel: true,
        conversationSourceTransferComplete: true,
        rolloutPath: path.join(codexHome, "sessions", "thread-native-search.jsonl"),
        dynamicToolsFingerprint: fixture.codexDynamicToolsFingerprint([]),
        webSearchThreadConfigFingerprint: fixture.fingerprintJsonObject(
          fixture.buildCodexNativeWebSearchThreadConfig(params.config),
        ),
        appServerRuntimeFingerprint:
          fixture.buildCodexSupervisionTestConnectionFingerprint(pluginConfig),
      } satisfies Parameters<typeof fixture.writeCodexAppServerBinding>[1];
      await fixture.writeNativeCatalogFixture(binding.rolloutPath, binding.threadId, []);
      await fixture.writeCodexAppServerBinding(params.sessionFile, binding);
      if (sideQuestion) {
        await fixture.testCodexAppServerBindingStore.mutate(bindingScope, { kind: "set", binding });
      }
      let preparationReply = false;
      let mutation: Promise<void> | undefined;
      // oxlint-disable-next-line typescript/unbound-method -- Calls preserve the intercepted Worker receiver.
      const emit = Worker.prototype.emit;
      const messages = vi.spyOn(Worker.prototype, "emit").mockImplementation(function (
        this: Worker,
        event,
        ...args: unknown[]
      ) {
        const reply = args[0];
        const result = isRecord(reply) && isRecord(reply.value) ? reply.value.value : undefined;
        if (
          event === "message" &&
          transition === "changed" &&
          !preparationReply &&
          isRecord(reply) &&
          reply.status === "ok" &&
          isRecord(result) &&
          (result.kind === "session-entry-read" || result.kind === "session-exact-entries")
        ) {
          preparationReply = true;
          // Delay only delivery of a real worker result while the native owner changes models.
          mutation = (async () => {
            await fixture.writeCodexAppServerBinding(params.sessionFile, {
              ...binding,
              model: "search-denied",
            });
            emit.call(this, event, ...args);
          })();
          return true;
        }
        return emit.call(this, event, ...args);
      });
      let prepared: typeof params;
      const prepare = () =>
        preparePluginHarnessParams(
          params,
          harness,
          false,
          () => {},
          false,
          modelLess ? null : { provider: "openai", model: "search-allowed" },
        );
      try {
        if (coreDispatch) {
          prepared = params;
        } else if (transition === "changed") {
          const readProjection = createSessionRowCapabilityReader({
            state: () => ({ disposed: false, topologyDirty: true }),
            lookup: () => undefined,
            matching: () => [],
          });
          const context = createDirectChatContext({
            sessionRowProjectionOwner: new SessionRowProjectionBinding({}, readProjection),
          });
          beginAgentDeletionJournal({
            agentId: "native-search-retiring",
            operationId: "native-search-preparation",
            agentDir: localPath("retiring-agent"),
            sessionsDir: localPath("retiring-sessions"),
            workspaceDir: localPath("retiring-workspace"),
            deleteFiles: false,
            phase: "draining",
          });
          prepared = await withPluginRuntimeGatewayContextResolver(() => context, prepare);
        } else {
          prepared = await prepare();
        }
        await mutation;
      } finally {
        messages.mockRestore();
      }
      if (transition === "changed") {
        expect(preparationReply).toBe(true);
      }
      if (!modelLess && !coreDispatch) {
        expect(prepared.preparedWebSearchPolicy).toMatchObject({
          allowed: true,
          persistentAllowed: true,
        });
      }
      if (sideQuestion && !coreDispatch && transition !== "unchanged") {
        // Change the requester after core preparation, before native source capture.
        await revokeRequester();
      }
      if (!coreDispatch) {
        expect(prepared.pluginHarnessToolPolicyRestricted).toBe(false);
      }
      if (transition === "early-requester-revoked") {
        await revokeRequester();
        params.hostCapabilities.assertActive();
        expect((await prepare()).preparedWebSearchPolicy).toMatchObject({ allowed: false });
      }
      const missingRequesterId = `native-search-requester-${transition}`;
      const requesterScope = { ...scope, sessionKey: "agent:main:dashboard:id-requester" };
      const lateIdChange = transition.startsWith("late-requester-id-");
      const requesterChangesAtDispatch =
        !sideQuestion &&
        (transition === "requester-revoked" ||
          transition === "requester-reassigned" ||
          transition === "missing-requester-id-created" ||
          lateIdChange);
      if (
        transition === "late-requester-id-removed" ||
        transition === "late-requester-id-reassigned"
      ) {
        await upsertSessionEntryCore(requesterScope, {
          sessionId: missingRequesterId,
          updatedAt: 1,
        });
      }
      if (transition === "missing-requester-id-created" || lateIdChange) {
        // Capture real ID-selector facts; the other cases prepare search policy through its normal path.
        const requesterFacts: SessionCapabilitySnapshot[] = [];
        const requester = await withPreparedSessionCapabilityRead(
          () =>
            createSubagentSessionStore(scope.storePath, scope.agentId).getById(missingRequesterId),
          { onRead: (snapshot) => requesterFacts.push(snapshot) },
        );
        if (
          transition === "missing-requester-id-created" ||
          transition === "late-requester-id-created"
        ) {
          expect(requester).toBeUndefined();
        } else {
          expect(requester).toMatchObject({ sessionId: missingRequesterId });
        }
        expect(requesterFacts).toContainEqual({
          query: {
            agentId: scope.agentId,
            storePath: scope.storePath,
            sessionId: missingRequesterId,
          },
          facts: requester === undefined ? undefined : expect.any(Array),
        });
        prepared = {
          ...prepared,
          preparedWebSearchPolicy: {
            ...prepared.preparedWebSearchPolicy!,
            requesterFacts: [
              ...(prepared.preparedWebSearchPolicy?.requesterFacts ?? []),
              ...requesterFacts,
            ],
          },
        };
      }
      const resolvePolicy = vi.spyOn(webSearchPolicy, "resolveWebSearchToolPolicy");
      const threadResult = (
        threadId: string,
        model: string = nativeModel,
        modelProvider: string = nativeProvider,
      ) => ({
        ...fixture.threadStartResult(threadId, { cwd: tempDir }),
        model,
        modelProvider,
      });
      const staticReplies = new Map<string, unknown>([
        ["modelProvider/capabilities/read", { imageGeneration: false, webSearch: true }],
        ["config/read", { config: {}, origins: {}, layers: [] }],
        ["configRequirements/read", { requirements: null }],
        ...["skills/list", "thread/backgroundTerminals/list"].map((method): [string, unknown] => [
          method,
          { data: [], nextCursor: null },
        ]),
      ]);
      const wire = await fixture.createLeasedCodexLifecycleHarness({
        agentDir: localPath("wire-agent"),
        codexHome,
        persistedThreads: [threadResult(binding.threadId)],
        respond(method) {
          if (method === "thread/resume") {
            return threadResult(
              binding.threadId,
              transition === "changed" ? "search-denied" : "search-allowed",
              "openai",
            );
          }
          if (method === "thread/fork") {
            const response = threadResult("side-thread");
            wire.seed(response, { loaded: true, subscribed: true });
            return response;
          }
          if (method === "turn/start") {
            if (sideQuestion) {
              queueMicrotask(() => completeTurn("side-thread", true));
            }
            return fixture.turnStartResult();
          }
          return staticReplies.get(method) ?? {};
        },
      });
      function completeTurn(threadId: string, answer = false) {
        return wire.notify({
          method: "turn/completed",
          params: {
            threadId,
            turn: {
              id: "turn-1",
              status: "completed",
              items: answer
                ? [{ id: "answer", type: "agentMessage", text: "Synthetic answer." }]
                : [],
            },
          },
        });
      }
      vi.spyOn(fixture.CodexAppServerClient, "start").mockResolvedValue(wire.client);
      fixture.setCodexAppServerClientFactoryForTest(async (_start, _auth, _dir, _config, options) =>
        fixture.getLeasedSharedCodexAppServerClient({
          ...options,
          ...wire.acquireOptions,
          preparedAuth: undefined,
          authRequirement: undefined,
        }),
      );
      let requesterChanged = false;
      if (requesterChangesAtDispatch) {
        const dispatch = fixture.CodexAppServerClient.prototype.request.bind(wire.client);
        wire.request.mockImplementation((method, body, options) =>
          method !== "thread/resume"
            ? dispatch(method, body, options)
            : dispatch(method, body, {
                ...options,
                withCurrent: async (write) => {
                  if (lateIdChange) {
                    expect(options?.withCurrent).toBeTypeOf("function");
                    await options!.withCurrent!(() => {
                      // All async rechecks/admission have finished; the physical write still checks its source.
                      replaceSessionEntrySync(
                        transition === "late-requester-id-reassigned"
                          ? { ...scope, sessionKey: "agent:main:dashboard:earlier-requester" }
                          : requesterScope,
                        {
                          sessionId:
                            transition === "late-requester-id-removed"
                              ? "replacement-requester"
                              : missingRequesterId,
                          updatedAt: 2,
                        },
                      );
                      requesterChanged = true;
                      write();
                    });
                    return;
                  }
                  if (!requesterChanged) {
                    if (transition === "missing-requester-id-created") {
                      await upsertSessionEntryCore(
                        { ...scope, sessionKey: "agent:main:dashboard:new-requester" },
                        { ...requesterPolicy, sessionId: missingRequesterId, updatedAt: 2 },
                      );
                    } else {
                      await revokeRequester();
                    }
                    requesterChanged = true;
                    params.hostCapabilities.assertActive();
                  }
                  if (options?.withCurrent) {
                    await options.withCurrent(write);
                  } else {
                    write();
                  }
                },
              }),
        );
      }
      const sideContext = {
        cfg: params.config!,
        agentDir: params.agentDir!,
        agentId: "main",
        provider: "openai",
        sessionKey: params.sessionKey,
        storePath: scope.storePath,
        isNewSession: false,
        resolvedReasoningLevel: "off" as const,
      };
      const sideParams = {
        ...sideContext,
        model: "search-allowed",
        runtimeModel: params.model,
        question: "Synthetic side question.",
        sessionEntry: { sessionId: params.sessionId, updatedAt: 1 },
        sessionId: params.sessionId,
        sessionFile: params.sessionFile,
        workspaceDir: tempDir,
        hostCapabilities: params.hostCapabilities,
        preparedWebSearchPolicy: prepared.preparedWebSearchPolicy,
        preparedRuntimeAuth: {
          plan: {
            providerForAuth: "openai",
            authProfileProviderForAuth: "openai",
            selectedAuthMode: "api-key" as const,
          },
          authStorage: params.authStorage,
          authProfileStore: params.authProfileStore,
          modelRegistry: params.modelRegistry,
        },
      };
      let coreRun: ReturnType<typeof runBtwSideQuestion> | undefined;
      let coreInput: Parameters<NonNullable<typeof harness.runSideQuestion>>[0] | undefined;
      let coreToolOptions: unknown;
      if (coreDispatch) {
        const generation = createModelGenerationFixture({
          agentDir: params.agentDir!,
          workspaceDir: tempDir,
          config: params.config!,
          label: "native-btw-host",
          provider: "openai",
          requestProvider: "openai",
          modelId: "search-allowed",
          runtimeApi: "openai-responses",
          runtimeBaseUrl: "https://api.openai.com/v1",
        });
        generation.pluginRegistry.providers[0]!.provider.resolveDynamicModel = (context) => ({
          ...params.model,
          id: context.modelId,
          provider: context.provider,
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
        });
        publishCurrentModelGeneration(generation);
        vi.spyOn(preparedRuntime, "acquirePublishedPreparedModelRuntime").mockResolvedValue({
          snapshot: generation.preparedModelRuntime,
          pluginGeneration: {
            remoteCatalog: null,
            pluginMetadataSnapshot: generation.metadataSnapshot,
            inlineProviderModels: [],
            configuredCatalogEntries: [],
            pluginRegistry: generation.pluginRegistry,
          },
          run: <T>(run: () => T): T => run(),
          [Symbol.asyncDispose]: async () => {},
        });
        await setHostToolFactoryForTest({ runId: "native-btw-core" }, (options) => {
          coreToolOptions = options;
          return [];
        });
        const dispatch = vi.fn(
          async (input: Parameters<NonNullable<typeof harness.runSideQuestion>>[0]) => {
            coreInput = input;
            if (scenario === "core-btw-host-changed") {
              await fixture.testCodexAppServerBindingStore.mutate(bindingScope, {
                kind: "set",
                binding: { ...binding, model: "search-changed" },
              });
            }
            if (ownershipChanged) {
              expect(
                await fixture.testCodexAppServerBindingStore.mutate(bindingScope, {
                  kind: "patch",
                  threadId: binding.threadId,
                  patch: {
                    connectionScope: nativeAuth ? undefined : "supervision",
                    supervisionSourceThreadId: nativeAuth ? undefined : binding.threadId,
                  },
                }),
              ).toBe(true);
            }
            return await harness.runSideQuestion!(input);
          },
        );
        registerAgentHarness({ ...harness, runSideQuestion: dispatch });
        coreRun = runBtwSideQuestion({
          ...sideContext,
          model: "search-outer",
          question: "Synthetic core side question.",
          sessionEntry: {
            sessionId: params.sessionId,
            sessionFile: params.sessionFile,
            updatedAt: 1,
            agentHarnessId: "codex",
            modelSelectionLocked: true,
          },
          authorityRunId: "native-btw-core",
        });
      }
      const run =
        coreRun ??
        (sideQuestion
          ? fixture.runCodexAppServerSideQuestion(sideParams, {
              pluginConfig,
              bindingStore: fixture.testCodexAppServerBindingStore,
              nativeHookRelay: { enabled: false },
            })
          : fixture.runCodexAppServerAttempt(prepared, { pluginConfig }));
      const complete =
        "waitForTurnAccepted" in run
          ? run.waitForTurnAccepted().then(
              () => completeTurn(binding.threadId),
              () => {},
            )
          : Promise.resolve();
      const outcome = await run.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await complete;
      const requests = wire.writes.map(
        (line) => JSON.parse(line) as { method: string; params?: unknown },
      );
      const nativeWrites = requests.filter(({ method }) =>
        ["thread/resume", "thread/start", "thread/fork", "turn/start"].includes(method),
      );
      const nativeSearch = nativeWrites
        .filter(({ method }) => method !== "turn/start")
        .map(({ params: requestParams }) =>
          isRecord(requestParams) && isRecord(requestParams.config)
            ? requestParams.config.web_search
            : undefined,
        );
      if (modelLess) {
        // A supervised cached-search thread may refuse a disabled policy replacement.
        expect(nativeSearch.every((mode) => mode === "disabled")).toBe(true);
        if ("error" in outcome) {
          expect(outcome.error).toMatchObject({
            message: expect.stringMatching(/web.search configuration|prepared.*policy/),
          });
          expect(nativeWrites).toEqual([]);
        } else {
          expect(nativeSearch.length).toBeGreaterThan(0);
          expect(nativeWrites.filter(({ method }) => method === "turn/start")).toHaveLength(1);
        }
      } else if (
        ownershipChanged ||
        (transition !== "unchanged" &&
          scenario !== "core-btw-host-unchanged" &&
          scenario !== "core-btw-native-unchanged" &&
          !nativeOnly)
      ) {
        expect(outcome).toMatchObject({
          error: {
            message: expect.stringMatching(
              ownershipChanged || scenario === "core-btw-host-changed"
                ? /Codex native session ownership is missing or changed/
                : transition === "changed"
                  ? /Native model changed after web search policy preparation/
                  : /policy changed|superseded|no longer active/,
            ),
          },
        });
        expect(nativeWrites).toEqual([]);
        if (requesterChangesAtDispatch) {
          expect(requesterChanged).toBe(true);
        }
      } else {
        expect(outcome).not.toHaveProperty("error");
        expect(
          nativeWrites.find(
            ({ method }) => method === (sideQuestion ? "thread/fork" : "thread/resume"),
          )?.params,
        ).toMatchObject({ config: { web_search: nativeOnly ? "disabled" : "cached" } });
        expect(nativeWrites.filter(({ method }) => method === "turn/start")).toHaveLength(1);
        if (!sideQuestion && !modelLess) {
          expect(resolvePolicy).not.toHaveBeenCalled();
        }
      }
      if (coreDispatch) {
        if (scenario === "core-btw-host-unchanged") {
          expect(coreToolOptions).toMatchObject({
            modelApi: "openai-responses",
            modelContextWindowTokens: 32_000,
          });
        }
        const modelRoute = {
          provider: nativeProvider,
          modelId: nativeModel,
          authRequirement: "api-key",
        };
        expect(coreInput).toMatchObject({
          runtimeModel: { provider: nativeProvider, id: nativeModel },
          preparedRuntimeAuth: {
            plan: {
              providerForAuth: nativeProvider,
              modelId: nativeModel,
              ...(nativeAuth ? { harnessAuthProvider: "openai" } : { modelRoute }),
            },
          },
          preparedWebSearchPolicy: {
            allowed: true,
            modelRef: { provider: nativeProvider, model: nativeModel },
          },
        });
        if (nativeAuth) {
          expect(coreInput?.preparedRuntimeAuth.resolvedApiKey).toBeUndefined();
          expect(coreInput?.preparedRuntimeAuth.authProfileStore.profiles).toEqual({});
          expect(coreInput?.preparedRuntimeAuth.plan.modelRoute).toBeUndefined();
        }
      }
    } finally {
      close();
    }
  },
);
