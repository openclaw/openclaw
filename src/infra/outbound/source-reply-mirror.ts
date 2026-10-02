// Source reply mirroring records successful same-conversation message-tool
// sends back into the owning session transcript.
import { asOptionalRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeOptionalTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { projectPluginMessageDeliveryFact } from "../../agents/embedded-agent-message-delivery.js";
import { isMessageToolSendActionName } from "../../agents/embedded-agent-messaging.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { normalizeOutboundLocation } from "../../channels/location.js";
import { resolveReactionMessageId } from "../../channels/plugins/actions/reaction-message-id.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import { resolveChannelPluginRegistration } from "../../channels/plugins/registry.js";
import type { ChannelId, ChannelMessageActionName } from "../../channels/plugins/types.public.js";
import { resolveChannelThreadAddressing } from "../../channels/thread-addressing.js";
import type { InternalChannelThreadingToolContext } from "../../channels/threading-tool-context-internal.js";
import { appendAssistantMessageToSessionTranscript } from "../../config/sessions.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  beginRestartRecoveryTerminalDelivery,
  cancelRestartRecoveryTerminalDelivery,
  completeRestartRecoveryTerminalDelivery,
  type RestartRecoveryTerminalDeliveryScope,
} from "../../config/sessions/restart-recovery-receipt.js";
import { getOwnedSessionTranscriptWriterFence } from "../../config/sessions/transcript-write-context.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAccountId, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { readTrimmedStringAlias } from "../../utils/string-readers.js";
import { createOutboundPayloadPlan, projectOutboundPayloadPlanForMirror } from "./payloads.js";
import { normalizeTargetForProvider } from "./target-normalization.js";

type SourceReplyTranscriptMirrorParams = {
  action: string;
  channel: string;
  actionParams: Record<string, unknown>;
  cfg: OpenClawConfig;
  accountId?: string | null;
  currentAccountId?: string | null;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  toolContext?: InternalChannelThreadingToolContext;
  idempotencyKey?: string;
  sourceReplyFinal?: boolean;
  toolCallId?: string;
  deliveredPayload?: unknown;
  replyToIsExplicit?: boolean;
};

type TerminalSourceReplyDeliveryStart =
  | TerminalSourceReplyDeliveryReceipt
  | {
      outcome: "already_delivered" | "delivery_ambiguous";
      result: { status: string; delivered: false; message: string };
    }
  | undefined;

function buildTerminalSourceReplyNoSendResult(outcome: "already_delivered" | "delivery_ambiguous") {
  return {
    outcome,
    result: {
      status: outcome,
      delivered: false as const,
      message:
        outcome === "already_delivered"
          ? "The completed reply was already delivered. Do not retry it."
          : "The completed reply may already have been delivered. Do not retry it.",
    },
  };
}

type MirrorableSourceReplyTranscriptParams = SourceReplyTranscriptMirrorParams & {
  sessionKey: string;
};

type TerminalSourceReplyDeliveryReceipt = RestartRecoveryTerminalDeliveryScope;

type SourceReplyThreadPlacement = "match" | "mismatch" | "unknown";

function resolveSourceReplyTarget(params: Record<string, unknown>): string | undefined {
  return readTrimmedStringAlias(params, ["target", "to", "channelId", "chatId"]);
}

function resolveSourceReplyThreadId(params: SourceReplyTranscriptMirrorParams): string | undefined {
  return readTrimmedStringAlias(params.actionParams, ["threadId", "messageThreadId"]);
}

function resolveDeliveryReceipt(
  params: SourceReplyTranscriptMirrorParams,
): Record<string, unknown> | undefined {
  const payload = asRecord(params.deliveredPayload);
  const result = asRecord(payload?.result);
  return asRecord(result?.receipt) ?? asRecord(payload?.receipt);
}

