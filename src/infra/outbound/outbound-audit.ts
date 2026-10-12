import type {
  AuditMessageConversationKind,
  AuditMessageFailureStage,
} from "../../audit/audit-event-types.js";
import type { ExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import {
  emitTrustedMessageAuditEvent,
  hasTrustedMessageAuditListeners,
} from "../../audit/message-audit-events.js";
// Projects one metadata-only audit terminal per logical outbound payload.
import type { ReplyPayload } from "../../auto-reply/types.js";
import {
  normalizeSessionPeerId,
  parseSessionDeliveryRoute,
} from "../../sessions/session-key-utils.js";
import {
  resolveTargetPrefixedChannel,
  stripOutboundTargetKindPrefix,
  stripTargetProviderPrefix,
} from "./channel-target-prefix.js";
import {
  countPhysicalOutboundSends,
  type OutboundAuditTerminal,
  type IndexedOutboundAuditTerminal,
  type OutboundDeliveryResult,
  type OutboundPayloadDeliveryOutcome,
} from "./deliver-types.js";
import type { OutboundSessionContext } from "./session-context.js";

type OutboundAuditDeliveryContext = {
  channel: string;
  to: string;
  runId?: string;
  accountId?: string;
  payloads?: readonly ReplyPayload[];
  replyPayloadSendingHook?: { runId?: string };
  preparedBatch?: {
    runId?: string;
    executionIdentityToken?: ExecutionIdentityAdmissionToken;
    sourcePayloadCount?: number;
  };
  session?: OutboundSessionContext;
};

function outboundQueueAuditSourceId(
  queueId: string,
  payloadIndex: number,
  lifecycle?: "queued" | "platform_started",
): string {
  const terminalId = `message:outbound:queue:${queueId}:payload:${payloadIndex}`;
  return lifecycle ? `${terminalId}:${lifecycle}` : terminalId;
}

function projectRecordedOutboundAuditTerminal(
  history: readonly OutboundPayloadDeliveryOutcome[],
): OutboundAuditTerminal | undefined {
  // A missing adapter identity leaves the whole payload history uncertain,
  // even if a later retry reports another terminal outcome.
  if (
    history.some(
      (outcome) =>
        outcome.status === "suppressed" && outcome.reason === "adapter_returned_no_identity",
    )
  ) {
    return { outcome: "unknown", failureStage: "platform_send" };
  }
  const latest = history.at(-1);
  if (latest?.status === "sent") {
    return {
      outcome: "sent",
      results: latest.results,
      ...(latest.deliveryKind ? { deliveryKind: latest.deliveryKind } : {}),
    };
  }
  if (latest?.status === "suppressed" && latest.reason !== "adapter_returned_no_identity") {
    return {
      outcome: "suppressed",
      reasonCode:
        latest.reason === "adapter_returned_no_send" ? "no_visible_payload" : latest.reason,
    };
  }
  return undefined;
}

type OutboundAuditBatch = {
  payloadCount: number;
  results: readonly OutboundDeliveryResult[];
  payloadOutcomes: readonly OutboundPayloadDeliveryOutcome[];
};

function projectOutboundAuditTerminals(
  params: OutboundAuditBatch,
  fallback: (history: readonly OutboundPayloadDeliveryOutcome[]) => OutboundAuditTerminal,
): IndexedOutboundAuditTerminal[] {
  const indexed = new Map<number, OutboundPayloadDeliveryOutcome[]>();
  for (const outcome of params.payloadOutcomes) {
    const history = indexed.get(outcome.index) ?? [];
    history.push(outcome);
    indexed.set(outcome.index, history);
  }
  return Array.from({ length: params.payloadCount }, (_, payloadIndex) => {
    const history = indexed.get(payloadIndex) ?? [];
    return {
      payloadIndex,
      terminal: projectRecordedOutboundAuditTerminal(history) ?? fallback(history),
    };
  });
}

export function completedOutboundAuditTerminals(
  params: OutboundAuditBatch,
): IndexedOutboundAuditTerminal[] {
  return projectOutboundAuditTerminals(params, () => {
    // Core delivery reports every original payload, including normalization
    // suppressions. The single-payload fallback supports legacy recovery senders.
    if (params.payloadCount === 1 && params.results.length > 0) {
      return { outcome: "sent", results: params.results };
    }
    return { outcome: "suppressed", reasonCode: "no_visible_payload" };
  });
}

export function failedOutboundAuditTerminals(
  params: OutboundAuditBatch & { failureStage: AuditMessageFailureStage },
): IndexedOutboundAuditTerminal[] {
  return projectOutboundAuditTerminals(params, (history) => {
    const latest = history.at(-1);
    const failed = latest?.status === "failed" ? latest : undefined;
    const failedResults = failed?.results ?? [];
    const payloadResults =
      failedResults.length > 0
        ? failedResults
        : (history.findLast((outcome) => outcome.status === "sent")?.results ?? []);
    const fallbackResults = params.payloadCount === 1 ? params.results : [];
    const results = payloadResults.length > 0 ? payloadResults : fallbackResults;
    return {
      outcome: "failed",
      failureStage: failed ? failed.stage : params.failureStage,
      results,
      sentBeforeError: results.length > 0 || (failed !== undefined && failed.sentBeforeError),
      ...(failed?.deliveryKind ? { deliveryKind: failed.deliveryKind } : {}),
    };
  });
}

export function uniformOutboundAuditTerminals(
  payloadCount: number,
  terminal: OutboundAuditTerminal,
): IndexedOutboundAuditTerminal[] {
  return Array.from({ length: payloadCount }, (_, payloadIndex) => ({ payloadIndex, terminal }));
}

// Canonical target-kind prefixes (see channel-target-prefix.ts) mapped to the
// session-route kinds they may prove. An explicit target kind is a destination
// fact: "group:123" must never validate a direct:123 route, or direct mode
// over-collects. Provider/channel prefixes carry no kind information.
const TARGET_KIND_TO_ROUTE_KINDS: Record<
  string,
  readonly ("channel" | "direct" | "dm" | "group")[]
> = {
  channel: ["channel"],
  conversation: ["channel"],
  thread: ["channel"],
  group: ["group"],
  room: ["group"],
  direct: ["direct", "dm"],
  dm: ["direct", "dm"],
  user: ["direct", "dm"],
};
const TARGET_PREFIX_RE = /^\s*([a-z][a-z0-9_-]*):/i;

function resolveOutboundTargetFacts(context: OutboundAuditDeliveryContext): {
  conversationId: string;
  withoutProvider: string;
  allowedRouteKinds: readonly ("channel" | "direct" | "dm" | "group")[] | undefined;
} {
  const channel = context.channel.toLowerCase();
  const aliasChannel = resolveTargetPrefixedChannel(context.to);
  const targetPrefix = TARGET_PREFIX_RE.exec(context.to)?.[1];
  const providerPrefixes =
    aliasChannel === channel
      ? [context.channel, targetPrefix ?? context.channel]
      : [context.channel];
  const withoutProvider = stripTargetProviderPrefix(context.to, ...providerPrefixes);
  const kindPrefix = TARGET_PREFIX_RE.exec(withoutProvider)?.[1]?.toLowerCase();
  // kindPrefix is destination-controlled. An inherited key such as "constructor"
  // must not read through to Object.prototype (Function), or .includes throws.
  const allowedRouteKinds =
    kindPrefix && Object.hasOwn(TARGET_KIND_TO_ROUTE_KINDS, kindPrefix)
      ? TARGET_KIND_TO_ROUTE_KINDS[kindPrefix]
      : undefined;
  const conversationId = stripOutboundTargetKindPrefix(
    withoutProvider,
    Object.keys(TARGET_KIND_TO_ROUTE_KINDS),
  );
  return { conversationId, withoutProvider, allowedRouteKinds };
}

/** True when a parsed session route provably names this delivery's destination. */
function routeNamesDestination(
  route: ReturnType<typeof parseSessionDeliveryRoute>,
  context: OutboundAuditDeliveryContext,
): route is NonNullable<ReturnType<typeof parseSessionDeliveryRoute>> {
  if (!route || route.channel !== context.channel.toLowerCase()) {
    return false;
  }
  // Provider aliases and kind prefixes are routing syntax, not platform ids.
  // Keep this shared with audit correlation so both decisions peel the same layers.
  const { conversationId, withoutProvider, allowedRouteKinds } =
    resolveOutboundTargetFacts(context);
  if (allowedRouteKinds && !allowedRouteKinds.includes(route.peerKind)) {
    return false;
  }
  const candidates = [context.to, withoutProvider, conversationId];
  return candidates.some((candidate) => {
    const normalized = normalizeSessionPeerId({
      channel: route.channel,
      peerKind: route.peerKind,
      peerId: candidate,
    });
    return normalized !== "" && normalized.toLowerCase() === route.peerId.toLowerCase();
  });
}

// Privacy gate: a false "direct" over-collects under audit.messages="direct",
// so "direct" requires destination proof (caller-declared kind or a session
// route that names this exact channel+peer). Weaker origin/policy signals may
// only classify away from collection ("group"), never toward "direct".
function resolveConversationKind(
  context: OutboundAuditDeliveryContext,
): AuditMessageConversationKind {
  if (context.session?.conversationKind) {
    // Declared destination facts only; see OutboundSessionContext.conversationKind.
    return context.session.conversationKind;
  }
  const routeCandidates = [context.session?.policyKey, context.session?.key];
  for (const candidate of routeCandidates) {
    const route = parseSessionDeliveryRoute(candidate);
    if (routeNamesDestination(route, context)) {
      return route.peerKind === "dm" || route.peerKind === "direct" ? "direct" : route.peerKind;
    }
  }
  if (context.session?.conversationType === "group") {
    return "group";
  }
  return "unknown";
}

function firstIdentifier(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const normalized = value?.trim();
    // "unknown"/"suppressed" are adapter sentinel messageIds, not platform
    // identifiers; treating them as real ids would pseudonymize a constant
    // and corrupt correlation refs.
    if (normalized && normalized !== "unknown" && normalized !== "suppressed") {
      return normalized;
    }
  }
  return undefined;
}

