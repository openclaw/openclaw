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
    const coreDispatch = scenario.startsWith("core-btw-");
    const nativeOnly = scenario === "core-btw-native-only";
    const nativeAuth = nativeOnly || scenario.startsWith("core-btw-native-");
    const ownershipChanged = scenario.endsWith("-to-host") || scenario.endsWith("-to-native");
    const nativeModel = nativeOnly ? "native-only" : "search-allowed";
    const nativeProvider = nativeOnly ? "ollama" : "openai";
    const sideQuestion = coreDispatch || scenario.startsWith("btw-");
    const modelLess = scenario === "model-less";
    const transition = scenario.replace(/^btw-/, "");
    const params = fixture.createParams(
      path.join(fixture.tempDir, "session.jsonl"),
      fixture.tempDir,
      {
        sessionKey: `agent:main:dashboard:native-search-${scenario}`,
        sessionId: `native-search-${scenario}`,
        provider: "openai",
        prompt: "Synthetic native search policy proof.",
      },
    );
    params.config = {
      ...(coreDispatch
        ? {
            agents: { defaults: { workspace: fixture.tempDir } },
            models: {
              providers: {
                openai: {
                  api: "openai-responses" as const,
                  baseUrl: "https://api.openai.com/v1",
                  apiKey: "synthetic-native-dispatch-key",
                  models: ["search-outer", "search-allowed", "search-changed"].map(
                    (id): ModelDefinitionConfig => ({
                      id,
                      name: id,
                      reasoning: true,
                      input: ["text", "image"],
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                      contextWindow: 32_000,
                      maxTokens: 4_096,
                    }),
                  ),
                },
              },
            },
          }
        : {}),
      tools: {
        web: { search: { enabled: true } },
        byProvider: { "openai/search-denied": { deny: ["web_search"] } },
      },
    };
    fixture.setCodexTestModelSupportsTools(params, true);
    fixture.setCodexTestToolFactory(params, () => []);
    params.agentDir = path.join(fixture.tempDir, "agent");
    const codexHome = path.join(fixture.tempDir, "native-codex-home");
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
      const revokeRequester = () =>
        patchSessionEntry({
          ...scope,
          update: () => ({
            spawnedBy:
              transition === "requester-reassigned"
                ? "agent:main:other-parent"
                : "agent:main:parent",
            spawnDepth: 1,
            inheritedToolPolicyVersion: 1,
            inheritedToolAllow: [],
            inheritedToolDeny: transition === "requester-reassigned" ? [] : ["web_search"],
          }),
        });
      const binding = {
        threadId: "thread-native-search",
        cwd: fixture.tempDir,
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
        await fixture.testCodexAppServerBindingStore.mutate(
          {
            kind: "session",
            agentId: "main",
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
          },
          { kind: "set", binding },
        );
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
            if (transition === "changed") {
              await fixture.writeCodexAppServerBinding(params.sessionFile, {
                ...binding,
                model: "search-denied",
              });
            }
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
            agentDir: path.join(fixture.tempDir, "retiring-agent"),
            sessionsDir: path.join(fixture.tempDir, "retiring-sessions"),
            workspaceDir: path.join(fixture.tempDir, "retiring-workspace"),
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
      const wire = await fixture.createLeasedCodexLifecycleHarness({
        agentDir: path.join(fixture.tempDir, "wire-agent"),
        codexHome,
        persistedThreads: [
          {
            ...fixture.threadStartResult(binding.threadId, { cwd: fixture.tempDir }),
            model: nativeModel,
            modelProvider: nativeProvider,
          },
        ],
        respond(method) {
          if (method === "thread/resume") {
            return {
              ...fixture.threadStartResult(binding.threadId, { cwd: fixture.tempDir }),
              model: transition === "changed" ? "search-denied" : "search-allowed",
              modelProvider: "openai",
            };
          }
          if (method === "thread/fork") {
            const response = {
              ...fixture.threadStartResult("side-thread", { cwd: fixture.tempDir }),
              model: nativeModel,
              modelProvider: nativeProvider,
            };
            wire.seed(response, { loaded: true, subscribed: true });
            return response;
          }
          if (method === "turn/start") {
            if (sideQuestion) {
              queueMicrotask(() => {
                wire.notify({
                  method: "turn/completed",
                  params: {
                    threadId: "side-thread",
                    turn: {
                      id: "turn-1",
                      status: "completed",
                      items: [{ id: "answer", type: "agentMessage", text: "Synthetic answer." }],
                    },
                  },
                });
              });
            }
            return fixture.turnStartResult();
          }
          if (method === "modelProvider/capabilities/read") {
            return { imageGeneration: false, webSearch: true };
          }
          if (method === "config/read") {
            return { config: {}, origins: {}, layers: [] };
          }
          if (method === "configRequirements/read") {
            return { requirements: null };
          }
          if (method === "skills/list" || method === "thread/backgroundTerminals/list") {
            return { data: [], nextCursor: null };
          }
          return {};
        },
      });
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
      if (
        !sideQuestion &&
        (transition === "requester-revoked" ||
          transition === "requester-reassigned" ||
          transition === "missing-requester-id-created" ||
          lateIdChange)
      ) {
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
                        {
                          ...scope,
                          sessionKey: "agent:main:dashboard:new-requester",
                        },
                        {
                          sessionId: missingRequesterId,
                          updatedAt: 2,
                          spawnedBy: "agent:main:parent",
                          spawnDepth: 1,
                          inheritedToolPolicyVersion: 1,
                          inheritedToolDeny: ["web_search"],
                        },
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
      const sideParams = {
        cfg: params.config!,
        agentDir: params.agentDir!,
        agentId: "main",
        provider: "openai",
        model: "search-allowed",
        runtimeModel: params.model,
        question: "Synthetic side question.",
        sessionEntry: { sessionId: params.sessionId, updatedAt: 1 },
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        sessionFile: params.sessionFile,
        storePath: scope.storePath,
        workspaceDir: fixture.tempDir,
        isNewSession: false,
        resolvedReasoningLevel: "off" as const,
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
          workspaceDir: fixture.tempDir,
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
              await fixture.testCodexAppServerBindingStore.mutate(
                {
                  kind: "session",
                  agentId: "main",
                  sessionId: params.sessionId,
                  sessionKey: params.sessionKey,
                },
                { kind: "set", binding: { ...binding, model: "search-changed" } },
              );
            }
            if (ownershipChanged) {
              expect(
                await fixture.testCodexAppServerBindingStore.mutate(
                  {
                    kind: "session",
                    agentId: "main",
                    sessionId: params.sessionId,
                    sessionKey: params.sessionKey,
                  },
                  {
                    kind: "patch",
                    threadId: binding.threadId,
                    patch: {
                      connectionScope: nativeAuth ? undefined : "supervision",
                      supervisionSourceThreadId: nativeAuth ? undefined : binding.threadId,
                    },
                  },
                ),
              ).toBe(true);
            }
            return await harness.runSideQuestion!(input);
          },
        );
        registerAgentHarness({ ...harness, runSideQuestion: dispatch });
        coreRun = runBtwSideQuestion({
          cfg: params.config!,
          agentDir: params.agentDir!,
          agentId: "main",
          provider: "openai",
          model: "search-outer",
          question: "Synthetic core side question.",
          sessionEntry: {
            sessionId: params.sessionId,
            sessionFile: params.sessionFile,
            updatedAt: 1,
            agentHarnessId: "codex",
            modelSelectionLocked: true,
          },
          sessionKey: params.sessionKey,
          storePath: scope.storePath,
          resolvedReasoningLevel: "off",
          isNewSession: false,
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
              () =>
                wire.notify({
                  method: "turn/completed",
                  params: {
                    threadId: binding.threadId,
                    turn: { id: "turn-1", status: "completed", items: [] },
                  },
                }),
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
      const nativeWrites = requests.filter(
        ({ method }) =>
          method === "thread/resume" ||
          method === "thread/start" ||
          method === "thread/fork" ||
          method === "turn/start",
      );
      const nativeSearch = nativeWrites
        .filter(({ method }) => method !== "turn/start")
        .map(({ params: requestParams }) =>
          isRecord(requestParams) && isRecord(requestParams.config)
            ? requestParams.config.web_search
            : undefined,
        );
      console.log(
        `[native-search] transition=${scenario} thread-or-turn-writes=${nativeWrites.length} thread-search=${JSON.stringify(nativeSearch)} outcome=${"error" in outcome ? "rejected" : "completed"}`,
      );
      if (coreDispatch && "error" in outcome) {
        console.log(`[native-search] core-error=${String(outcome.error)}`);
      }
      if (ownershipChanged) {
        expect(outcome).toHaveProperty("error");
        expect("error" in outcome && outcome.error).toMatchObject({
          message: expect.stringContaining("Codex native session ownership is missing or changed"),
        });
        expect(nativeWrites).toEqual([]);
      } else if (modelLess) {
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
        transition !== "unchanged" &&
        scenario !== "core-btw-host-unchanged" &&
        scenario !== "core-btw-native-unchanged" &&
        !nativeOnly
      ) {
        expect(outcome).toHaveProperty("error");
        expect("error" in outcome && outcome.error).toMatchObject({
          message: expect.stringMatching(
            scenario === "core-btw-host-changed"
              ? /Codex native session ownership is missing or changed/
              : transition === "changed"
                ? /Native model changed after web search policy preparation/
                : /policy changed|superseded|no longer active/,
          ),
        });
        expect(nativeWrites).toEqual([]);
        if (
          !sideQuestion &&
          (transition === "requester-revoked" ||
            transition === "requester-reassigned" ||
            transition === "missing-requester-id-created" ||
            lateIdChange)
        ) {
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
        expect(coreInput?.runtimeModel).toMatchObject({
          provider: nativeProvider,
          id: nativeModel,
        });
        expect(coreInput?.preparedRuntimeAuth.plan).toMatchObject({
          providerForAuth: nativeProvider,
          modelId: nativeModel,
          ...(nativeAuth
            ? { harnessAuthProvider: "openai" }
            : {
                modelRoute: {
                  provider: nativeProvider,
                  modelId: nativeModel,
                  authRequirement: "api-key",
                },
              }),
        });
        if (nativeAuth) {
          expect(coreInput?.preparedRuntimeAuth.resolvedApiKey).toBeUndefined();
          expect(coreInput?.preparedRuntimeAuth.authProfileStore.profiles).toEqual({});
          expect(coreInput?.preparedRuntimeAuth.plan.modelRoute).toBeUndefined();
        }
        expect(coreInput?.preparedWebSearchPolicy).toMatchObject({
          allowed: true,
          modelRef: { provider: nativeProvider, model: nativeModel },
        });
      }
    } finally {
      close();
    }
  },
);