function resolveDeliveredThreadPlacement(
  params: SourceReplyTranscriptMirrorParams,
  currentThreadId: string | undefined,
): SourceReplyThreadPlacement | undefined {
  const receipt = resolveDeliveryReceipt(params);
  if (!receipt) {
    return undefined;
  }
  const deliveredThreadId = normalizeOptionalString(receipt.threadId);
  if (deliveredThreadId) {
    return deliveredThreadId === currentThreadId ? "match" : "mismatch";
  }
  const deliveredReplyToId = normalizeOptionalString(receipt.replyToId);
  if (deliveredReplyToId) {
    const currentMessageId = normalizeMessageIdValue(params.toolContext?.currentMessageId);
    return deliveredReplyToId === currentThreadId || deliveredReplyToId === currentMessageId
      ? "match"
      : "mismatch";
  }
  return currentThreadId ? "mismatch" : "match";
}

function resolveSourceReplyThreadPlacement(
  params: SourceReplyTranscriptMirrorParams,
  threadAddressing: ReturnType<typeof resolveChannelThreadAddressing>,
): SourceReplyThreadPlacement {
  const currentThreadId = normalizeOptionalString(params.toolContext?.currentThreadTs);
  const deliveredPlacement = resolveDeliveredThreadPlacement(params, currentThreadId);
  if (deliveredPlacement) {
    return deliveredPlacement;
  }
  if (params.actionParams.topLevel === true) {
    return currentThreadId ? "mismatch" : "match";
  }
  if (
    threadAddressing === "message" &&
    params.replyToIsExplicit === true &&
    !currentThreadId &&
    normalizeOptionalString(params.actionParams.replyTo)
  ) {
    return "mismatch";
  }
  for (const key of ["threadId", "messageThreadId"] as const) {
    if (!Object.hasOwn(params.actionParams, key)) {
      continue;
    }
    const explicitThreadId = normalizeOptionalString(params.actionParams[key]);
    if (!explicitThreadId) {
      return currentThreadId ? "mismatch" : "match";
    }
    return explicitThreadId === currentThreadId ? "match" : "mismatch";
  }
  return currentThreadId ? "unknown" : "match";
}

function resolveThreadedSourceTarget(
  params: SourceReplyTranscriptMirrorParams,
  requestedTarget: string,
): string {
  const threadId = resolveSourceReplyThreadId(params);
  if (!threadId) {
    return requestedTarget;
  }
  return (
    normalizeOptionalString(
      getChannelPlugin(params.channel as ChannelId)?.threading?.resolveCurrentChannelId?.({
        to: requestedTarget,
        threadId,
      }),
    ) ?? requestedTarget
  );
}

function resolveCurrentSourceTurnId(
  toolContext: InternalChannelThreadingToolContext | undefined,
): string | undefined {
  return normalizeOptionalString(toolContext?.currentSourceTurnId);
}

function resolveTerminalSourceReplyDeliveryReceipt(
  params: SourceReplyTranscriptMirrorParams,
): TerminalSourceReplyDeliveryReceipt | undefined {
  const toolCallId = normalizeOptionalString(params.toolCallId);
  if (params.sourceReplyFinal !== true) {
    return undefined;
  }
  if (!toolCallId) {
    throw new Error("terminal source reply requires tool-call correlation");
  }
  if (!params.sessionId || !isCurrentSourceConversation(params)) {
    return undefined;
  }
  const sourceTurnId = resolveCurrentSourceTurnId(params.toolContext);
  if (!sourceTurnId) {
    return undefined;
  }
  const agentId = params.agentId ?? resolveAgentIdFromSessionKey(params.sessionKey);
  // Agent admission promotes legacy aliases before the run starts. The signed
  // runtime session key therefore owns both the active claim and transcript.
  return {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sourceTurnId,
    storePath: resolveSessionStorePathCore(params.cfg.session?.store, { agentId }),
    toolCallId,
  };
}

/** Arms the fail-closed state before a terminal source reply can reach a provider. */
export async function beginTerminalSourceReplyDelivery(
  params: SourceReplyTranscriptMirrorParams,
): Promise<TerminalSourceReplyDeliveryStart> {
  const receipt = resolveTerminalSourceReplyDeliveryReceipt(params);
  if (!receipt) {
    return undefined;
  }
  const result = await beginRestartRecoveryTerminalDelivery(receipt);
  if (result === "not-applicable") {
    return undefined;
  }
  if (result === "already-delivered") {
    return buildTerminalSourceReplyNoSendResult("already_delivered");
  }
  if (result === "delivery-ambiguous" || result === "stale") {
    return buildTerminalSourceReplyNoSendResult("delivery_ambiguous");
  }
  return receipt;
}

