import { resolveAgentConfig } from "../agents/agent-scope-config.js";
import { isChannelAccountExplicitlyDisabled } from "../channels/account-config-enabled.js";
import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import { getChannelPlugin } from "../channels/plugins/index.js";
import type { ProgressContinuationReceipt } from "../channels/progress-continuation.js";
import type { ChannelProgressDraftCompositorSnapshot } from "../channels/progress-draft-compositor.types.js";
import { createTypingCallbacks } from "../channels/typing.js";
import {
  type ConversationDeliveryRecord,
  getConversationDeliveryOperation,
  getConversationProgressSnapshot,
  recordConversationProgressReceipt,
  updateConversationProgressSnapshot,
} from "../config/sessions/conversation-delivery-store.js";
import { buildConversationIdentity } from "../config/sessions/conversation-identity.js";
import {
  resolveConversation,
  resolveConversationRegistryScope,
  resolveCurrentConversationSession,
  runConversationDatabaseWrite,
} from "../config/sessions/conversation-registry.js";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import { resolveMessageActionOutcome } from "../infra/outbound/message-action-contracts.js";
import { runMessageAction } from "../infra/outbound/message-action-runner.js";
import { getRuntimeConfig } from "../infra/outbound/message.config.runtime.js";
import { resolveOutboundSessionRoute } from "../infra/outbound/outbound-session.js";
import { normalizeTargetForProvider } from "../infra/outbound/target-normalization.js";
import { resolveOutboundTarget } from "../infra/outbound/targets.js";
import { channelRouteTargetsMatchExact } from "../plugin-sdk/channel-route.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { runWithGatewayDetachedWorkContinuation } from "../process/gateway-work-admission.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";

export type TaskProgressPublication = {
  operationId: string;
  requesterSessionId: string;
  sessionKey: string;
  agentId: string;
  origin: DeliveryContext;
  sourceMessageId?: string | number;
  sourceChannelId?: string | number;
  content: string;
  previousContent?: string;
  snapshot: ChannelProgressDraftCompositorSnapshot;
  signal: AbortSignal;
  assertCurrent: () => void;
};

async function prepareTaskProgressTarget(
  params: Omit<TaskProgressPublication, "content" | "snapshot">,
) {
  const cfg = getRuntimeConfig();
  const channel = params.origin.channel;
  const to = params.origin.to;
  if (!channel || !to) {
    throw new Error("Task progress has no captured destination");
  }
  const plugin = getChannelPlugin(channel);
  if (!plugin) {
    return "unknown" as const;
  }
  const accountId = params.origin.accountId ?? resolveChannelDefaultAccountId({ plugin, cfg });
  const scope = resolveConversationRegistryScope({ agentId: params.agentId, config: cfg });
  const assertRequester = () => {
    params.signal.throwIfAborted();
    params.assertCurrent();
    const currentConfig = getRuntimeConfig();
    if (
      !plugin.config.listAccountIds(currentConfig).includes(accountId) ||
      isChannelAccountExplicitlyDisabled({ cfg: currentConfig, channel, accountId })
    ) {
      throw new Error("Task progress account is no longer available");
    }
    const requester = loadSessionEntryReadOnly({
      storePath: scope.storePath,
      sessionKey: params.sessionKey,
    });
    if (requester?.sessionId !== params.requesterSessionId) {
      throw new Error("Task progress requester was replaced");
    }
  };
  assertRequester();
  const existing = getConversationDeliveryOperation(scope, params.operationId);
  const hooks = getGlobalHookRunner();
  if (hooks?.hasHooks("reply_payload_sending")) {
    return "suppressed" as const;
  }
  if (
    !plugin.actions?.writeAuthorityActions?.includes("edit") ||
    hooks?.hasHooks("message_sending")
  ) {
    // Match the existing preview policy: modifiers must see each full-message update.
    return existing ? ("unknown" as const) : ("unsupported" as const);
  }
  const target = resolveOutboundTarget({ cfg, plugin, channel, accountId, to, mode: "explicit" });
  if (!target.ok) {
    throw target.error;
  }
  const route = await resolveOutboundSessionRoute({
    cfg,
    plugin,
    channel,
    accountId,
    agentId: params.agentId,
    target: target.to,
    threadId: params.origin.threadId,
  });
  assertRequester();
  const identity = route
    ? buildConversationIdentity({
        channel,
        accountId,
        kind: route.chatType,
        peerId: route.peer.id,
        deliveryTarget: route.to,
        threadId: route.threadId,
      })
    : null;
  const conversation = identity ? resolveConversation(scope, identity.conversationRef) : undefined;
  if (!conversation || !route) {
    return existing ? ("unknown" as const) : ("unsupported" as const);
  }
  const assertCurrent = () => {
    assertRequester();
    const current = resolveCurrentConversationSession(scope, conversation.conversationRef, {
      sessionKey: params.sessionKey,
      sessionId: params.requesterSessionId,
    });
    if (
      current?.sessionKey !== params.sessionKey ||
      current.sessionId !== params.requesterSessionId
    ) {
      throw new Error("Task progress conversation was replaced");
    }
    const currentHooks = getGlobalHookRunner();
    if (
      currentHooks?.hasHooks("message_sending") ||
      currentHooks?.hasHooks("reply_payload_sending")
    ) {
      throw new Error("Task progress preview policy changed");
    }
  };
  assertCurrent();
  return { cfg, channel, plugin, accountId, scope, route, conversation, assertCurrent };
}

