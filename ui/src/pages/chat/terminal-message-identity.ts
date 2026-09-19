import {
  readAssistantStreamSegmentIdentity,
  readSessionMessageIdentity,
} from "@openclaw/gateway-client/browser";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { resolveAssistantMessagePhase } from "../../../../src/shared/chat-message-content.js";
import { extractText } from "../../lib/chat/message-extract.js";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";

type LiveTerminalIdentity = {
  runId: string;
  afterBoundaryRunId?: string;
  disposition?: "aborted" | "error" | "timeout";
};

const liveTerminalIdentities = new WeakMap<object, LiveTerminalIdentity>();
const authoritativeTerminals = new WeakMap<object, AuthoritativeTerminal>();
// Terminals whose run still read active at persistence time; the run-clear
// reconcile promotes them so the live copy retires once history applies (#149153).
const pendingAuthoritativeTerminals = new WeakMap<
  object,
  Map<string, PendingAuthoritativeTerminal>
>();

type AuthoritativeTerminal = {
  historyApplied: boolean;
  messageId: string;
  runId: string;
  sessionKey: string;
};

/** A saved row owns the run's final reply only when it carries non-commentary text. */
function ownsFinalReply(message: unknown): boolean {
  if (readAssistantStreamSegmentIdentity(message) !== undefined) {
    return false;
  }
  // The canonical phase owner decides commentary vs answer; reading the raw
  // signature here would drift from that contract (#149153).
  if (resolveAssistantMessagePhase(message) === "commentary") {
    return false;
  }
  return Boolean(extractText(message)?.trim());
}

type PendingAuthoritativeTerminal = {
  messageId: string;
  runId: string;
  sessionKey: string;
};

/** Associates a live terminal projection with its run without altering transcript bytes. */
export function rememberLiveTerminalRun(
  message: unknown,
  runId: string | null | undefined,
  afterBoundaryRunId?: string,
  disposition?: LiveTerminalIdentity["disposition"],
): unknown {
  if (runId && message && typeof message === "object") {
    liveTerminalIdentities.set(message, {
      runId,
      ...(afterBoundaryRunId ? { afterBoundaryRunId } : {}),
      ...(disposition ? { disposition } : {}),
    });
  }
  return message;
}

export function isLiveTerminalForRun(message: unknown, runId: string): boolean {
  return Boolean(
    message && typeof message === "object" && liveTerminalIdentities.get(message)?.runId === runId,
  );
}

export function readLiveTerminalRunId(message: unknown): string | null {
  return message && typeof message === "object"
    ? (liveTerminalIdentities.get(message)?.runId ?? null)
    : null;
}

export function readLiveTerminalAfterBoundaryRunId(message: unknown): string | null {
  return message && typeof message === "object"
    ? (liveTerminalIdentities.get(message)?.afterBoundaryRunId ?? null)
    : null;
}

export function readLiveTerminalDisposition(
  message: unknown,
): LiveTerminalIdentity["disposition"] | null {
  return message && typeof message === "object"
    ? (liveTerminalIdentities.get(message)?.disposition ?? null)
    : null;
}

export function rememberAuthoritativeTerminal(options: {
  event: {
    clientRunId?: string | null;
    hasActiveRun?: boolean | null;
    key: string;
    runId?: string | null;
  };
  host: object;
  matchesChat: boolean;
  payload: unknown;
  runIdBeforeApply: string | null;
}): void {
  const payload = asNullableRecord(options.payload);
  const identity = readSessionMessageIdentity(payload?.message, {
    messageId: payload?.messageId,
  });
  const messageId = identity?.role === "assistant" && !identity.isImported ? identity.id : null;
  if (!options.runIdBeforeApply || !options.matchesChat || !messageId) {
    return;
  }
  if (!ownsFinalReply(payload?.message)) {
    return;
  }
  const runId = options.event.clientRunId ?? options.event.runId ?? options.runIdBeforeApply;
  if (options.event.hasActiveRun === true) {
    // The persisted final landed while its run still reads active. Keep it pending:
    // the run-clear reconcile arms it before history applies, otherwise the live
    // terminal copy is never retired and the reply renders twice (#149153).
    const pendingByRun =
      pendingAuthoritativeTerminals.get(options.host) ??
      new Map<string, PendingAuthoritativeTerminal>();
    pendingByRun.set(runId, { messageId, runId, sessionKey: options.event.key });
    pendingAuthoritativeTerminals.set(options.host, pendingByRun);
    return;
  }
  authoritativeTerminals.set(options.host, {
    historyApplied: false,
    messageId,
    runId,
    sessionKey: options.event.key,
  });
}

