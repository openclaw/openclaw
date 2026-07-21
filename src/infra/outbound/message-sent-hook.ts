import { getReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { fireAndForgetHook } from "../../hooks/fire-and-forget.js";
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import {
  buildCanonicalSentMessageHookContext,
  toInternalMessageSentContext,
  toPluginMessageContext,
  toPluginMessageSentEvent,
} from "../../hooks/message-hook-mappers.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { formatErrorMessage } from "../errors.js";
import type { OutboundDeliveryResult } from "./deliver-types.js";
import type {
  IndexedOutboundAuditTerminal,
  OutboundAuditDeliveryContext,
} from "./outbound-audit.js";
import { summarizeOutboundPayloadForTransport } from "./payloads.js";

const log = createSubsystemLogger("outbound/message-sent-hook");
const messageSentHookOwnedResults = new WeakSet<object>();
const messageSentHookEvents = new WeakMap<object, readonly IndexedMessageSentHookEvent[]>();
const successfulNativeDeliveries = new WeakMap<object, { messageId?: string }>();
const nativeDeliveryNotAttemptedErrors = new WeakSet<object>();

export type MessageSentHookEvent = {
  success: boolean;
  content: string;
  error?: string;
  messageId?: string;
  runId?: string;
};

export type IndexedMessageSentHookEvent = {
  payloadIndex: number;
  event: MessageSentHookEvent;
};

export function attachMessageSentHookEvents<T>(
  value: T,
  events: readonly IndexedMessageSentHookEvent[],
): T {
  if (
    events.length > 0 &&
    ((typeof value === "object" && value !== null) || typeof value === "function")
  ) {
    messageSentHookEvents.set(value as object, [...events]);
  }
  return value;
}

export function getMessageSentHookEvents(value: unknown): readonly IndexedMessageSentHookEvent[] {
  return (typeof value === "object" && value !== null) || typeof value === "function"
    ? (messageSentHookEvents.get(value as object) ?? [])
    : [];
}

type MessageSentTerminalContext = OutboundAuditDeliveryContext & {
  /** Maps prepared payload positions back to the original batch indexes. */
  payloadSourceIndexes?: readonly number[];
};

function resolveTerminalPayload(
  context: MessageSentTerminalContext,
  payloadIndex: number,
): ReplyPayload | undefined {
  const preparedIndex = context.payloadSourceIndexes?.indexOf(payloadIndex) ?? payloadIndex;
  return context.payloads[preparedIndex];
}

function resolveTerminalMessageId(results: readonly OutboundDeliveryResult[]): string | undefined {
  const last = results.at(-1);
  const candidates = [
    last?.messageId,
    last?.receipt?.primaryPlatformMessageId,
    last?.receipt?.platformMessageIds.at(-1),
  ];
  return candidates.find((value) => value && value !== "unknown" && value !== "suppressed");
}

/** Publishes observer hooks only after the durable owner declares a logical payload terminal. */
export function emitMessageSentHookTerminals(params: {
  context: MessageSentTerminalContext;
  terminals:
    | readonly IndexedOutboundAuditTerminal[]
    | (() => readonly IndexedOutboundAuditTerminal[]);
  events?: readonly IndexedMessageSentHookEvent[];
}): void {
  let terminals: readonly IndexedOutboundAuditTerminal[];
  try {
    terminals = typeof params.terminals === "function" ? params.terminals() : params.terminals;
  } catch {
    return;
  }
  const emit = createMessageSentHookEmitter({
    channel: params.context.channel,
    to: params.context.to,
    accountId: params.context.accountId,
    sessionKey: params.context.mirror?.sessionKey ?? params.context.session?.key,
    isGroup: params.context.mirror?.isGroup,
    groupId: params.context.mirror?.groupId,
  });
  const eventsByPayload = new Map(params.events?.map((entry) => [entry.payloadIndex, entry.event]));
  for (const { payloadIndex, terminal } of terminals) {
    if (terminal.outcome === "suppressed") {
      continue;
    }
    const event = eventsByPayload.get(payloadIndex);
    if (event) {
      emit(event);
      continue;
    }
    const payload = resolveTerminalPayload(params.context, payloadIndex);
    const summary = payload ? summarizeOutboundPayloadForTransport(payload) : undefined;
    const content = summary?.hookContent ?? summary?.text ?? "";
    const runId =
      (payload ? getReplyPayloadMetadata(payload)?.outboundHookLifecycle?.runId : undefined) ??
      params.context.replyPayloadSendingHook?.runId;
    const results = terminal.results ?? [];
    const messageId = resolveTerminalMessageId(results);
    if (terminal.outcome === "sent") {
      emit({
        success: true,
        content,
        ...(messageId ? { messageId } : {}),
        ...(runId ? { runId } : {}),
      });
      continue;
    }
    const providerAttempted =
      terminal.providerAttempted === true ||
      terminal.sentBeforeError === true ||
      results.length > 0;
    if (!providerAttempted) {
      continue;
    }
    emit({
      success: false,
      content,
      error: formatErrorMessage(terminal.error ?? "outbound delivery failed"),
      ...(messageId ? { messageId } : {}),
      ...(runId ? { runId } : {}),
    });
  }
}

export function markMessageSentHookOwned<T>(value: T): T {
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    messageSentHookOwnedResults.add(value as object);
  }
  return value;
}

