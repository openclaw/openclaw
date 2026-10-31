import fs from "node:fs/promises";
import { getAiTransportHost } from "@openclaw/ai";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installPrivateUpdateHandoffStore } from "../../test/helpers/private-update-handoff-store.js";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { disposeAllSessionMcpRuntimes } from "../agents/agent-bundle-mcp-manager-api.js";
import { bindSessionMcpRuntimeTestScheduler } from "../agents/agent-bundle-mcp-manager.test-support.js";
import { providerResponse } from "../agents/embedded-agent-runner.wire.test-support.js";
import { modelDefinition } from "../agents/model-auth.fixtures.test-support.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../agents/prepared-model-runtime.test-support.js";
import { createDefaultDeps } from "../cli/deps.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveAgentMainSessionKey } from "../config/sessions/main-session.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import "../llm/ai-transport-host.js";
import { diffConfigPaths } from "../gateway/config-diff.js";
import { buildGatewayReloadPlan } from "../gateway/config-reload-plan.js";
import { refreshSessionPatchQueuedSelection } from "../gateway/server-methods/sessions-patch-model-selection.js";
import { createHotReloadHandlerTestParams } from "../gateway/server-reload-handlers.config.test-support.js";
import { createGatewayReloadHandlers } from "../gateway/server-reload-hot.js";
import { registerInternalHook, unregisterInternalHook } from "../hooks/internal-hooks.js";
import { formatErrorMessage } from "../infra/errors.js";
import * as globalHooks from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-fixtures.js";
import {
  requireActivePluginChannelRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { closeSessionControllerAdmission } from "../sessions/session-controller.lifecycle.js";
import { resetSessionControllerStateForTest } from "../sessions/session-lifecycle-admission.test-support.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { makeCronJob } from "./delivery.test-helpers.js";
import { TEST_SCHEDULED_OCCURRENCE } from "./scheduled-occurrence.test-support.js";
import { runCronSessionTurn } from "./session-run.js";
import type { CronStoredJob } from "./types.js";

const admission = vi.hoisted(() => ({
  beforeOperation: undefined as (() => () => void) | undefined,
  beforeTargetPreparation: undefined as
    | ((assertCurrent: (() => void) | undefined) => void | Promise<void>)
    | undefined,
  onEnqueued: undefined as ((sessionKey: string) => void) | undefined,
  whileQueuedAdmissionWaits: undefined as ((sessionKey: string) => Promise<void>) | undefined,
}));

// The real queue runs; this only reports when a turn has been queued behind an active one.
vi.mock("../auto-reply/reply/queue/enqueue.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auto-reply/reply/queue/enqueue.js")>();
  return {
    ...actual,
    enqueueFollowupRun: (...args: Parameters<typeof actual.enqueueFollowupRun>) => {
      const enqueued = actual.enqueueFollowupRun(...args);
      if (enqueued) {
        admission.onEnqueued?.(args[0]);
      }
      return enqueued;
    },
  };
});

// The real admission owner runs; a test may commit one settings write once a source has
// entered it, before its selection fence.
vi.mock("../auto-reply/reply/reply-turn-admission.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../auto-reply/reply/reply-turn-admission.js")>();
  return {
    ...actual,
    admitReplyTurn: async (...args: Parameters<typeof actual.admitReplyTurn>) => {
      // Only reply-turn preparation passes the selection fence; dispatch admission does not.
      const write = args[0].captureRunSelection ? admission.whileQueuedAdmissionWaits : undefined;
      if (write) {
        admission.whileQueuedAdmissionWaits = undefined;
        await write(args[0].sessionKey);
      }
      return await actual.admitReplyTurn(...args);
    },
  };
});

// Retain a real lifecycle closure through the operation owner's synchronous guard.
vi.mock("../sessions/session-controller.js", async (original) => {
  const actual = await original<typeof import("../sessions/session-controller.js")>();
  return {
    ...actual,
    createReplyOperation: (...args: Parameters<typeof actual.createReplyOperation>) => {
      const block = admission.beforeOperation;
      admission.beforeOperation = undefined;
      const release = block?.();
      try {
        return actual.createReplyOperation(...args);
      } finally {
        release?.();
      }
    },
  };
});

