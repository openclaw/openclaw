import type {
  AuditMessageConversationKind,
  AuditMessageDeliveryKind,
  AuditMessageFailureStage,
  AuditOutboundMessageSuppressedReasonCode,
} from "../../audit/audit-event-types.js";
import {
  emitTrustedMessageAuditEvent,
  hasTrustedMessageAuditListeners,
} from "../../audit/message-audit-events.js";
// Projects one metadata-only audit terminal per logical outbound payload.
import type { ReplyPayload } from "../../auto-reply/types.js";
import {
  countPhysicalOutboundSends,
  type OutboundDeliveryResult,
  type OutboundPayloadDeliveryOutcome,
} from "./deliver-types.js";
import type { DeliveryMirror } from "./mirror.js";
import type { OutboundSessionContext } from "./session-context.js";
import type { OutboundChannel } from "./targets.js";

type OutboundAuditDeliveryContext = {
  channel: Exclude<OutboundChannel, "none">;
  to: string;
  accountId?: string;
  payloads: readonly ReplyPayload[];
  replyPayloadSendingHook?: { runId?: string };
  session?: OutboundSessionContext;
  mirror?: DeliveryMirror;
};

export type OutboundAuditTerminal =
  | {
      outcome: "sent";
      results: readonly OutboundDeliveryResult[];
      deliveryKind?: AuditMessageDeliveryKind;
    }
  | {
      outcome: "suppressed";
      reasonCode: AuditOutboundMessageSuppressedReasonCode;
      results?: readonly OutboundDeliveryResult[];
    }
  | {
      outcome: "failed";
      failureStage: AuditMessageFailureStage;
      results?: readonly OutboundDeliveryResult[];
      sentBeforeError?: boolean;
      deliveryKind?: AuditMessageDeliveryKind;
    }
  | {
      outcome: "unknown";
      failureStage: AuditMessageFailureStage;
      results?: readonly OutboundDeliveryResult[];
      sentBeforeError?: boolean;
    };

export type IndexedOutboundAuditTerminal = {
  payloadIndex: number;
  terminal: OutboundAuditTerminal;
};

export function outboundQueueAuditSourceId(queueId: string, payloadIndex: number): string {
  return `message:outbound:queue:${queueId}:payload:${payloadIndex}`;
}

function outcomesByPayload(
  outcomes: readonly OutboundPayloadDeliveryOutcome[],
): Map<number, OutboundPayloadDeliveryOutcome[]> {
  const indexed = new Map<number, OutboundPayloadDeliveryOutcome[]>();
  for (const outcome of outcomes) {
    const history = indexed.get(outcome.index) ?? [];
    history.push(outcome);
    indexed.set(outcome.index, history);
  }
  return indexed;
}

function sentResults(
  history: readonly OutboundPayloadDeliveryOutcome[],
): readonly OutboundDeliveryResult[] {
  const sent = history.findLast(
    (outcome): outcome is Extract<OutboundPayloadDeliveryOutcome, { status: "sent" }> =>
      outcome.status === "sent",
  );
  return sent?.results ?? [];
}

function hasUnknownAdapterSideEffect(history: readonly OutboundPayloadDeliveryOutcome[]): boolean {
  return history.some(
    (outcome) =>
      outcome.status === "suppressed" && outcome.reason === "adapter_returned_no_identity",
  );
}

export function completedOutboundAuditTerminals(params: {
  payloadCount: number;
  results: readonly OutboundDeliveryResult[];
  payloadOutcomes: readonly OutboundPayloadDeliveryOutcome[];
}): IndexedOutboundAuditTerminal[] {
  const indexed = outcomesByPayload(params.payloadOutcomes);
  return Array.from({ length: params.payloadCount }, (_, payloadIndex) => {
    const history = indexed.get(payloadIndex) ?? [];
    const latest = history.at(-1);
    if (hasUnknownAdapterSideEffect(history)) {
      return {
        payloadIndex,
        terminal: { outcome: "unknown", failureStage: "platform_send" },
      };
    }
    if (latest?.status === "sent") {
      return {
        payloadIndex,
        terminal: {
          outcome: "sent",
          results: latest.results,
          ...(latest.deliveryKind ? { deliveryKind: latest.deliveryKind } : {}),
        },
      };
    }
    if (latest?.status === "suppressed") {
      if (latest.reason === "adapter_returned_no_identity") {
        return {
          payloadIndex,
          terminal: { outcome: "unknown", failureStage: "platform_send" },
        };
      }
      return {
        payloadIndex,
        terminal: { outcome: "suppressed", reasonCode: latest.reason },
      };
    }
    // Core delivery reports every original payload, including normalization
    // suppressions. The single-payload fallback supports legacy recovery senders.
    if (params.payloadCount === 1 && params.results.length > 0) {
      return { payloadIndex, terminal: { outcome: "sent", results: params.results } };
    }
    return {
      payloadIndex,
      terminal: { outcome: "suppressed", reasonCode: "no_visible_payload" },
    };
  });
}