export function isMessageSentHookOwned(value: unknown): boolean {
  return (
    ((typeof value === "object" && value !== null) || typeof value === "function") &&
    messageSentHookOwnedResults.has(value as object)
  );
}

/** Carries a completed native send through a later bookkeeping failure to the outer observer. */
export function markSuccessfulNativeDelivery<T>(value: T, messageId?: string): T {
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    successfulNativeDeliveries.set(value as object, messageId ? { messageId } : {});
  }
  return value;
}

/** Reads native-send success that occurred before a later non-transport failure. */
export function getSuccessfulNativeDelivery(value: unknown): { messageId?: string } | undefined {
  return (typeof value === "object" && value !== null) || typeof value === "function"
    ? successfulNativeDeliveries.get(value as object)
    : undefined;
}

/** Marks a delivery failure that occurred before the provider adapter was invoked. */
export function markNativeDeliveryNotAttempted<T extends object>(value: T): T;
export function markNativeDeliveryNotAttempted(value: unknown): Error;
export function markNativeDeliveryNotAttempted(value: unknown): object {
  const error =
    (typeof value === "object" && value !== null) || typeof value === "function"
      ? (value as object)
      : new Error(
          typeof value === "string" ? value : "native delivery failed before provider attempt",
          {
            cause: value,
          },
        );
  nativeDeliveryNotAttemptedErrors.add(error);
  return error;
}

/** Identifies failures that must not produce a false message_sent observation. */
export function isNativeDeliveryNotAttempted(value: unknown): boolean {
  return (
    ((typeof value === "object" && value !== null) || typeof value === "function") &&
    nativeDeliveryNotAttemptedErrors.has(value as object)
  );
}

export function createMessageSentHookEmitter(params: {
  channel: string;
  to: string;
  accountId?: string;
  sessionKey?: string;
  isGroup?: boolean;
  groupId?: string;
}): (event: MessageSentHookEvent) => void {
  const canEmitInternalHook = Boolean(params.sessionKey);

  return (event) => {
    const hookRunner = getGlobalHookRunner();
    const hasMessageSentHooks = hookRunner?.hasHooks("message_sent") ?? false;
    if (!hasMessageSentHooks && !canEmitInternalHook) {
      return;
    }
    const canonical = buildCanonicalSentMessageHookContext({
      to: params.to,
      content: event.content,
      success: event.success,
      error: event.error,
      channelId: params.channel,
      accountId: params.accountId,
      conversationId: params.to,
      sessionKey: params.sessionKey,
      runId: event.runId,
      messageId: event.messageId,
      isGroup: params.isGroup,
      groupId: params.groupId,
    });
    if (hasMessageSentHooks) {
      fireAndForgetHook(
        hookRunner!.runMessageSent(
          toPluginMessageSentEvent(canonical),
          toPluginMessageContext(canonical),
        ),
        "message_sent plugin hook failed",
        (message) => {
          log.warn(message);
        },
      );
    }
    if (!canEmitInternalHook) {
      return;
    }
    fireAndForgetHook(
      triggerInternalHook(
        createInternalHookEvent(
          "message",
          "sent",
          params.sessionKey!,
          toInternalMessageSentContext(canonical),
        ),
      ),
      "message:sent internal hook failed",
      (message) => {
        log.warn(message);
      },
    );
  };
}