function resolveResultIdentifiers(
  context: OutboundAuditDeliveryContext,
  results: readonly OutboundDeliveryResult[],
): {
  conversationId?: string;
  messageId?: string;
} {
  const last = results.at(-1);
  const conversationId =
    firstIdentifier(last?.target?.id, last?.toJid) ??
    resolveOutboundTargetFacts(context).conversationId;
  const messageId = firstIdentifier(
    last?.messageId,
    last?.receipt?.primaryPlatformMessageId,
    last?.receipt?.platformMessageIds.at(-1),
  );
  return {
    ...(conversationId ? { conversationId } : {}),
    ...(messageId ? { messageId } : {}),
  };
}

function outboundAuditContext(context: OutboundAuditDeliveryContext, includeReplyHook = false) {
  const agentId = context.session?.agentId;
  const runId =
    context.runId ??
    context.preparedBatch?.runId ??
    (includeReplyHook ? context.replyPayloadSendingHook?.runId : undefined);
  return {
    actorType: agentId ? ("agent" as const) : ("system" as const),
    actorId: agentId ?? "gateway",
    ...(agentId ? { agentId } : {}),
    ...(context.preparedBatch?.executionIdentityToken
      ? { executionIdentityToken: context.preparedBatch.executionIdentityToken }
      : {}),
    direction: "outbound" as const,
    channel: context.channel,
    conversationKind: resolveConversationKind(context),
    ...(context.accountId ? { accountId: context.accountId } : {}),
    targetId: context.to,
    ...(runId ? { runId } : {}),
  };
}