// Publish during real native target preparation, after scheduled start admission.
vi.mock(
  "../agents/embedded-agent-runner/run/attempt-transcript-lifecycle-prepare.js",
  async (original) => {
    const actual =
      await original<
        typeof import("../agents/embedded-agent-runner/run/attempt-transcript-lifecycle-prepare.js")
      >();
    return {
      ...actual,
      prepareEmbeddedAttemptTranscriptLifecycle: async (
        ...args: Parameters<typeof actual.prepareEmbeddedAttemptTranscriptLifecycle>
      ) => {
        await admission.beforeTargetPreparation?.(
          args[0].attempt.preparedSessionTarget?.assertCurrent,
        );
        return actual.prepareEmbeddedAttemptTranscriptLifecycle(...args);
      },
    };
  },
);

// Match Gateway startup: scheduled session turns settle through the real reply runtime.
await Promise.all([
  import("../auto-reply/dispatch.js"),
  import("../auto-reply/reply/get-reply-from-config.runtime.js").then((runtime) =>
    runtime.prewarmConfigDrivenReplyRuntime(),
  ),
]);

// Loopback stubs named by role: the pinned model always fails with 401 on purpose; the others answer.
const providerUrls = {
  pinned: "http://127.0.0.1:11434/v1",
  primary: "http://127.0.0.1:11435/v1",
  fallback: "http://127.0.0.1:11436/v1",
  jobfallback: "http://127.0.0.1:11437/v1",
} as const;

const namedSessionKey = "agent:main:scheduled-pin";

function completedResponse(model: string): Response {
  return providerResponse({
    api: "openai-responses",
    model,
    id: "resp_synthetic",
    messageId: "msg_synthetic",
    text: "answered",
    calls: [],
  }).response;
}

function stubProvider(baseUrl: string, model: string) {
  return {
    api: "openai-responses" as const,
    baseUrl,
    agentRuntime: { id: "openclaw" },
    models: [modelDefinition(model, { reasoning: false, contextWindow: 128_000, maxTokens: 1024 })],
  };
}

beforeEach(bindSessionMcpRuntimeTestScheduler);

afterEach(async () => {
  admission.beforeOperation = undefined;
  admission.beforeTargetPreparation = undefined;
  admission.onEnqueued = undefined;
  admission.whileQueuedAdmissionWaits = undefined;
  await disposeAllSessionMcpRuntimes();
  await resetPreparedModelRuntimeSnapshotsForTest();
  // Each case has its own state root; a prior case's controller would make the key ambiguous.
  resetSessionControllerStateForTest();
  resetPluginRuntimeStateForTest();
  vi.restoreAllMocks();
});

