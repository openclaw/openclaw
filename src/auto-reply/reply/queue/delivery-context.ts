import { stableStringify } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { readToolAllowlistIntersection } from "../../../agents/tool-policy.js";
import { normalizeChatType } from "../../../channels/chat-type.js";
import { channelRouteDedupeKey } from "../../../plugin-sdk/channel-route.js";
import { resolveGlobalSingleton } from "../../../shared/global-singleton.js";
import { normalizeMessageChannel } from "../../../utils/message-channel.js";
import {
  resolveReplyScreenToolTarget,
  resolveReplyThemeProfileId,
} from "../reply-tool-authority.js";
import type { FollowupRun } from "./types.js";

export function hasPreparedCurrentTurnImages(run: FollowupRun): boolean {
  return (
    // SAFETY: queue producers attach this private marker; only literal true selects prepared input.
    (run as FollowupRun & { currentTurnImagesPrepared?: true }).currentTurnImagesPrepared === true
  );
}

const QUEUED_ADMISSION_OWNER_STATE_KEY = Symbol.for("openclaw.queuedAdmissionOwnerState");
const queuedAdmissionOwnerState = resolveGlobalSingleton(QUEUED_ADMISSION_OWNER_STATE_KEY, () => ({
  keys: new WeakMap<NonNullable<FollowupRun["turnAdoptionLifecycle"]>, string>(),
  nextId: 1,
}));

export function hasExclusiveTurnAdmission(
  lifecycle: FollowupRun["turnAdoptionLifecycle"],
): lifecycle is NonNullable<FollowupRun["turnAdoptionLifecycle"]> & {
  admission: "exclusive";
} {
  return lifecycle?.admission === "exclusive";
}

function resolveTurnAdoptionLifecycleDeliveryKey(
  lifecycle: FollowupRun["turnAdoptionLifecycle"],
): string {
  if (!lifecycle) {
    return "";
  }
  const explicitOwnerKey = lifecycle.ownerKey ?? "";
  // Closed admission marker — never infer exclusive from onAbandoned presence.
  // Cancel-only owners share collect identity via ownerKey alone.
  if (!hasExclusiveTurnAdmission(lifecycle)) {
    return explicitOwnerKey;
  }
  let admissionOwnerKey = queuedAdmissionOwnerState.keys.get(lifecycle);
  if (!admissionOwnerKey) {
    admissionOwnerKey = `admission:${queuedAdmissionOwnerState.nextId++}`;
    queuedAdmissionOwnerState.keys.set(lifecycle, admissionOwnerKey);
  }
  // Durable admission callbacks own separate ingress identities. Combining
  // them would let one source commit before a sibling rejects the aggregate.
  return JSON.stringify([explicitOwnerKey, admissionOwnerKey]);
}

// Keep this key aligned with the fields that affect per-message authorization or
// exec-context propagation in collect-mode batching. Display-only sender fields
// stay out of the key so profile/name drift does not force conservative splits.
// Fields like authProfileId, elevatedLevel, ownerNumbers, and config are
// intentionally excluded because they are session-level or not consulted in
// per-message authorization checks.
function resolveFollowupAuthorizationKey(run: FollowupRun): string {
  const execution = run.run;
  return JSON.stringify([
    execution.senderId ?? "",
    JSON.stringify(execution.channelContext ?? null),
    stableStringify(execution.conversationToolPolicy ?? null),
    execution.senderE164 ?? "",
    execution.senderIsOwner === true,
    execution.execOverrides?.host ?? "",
    execution.execOverrides?.security ?? "",
    execution.execOverrides?.ask ?? "",
    execution.execOverrides?.node ?? "",
    execution.execOverrides?.nodeCwd ?? "",
    execution.bashElevated?.enabled === true,
    execution.bashElevated?.allowed === true,
    execution.bashElevated?.defaultLevel ?? "",
    execution.approvalReviewerDeviceId ?? "",
  ]);
}