/** Cancels a pre-send intent only when dispatch proved that no send occurred. */
export async function cancelTerminalSourceReplyDelivery(
  receipt: TerminalSourceReplyDeliveryReceipt | undefined,
): Promise<void> {
  if (receipt) {
    await cancelRestartRecoveryTerminalDelivery(receipt);
  }
}

/** Reconciles the provider result while an unresolved intent remains fail closed. */
export async function reconcileTerminalSourceReplyDelivery(params: {
  deliveredPayload: unknown;
  mirror: SourceReplyTranscriptMirrorParams;
  preservePendingOnExplicitFailure?: boolean;
  receipt: TerminalSourceReplyDeliveryReceipt | undefined;
}): Promise<"delivered" | "not-delivered" | "not-source" | "not-applicable" | "pending"> {
  if (!params.receipt) {
    return "not-applicable";
  }
  const deliveryFact = projectPluginMessageDeliveryFact(params.deliveredPayload);
  if (deliveryFact && deliveryFact.status !== "settled") {
    if (params.preservePendingOnExplicitFailure) {
      return "pending";
    }
    await cancelRestartRecoveryTerminalDelivery(params.receipt);
    return "not-delivered";
  }
  if (
    !matchesDeliveredSourceTargets(
      { ...params.mirror, deliveredPayload: params.deliveredPayload },
      deliveryFact,
    ) ||
    !isExactCurrentSourceConversation({
      ...params.mirror,
      deliveredPayload: params.deliveredPayload,
    })
  ) {
    return "not-source";
  }
  await completeRestartRecoveryTerminalDelivery(params.receipt);
  return "delivered";
}

function resolveTranscriptMirrorIdempotencyKey(params: {
  idempotencyKey?: string;
  sourceReplyFinal?: boolean;
  sourceTurnId?: string;
}): string | undefined {
  if (params.sourceReplyFinal !== true || !params.idempotencyKey || !params.sourceTurnId) {
    return params.idempotencyKey;
  }
  // Progress and terminal mirrors may share provider idempotency. Transcript
  // receipts need distinct keys so a progress row cannot mask the terminal marker.
  return `${params.idempotencyKey}:terminal-receipt:${params.sourceTurnId}`;
}

function hasCurrentSourceContext(params: SourceReplyTranscriptMirrorParams): boolean {
  if (!params.sessionKey?.trim()) {
    return false;
  }
  const toolContext = params.toolContext;
  if (!toolContext) {
    return false;
  }
  const accountId = normalizeOptionalString(params.accountId);
  if (accountId) {
    const currentAccountId = normalizeOptionalString(params.currentAccountId);
    if (
      !currentAccountId ||
      normalizeAccountId(accountId) !== normalizeAccountId(currentAccountId)
    ) {
      return false;
    }
  }
  const currentChannel = normalizeOptionalLowercaseString(toolContext.currentChannelProvider);
  if (!currentChannel || currentChannel !== normalizeOptionalLowercaseString(params.channel)) {
    return false;
  }
  return true;
}

function matchesCurrentSourceTarget(
  params: SourceReplyTranscriptMirrorParams,
  threadPlacement: SourceReplyThreadPlacement,
): boolean {
  const toolContext = params.toolContext;
  if (!toolContext) {
    return false;
  }
  const currentTargets = [
    normalizeOptionalString(toolContext.currentMessagingTarget),
    normalizeOptionalString(toolContext.currentChannelId),
  ].filter((target): target is string => Boolean(target));
  if (currentTargets.length === 0) {
    return false;
  }
  const requestedTarget = resolveSourceReplyTarget(params.actionParams);
  if (!requestedTarget) {
    return false;
  }
  if (threadPlacement === "mismatch") {
    return false;
  }
  const threadedTarget = resolveThreadedSourceTarget(params, requestedTarget);
  const plugin = getChannelPlugin(params.channel as ChannelId);
  const matchesToolContextTarget = plugin?.threading?.matchesToolContextTarget;
  if (
    threadPlacement === "match" &&
    (matchesToolContextTarget?.({
      target: requestedTarget,
      toolContext,
    }) ||
      (threadedTarget !== requestedTarget &&
        matchesToolContextTarget?.({
          target: threadedTarget,
          toolContext,
        })))
  ) {
    return true;
  }
  const normalizedTargets = new Set(
    [requestedTarget, threadedTarget]
      .map((target) => normalizeTargetForProvider(params.channel, target, plugin))
      .filter((target): target is string => Boolean(target)),
  );
  return currentTargets.some((target) => {
    const normalized = normalizeTargetForProvider(params.channel, target, plugin);
    return normalized !== undefined && normalizedTargets.has(normalized);
  });
}