/**
 * Emits only after the owning lifecycle has made the delivery terminal.
 * Queue retries share one source id, so recovery cannot duplicate the final row.
 */
function emitOutboundAuditTerminal(params: {
  context: OutboundAuditDeliveryContext;
  terminal: OutboundAuditTerminal;
  startedAt: number;
  sourceId?: string;
}): void {
  try {
    const { context, terminal } = params;
    const results = terminal.results ?? [];
    const identifiers = resolveResultIdentifiers(context, results);
    const sentBeforeError =
      (terminal.outcome === "failed" || terminal.outcome === "unknown") &&
      terminal.sentBeforeError === true;
    const terminalFields =
      terminal.outcome === "sent"
        ? {
            status: "succeeded" as const,
            outcome: "sent" as const,
            ...(terminal.deliveryKind ? { deliveryKind: terminal.deliveryKind } : {}),
          }
        : terminal.outcome === "suppressed"
          ? {
              status: "blocked" as const,
              outcome: "suppressed" as const,
              reasonCode: terminal.reasonCode,
            }
          : terminal.outcome === "unknown"
            ? {
                status: "unknown" as const,
                outcome: "unknown" as const,
                failureStage: terminal.failureStage,
              }
            : {
                status: "failed" as const,
                outcome: "failed" as const,
                errorCode:
                  results.length > 0 || sentBeforeError
                    ? ("message_delivery_partial_failure" as const)
                    : ("message_delivery_failed" as const),
                failureStage: terminal.failureStage,
                ...(terminal.deliveryKind ? { deliveryKind: terminal.deliveryKind } : {}),
              };
    emitTrustedMessageAuditEvent({
      ...(params.sourceId ? { sourceId: params.sourceId } : {}),
      kind: "message",
      action: "message.outbound.finished",
      occurredAt: Date.now(),
      ...terminalFields,
      ...outboundAuditContext(context, true),
      durationMs: Math.max(0, Date.now() - params.startedAt),
      resultCount: countPhysicalOutboundSends(results),
      ...identifiers,
    });
  } catch {
    // Audit observers cannot alter delivery or queue semantics.
  }
}

