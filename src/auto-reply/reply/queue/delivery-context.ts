import { stableStringify } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { readToolAllowlistIntersection } from "../../../agents/tool-policy.js";
import { normalizeChatType } from "../../../channels/chat-type.js";
import { combineChannelAdmissionEvidence } from "../../../channels/message-access/admission-evidence.js";
import { channelRouteDedupeKey } from "../../../plugin-sdk/channel-route.js";
import { resolveGlobalSingleton } from "../../../shared/global-singleton.js";
import { normalizeMessageChannel } from "../../../utils/message-channel.js";
import {
  resolveReplyOperatorAuthorityKey,
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
    resolveReplyOperatorAuthorityKey(run.operatorAuthority),
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
    execution.clientId ?? "",
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

type FollowupRuntimeMetadata = Pick<
  FollowupRun,
  | "operatorAuthority"
  | "personalBootstrapEligible"
  | "currentInboundEventKind"
  | "currentInboundAudio"
  | "currentInboundContext"
  | "explicitSkillSelections"
  | "channelAdmissionEvidence"
  | "toolsAllow"
  | "disableTools"
  | "abortSignal"
  | "queueAbortSignal"
  | "deliveryCorrelations"
  | "turnAdoptionLifecycle"
  | "replyOperationRunStates"
  | "queuedFollowupReplyDisposition"
>;

function hasCurrentTurnRuntimeMetadata(item: FollowupRun): boolean {
  return (
    item.currentInboundEventKind === "room_event" ||
    item.currentInboundAudio === true ||
    Boolean(item.currentInboundContext)
  );
}

function collectCurrentInboundContext(items: FollowupRun[]): FollowupRun["currentInboundContext"] {
  const contexts = items.flatMap((item, index) =>
    item.currentInboundContext ? [{ context: item.currentInboundContext, index }] : [],
  );
  if (contexts.length === 0) {
    return undefined;
  }
  if (contexts.length === 1) {
    return contexts[0]?.context;
  }
  const renderField = (field: "text" | "resumableText") => {
    const blocks = contexts.flatMap(({ context, index }) => {
      const value = context[field];
      return value ? [`Queued #${index + 1} context:\n${value}`] : [];
    });
    return blocks.length > 0 ? blocks.join("\n\n") : undefined;
  };
  const text = renderField("text");
  if (!text) {
    return undefined;
  }
  const resumableText = renderField("resumableText");
  const injectedGoalContexts = [
    ...new Set(contexts.flatMap(({ context }) => context.injectedGoalContexts ?? [])),
  ];
  return {
    text,
    ...(resumableText ? { resumableText } : {}),
    fragments: contexts.flatMap(
      ({ context }) =>
        context.fragments ?? [{ kind: "conversation-data" as const, text: context.text }],
    ),
    promptJoiner: "\n\n",
    ...(injectedGoalContexts.length > 0 ? { injectedGoalContexts } : {}),
  };
}

export function collectRuntimeMetadata(
  items: FollowupRun[],
  abortSignal?: AbortSignal,
): FollowupRuntimeMetadata {
  const currentTurnSource = items.find(hasCurrentTurnRuntimeMetadata);
  // Delivery-key equality proves every source has the same turn authority.
  // Preserve the exact carrier (including hidden intersections); never derive it from identity evidence.
  const authoritySource = items.at(-1);
  const deliveryCorrelations = items.flatMap((item) => item.deliveryCorrelations ?? []);
  const explicitSkillSelections = [
    ...new Map(
      items
        .flatMap((item) => item.explicitSkillSelections ?? [])
        .map((selection) => [selection.path, selection] as const),
    ).values(),
  ];
  return {
    operatorAuthority: authoritySource?.operatorAuthority,
    ...(items.length > 0 && items.every((item) => item.personalBootstrapEligible === true)
      ? { personalBootstrapEligible: true }
      : {}),
    currentInboundEventKind: currentTurnSource?.currentInboundEventKind,
    currentInboundAudio: currentTurnSource?.currentInboundAudio,
    currentInboundContext: collectCurrentInboundContext(items),
    explicitSkillSelections:
      explicitSkillSelections.length > 0 ? explicitSkillSelections : undefined,
    channelAdmissionEvidence: combineChannelAdmissionEvidence(
      items.map((item) => item.channelAdmissionEvidence),
    ),
    toolsAllow: authoritySource?.toolsAllow,
    disableTools: authoritySource?.disableTools,
    abortSignal,
    queueAbortSignal: items.find((item) => item.queueAbortSignal)?.queueAbortSignal,
    deliveryCorrelations: deliveryCorrelations.length > 0 ? deliveryCorrelations : undefined,
    turnAdoptionLifecycle: items.length === 1 ? items[0]?.turnAdoptionLifecycle : undefined,
    replyOperationRunStates: items.flatMap((item) => item.replyOperationRunStates ?? []),
    queuedFollowupReplyDisposition: items.at(-1)?.queuedFollowupReplyDisposition,
  };
}

export function createOverflowSummaryRetrySource(source: FollowupRun): FollowupRun {
  return {
    prompt: source.prompt,
    admissionSessionId: source.admissionSessionId,
    operatorAuthority: source.operatorAuthority,
    personalBootstrapEligible: source.personalBootstrapEligible,
    queueAbortSignal: source.queueAbortSignal,
    transcriptPrompt: source.transcriptPrompt,
    userTurnTranscriptRecorder: source.userTurnTranscriptRecorder,
    explicitSkillSelections: source.explicitSkillSelections,
    toolsAllow: source.toolsAllow,
    disableTools: source.disableTools,
    images: source.images,
    imageOrder: source.imageOrder,
    media: source.media,
    channelAdmissionEvidence: source.channelAdmissionEvidence,
    messageId: source.messageId,
    summaryLine: source.summaryLine,
    enqueuedAt: source.enqueuedAt,
    originatingChannel: source.originatingChannel,
    originatingTo: source.originatingTo,
    originatingAccountId: source.originatingAccountId,
    originatingThreadId: source.originatingThreadId,
    originatingChatId: source.originatingChatId,
    originatingReplyToId: source.originatingReplyToId,
    originatingReplyToMode: source.originatingReplyToMode,
    originatingChatType: source.originatingChatType,
    abortSignal: source.abortSignal,
    turnAdoptionLifecycle: source.turnAdoptionLifecycle,
    replyOperationRunStates: source.replyOperationRunStates,
    queuedFollowupReplyDisposition: source.queuedFollowupReplyDisposition,
    ...(source.currentInboundEventKind === "room_event"
      ? { currentInboundEventKind: "room_event" }
      : {}),
    run: source.run,
  };
}