/** Adopts positive platform evidence without sending or editing a message. */
export async function adoptTaskProgressMessage(
  params: Omit<TaskProgressPublication, "content" | "snapshot"> & {
    receipt: ProgressContinuationReceipt;
  },
): Promise<boolean> {
  const prepared = await prepareTaskProgressTarget(params);
  if (typeof prepared === "string") {
    return false;
  }
  const { cfg, channel, plugin, accountId, scope, route, conversation, assertCurrent } = prepared;
  assertCurrent();
  const { receipt } = params;
  if (!receipt.messageId.trim()) {
    return false;
  }
  const target = resolveOutboundTarget({
    cfg,
    plugin,
    channel,
    accountId,
    to: receipt.to,
    mode: "explicit",
  });
  if (!target.ok) {
    return false;
  }
  const receiptRoute = await resolveOutboundSessionRoute({
    cfg,
    plugin,
    channel,
    accountId,
    agentId: params.agentId,
    target: target.to,
    threadId: receipt.threadId,
  });
  assertCurrent();
  if (
    !receiptRoute ||
    !channelRouteTargetsMatchExact({
      left: {
        channel: receipt.channel,
        accountId: receipt.accountId ?? resolveChannelDefaultAccountId({ plugin, cfg }),
        to: normalizeTargetForProvider(channel, receiptRoute.to, plugin),
        threadId: receiptRoute.threadId,
      },
      right: {
        channel,
        accountId,
        to: normalizeTargetForProvider(channel, route.to, plugin),
        threadId: route.threadId,
      },
    })
  ) {
    return false;
  }
  await runConversationDatabaseWrite(scope, (writeScope) =>
    recordConversationProgressReceipt(writeScope, {
      operationId: params.operationId,
      conversationRef: conversation.conversationRef,
      sourceSessionKey: params.sessionKey,
      message: receipt.text,
      platformMessageId: receipt.messageId,
      progressSnapshot: receipt.snapshot,
      assertCurrent,
    }),
  );
  assertCurrent();
  return true;
}

