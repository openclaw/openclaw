import { vi, type Mock } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type {
  AcpSessionResolution,
  AcpRunTurnInput,
  SessionAcpMeta,
} from "../../acp/control-plane/manager.types.js";
import { resolveAcpSessionTarget } from "../../acp/control-plane/manager.utils.js";
import { AcpRuntimeError } from "../../acp/runtime/errors.js";
import { clearAgentHarnesses } from "../../agents/harness/registry.js";
import type {
  ChannelMessagingAdapter,
  ChannelThreadingAdapter,
} from "../../channels/plugins/types.core.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { AcpRuntime, AcpRuntimeEvent } from "../../plugin-sdk/acp-runtime.js";
import { clearPluginCommands } from "../../plugins/commands.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { createInternalHookEventPayload } from "../../test-utils/internal-hook-event-payload.js";
import type { MsgContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import {
  acpManagerRuntimeMocks,
  acpMocks,
  agentEventMocks,
  createDispatcher,
  diagnosticMocks,
  hookMocks,
  internalHookMocks,
  messageAuditMocks,
  mocks,
  noAbortResult,
  parseGenericThreadSessionInfo,
  placementContextMocks,
  resetPluginTtsAndThreadMocks,
  runtimePluginMocks,
  sessionBindingMocks,
  sessionStoreMocks,
  stageSandboxMediaMocks,
  threadInfoMocks,
  transcriptMocks,
  ttsMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import type { ReplyDispatcher } from "./reply-dispatcher.types.js";
import { buildTestCtx } from "./test-ctx.js";

const hooks = hookMocks.runner;
const sessions = sessionStoreMocks;
const bindings = sessionBindingMocks;
const diagnostics = diagnosticMocks;
const runtimePlugins = runtimePluginMocks;
const currentEntry = () => sessions.currentEntry;

export type ResolveInboundConversationParams = Parameters<
  NonNullable<ChannelMessagingAdapter["resolveInboundConversation"]>
>[0];
export const automaticGroupReplyConfig = {
  messages: { groupChat: { visibleReplies: "automatic" } },
} as const satisfies OpenClawConfig;
export const messageToolGroupReplyConfig = {
  messages: { groupChat: { visibleReplies: "message_tool" } },
} as const satisfies OpenClawConfig;
export const automaticDirectReplyConfig = {
  messages: { visibleReplies: "automatic" },
} as const satisfies OpenClawConfig;
export let dispatchReplyFromConfig: typeof import("./dispatch-from-config.js").dispatchReplyFromConfig;
let resetInboundDedupe: typeof import("./inbound-dedupe.js").resetInboundDedupe;
export let tryDispatchAcpReplyHook: typeof import("../../plugin-sdk/acpx.js").tryDispatchAcpReplyHook;
export let createReplyOperation: typeof import("./reply-run-registry.js").createReplyOperation;
export let replyRunRegistry: typeof import("./reply-run-registry.js").replyRunRegistry;
let replyRunTesting: typeof import("./reply-run-registry.test-support.js").testing;
export let admitReplyTurn: typeof import("./reply-turn-admission.js").admitReplyTurn;
export let runWithReplyOperationLifecycleAdmission: typeof import("./reply-turn-admission.js").runWithReplyOperationLifecycleAdmission;

type TestMock = ReturnType<typeof vi.fn>;
type ApprovalPrompt = {
  cfg: OpenClawConfig;
  payload: ReplyPayload;
  hint?: { kind?: string; approvalKind?: string; nativeRouteActive?: boolean };
};
type DispatchReplyArgs = Parameters<typeof dispatchReplyFromConfig>[0];

function shouldUseAcpReplyDispatchHook(eventUnknown: unknown): boolean {
  const event = eventUnknown as Parameters<typeof hooks.runReplyDispatch>[0];
  if (event.ctx?.AcpDispatchTailAfterReset) {
    return true;
  }
  return [event.sessionKey, event.ctx?.SessionKey, event.ctx?.CommandTargetSessionKey].some(
    (value) => {
      const key = value?.trim();
      return Boolean(key && (key.includes("acp:") || key.includes(":acp") || key.includes("-acp")));
    },
  );
}

export function setNoAbort() {
  mocks.tryFastAbortFromMessage.mockResolvedValue(noAbortResult);
}

export function createDispatchGate<T = void>() {
  const started = createDeferred();
  const pending = createDeferred<T>();
  return {
    ...pending,
    started: started.promise,
    wait: () => {
      started.resolve();
      return pending.promise;
    },
  };
}

export function createActiveSlackThread(userId: string) {
  setNoAbort();
  const sessionKey = `agent:main:slack:direct:${userId}`;
  const sessionId = "active-session";
  sessions.currentEntry = { sessionId, updatedAt: Date.now() };
  const activeOperation = createReplyOperation({
    sessionKey,
    sessionId,
    resetTriggered: false,
    routeThreadId: "500.000",
  });
  activeOperation.setPhase("running");
  return {
    activeOperation,
    sessionId,
    sessionKey,
    createCtx: (overrides: Partial<MsgContext> = {}) =>
      buildTestCtx({
        Provider: "slack",
        Surface: "slack",
        OriginatingChannel: "slack",
        OriginatingTo: `user:${userId}`,
        ChatType: "direct",
        SessionKey: sessionKey,
        MessageThreadId: "501.000",
        ...overrides,
      }),
  };
}

type MockAcpRuntime = AcpRuntime & {
  [K in "ensureSession" | "runTurn" | "cancel" | "close"]: Mock<AcpRuntime[K]>;
};

export function createAcpRuntime(events: AcpRuntimeEvent[]): MockAcpRuntime {
  return {
    ensureSession: vi.fn<AcpRuntime["ensureSession"]>(async (input) => ({
      sessionKey: input.sessionKey,
      agentId: input.agentId,
      backend: "acpx",
      runtimeSessionName: `${input.sessionKey}:${input.mode}`,
    })),
    runTurn: vi.fn<AcpRuntime["runTurn"]>(async function* (_input) {
      yield* events;
    }),
    cancel: vi.fn<AcpRuntime["cancel"]>(async () => {}),
    close: vi.fn<AcpRuntime["close"]>(async () => {}),
  };
}

type SessionLookup = Pick<AcpRunTurnInput, "cfg" | "sessionKey" | "agentId">;
type MockTurn = Pick<
  AcpRunTurnInput,
  "cfg" | "sessionKey" | "agentId" | "text" | "attachments" | "mode" | "requestId" | "signal"
> &
  Required<Pick<AcpRunTurnInput, "onEvent">>;

const readSessionMeta = (params: SessionLookup) =>
  (acpMocks.readAcpSessionEntry(params) as { acp?: SessionAcpMeta } | null)?.acp;

export function createMockAcpSessionManager({
  staleAgentSessions = true,
  closeOneshot = true,
} = {}) {
  return {
    resolveSessionAsync: async (params: SessionLookup): Promise<AcpSessionResolution> => {
      const target = resolveAcpSessionTarget(params);
      const meta = readSessionMeta({ cfg: params.cfg, ...target });
      if (meta) {
        return { kind: "ready", ...target, meta };
      }
      return staleAgentSessions && target.sessionKey.startsWith("agent:")
        ? {
            kind: "stale",
            ...target,
            error: new AcpRuntimeError(
              "ACP_SESSION_INIT_FAILED",
              `ACP metadata is missing for ${target.sessionKey}.`,
            ),
          }
        : { kind: "none", ...target };
    },
    getObservabilitySnapshot: () => ({
      runtimeCache: { activeSessions: 0 },
      turns: { queueDepth: 0 },
    }),
    runTurn: vi.fn(async (params: MockTurn) => {
      const { cfg, sessionKey, agentId, text, attachments, mode, requestId, signal } = params;
      const meta = readSessionMeta({ cfg, sessionKey, agentId });
      const { runtime } = acpMocks.requireAcpRuntimeBackend() as {
        runtime?: ReturnType<typeof createAcpRuntime>;
      };
      if (!runtime) {
        throw new Error("ACP runtime backend not mocked");
      }
      const handle = await runtime.ensureSession({
        sessionKey,
        agentId,
        mode: meta?.mode || "persistent",
        agent: meta?.agent || "codex",
      });
      for await (const event of runtime.runTurn({
        handle,
        text: text ?? "",
        attachments,
        mode,
        requestId,
        signal,
      })) {
        await params.onEvent(event);
      }
      if (closeOneshot && meta?.mode === "oneshot") {
        await runtime.close({ handle, reason: "oneshot-complete" });
      }
    }),
  };
}

export function firstMockCall(mockFn: TestMock, label: string, index = 0): unknown[] {
  const call = mockFn.mock.calls[index] as unknown[] | undefined;
  if (!call) {
    throw new Error(`expected ${label} call #${index + 1}`);
  }
  return call;
}

export function firstMockArg(mockFn: TestMock, label: string, index = 0, argIndex = 0): unknown {
  return firstMockCall(mockFn, label, index)[argIndex];
}

function firstDispatcherPayload(
  dispatcher: ReplyDispatcher,
  kind: "sendToolResult" | "sendFinalReply",
): ReplyPayload | undefined {
  return firstMockArg(
    dispatcher[kind] as TestMock,
    kind === "sendToolResult" ? "tool result" : "final reply",
  ) as ReplyPayload;
}
export const firstToolResultPayload = (dispatcher: ReplyDispatcher) =>
  firstDispatcherPayload(dispatcher, "sendToolResult");
export const firstFinalReplyPayload = (dispatcher: ReplyDispatcher) =>
  firstDispatcherPayload(dispatcher, "sendFinalReply");

export function firstRouteReplyCall(): Record<string, unknown> {
  const call = firstMockArg(mocks.routeReply, "route reply");
  if (!call || typeof call !== "object") {
    throw new Error("expected route reply params");
  }
  return call as Record<string, unknown>;
}

function testRegistry(...plugins: Array<{ id: string }>) {
  return createTestRegistry(
    plugins.map((plugin) => ({ pluginId: plugin.id, source: "test", plugin })),
  );
}

export function installThreadingTestPlugin(params: {
  defaultAccountId?: string;
  id: string;
  resolveReplyToMode?: NonNullable<ChannelThreadingAdapter["resolveReplyToMode"]>;
}) {
  const plugin = createChannelTestPluginBase({ id: params.id });
  const defaultAccountId = params.defaultAccountId;
  const registry = testRegistry({
    ...plugin,
    config: defaultAccountId
      ? { ...plugin.config, defaultAccountId: () => defaultAccountId }
      : plugin.config,
    threading: { resolveReplyToMode: params.resolveReplyToMode ?? (() => "all") },
  });
  setActivePluginRegistry(registry);
  runtimePlugins.loadAgentRuntimePluginRegistryHandle.mockReturnValue(registry);
}

export function installCaptionedVoiceTestPlugin(id: string) {
  const plugin = createChannelTestPluginBase({
    id,
    capabilities: {
      chatTypes: ["direct"],
      tts: { voice: { synthesisTarget: "voice-note", captionedFinalText: true } },
    },
  });
  const registry = testRegistry(plugin);
  setActivePluginRegistry(registry);
  runtimePlugins.loadAgentRuntimePluginRegistryHandle.mockReturnValue(registry);
}

function requireHandler<T>(handler: T, name: string): NonNullable<T> {
  if (typeof handler !== "function") {
    throw new Error(`expected ${name} handler`);
  }
  return handler;
}

export const requireToolResultHandler = (handler: GetReplyOptions["onToolResult"]) =>
  requireHandler(handler, "onToolResult");
export const requireBlockReplyHandler = (handler: GetReplyOptions["onBlockReply"]) =>
  requireHandler(handler, "onBlockReply");

export async function dispatchTwiceWithFreshDispatchers(
  params: Omit<DispatchReplyArgs, "dispatcher">,
) {
  const first = await dispatchReplyFromConfig({ ...params, dispatcher: createDispatcher() });
  const second = await dispatchReplyFromConfig({ ...params, dispatcher: createDispatcher() });
  return [first, second] as const;
}

export function messageAuditEvents(): Array<Record<string, unknown>> {
  return messageAuditMocks.emitTrustedMessageAuditEvent.mock.calls.map(([event]) =>
    event && typeof event === "object" ? (event as Record<string, unknown>) : {},
  );
}

export const globalBeforeAll0 = async () => {
  ({ dispatchReplyFromConfig } = await import("./dispatch-from-config.js"));
  await import("./dispatch-acp.js");
  await import("./dispatch-acp-command-bypass.js");
  ({ resetInboundDedupe } = await import("./inbound-dedupe.js"));
  // The broad facade imports the real manager outside this fixture's mocked dispatch boundary.
  ({ tryDispatchAcpReplyHook } = await import("../../plugin-sdk/acpx.js"));
  ({ createReplyOperation, replyRunRegistry } = await import("./reply-run-registry.js"));
  ({ testing: replyRunTesting } = await import("./reply-run-registry.test-support.js"));
  ({ admitReplyTurn, runWithReplyOperationLifecycleAdmission } =
    await import("./reply-turn-admission.js"));
};

export function resetDispatchSessionMocks() {
  acpMocks.listAcpSessionEntries.mockReset().mockResolvedValue([]);
  acpMocks.readAcpSessionEntry.mockReset().mockReturnValue(null);
  acpMocks.upsertAcpSessionMeta.mockReset().mockResolvedValue(null);
  acpMocks.requireAcpRuntimeBackend.mockReset();
  bindings.listBySession.mockReset().mockReturnValue([]);
  bindings.resolveByConversation.mockReset().mockReturnValue(null);
  bindings.touch.mockReset();
  sessions.currentEntry = undefined;
  sessions.loadSessionStoreEntry.mockReset().mockImplementation(currentEntry);
  sessions.resolveSessionStorePathCore.mockReset().mockReturnValue("/tmp/mock-sessions.json");
  agentEventMocks.emitAgentEvent.mockReset();
  agentEventMocks.emitAgentAuditEvent.mockReset();
}

export const describe0BeforeEach0 = () => {
  clearAgentHarnesses();
  clearPluginCommands();
  resetPluginTtsAndThreadMocks();
  const approvalPlugins = ["discord", "signal"].map((id) =>
    Object.assign(
      createChannelTestPluginBase({
        id,
        capabilities: { chatTypes: ["direct"], nativeCommands: true },
      }),
      {
        outbound: {
          deliveryMode: "direct" as const,
          shouldSuppressLocalPayloadPrompt: ({ cfg, payload, hint }: ApprovalPrompt) =>
            (id === "discord" ||
              (hint?.kind === "approval-pending" &&
                hint.approvalKind === "exec" &&
                cfg.approvals?.exec?.enabled === true)) &&
            hint?.nativeRouteActive === true &&
            Boolean(
              payload.channelData &&
              typeof payload.channelData === "object" &&
              !Array.isArray(payload.channelData) &&
              payload.channelData.execApproval,
            ),
        },
      },
    ),
  );
  const passiveThreadingTestPlugins = ["slack", "telegram", "feishu", "mattermost", "imessage"].map(
    (id) =>
      Object.assign(createChannelTestPluginBase({ id }), {
        threading: { resolveReplyToMode: () => "all" as const },
      }),
  );
  setActivePluginRegistry(testRegistry(...approvalPlugins, ...passiveThreadingTestPlugins));
  acpManagerRuntimeMocks.getAcpSessionManager
    .mockReset()
    .mockReturnValue(createMockAcpSessionManager());
  replyRunTesting.resetReplyRunRegistry();
  resetInboundDedupe();
  mocks.isRoutableChannel
    .mockReset()
    .mockImplementation((channel) =>
      Boolean(
        channel &&
        [
          "telegram",
          "slack",
          "discord",
          "signal",
          "imessage",
          "whatsapp",
          "feishu",
          "mattermost",
        ].includes(channel),
      ),
    );
  mocks.routeReply.mockReset().mockResolvedValue({ ok: true, delivered: true, messageId: "mock" });
  mocks.tryFastApproveFromMessage.mockReset().mockResolvedValue({ handled: false });
  resetDispatchSessionMocks();
  diagnostics.logMessageQueued.mockClear();
  diagnostics.logMessageProcessed.mockClear();
  diagnostics.logSessionStateChange.mockClear();
  diagnostics.markDiagnosticSessionProgress.mockClear();
  diagnostics.logMessageDispatchStarted.mockClear();
  diagnostics.logMessageDispatchCompleted.mockClear();
  hooks.hasHooks
    .mockClear()
    .mockImplementation((hookName?: string) => hookName === "reply_dispatch");
  hooks.runInboundClaim.mockClear().mockResolvedValue(undefined);
  hooks.runInboundClaimForPlugin.mockClear().mockResolvedValue(undefined);
  hooks.runInboundClaimForPluginOutcome.mockClear().mockResolvedValue({ status: "no_handler" });
  hooks.runMessageReceived.mockClear();
  hooks.runBeforeDispatch.mockClear().mockResolvedValue(undefined);
  hooks.runReplyDispatch.mockClear().mockImplementation(async (event: unknown, ctx: unknown) => {
    if (!shouldUseAcpReplyDispatchHook(event)) {
      return undefined;
    }
    return (await tryDispatchAcpReplyHook(event as never, ctx as never)) ?? undefined;
  });
  hookMocks.registry.plugins = [];
  internalHookMocks.createInternalHookEvent
    .mockClear()
    .mockImplementation(createInternalHookEventPayload);
  internalHookMocks.triggerInternalHook.mockClear();
  acpMocks.readAcpSessionMeta.mockReset().mockReturnValue(null);
  acpMocks.getAcpRuntimeBackend.mockReset();
  agentEventMocks.onAgentEvent.mockReset().mockReturnValue(() => {});
  messageAuditMocks.enabled = true;
  messageAuditMocks.emitTrustedMessageAuditEvent.mockReset();
  bindings.resolveByConversationAsync.mockReset();
  sessions.entriesBySessionKey.clear();
  sessions.loadSessionEntry.mockReset().mockImplementation(currentEntry);
  transcriptMocks.persistAcpDispatchTranscript.mockClear();
  transcriptMocks.appendAssistantMessageToSessionTranscript.mockClear();
  stageSandboxMediaMocks.stageSandboxMedia.mockReset().mockResolvedValue({ staged: new Map() });
  runtimePlugins.loadAgentRuntimePluginRegistryHandle
    .mockReset()
    .mockImplementation(() => getActivePluginRegistry() ?? runtimePlugins.pluginRegistry);
};

export const createHookCtx = (overrides: Partial<MsgContext> = {}) =>
  buildTestCtx({
    Body: "hello",
    BodyForAgent: "hello",
    BodyForCommands: "hello",
    From: "user1",
    Surface: "telegram",
    ChatType: "private",
    ...overrides,
  });

export const describe1BeforeEach0 = () => {
  resetInboundDedupe();
  mocks.routeReply.mockReset().mockResolvedValue({ ok: true, delivered: true, messageId: "mock" });
  threadInfoMocks.parseSessionThreadInfo
    .mockReset()
    .mockImplementation(parseGenericThreadSessionInfo);
  ttsMocks.state.synthesizeFinalAudio = false;
  ttsMocks.maybeApplyTtsToPayload.mockClear();
  setNoAbort();
  hooks.runBeforeDispatch.mockClear().mockResolvedValue(undefined);
  hooks.runReplyDispatch.mockClear().mockResolvedValue(undefined);
  hooks.hasHooks.mockImplementation((hookName?: string) => hookName === "before_dispatch");
};

export const describe2BeforeEach0 = () => {
  // This suite swaps global registries between cases; keep each request on a live
  // snapshot so later retirement cannot invalidate the dispatch under test.
  const activeRegistry = getActivePluginRegistry();
  runtimePlugins.loadAgentRuntimePluginRegistryHandle
    .mockReset()
    .mockReturnValue(activeRegistry ? { ...activeRegistry } : createTestRegistry([]));
  resetInboundDedupe();
  mocks.routeReply.mockReset().mockResolvedValue({ ok: true, delivered: true, messageId: "mock" });
  sessions.currentEntry = undefined;
  placementContextMocks.getMany.mockReset().mockReturnValue(new Map());
  placementContextMocks.resolveSessionWorkerPlacementContext
    .mockReset()
    .mockReturnValue(placementContextMocks.context);
  bindings.resolveByConversation.mockReset().mockReturnValue(null);
  bindings.resolveByConversationAsync.mockReset();
  bindings.touch.mockReset();
  hookMocks.registry.plugins = [];
  hooks.runInboundClaimForPluginOutcome.mockClear().mockResolvedValue({ status: "no_handler" });
  hooks.hasHooks.mockImplementation((hookName?: string) => hookName === "reply_dispatch");
  hooks.runReplyDispatch.mockResolvedValue(undefined);
  hooks.runBeforeDispatch.mockResolvedValue(undefined);
  threadInfoMocks.parseSessionThreadInfo
    .mockReset()
    .mockImplementation(parseGenericThreadSessionInfo);
};
