// Shared fixtures for dispatch runtime selection, hooks, and provider handoff.
import { vi, type Mock } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type {
  AcpSessionResolution,
  SessionAcpMeta,
} from "../../acp/control-plane/manager.types.js";
import { resolveAcpSessionTarget } from "../../acp/control-plane/manager.utils.js";
import { AcpRuntimeError } from "../../acp/runtime/errors.js";
import { clearAgentHarnesses } from "../../agents/harness/registry.js";
import type {
  ChannelMessagingAdapter,
  ChannelThreadingAdapter,
} from "../../channels/plugins/types.core.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
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
import { createMockAcpRunTurn } from "./dispatch-from-config.acp-abort.test-support.js";
import {
  acpManagerRuntimeMocks,
  acpMocks,
  agentEventMocks,
  createDispatcher,
  diagnosticMocks,
  hookMocks,
  internalHookMocks,
  messageAuditMocks,
  mockPluginBinding,
  mocks,
  mockSessionStorePath,
  noAbortResult,
  parseGenericThreadSessionInfo,
  placementContextMocks,
  resetPluginTtsAndThreadMocks,
  runtimePluginMocks,
  sessionBindingMocks,
  sessionStoreMocks,
  setDiscordTestRegistry,
  stageSandboxMediaMocks,
  threadInfoMocks,
  transcriptMocks,
  ttsMocks,
  emptyConfig,
} from "./dispatch-from-config.shared.test-harness.js";
import type { ReplyDispatcher } from "./reply-dispatcher.types.js";
import { buildTestCtx } from "./test-ctx.js";
import { createAcpTestObservabilitySnapshot } from "./test-fixtures/acp-runtime.js";

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

export let createReplyOperation: typeof import("../../sessions/session-controller.js").createReplyOperation;

export let getSessionControllerOperation: typeof import("../../sessions/session-controller.js").getSessionControllerOperation;

export let isSessionRunActiveForKey: typeof import("../../sessions/session-controller.queries.js").isSessionRunActiveForKey;

let controllerTesting: typeof import("../../sessions/session-controller.test-support.js").testing;

export let admitReplyTurn: typeof import("./reply-turn-admission.js").admitReplyTurn;

export let runWithReplyOperationLifecycleAdmission: typeof import("./reply-turn-admission.js").runWithReplyOperationLifecycleAdmission;

type DispatchReplyArgs = Parameters<
  typeof import("./dispatch-from-config.js").dispatchReplyFromConfig
>[0];

export function createMessageToolOnlyDispatchArgs(
  ctx: DispatchReplyArgs["ctx"],
  dispatcher: DispatchReplyArgs["dispatcher"],
  replyResolver: DispatchReplyArgs["replyResolver"],
): DispatchReplyArgs {
  return {
    ctx,
    cfg: emptyConfig,
    dispatcher,
    replyResolver,
    replyOptions: { sourceReplyDeliveryMode: "message_tool_only" },
  };
}