/**
 * Arms a terminal deferred by an active run once the applied history carries that
 * terminal. Single promotion owner: every history reload path converges here, so
 * chat.final and session reconciliation both retire the live copy (#149153).
 */
export function armPendingAuthoritativeTerminalForHistory(options: {
  host: object;
  sessionKey: string;
  visibleMessages: readonly unknown[];
}): void {
  const pendingByRun = pendingAuthoritativeTerminals.get(options.host);
  if (!pendingByRun) {
    return;
  }
  for (const [runId, pending] of pendingByRun) {
    if (!areUiSessionKeysEquivalent(pending.sessionKey, options.sessionKey)) {
      continue;
    }
    const historyHasTerminal = options.visibleMessages.some((message) => {
      const identity = readSessionMessageIdentity(message);
      return (
        identity?.role === "assistant" && !identity.isImported && identity.id === pending.messageId
      );
    });
    if (!historyHasTerminal) {
      continue;
    }
    pendingByRun.delete(runId);
    const armed = authoritativeTerminals.get(options.host);
    if (armed?.historyApplied && armed.runId === pending.runId) {
      continue;
    }
    authoritativeTerminals.set(options.host, {
      historyApplied: false,
      messageId: pending.messageId,
      runId: pending.runId,
      sessionKey: pending.sessionKey,
    });
  }
  if (pendingByRun.size === 0) {
    pendingAuthoritativeTerminals.delete(options.host);
  }
}

export function reconcileAuthoritativeTerminalHistory<T>(options: {
  host: object;
  previousMessages: T[];
  sessionKey: string;
  visibleMessages: T[];
}): T[] {
  const terminal = authoritativeTerminals.get(options.host);
  const terminalMessage =
    terminal && areUiSessionKeysEquivalent(terminal.sessionKey, options.sessionKey)
      ? options.visibleMessages.find((message) => {
          const identity = readSessionMessageIdentity(message);
          return (
            identity?.role === "assistant" &&
            !identity.isImported &&
            identity.id === terminal.messageId
          );
        })
      : undefined;
  if (!terminal || !terminalMessage) {
    return options.previousMessages;
  }
  authoritativeTerminals.set(options.host, { ...terminal, historyApplied: true });
  return options.previousMessages.filter(
    (message) => !isLiveTerminalForRun(message, terminal.runId),
  );
}

export function authoritativeHistoryAppliedForRun(host: object, runId: string): boolean {
  const terminal = authoritativeTerminals.get(host);
  return terminal?.runId === runId && terminal.historyApplied;
}

export function normalizeFinalAssistantMessage(message: unknown): Record<string, unknown> | null {
  const candidate = asNullableRecord(message);
  if (
    !candidate ||
    (typeof candidate.role === "string" &&
      normalizeLowercaseStringOrEmpty(candidate.role) !== "assistant") ||
    (!("content" in candidate) && typeof candidate.text !== "string")
  ) {
    return null;
  }
  const assistant =
    typeof candidate.role === "string" ? candidate : { ...candidate, role: "assistant" };
  // Canonicalize text-only finals before reducing so replay identity includes the reply.
  return !Object.hasOwn(assistant, "content") && typeof assistant.text === "string"
    ? { ...assistant, content: [{ type: "text", text: assistant.text }] }
    : assistant;
}