function matchesDeliveredSourceTargets(
  params: SourceReplyTranscriptMirrorParams,
  delivery: ReturnType<typeof projectPluginMessageDeliveryFact>,
): boolean {
  // Requested routes cannot override contradictory transport facts. Match each
  // reported recipient independently, without inheriting requested thread aliases.
  // Aggregate metadata cannot hide a physical message delivered to another topic.
  const receipt = resolveDeliveryReceipt(params);
  const deliveredThreadId = normalizeOptionalString(receipt?.threadId);
  const currentThreadId = normalizeOptionalString(params.toolContext?.currentThreadTs);
  if (
    Array.isArray(receipt?.parts) &&
    receipt.parts.some((part) => {
      const threadId = normalizeOptionalString(asRecord(part)?.threadId);
      return threadId !== undefined && threadId !== (deliveredThreadId ?? currentThreadId);
    })
  ) {
    return false;
  }
  return (delivery?.deliveredTargets ?? []).every((target) =>
    matchesCurrentSourceTarget(
      {
        ...params,
        actionParams: {
          target,
          ...(deliveredThreadId ? { threadId: deliveredThreadId } : {}),
        },
      },
      "match",
    ),
  );
}

function isCurrentSourceConversation(
  params: SourceReplyTranscriptMirrorParams,
): params is MirrorableSourceReplyTranscriptParams {
  // Polls share the send target contract. Transcript mirroring stays send-only
  // because poll params carry no message text to mirror.
  if (params.action !== "send" && params.action !== "poll") {
    return false;
  }
  if (!hasCurrentSourceContext(params)) {
    return false;
  }
  const threadPlacement = resolveSourceReplyThreadPlacement(
    params,
    resolveChannelThreadAddressing(params.channel),
  );
  return matchesCurrentSourceTarget(params, threadPlacement);
}

function isExactCurrentSourceConversation(
  params: SourceReplyTranscriptMirrorParams,
): params is MirrorableSourceReplyTranscriptParams {
  const threadPlacement = resolveSourceReplyThreadPlacement(
    params,
    resolveChannelThreadAddressing(params.channel),
  );
  return threadPlacement === "match" && isCurrentSourceConversation(params);
}

type SourceReplyMatch = boolean | (() => Promise<boolean>);

function resolveOwnerCurrentConversationMatch(
  params: SourceReplyTranscriptMirrorParams,
  allowAsync: boolean,
): SourceReplyMatch | undefined {
  const toolContext = params.toolContext;
  if (!toolContext) {
    return undefined;
  }
  // SAFETY: message actions reach this boundary only after channel resolution.
  const channel = params.channel as ChannelId;
  const registration = resolveChannelPluginRegistration(channel);
  if (registration?.origin !== "bundled") {
    return undefined;
  }
  const aliasSpec =
    registration.plugin.actions?.messageActionTargetAliases?.[
      // SAFETY: action alias lookup accepts the normalized runtime action name.
      params.action as ChannelMessageActionName
    ];
  if (!aliasSpec) {
    return undefined;
  }
  const matchParams = {
    args: params.actionParams,
    accountId: normalizeAccountId(params.accountId ?? params.currentAccountId),
    toolContext,
  };
  const matchAsync = aliasSpec.matchesCurrentConversationAsync;
  if (allowAsync && matchAsync) {
    const authority = registration.captureReadAuthority?.();
    const isRegistrationCurrent = () => {
      const current =
        registration.captureReadAuthority && !authority?.()
          ? undefined
          : resolveChannelPluginRegistration(channel, { loadedOnly: true });
      return current?.plugin === registration.plugin && current.origin === "bundled";
    };
    if (!isRegistrationCurrent()) {
      return false;
    }
    return async () => (await matchAsync(matchParams)) && isRegistrationCurrent();
  }
  return aliasSpec.matchesCurrentConversation?.(matchParams) === true;
}