function shouldUseAcpReplyDispatchHook(eventUnknown: unknown): boolean {
  const event = eventUnknown as {
    sessionKey?: string;
    ctx?: {
      SessionKey?: string;
      CommandTargetSessionKey?: string;
      AcpDispatchTailAfterReset?: boolean;
    };
  };
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

export function resetDeliverySettlementFixture() {
  // Keep the delivery cases on their original non-ACP, Discord-only fixture.
  setDiscordTestRegistry();
  mocks.tryFastAbortFromMessage.mockReset();
  setNoAbort();
  hookMocks.runner.runReplyDispatch.mockReset().mockResolvedValue(undefined);
  sessionStoreMocks.updateSessionEntry.mockClear();
  acpManagerRuntimeMocks.getAcpSessionManager.mockImplementation(() => ({
    resolveSessionAsync: async () => ({ kind: "none" as const }),
    getObservabilitySnapshot: createAcpTestObservabilitySnapshot,
    runTurn: vi.fn(),
  }));
  runtimePluginMocks.loadAgentRuntimePluginRegistryHandle.mockReturnValue(
    runtimePluginMocks.pluginRegistry,
  );
}

type MockAcpRuntime = AcpRuntime & {
  [K in "ensureSession" | "runTurn" | "cancel" | "close"]: Mock<AcpRuntime[K]>;
};

export function createAcpRuntime(events: AcpRuntimeEvent[]): MockAcpRuntime {
  const runtime = {
    ensureSession: vi.fn<AcpRuntime["ensureSession"]>(async (input) => ({
      sessionKey: input.sessionKey,
      agentId: input.agentId,
      backend: "acpx",
      runtimeSessionName: `${input.sessionKey}:${input.mode}`,
    })),
    runTurn: vi.fn<AcpRuntime["runTurn"]>(async function* () {
      yield* events;
    }),
    cancel: vi.fn<AcpRuntime["cancel"]>(async () => {}),
    close: vi.fn<AcpRuntime["close"]>(async () => {}),
  } satisfies AcpRuntime;
  return runtime;
}

function createMockAcpSessionManager() {
  return {
    resolveSessionAsync: async (params: {
      cfg: OpenClawConfig;
      sessionKey: string;
      agentId?: string;
    }): Promise<AcpSessionResolution> => {
      const target = resolveAcpSessionTarget(params);
      const entry = acpMocks.readAcpSessionEntry({
        cfg: params.cfg,
        ...target,
      }) as { acp?: SessionAcpMeta } | null;
      if (entry?.acp) {
        return { kind: "ready", ...target, meta: entry.acp };
      }
      return target.sessionKey.startsWith("agent:")
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
    getObservabilitySnapshot: createAcpTestObservabilitySnapshot,
    runTurn: createMockAcpRunTurn((runtime, handle, mode) =>
      mode === "oneshot" ? runtime.close({ handle, reason: "oneshot-complete" }) : undefined,
    ),
  };
}

export function firstMockCall(
  mockFn: ReturnType<typeof vi.fn>,
  label: string,
  index = 0,
): unknown[] {
  const call = mockFn.mock.calls[index] as unknown[] | undefined;
  if (!call) {
    throw new Error(`expected ${label} call #${index + 1}`);
  }
  return call;
}

export function firstMockArg(
  mockFn: ReturnType<typeof vi.fn>,
  label: string,
  index = 0,
  argIndex = 0,
): unknown {
  return firstMockCall(mockFn, label, index)[argIndex];
}

export function firstToolResultPayload(dispatcher: ReplyDispatcher): ReplyPayload | undefined {
  return firstMockArg(
    dispatcher.sendToolResult as ReturnType<typeof vi.fn>,
    "tool result",
  ) as ReplyPayload;
}

export function firstFinalReplyPayload(dispatcher: ReplyDispatcher): ReplyPayload | undefined {
  return firstMockArg(
    dispatcher.sendFinalReply as ReturnType<typeof vi.fn>,
    "final reply",
  ) as ReplyPayload;
}

export function firstRouteReplyCall(): Record<string, unknown> {
  const call = firstMockArg(mocks.routeReply, "route reply");
  if (!call || typeof call !== "object") {
    throw new Error("expected route reply params");
  }
  return call as Record<string, unknown>;
}

export function installThreadingTestPlugin(params: {
  defaultAccountId?: string;
  id: string;
  resolveReplyToMode?: NonNullable<ChannelThreadingAdapter["resolveReplyToMode"]>;
}) {
  const plugin = createChannelTestPluginBase({ id: params.id });
  const defaultAccountId = params.defaultAccountId;
  activateChannel({
    ...plugin,
    config: defaultAccountId
      ? { ...plugin.config, defaultAccountId: () => defaultAccountId }
      : plugin.config,
    threading: { resolveReplyToMode: params.resolveReplyToMode ?? (() => "all") },
  });
}

export function installCaptionedVoiceTestPlugin(id: string) {
  activateChannel(
    createChannelTestPluginBase({
      id,
      capabilities: {
        chatTypes: ["direct"],
        tts: { voice: { synthesisTarget: "voice-note", captionedFinalText: true } },
      },
    }),
  );
}

function channelRecord(plugin: ChannelPlugin) {
  return { pluginId: plugin.id, source: "test" as const, plugin };
}

function activateChannel(plugin: ChannelPlugin) {
  const registry = createTestRegistry([channelRecord(plugin)]);
  setActivePluginRegistry(registry);
  runtimePluginMocks.loadAgentRuntimePluginRegistryHandle.mockReturnValue(registry);
}

export function requireToolResultHandler(
  handler: GetReplyOptions["onToolResult"] | undefined,
): NonNullable<GetReplyOptions["onToolResult"]> {
  if (typeof handler !== "function") {
    throw new Error("expected onToolResult handler");
  }
  return handler;
}

export function requireBlockReplyHandler(
  handler: GetReplyOptions["onBlockReply"] | undefined,
): NonNullable<GetReplyOptions["onBlockReply"]> {
  if (typeof handler !== "function") {
    throw new Error("expected onBlockReply handler");
  }
  return handler;
}

export async function dispatchTwiceWithFreshDispatchers(
  params: Omit<DispatchReplyArgs, "dispatcher">,
) {
  const first = await dispatchReplyFromConfig({
    ...params,
    dispatcher: createDispatcher(),
  });
  const second = await dispatchReplyFromConfig({
    ...params,
    dispatcher: createDispatcher(),
  });
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
  ({ createReplyOperation, getSessionControllerOperation } =
    await import("../../sessions/session-controller.js"));
  ({ isSessionRunActiveForKey } = await import("../../sessions/session-controller.queries.js"));
  ({ testing: controllerTesting } =
    await import("../../sessions/session-controller.test-support.js"));
  ({ admitReplyTurn, runWithReplyOperationLifecycleAdmission } =
    await import("./reply-turn-admission.js"));
};

function nativeApprovalPlugin(
  id: string,
  shouldSuppressLocalPayloadPrompt: (params: {
    cfg: OpenClawConfig;
    payload: ReplyPayload;
    hint?: { kind?: string; approvalKind?: string; nativeRouteActive?: boolean };
  }) => boolean,
) {
  return {
    ...createChannelTestPluginBase({
      id,
      capabilities: { chatTypes: ["direct"], nativeCommands: true },
    }),
    outbound: { deliveryMode: "direct" as const, shouldSuppressLocalPayloadPrompt },
  };
}

function hasExecApproval(payload: ReplyPayload) {
  return Boolean(
    payload.channelData &&
    typeof payload.channelData === "object" &&
    !Array.isArray(payload.channelData) &&
    payload.channelData.execApproval,
  );
}

function resetRouteReply() {
  mocks.routeReply.mockReset().mockResolvedValue({ ok: true, delivered: true, messageId: "mock" });
}

function resetBindingLookup() {
  sessionBindingMocks.resolveByConversation.mockReset().mockReturnValue(null);
  sessionBindingMocks.resolveByConversationAsync.mockReset();
  sessionBindingMocks.touch.mockReset();
}

function resetThreadInfo() {
  threadInfoMocks.parseSessionThreadInfo
    .mockReset()
    .mockImplementation(parseGenericThreadSessionInfo);
}

export const describe0BeforeEach0 = () => {
  clearAgentHarnesses();
  clearPluginCommands();
  resetPluginTtsAndThreadMocks();
  // This suite keeps richer channel registry and ACP hook wiring local.
  const discordTestPlugin = nativeApprovalPlugin(
    "discord",
    ({ payload, hint }) => hint?.nativeRouteActive === true && hasExecApproval(payload),
  );
  const signalTestPlugin = nativeApprovalPlugin(
    "signal",
    ({ cfg, payload, hint }) =>
      hint?.kind === "approval-pending" &&
      hint.approvalKind === "exec" &&
      hint.nativeRouteActive === true &&
      cfg.approvals?.exec?.enabled === true &&
      hasExecApproval(payload),
  );
  const passiveThreadingTestPlugins = ["slack", "telegram", "feishu", "mattermost", "imessage"].map(
    (id) =>
      channelRecord({
        ...createChannelTestPluginBase({ id }),
        threading: { resolveReplyToMode: () => "all" },
      }),
  );
  setActivePluginRegistry(
    createTestRegistry([
      channelRecord(discordTestPlugin),
      channelRecord(signalTestPlugin),
      ...passiveThreadingTestPlugins,
    ]),
  );
  acpManagerRuntimeMocks.getAcpSessionManager
    .mockReset()
    .mockReturnValue(createMockAcpSessionManager());
  controllerTesting.resetSessionControllerForTest();
  resetInboundDedupe();
  mocks.isRoutableChannel.mockReset();
  mocks.isRoutableChannel.mockImplementation((channel) =>
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
  resetRouteReply();
  mocks.tryFastApproveFromMessage.mockReset().mockResolvedValue({ handled: false });
  acpMocks.listAcpSessionEntries.mockReset().mockResolvedValue([]);
  diagnosticMocks.logMessageQueued.mockClear();
  diagnosticMocks.logMessageProcessed.mockClear();
  diagnosticMocks.logSessionStateChange.mockClear();
  diagnosticMocks.markDiagnosticSessionProgress.mockClear();
  diagnosticMocks.logMessageDispatchStarted.mockClear();
  diagnosticMocks.logMessageDispatchCompleted.mockClear();
  hookMocks.runner.hasHooks
    .mockClear()
    .mockImplementation((hookName?: string) => hookName === "reply_dispatch");
  hookMocks.runner.runInboundClaim.mockClear().mockResolvedValue(undefined);
  hookMocks.runner.runInboundClaimForPlugin.mockClear().mockResolvedValue(undefined);
  hookMocks.runner.runInboundClaimForPluginOutcome.mockClear().mockResolvedValue({
    status: "no_handler",
  });
  hookMocks.runner.runMessageReceived.mockClear();
  hookMocks.runner.runBeforeDispatch.mockClear().mockResolvedValue(undefined);
  hookMocks.runner.runReplyDispatch
    .mockClear()
    .mockImplementation(async (event: unknown, ctx: unknown) => {
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
  acpMocks.readAcpSessionEntry.mockReset().mockReturnValue(null);
  acpMocks.readAcpSessionMeta.mockReset().mockReturnValue(null);
  acpMocks.upsertAcpSessionMeta.mockReset().mockResolvedValue(null);
  acpMocks.getAcpRuntimeBackend.mockReset();
  acpMocks.requireAcpRuntimeBackend.mockReset();
  agentEventMocks.emitAgentEvent.mockReset();
  agentEventMocks.emitAgentAuditEvent.mockReset();
  agentEventMocks.onAgentEvent.mockReset().mockReturnValue(() => {});
  messageAuditMocks.enabled = true;
  messageAuditMocks.emitTrustedMessageAuditEvent.mockReset();
  sessionBindingMocks.listBySession.mockReset().mockReturnValue([]);
  resetBindingLookup();
  sessionStoreMocks.currentEntry = undefined;
  sessionStoreMocks.entriesBySessionKey.clear();
  sessionStoreMocks.loadSessionEntry
    .mockReset()
    .mockImplementation(() => sessionStoreMocks.currentEntry);
  sessionStoreMocks.loadSessionStoreEntry
    .mockReset()
    .mockImplementation(() => sessionStoreMocks.currentEntry);
  sessionStoreMocks.resolveSessionStorePathCore.mockReset().mockReturnValue(mockSessionStorePath);
  transcriptMocks.persistAcpDispatchTranscript.mockClear();
  transcriptMocks.appendAssistantMessageToSessionTranscript.mockClear();
  stageSandboxMediaMocks.stageSandboxMedia.mockReset().mockResolvedValue({ staged: new Map() });
  runtimePluginMocks.loadAgentRuntimePluginRegistryHandle
    .mockReset()
    .mockImplementation(() => getActivePluginRegistry() ?? runtimePluginMocks.pluginRegistry);
};

export function mockPluginBoundDiscordBinding({
  conversationId = "channel:1481858418548412579",
  ...params
}: Omit<Parameters<typeof mockPluginBinding>[0], "conversation"> & { conversationId?: string }) {
  return mockPluginBinding({
    ...params,
    conversation: { channel: "discord", accountId: "default", conversationId },
  });
}

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
  resetRouteReply();
  resetThreadInfo();
  ttsMocks.state.synthesizeFinalAudio = false;
  ttsMocks.maybeApplyTtsToPayload.mockClear();
  setNoAbort();
  hookMocks.runner.runBeforeDispatch.mockClear().mockResolvedValue(undefined);
  hookMocks.runner.runReplyDispatch.mockClear().mockResolvedValue(undefined);
  hookMocks.runner.hasHooks.mockImplementation(
    (hookName?: string) => hookName === "before_dispatch",
  );
};

export const describe2BeforeEach0 = () => {
  controllerTesting.resetSessionControllerForTest();
  // This suite swaps global registries between cases; keep each request on a live
  // snapshot so later retirement cannot invalidate the dispatch under test.
  const activeRegistry = getActivePluginRegistry();
  runtimePluginMocks.loadAgentRuntimePluginRegistryHandle
    .mockReset()
    .mockReturnValue(activeRegistry ? { ...activeRegistry } : createTestRegistry([]));
  resetInboundDedupe();
  resetRouteReply();
  sessionStoreMocks.currentEntry = undefined;
  placementContextMocks.getMany.mockReset().mockReturnValue(new Map());
  placementContextMocks.resolveSessionWorkerPlacementContext
    .mockReset()
    .mockReturnValue(placementContextMocks.context);
  resetBindingLookup();
  hookMocks.registry.plugins = [];
  hookMocks.runner.runInboundClaimForPluginOutcome.mockClear().mockResolvedValue({
    status: "no_handler",
  });
  hookMocks.runner.hasHooks.mockImplementation(
    (hookName?: string) => hookName === "reply_dispatch",
  );
  hookMocks.runner.runReplyDispatch.mockResolvedValue(undefined);
  hookMocks.runner.runBeforeDispatch.mockResolvedValue(undefined);
  resetThreadInfo();
};