/** Emits a replay-safe owner-native receipt after the queue transition commits. */
export function emitOutboundAuditLifecycle(params: {
  context: OutboundAuditDeliveryContext;
  outcome: "queued" | "platform_started";
  queueId: string;
  startedAt: number;
  payloadIndexes?: readonly number[];
}): void {
  if (!hasTrustedMessageAuditListeners()) {
    return;
  }
  const payloadCount = params.context.preparedBatch?.sourcePayloadCount ?? 1;
  const payloadIndexes = params.payloadIndexes ?? Array.from({ length: payloadCount }, (_, i) => i);
  try {
    for (const payloadIndex of payloadIndexes) {
      if (!Number.isSafeInteger(payloadIndex) || payloadIndex < 0 || payloadIndex >= payloadCount) {
        continue;
      }
      emitTrustedMessageAuditEvent({
        sourceId: outboundQueueAuditSourceId(params.queueId, payloadIndex, params.outcome),
        occurredAt: Date.now(),
        status: "started" as const,
        ...outboundAuditContext(params.context),
        durationMs: Math.max(0, Date.now() - params.startedAt),
        resultCount: 0,
        kind: "message",
        ...(params.outcome === "queued"
          ? { action: "message.outbound.queued" as const, outcome: "queued" as const }
          : {
              action: "message.outbound.platform-started" as const,
              outcome: "platform_started" as const,
            }),
      });
    }
  } catch {
    // Audit observers cannot alter delivery or queue semantics.
  }
}

/** Emits only after the owning lifecycle has made each logical payload terminal. */
export function emitOutboundAuditTerminals(params: {
  context: OutboundAuditDeliveryContext;
  terminals:
    | readonly IndexedOutboundAuditTerminal[]
    | (() => readonly IndexedOutboundAuditTerminal[]);
  startedAt: number;
  queueId?: string;
}): void {
  if (!hasTrustedMessageAuditListeners()) {
    return;
  }
  let terminals: readonly IndexedOutboundAuditTerminal[];
  try {
    terminals = typeof params.terminals === "function" ? params.terminals() : params.terminals;
  } catch {
    return;
  }
  for (const indexed of terminals) {
    emitOutboundAuditTerminal({
      context: params.context,
      terminal: indexed.terminal,
      startedAt: params.startedAt,
      ...(params.queueId
        ? { sourceId: outboundQueueAuditSourceId(params.queueId, indexed.payloadIndex) }
        : {}),
    });
  }
}