/** Presentation state is scoped to the live requester window, not write authority. */
export function readTaskProgressSnapshot(
  params: Pick<
    TaskProgressPublication,
    "operationId" | "agentId" | "sessionKey" | "requesterSessionId"
  >,
): ChannelProgressDraftCompositorSnapshot | undefined {
  const scope = resolveConversationRegistryScope({
    agentId: params.agentId,
    config: getRuntimeConfig(),
  });
  const requester = loadSessionEntryReadOnly({
    storePath: scope.storePath,
    sessionKey: params.sessionKey,
  });
  if (requester?.sessionId !== params.requesterSessionId) {
    return undefined;
  }
  const receipt = getConversationDeliveryOperation(scope, params.operationId);
  if (
    !receipt ||
    receipt.operationKind !== "send" ||
    receipt.sourceSessionKey !== params.sessionKey
  ) {
    return undefined;
  }
  const current = resolveCurrentConversationSession(scope, receipt.conversationRef, {
    sessionKey: params.sessionKey,
    sessionId: params.requesterSessionId,
  });
  return current?.sessionKey === params.sessionKey &&
    current.sessionId === params.requesterSessionId
    ? getConversationProgressSnapshot(scope, params.operationId)
    : undefined;
}

/** Edits only the previously adopted card; an absent or uncertain receipt cannot create one. */
export async function publishTaskProgressMessage(
  params: TaskProgressPublication,
): Promise<"sent" | "unchanged" | "suppressed" | "unknown" | "unsupported"> {
  const prepared = await prepareTaskProgressTarget(params);
  if (typeof prepared === "string") {
    return prepared;
  }
  const { cfg, channel, plugin, accountId, scope, route, conversation } = prepared;
  const assertReceipt = (receipt: ConversationDeliveryRecord) => {
    if (
      receipt.operationKind !== "send" ||
      receipt.conversationRef !== conversation.conversationRef ||
      receipt.sourceSessionKey !== params.sessionKey
    ) {
      throw new Error("Task progress receipt belongs to another destination");
    }
  };
  prepared.assertCurrent();
  const receipt = getConversationDeliveryOperation(scope, params.operationId);
  if (!receipt) {
    return "unknown";
  }
  assertReceipt(receipt);
  if (receipt.status === "suppressed") {
    return "suppressed";
  }
  const messageId = receipt.platformMessageId;
  if ((receipt.status !== "sent" && receipt.status !== "replied") || !messageId) {
    return "unknown";
  }
  const assertCurrent = () => {
    prepared.assertCurrent();
    const current = getConversationDeliveryOperation(scope, params.operationId);
    if (
      !current ||
      (current.status !== "sent" && current.status !== "replied") ||
      current.platformMessageId !== messageId
    ) {
      throw new Error("Task progress receipt is no longer identified");
    }
    assertReceipt(current);
  };
  await runConversationDatabaseWrite(scope, (writeScope) =>
    updateConversationProgressSnapshot(writeScope, {
      operationId: params.operationId,
      progressSnapshot: params.snapshot,
      assertCurrent,
    }),
  );
  assertCurrent();
  if (params.previousContent === params.content) {
    return "unchanged";
  }
  const edited = await runMessageAction({
    cfg,
    action: "edit",
    progressSnapshot: params.snapshot,
    params: {
      channel,
      to: route.to,
      messageId,
      message: params.content,
      threadId: route.threadId,
    },
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: params.requesterSessionId,
    defaultAccountId: accountId,
    requesterAccountId: accountId,
    toolContext: {
      currentChannelId: String(params.sourceChannelId ?? route.peer.id),
      currentMessagingTarget: route.to,
      currentChannelProvider: plugin.id,
      currentChatType: route.chatType,
      currentThreadTs: route.threadId === undefined ? undefined : String(route.threadId),
      currentMessageId: params.sourceMessageId,
      sameChannelThreadRequired: route.threadId !== undefined,
    },
    assertDirectAdapterHandoff: assertCurrent,
    abortSignal: params.signal,
    suppressTranscriptMirror: true,
    gatewayOwnedDelivery: true,
  });
  return !edited.dryRun && resolveMessageActionOutcome(edited).ok ? "sent" : "unknown";
}