function resolveDeliveredThreadPlacementSourceReply(
  params: SourceReplyTranscriptMirrorParams,
  allowAsync: boolean,
): SourceReplyMatch {
  if (!hasCurrentSourceContext(params)) {
    return false;
  }
  const receipt = resolveDeliveryReceipt(params);
  if (normalizeOptionalString(receipt?.threadId) || normalizeOptionalString(receipt?.replyToId)) {
    const threadPlacement = resolveSourceReplyThreadPlacement(
      params,
      resolveChannelThreadAddressing(params.channel),
    );
    return threadPlacement === "match" && matchesCurrentSourceTarget(params, threadPlacement);
  }
  return resolveOwnerCurrentConversationMatch(params, allowAsync) ?? false;
}

function resolveDeliveredCurrentSourceReply(
  params: SourceReplyTranscriptMirrorParams,
  allowAsync: boolean,
): SourceReplyMatch {
  const deliveryFact = projectPluginMessageDeliveryFact(params.deliveredPayload);
  if (
    (deliveryFact && deliveryFact.status !== "settled") ||
    !matchesDeliveredSourceTargets(params, deliveryFact)
  ) {
    return false;
  }
  switch (params.action.trim().toLowerCase()) {
    case "react":
      return (
        params.sourceReplyFinal === true &&
        params.actionParams.remove !== true &&
        Boolean(normalizeOptionalString(params.actionParams.emoji)) &&
        isDeliveredCurrentSourceReplyAction(params)
      );
    case "reply":
      return isDeliveredCurrentSourceReplyAction(params);
    case "thread-reply":
      return resolveDeliveredThreadPlacementSourceReply(params, allowAsync);
    default:
      // Send variants share destination proof, not transcript or restart-receipt ownership.
      return (
        (isMessageToolSendActionName(params.action) || params.action === "poll") &&
        isExactCurrentSourceConversation({ ...params, action: "send" })
      );
  }
}

/** Synchronous classification for send-only consumers and legacy owner callbacks. */
export function isDeliveredCurrentSourceReply(params: SourceReplyTranscriptMirrorParams): boolean {
  return resolveDeliveredCurrentSourceReply(params, false) === true;
}

/** Confirms delivered source replies, awaiting bundled thread-alias proof when needed. */
export async function isDeliveredCurrentSourceReplyAsync(
  params: SourceReplyTranscriptMirrorParams,
): Promise<boolean> {
  const match = resolveDeliveredCurrentSourceReply(params, true);
  return typeof match === "function" ? await match() : match;
}

function normalizeMessageIdValue(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return normalizeOptionalString(value);
}

/**
 * Confirms a reply or explicitly terminal reaction addressed the message that triggered
 * the current run. Reply actions resolve their conversation from the replied-to message,
 * so target matching cannot apply; replying to the run's own inbound message is the
 * one implicit route that provably lands in the current source conversation.
 */