export function failedOutboundAuditTerminals(params: {
  payloadCount: number;
  results: readonly OutboundDeliveryResult[];
  payloadOutcomes: readonly OutboundPayloadDeliveryOutcome[];
  failureStage: AuditMessageFailureStage;
}): IndexedOutboundAuditTerminal[] {
  const indexed = outcomesByPayload(params.payloadOutcomes);
  return Array.from({ length: params.payloadCount }, (_, payloadIndex) => {
    const history = indexed.get(payloadIndex) ?? [];
    const latest = history.at(-1);
    if (hasUnknownAdapterSideEffect(history)) {
      return {
        payloadIndex,
        terminal: { outcome: "unknown", failureStage: "platform_send" },
      };
    }
    if (latest?.status === "sent") {
      return {
        payloadIndex,
        terminal: {
          outcome: "sent",
          results: latest.results,
          ...(latest.deliveryKind ? { deliveryKind: latest.deliveryKind } : {}),
        },
      };
    }
    if (latest?.status === "suppressed") {
      if (latest.reason === "adapter_returned_no_identity") {
        return {
          payloadIndex,
          terminal: { outcome: "unknown", failureStage: "platform_send" },
        };
      }
      return {
        payloadIndex,
        terminal: { outcome: "suppressed", reasonCode: latest.reason },
      };
    }
    const failedResults = latest?.status === "failed" ? (latest.results ?? []) : [];
    const payloadResults = failedResults.length > 0 ? failedResults : sentResults(history);
    const fallbackResults = params.payloadCount === 1 ? params.results : [];
    const results = payloadResults.length > 0 ? payloadResults : fallbackResults;
    return {
      payloadIndex,
      terminal: {
        outcome: "failed",
        failureStage: latest?.status === "failed" ? latest.stage : params.failureStage,
        results,
        sentBeforeError:
          results.length > 0 || (latest?.status === "failed" && latest.sentBeforeError),
        ...(latest?.status === "failed" && latest.deliveryKind
          ? { deliveryKind: latest.deliveryKind }
          : {}),
      },
    };
  });
}

export function uniformOutboundAuditTerminals(
  payloadCount: number,
  terminal: OutboundAuditTerminal,
): IndexedOutboundAuditTerminal[] {
  return Array.from({ length: payloadCount }, (_, payloadIndex) => ({ payloadIndex, terminal }));
}

function resolveConversationKind(
  context: OutboundAuditDeliveryContext,
): AuditMessageConversationKind {
  if (context.session?.conversationKind) {
    return context.session.conversationKind;
  }
  if (
    context.session?.conversationType === "direct" ||
    context.session?.conversationType === "group"
  ) {
    return context.session.conversationType;
  }
  if (context.mirror?.isGroup === true) {
    return "group";
  }
  if (context.mirror?.isGroup === false) {
    return "direct";
  }
  return "unknown";
}

function firstIdentifier(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const normalized = value?.trim();
    if (normalized && normalized !== "unknown" && normalized !== "suppressed") {
      return normalized;
    }
  }
  return undefined;
}

function resolveResultIdentifiers(results: readonly OutboundDeliveryResult[]): {
  conversationId?: string;
  messageId?: string;
} {
  const last = results.at(-1);
  if (!last) {
    return {};
  }
  const conversationId = firstIdentifier(
    last.conversationId,
    last.chatId,
    last.channelId,
    last.roomId,
    last.toJid,
  );
  const messageId = firstIdentifier(
    last.messageId,
    last.receipt?.primaryPlatformMessageId,
    last.receipt?.platformMessageIds.at(-1),
  );
  return {
    ...(conversationId ? { conversationId } : {}),
    ...(messageId ? { messageId } : {}),
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
  payloadIndex: number;
}): void {
  try {
    const { context, terminal } = params;
    const results = terminal.results ?? [];
    const agentId = context.session?.agentId ?? context.mirror?.agentId;
    const identifiers = resolveResultIdentifiers(results);
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
      actorType: agentId ? "agent" : "system",
      actorId: agentId ?? "gateway",
      ...(agentId ? { agentId } : {}),
      ...(context.replyPayloadSendingHook?.runId
        ? { runId: context.replyPayloadSendingHook.runId }
        : {}),
      direction: "outbound",
      channel: context.channel,
      conversationKind: resolveConversationKind(context),
      durationMs: Math.max(0, Date.now() - params.startedAt),
      resultCount: countPhysicalOutboundSends(results),
      ...(context.accountId ? { accountId: context.accountId } : {}),
      targetId: context.to,
      ...identifiers,
    });
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
      payloadIndex: indexed.payloadIndex,
      ...(params.queueId
        ? { sourceId: outboundQueueAuditSourceId(params.queueId, indexed.payloadIndex) }
        : {}),
    });
  }
}