describe("stored session model selections in scheduled session turns", () => {
  const userSelection = { modelOverrideSource: "user" } as const;
  const pinned = { provider: "pinned", model: "model-x" };
  const primary = { provider: "primary", model: "model-a" };
  const policyCases = [
    ["unrelated", "ok", 1, 1, 0],
    ["logging-only", "ok", 1, 1, 0],
    ["unrelated-model-provider", "ok", 1, 1, 0],
    ["provider-setup-sequence", "ok", 1, 1, 0],
    ["selected-model-denied", "error", 0, 1, 0],
    ["policy", "ok", 1, 2, 0],
    ["in-place-policy", "ok", 1, 2, 0],
    ["other-agent", "ok", 1, 1, 0],
    ["unrelated-auth", "ok", 1, 1, 0],
    ["provider-auth", "ok", 1, 2, 0],
    ["unrelated-auth-hook", "ok", 1, 1, 1],
    ["provider-auth-hook", "error", 0, 1, 1],
    ["fallback-auth", "error", 1, 1, 0],
    ["agent-policy", "ok", 1, 2, 0],
    ["channel-defaults", "ok", 1, 2, 0],
    ["bootstrap-effect", "error", 0, 1, 1],
    ["hook-effect", "error", 0, 1, 1],
    ["model-hook-effect", "error", 0, 1, 1],
    ["revoked", "error", 0, 1, 0],
    ["cancelled", "error", 0, 1, 0],
    ["unknown-effect", "error", 1, 1, 0],
    ["text-only", "error", 0, 1, 0],
  ] as const;
  async function runWithFailingPinnedModel(params: {
    reload?: (typeof policyCases)[number][0];
    storedSelection?: Pick<SessionEntry, "modelOverrideSource">;
    target?: "main" | "session";
    payload?: { model?: string; fallbacks?: string[] };
    payloadKind?: "systemEvent";
    storedPin?: { provider: string; model: string } | null;
    defaultPrimary?: string;
    modelAllow?: string[];
    // Commit a sessions.patch model change while a queued turn waits in admission.
    retargetWhileAdmitting?: { pin: { provider: string; model: string } | null; blocked?: boolean };
  }) {
    return await withOpenClawTestState({ label: "cron-session-turn-model" }, async (state) => {
      installPrivateUpdateHandoffStore(state.root);
      const requests: string[] = [];
      const controller = new AbortController();
      let revoked = false;
      let preparations = 0;
      let publications = 0;
      let authorityRefusal: string | undefined;
      const requestRecoveryRestart = vi.fn(() => ({ status: "emitted" as const }));
      const effectPath = `${state.workspaceDir}/hook-effects.txt`;
      const effect = () => fs.appendFile(effectPath, "effect\n").then(() => undefined);
      using _ = {
        [Symbol.dispose]: () => unregisterInternalHook("agent:bootstrap", effect),
      };
      if (params.reload === "hook-effect" || params.reload === "model-hook-effect") {
        const hookName =
          params.reload === "hook-effect" ? "before_agent_reply" : "before_model_resolve";
        const registry = createMockPluginRegistry([{ hookName, handler: effect }]);
        setActivePluginRegistry(registry);
        globalHooks.initializeGlobalHookRunner(registry);
        if (params.reload === "hook-effect") {
          // Native preparation replaces the synthetic registry before reply dispatch.
          const hooks = globalHooks.ensureGlobalHookRunner();
          vi.spyOn(hooks, "hasHooks").mockImplementation((name) => name === "before_agent_reply");
          vi.spyOn(hooks, "runBeforeAgentReply").mockImplementation(effect);
        }
      }
      if (params.reload === "bootstrap-effect" || params.reload?.endsWith("auth-hook")) {
        registerInternalHook("agent:bootstrap", effect);
      }
      admission.beforeTargetPreparation = async (assertCurrent) => {
        preparations++;
        if (preparations !== 1 || !params.reload || params.reload === "unknown-effect") {
          return;
        }
        if (params.reload === "text-only") {
          throw new Error("Session event configuration changed; retry under the current policy");
        }
        if (hotReloadConfigs.length) {
          const handlers = createGatewayReloadHandlers(
            createHotReloadHandlerTestParams({
              scheduler: createTestGatewayScheduler(),
              deps: createDefaultDeps(),
              getPluginRegistry: requireActivePluginChannelRegistry,
              requestRecoveryRestart,
            }),
          );
          try {
            let previous = cfg;
            for (const config of hotReloadConfigs) {
              expect(
                await handlers.applyHotReload(
                  buildGatewayReloadPlan(diffConfigPaths(previous, config)),
                  config,
                  {
                    sourceConfig: config,
                    isCurrent: () => true,
                    publish: async (commit) => {
                      setRuntimeConfigSnapshot(config);
                      await commit();
                    },
                  },
                ),
              ).toBe("applied");
              publications++;
              // Assert the real admitted target after every publication, before another edit.
              try {
                expectDefined(assertCurrent, "prepared scheduled target authority")();
              } catch (error) {
                authorityRefusal = formatErrorMessage(error);
                throw error;
              }
              previous = config;
            }
          } finally {
            handlers.stopRestartRetries();
          }
          return;
        }
        if (params.reload === "in-place-policy") {
          cfg.tools = next.tools;
          setRuntimeConfigSnapshot(cfg);
        } else {
          setRuntimeConfigSnapshot(next);
        }
        revoked = params.reload === "revoked";
        if (params.reload === "cancelled") {
          controller.abort();
        }
      };
      const activeTurn = params.retargetWhileAdmitting && {
        pin: params.retargetWhileAdmitting.pin,
        started: Promise.withResolvers<void>(),
        release: Promise.withResolvers<void>(),
      };
      const providerFetch: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        if (request.method !== "POST" || !request.url.endsWith("/responses")) {
          throw new Error(`Unexpected external I/O in scheduled session fixture: ${request.url}`);
        }
        const body = (await request.json()) as { model?: string };
        const route = Object.entries(providerUrls).find(([, url]) =>
          request.url.startsWith(url),
        )?.[0];
        requests.push(`${route ?? "unknown"}/${body.model}`);
        if (params.reload === "unknown-effect") {
          setRuntimeConfigSnapshot(next);
        }
        if (activeTurn && requests.length === 1) {
          // The first request belongs to the active turn; hold the session until the next one queues.
          activeTurn.started.resolve();
          await activeTurn.release.promise;
        }
        if (route === "pinned" || (params.reload === "fallback-auth" && route === "primary")) {
          return Response.json(
            {
              error: {
                message: "Incorrect API key provided.",
                type: "invalid_request_error",
                code: "invalid_api_key",
              },
            },
            { status: 401 },
          );
        }
        return completedResponse(body.model ?? "unknown");
      };
      vi.spyOn(globalThis, "fetch").mockImplementation(providerFetch);
      vi.spyOn(getAiTransportHost(), "buildModelFetch").mockReturnValue(providerFetch);
      const routeParams = { agentRuntime: { id: "openclaw" }, params: { transport: "sse" } };
      const modelAllow =
        params.modelAllow ??
        (params.reload === "provider-setup-sequence" || params.reload === "selected-model-denied"
          ? ["primary/model-a"]
          : undefined);
      const cfg: OpenClawConfig = {
        agents: {
          entries: { main: { agentDir: state.agentDir(), workspace: state.workspaceDir } },
          defaults: {
            model: {
              primary: params.defaultPrimary ?? "primary/model-a",
              fallbacks: ["fallback/model-b"],
            },
            ...(modelAllow ? { modelPolicy: { allow: modelAllow } } : {}),
            models: Object.fromEntries(
              ["pinned/model-x", "primary/model-a", "fallback/model-b", "jobfallback/model-c"].map(
                (ref) => [ref, routeParams],
              ),
            ),
          },
        },
        models: {
          mode: "replace",
          providers: {
            // Credentialless loopback routes, so each route's own account check admits it.
            pinned: stubProvider(providerUrls.pinned, "model-x"),
            primary: stubProvider(providerUrls.primary, "model-a"),
            fallback: stubProvider(providerUrls.fallback, "model-b"),
            jobfallback: stubProvider(providerUrls.jobfallback, "model-c"),
            ...(params.reload === "unrelated-model-provider"
              ? { other: stubProvider("http://127.0.0.1:11438/v1", "model-other") }
              : {}),
          },
        },
        plugins: { allow: ["openai"], slots: { memory: "none" } },
        skills: { load: { watch: false } },
        tools: { deny: ["*"] },
        channels: { discord: { enabled: true, guilds: {} }, slack: { enabled: true } },
      };
      const next: OpenClawConfig = { ...cfg };
      const hotReloadConfigs: OpenClawConfig[] = [];
      if (params.reload === "logging-only") {
        hotReloadConfigs.push({ ...cfg, logging: { level: "debug" } });
      } else if (params.reload === "unrelated-model-provider") {
        hotReloadConfigs.push({
          ...cfg,
          models: {
            ...cfg.models,
            providers: {
              ...cfg.models?.providers,
              other: stubProvider("http://127.0.0.1:11439/v1", "model-other"),
            },
          },
        });
      } else if (
        params.reload === "provider-setup-sequence" ||
        params.reload === "selected-model-denied"
      ) {
        for (const email of [undefined, "first@example.test", "second@example.test"]) {
          hotReloadConfigs.push({
            ...cfg,
            auth: { profiles: { "other:manual": { provider: "other", mode: "api_key", email } } },
          });
        }
        hotReloadConfigs.push({
          ...hotReloadConfigs[2],
          agents: {
            ...cfg.agents,
            defaults: {
              ...cfg.agents?.defaults,
              modelPolicy: {
                allow:
                  params.reload === "selected-model-denied"
                    ? ["other/model"]
                    : ["primary/model-a", "other/model"],
              },
            },
          },
        });
      }
      if (params.reload === "unrelated") {
        next.channels = {
          discord: {
            enabled: true,
            guilds: { synthetic: { channels: { other: { users: ["synthetic"] } } } },
          },
          slack: { enabled: true },
        };
      } else if (params.reload?.includes("auth")) {
        const provider = params.reload.startsWith("unrelated")
          ? "unrelated-provider"
          : params.reload === "fallback-auth"
            ? "fallback"
            : "primary";
        next.auth = { profiles: { [`${provider}:manual`]: { provider, mode: "api_key" } } };
      } else if (params.reload === "other-agent") {
        next.agents = {
          ...cfg.agents,
          entries: { ...cfg.agents?.entries, other: { tools: { deny: ["write"] } } },
        };
      } else if (params.reload === "agent-policy") {
        next.agents = {
          ...cfg.agents,
          entries: { main: { ...cfg.agents?.entries?.main, cwd: state.workspaceDir } },
        };
      } else if (params.reload === "channel-defaults") {
        next.channels = { ...cfg.channels, defaults: { groupPolicy: "disabled" } };
      } else {
        next.tools = { deny: ["write"] };
      }
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      // `main` resolves to the agent's main conversation, as the Gateway target resolver does.
      const sessionKey =
        params.target === "main"
          ? resolveAgentMainSessionKey({ cfg, agentId: "main" })
          : namedSessionKey;
      const stored: CronStoredJob = makeCronJob({
        id: "session-turn-model",
        agentId: "main",
        sessionTarget: params.target === "main" ? "main" : `session:${sessionKey}`,
        wakeMode: "now",
        delivery: { mode: "none" },
        payload:
          params.payloadKind === "systemEvent"
            ? { kind: "systemEvent", text: "Reply." }
            : { kind: "agentTurn", message: "Reply.", ...params.payload },
      });
      const conversation = {
        sessionId: "pinned-conversation",
        updatedAt: Date.now(),
        sessionStartedAt: Date.now(),
      };
      const entryFor = (
        pin: { provider: string; model: string } | null,
        selection: Pick<SessionEntry, "modelOverrideSource"> = userSelection,
      ): SessionEntry => ({
        ...conversation,
        ...(pin ? { providerOverride: pin.provider, modelOverride: pin.model, ...selection } : {}),
      });
      await replaceSessionEntry(
        { agentId: "main", sessionKey },
        entryFor(
          params.storedPin === undefined ? pinned : params.storedPin,
          params.storedSelection,
        ),
      );
      const activeJob: CronStoredJob = { ...stored, id: "active-turn", name: "Active turn" };
      const runTurn = (scheduled: CronStoredJob) =>
        runCronSessionTurn({
          occurrence: TEST_SCHEDULED_OCCURRENCE,
          cfg,
          agentId: "main",
          sessionKey,
          job: scheduled,
          text: "Reply.",
          admissionSource: "operator-schedule",
          deliveryAttemptFence: null,
          abortSignal: controller.signal,
          assertCurrent() {
            if (revoked) {
              throw new Error("Scheduled source revoked");
            }
          },
        });
      if (!activeTurn) {
        return {
          result: await runTurn(stored),
          requests,
          preparations,
          publications,
          authorityRefusal,
          recoveryRequests: requestRecoveryRestart.mock.calls.length,
          hookEffects: await fs.readFile(effectPath, "utf8").catch(() => undefined),
        };
      }
      admission.whileQueuedAdmissionWaits = async (admittedSessionKey) => {
        expect(admittedSessionKey).toBe(sessionKey);
        // Commit, then refresh waiting work, as sessions.patch does for a model change.
        const { pin } = activeTurn;
        const entry = entryFor(pin);
        await replaceSessionEntry({ agentId: "main", sessionKey }, entry);
        refreshSessionPatchQueuedSelection({
          cfg,
          entry,
          patch: { key: sessionKey, model: pin ? `${pin.provider}/${pin.model}` : null },
          sessionKey,
          agentId: "main",
        });
        if (params.retargetWhileAdmitting?.blocked) {
          admission.beforeOperation = () =>
            closeSessionControllerAdmission({
              agentId: "main",
              scope: resolveSessionStorePathCore(cfg.session?.store, { agentId: "main" }),
              identities: [sessionKey, conversation.sessionId],
              reason: new Error("Lifecycle publication before operation acquisition"),
            });
        }
      };
      const queued = Promise.withResolvers<void>();
      admission.onEnqueued = (queuedSessionKey) => {
        if (queuedSessionKey === sessionKey) {
          queued.resolve();
        }
      };
      const activeResult = runTurn(activeJob);
      let pending: ReturnType<typeof runTurn> | undefined;
      try {
        await awaitGateBeforeSettlement(activeTurn.started.promise, activeResult, "active turn");
        pending = runTurn(stored);
        await awaitGateBeforeSettlement(queued.promise, pending, "scheduled turn");
      } finally {
        activeTurn.release.resolve();
        // Join both turns before the state root is torn down, on failure paths too.
        await Promise.allSettled([activeResult, pending]);
      }
      expect((await activeResult).status).toBe("ok");
      const result = await pending;
      return { result, requests };
    });
  }

  it.each([
    ["user", "session", undefined, userSelection],
    ["legacy", "session", undefined, {}],
    ["user", "main", undefined, userSelection],
    ["legacy", "main", undefined, {}],
    ["user", "main", "systemEvent", userSelection],
    ["legacy", "main", "systemEvent", {}],
  ] as const)(
    "reports a failed %s selection in a %s/%s turn without fallback",
    async (_name, target, payloadKind, storedSelection) => {
      const { result, requests } = await runWithFailingPinnedModel({
        storedSelection,
        target,
        payloadKind,
      });
      expect(requests).toEqual(["pinned/model-x"]);
      expect(result?.status).toBe("error");
      expect(result?.error).toContain("Couldn't sign in to the AI service");
    },
  );

  it.each([
    ["automatic selection", { storedSelection: { modelOverrideSource: "auto" } }],
    [
      "unpinned main system-event",
      {
        storedPin: null,
        defaultPrimary: "pinned/model-x",
        target: "main",
        payloadKind: "systemEvent",
      },
    ],
    ["explicit job fallbacks", { payload: { fallbacks: ["jobfallback/model-c"] } }],
    ["explicit job model", { payload: { model: "pinned/model-x" } }],
    [
      "disallowed user selection",
      {
        storedPin: primary,
        defaultPrimary: "pinned/model-x",
        modelAllow: ["pinned/*", "fallback/*"],
      },
    ],
  ] satisfies Array<[string, Parameters<typeof runWithFailingPinnedModel>[0]]>)(
    "keeps falling back for %s",
    async (_name, selection) => {
      const { result, requests } = await runWithFailingPinnedModel(selection);
      const fallback =
        "payload" in selection && "fallbacks" in selection.payload
          ? "jobfallback/model-c"
          : "fallback/model-b";
      expect(requests).toEqual(["pinned/model-x", fallback]);
      expect(result.status, result.error).toBe("ok");
    },
  );

  it.each(policyCases)(
    "settles a scheduled occurrence across %s target preparation once",
    async (reload, status, calls, attempts, effects) => {
      const {
        result,
        requests,
        preparations,
        publications,
        authorityRefusal,
        recoveryRequests,
        hookEffects,
      } = await runWithFailingPinnedModel({
        storedPin: null,
        payload: { fallbacks: reload === "fallback-auth" ? ["fallback/model-b"] : [] },
        reload,
      });
      expect(hookEffects).toBe(effects ? "effect\n" : undefined);
      if (reload === "provider-setup-sequence" || reload === "selected-model-denied") {
        expect(publications).toBe(4);
      } else if (reload === "logging-only" || reload === "unrelated-model-provider") {
        expect(publications).toBe(1);
      }
      expect(recoveryRequests).toBe(0);
      if (reload === "selected-model-denied") {
        expect(authorityRefusal).toContain("Session event configuration changed");
      }
      expect(result?.status, result?.error).toBe(status);
      expect(requests).toEqual(calls ? ["primary/model-a"] : []);
      expect(preparations).toBe(attempts);
    },
  );

  describe("when the session model changes while a queued turn waits for admission", () => {
    it("falls back once the user pin is cleared", async () => {
      // The answering pin is cleared, so the failing default runs with its configured fallback.
      const { result, requests } = await runWithFailingPinnedModel({
        storedPin: primary,
        defaultPrimary: "pinned/model-x",
        retargetWhileAdmitting: { pin: null },
      });
      expect(requests).toEqual(["primary/model-a", "pinned/model-x", "fallback/model-b"]);
      expect(result.status, result.error).toBe("ok");
    });

    it.each([
      { target: "session", payloadKind: undefined, blocked: false },
      { target: "session", payloadKind: undefined, blocked: true },
      { target: "main", payloadKind: "systemEvent", blocked: false },
    ] as const)(
      "keeps a queued $target/$payloadKind turn strict after pinning (admission blocked: $blocked)",
      async ({ target, payloadKind, blocked }) => {
        const { result, requests } = await runWithFailingPinnedModel({
          storedSelection: {},
          storedPin: null,
          target,
          payloadKind,
          retargetWhileAdmitting: { pin: pinned, blocked },
        });
        expect(requests).toEqual(["primary/model-a", "pinned/model-x"]);
        expect(result?.status).toBe("error");
        expect(result?.error).toContain("Couldn't sign in to the AI service");
      },
    );
  });
});