export type TaskProgressTyping = Pick<
  TaskProgressPublication,
  "operationId" | "requesterSessionId" | "sessionKey" | "agentId" | "origin" | "signal"
> & {
  prepareCurrent: () => Promise<() => void>;
  isExecutionActive: () => boolean;
  onStopped: () => void;
  onError: (error: unknown) => void;
};

/** Reuses the channel typing loop; the task batch owns its lifetime and cancellation. */
export function startTaskProgressTyping(params: TaskProgressTyping): boolean {
  const channel = params.origin.channel;
  const to = params.origin.to;
  if (!channel || !to || params.signal.aborted) {
    return false;
  }
  const plugin = getChannelPlugin(channel);
  const sendTyping = plugin?.heartbeat?.sendTypingGuarded;
  if (!plugin || !sendTyping) {
    return false;
  }
  const cfg = getRuntimeConfig();
  const accountId = params.origin.accountId ?? resolveChannelDefaultAccountId({ plugin, cfg });
  const scope = resolveConversationRegistryScope({ agentId: params.agentId, config: cfg });
  const receipt = getConversationDeliveryOperation(scope, params.operationId);
  if (
    !receipt ||
    receipt.operationKind !== "send" ||
    receipt.sourceSessionKey !== params.sessionKey
  ) {
    return false;
  }
  const controller = new AbortController();
  const signal = AbortSignal.any([params.signal, controller.signal]);
  const assertCurrent = (assertTaskCurrent: () => void) => {
    signal.throwIfAborted();
    assertTaskCurrent();
    const currentConfig = getRuntimeConfig();
    const requester = loadSessionEntryReadOnly({
      storePath: scope.storePath,
      sessionKey: params.sessionKey,
    });
    const mode =
      resolveAgentConfig(currentConfig, params.agentId)?.typingMode ??
      currentConfig.agents?.defaults?.typingMode;
    const hooks = getGlobalHookRunner();
    const association = resolveCurrentConversationSession(scope, receipt.conversationRef, {
      sessionKey: params.sessionKey,
      sessionId: params.requesterSessionId,
    });
    if (
      requester?.sessionId !== params.requesterSessionId ||
      !association ||
      mode === "never" ||
      !params.isExecutionActive() ||
      !plugin.config.listAccountIds(currentConfig).includes(accountId) ||
      isChannelAccountExplicitlyDisabled({ cfg: currentConfig, channel, accountId }) ||
      hooks?.hasHooks("message_sending") ||
      hooks?.hasHooks("reply_payload_sending")
    ) {
      throw new Error("Task progress typing is no longer authorized");
    }
  };
  const callbacks = createTypingCallbacks({
    start: async () => {
      await runWithGatewayDetachedWorkContinuation(async () => {
        const assertTaskCurrent = await params.prepareCurrent();
        const assertAuthorized = () => assertCurrent(assertTaskCurrent);
        assertAuthorized();
        await sendTyping({
          cfg: getRuntimeConfig(),
          to,
          accountId,
          threadId: params.origin.threadId,
          signal,
          assertPlatformSendAuthorized: assertAuthorized,
        });
      }, "tasks:progress-typing");
    },
    // The captured task lifetime, not an unrelated reply timeout, is the duration bound.
    maxDurationMs: 0,
    onStartError: (error) => {
      stop();
      if (!params.signal.aborted) {
        params.onError(error);
      }
    },
  });
  function stop() {
    if (controller.signal.aborted) {
      return;
    }
    controller.abort();
    callbacks.onCleanup?.();
    params.signal.removeEventListener("abort", stop);
    params.onStopped();
  }
  params.signal.addEventListener("abort", stop, { once: true });
  if (params.signal.aborted) {
    stop();
    return false;
  }
  void callbacks.onReplyStart();
  return true;
}