function isDeliveredCurrentSourceReplyAction(params: SourceReplyTranscriptMirrorParams): boolean {
  const toolContext = params.toolContext;
  if (!toolContext || !hasCurrentSourceContext(params)) {
    return false;
  }
  // Target params on reply actions are either agent-explicit or runner-resolved
  // from the tool context; both must still address the current conversation.
  // Delegate equivalence to the channel plugin first so provider-normalized
  // forms (for example `C123` vs `channel:C123`) are recognized like sends.
  const requestedTarget = resolveSourceReplyTarget(params.actionParams);
  if (requestedTarget) {
    const channelPlugin = getChannelPlugin(params.channel as ChannelId);
    const matchesToolContextTarget = channelPlugin?.threading?.matchesToolContextTarget;
    if (!matchesToolContextTarget?.({ target: requestedTarget, toolContext })) {
      const currentTargets = [
        normalizeOptionalString(toolContext.currentMessagingTarget),
        normalizeOptionalString(toolContext.currentChannelId),
      ].filter((target): target is string => Boolean(target));
      const normalizedTarget =
        normalizeTargetForProvider(params.channel, requestedTarget, channelPlugin) ??
        requestedTarget;
      if (
        !currentTargets.some(
          (target) =>
            (normalizeTargetForProvider(params.channel, target, channelPlugin) ?? target) ===
            normalizedTarget,
        )
      ) {
        return false;
      }
    }
  }
  const repliedToMessageId = normalizeMessageIdValue(
    params.action === "react"
      ? resolveReactionMessageId({ args: params.actionParams, toolContext })
      : (params.actionParams.messageId ?? params.actionParams.replyTo),
  );
  const currentMessageId = normalizeMessageIdValue(toolContext.currentMessageId);
  return Boolean(repliedToMessageId && currentMessageId && repliedToMessageId === currentMessageId);
}

/** Mirrors successful outbound source replies into the owning session transcript. */
export async function mirrorDeliveredSourceReplyToTranscript(
  params: SourceReplyTranscriptMirrorParams,
): Promise<boolean> {
  const deliveryFact = projectPluginMessageDeliveryFact(params.deliveredPayload);
  if (
    (deliveryFact && (deliveryFact.status !== "settled" || deliveryFact.partialDelivery)) ||
    !matchesDeliveredSourceTargets(params, deliveryFact)
  ) {
    return false;
  }
  const threadPlacement = resolveSourceReplyThreadPlacement(
    params,
    resolveChannelThreadAddressing(params.channel),
  );
  if (!isCurrentSourceConversation(params)) {
    return false;
  }
  if (params.sourceReplyFinal === true && threadPlacement !== "match") {
    return false;
  }

  const plan = createOutboundPayloadPlan([
    {
      text:
        readTrimmedStringAlias(params.actionParams, ["message", "content", "text", "caption"]) ??
        "",
      mediaUrl: readTrimmedStringAlias(params.actionParams, [
        "mediaUrl",
        "media",
        "path",
        "filePath",
        "fileUrl",
      ]),
      mediaUrls: normalizeOptionalTrimmedStringList(params.actionParams.mediaUrls),
      presentation: params.actionParams.presentation as ReplyPayload["presentation"],
      interactive: params.actionParams.interactive as ReplyPayload["interactive"],
      channelData: params.actionParams.channelData as ReplyPayload["channelData"],
      location: normalizeOutboundLocation(params.actionParams.location),
    },
  ]);
  const mirror = projectOutboundPayloadPlanForMirror(plan);
  if (!mirror.text && mirror.mediaUrls.length === 0) {
    return false;
  }
  const sourceTurnId = resolveCurrentSourceTurnId(params.toolContext);
  const writerFence = getOwnedSessionTranscriptWriterFence({ sessionKey: params.sessionKey });
  const result = await appendAssistantMessageToSessionTranscript({
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    ...(params.sessionId ? { expectedSessionId: params.sessionId } : {}),
    ...(writerFence?.expectedLifecycleRevision !== undefined
      ? { expectedLifecycleRevision: writerFence.expectedLifecycleRevision }
      : {}),
    ...(writerFence ? { expectedWriterRunId: writerFence.expectedWriterRunId } : {}),
    text: mirror.text,
    mediaUrls: mirror.mediaUrls.length ? mirror.mediaUrls : undefined,
    idempotencyKey: resolveTranscriptMirrorIdempotencyKey({
      idempotencyKey: params.idempotencyKey,
      sourceReplyFinal: params.sourceReplyFinal,
      sourceTurnId,
    }),
    ...(params.sourceReplyFinal !== undefined
      ? {
          deliveryMirror: {
            kind: "message-tool-source-reply" as const,
            final: params.sourceReplyFinal,
            ...(params.toolCallId ? { toolCallId: params.toolCallId } : {}),
            ...(sourceTurnId ? { sourceTurnId } : {}),
          },
        }
      : {}),
    config: params.cfg,
  });
  return result.ok;
}