export function resolveFollowupDeliveryContextKey(run: FollowupRun): string {
  const execution = run.run;
  const provenance = execution.inputProvenance;
  return JSON.stringify([
    channelRouteDedupeKey({
      channel: run.originatingChannel,
      to: run.originatingTo,
      accountId: run.originatingAccountId,
      threadId: run.originatingThreadId,
    }),
    hasPreparedCurrentTurnImages(run),
    // Approved sources skip the write hook; never carry unstaged input past it.
    Boolean(run.userTurnTranscriptRecorder?.getPendingInputMessage?.()),
    run.originatingChatId ?? "",
    resolveFollowupReplyAnchor(run) ?? "",
    run.originatingReplyToMode ?? "",
    normalizeChatType(run.originatingChatType) ?? "",
    resolveFollowupAuthorizationKey(run),
    run.turnAdoptionLifecycle?.ownerKey ?? "",
    normalizeOptionalString(execution.runtimePolicySessionKey ?? execution.sessionKey) ?? "",
    execution.provider,
    execution.model,
    execution.messageProvider ?? "",
    JSON.stringify([...new Set(execution.clientCaps ?? [])].toSorted()),
    stableStringify(resolveReplyScreenToolTarget(run) ?? null),
    resolveReplyThemeProfileId(run) ?? "",
    stableStringify(execution.toolBindings ?? null),
    execution.chatType ?? "",
    execution.agentAccountId ?? "",
    execution.conversationRoutePeerId ?? "",
    execution.groupId ?? "",
    execution.groupChannel ?? "",
    execution.groupSpace ?? "",
    JSON.stringify([...new Set(execution.memberRoleIds ?? [])].toSorted()),
    execution.spawnedBy ?? "",
    execution.traceAuthorized === true,
    execution.traceLevelOverride ?? "",
    execution.thinkLevel ?? "",
    execution.thinkLevelOverride ?? "",
    execution.fastMode ?? "",
    execution.fastModeOverride === true,
    execution.fastModeAutoOnSecondsOverride === true,
    execution.fastModeAutoOnSeconds ?? "",
    execution.verboseLevel ?? "",
    execution.verboseLevelOverride ?? "",
    execution.reasoningLevel ?? "",
    execution.elevatedLevel ?? "",
    provenance?.kind ?? "",
    provenance?.originSessionId ?? "",
    provenance?.sourceSessionKey ?? "",
    provenance?.sourceChannel ?? "",
    provenance?.sourceTool ?? "",
    stableStringify(execution.trustedInternalHandoff ?? null),
    stableStringify(execution.scheduledToolPolicy ?? null),
    stableStringify(execution.runtimePluginToolGrant ?? null),
    stableStringify(run.toolsAllow ?? null),
    stableStringify(
      run.toolsAllow ? (readToolAllowlistIntersection(run.toolsAllow) ?? null) : null,
    ),
    run.disableTools === true,
    execution.extraSystemPrompt ?? "",
    execution.extraSystemPromptStatic ?? "",
    execution.sourceReplyDeliveryMode ?? "",
    execution.taskSuggestionDeliveryMode ?? "",
    execution.silentReplyPromptMode ?? "",
    execution.enforceFinalTag === true,
    execution.skipProviderRuntimeHints === true,
    execution.silentExpected === true,
    run.currentInboundEventKind ?? "",
    execution.terminalReplyExpectation ?? "",
    execution.suppressNextUserMessagePersistence === true,
    execution.suppressTranscriptOnlyAssistantPersistence === true,
    execution.blockReplyBreak,
    resolveTurnAdoptionLifecycleDeliveryKey(run.turnAdoptionLifecycle),
  ]);
}

export function resolveFollowupReplyAnchor(run: FollowupRun): string | undefined {
  if (run.originatingReplyToMode === "off") {
    return undefined;
  }
  const replyToId = normalizeOptionalString(run.originatingReplyToId);
  if (replyToId || normalizeMessageChannel(run.originatingChannel) !== "slack") {
    return replyToId;
  }
  const threadId = run.originatingThreadId;
  const hasRoutedThread =
    typeof threadId === "number"
      ? Number.isFinite(threadId)
      : normalizeOptionalString(threadId) !== undefined;
  // Slack standalone turns have no parent reply id, but enabled reply policies
  // still need the message id so collect groups cannot cross independent roots.
  // A routed thread already owns that boundary and remains collectable across turns.
  return hasRoutedThread ? undefined : normalizeOptionalString(run.messageId);
}
