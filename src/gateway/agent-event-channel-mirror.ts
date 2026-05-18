import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import { sendDurableMessageBatch as defaultSendDurableMessageBatch } from "../channels/message/runtime.js";
import type { DurableMessageBatchSendResult } from "../channels/message/send.js";
import type { AgentEventPayload } from "../infra/agent-events.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { loadSessionEntry as defaultLoadSessionEntry } from "./session-utils.js";

const log = createSubsystemLogger("gateway/agent-event-channel-mirror");
const DEFAULT_DELAY_MS = 250;
const MAX_INLINE_OUTPUT_CHARS = 12_000;
const MAX_SEEN_EVENTS = 10_000;

type LoadedSessionEntry = ReturnType<typeof defaultLoadSessionEntry>;
type SendDurableMessageBatch = (
  params: Parameters<typeof defaultSendDurableMessageBatch>[0],
) => Promise<DurableMessageBatchSendResult> | DurableMessageBatchSendResult;

type AgentEventChannelMirrorDeps = {
  loadSessionEntry?: (sessionKey: string) => LoadedSessionEntry;
  sendDurableMessageBatch?: SendDurableMessageBatch;
  delayMs?: number;
};

type MirrorState = {
  assistantTextByRun: Map<string, string>;
  thinkingTextByRun: Map<string, string>;
  queuesBySession: Map<string, Promise<void>>;
  seenEvents: Set<string>;
};

type DeliveryRoute = {
  channel: "telegram";
  to: string;
  accountId?: string;
  threadId: string | number;
};

function eventKey(evt: AgentEventPayload): string {
  return `${evt.runId}:${evt.seq}:${evt.stream}`;
}

function rememberSeenEvent(state: MirrorState, key: string): boolean {
  if (state.seenEvents.has(key)) {
    return false;
  }
  state.seenEvents.add(key);
  if (state.seenEvents.size > MAX_SEEN_EVENTS) {
    const first = state.seenEvents.values().next().value;
    if (typeof first === "string") {
      state.seenEvents.delete(first);
    }
  }
  return true;
}

function hasSessionKey(sessionKey: string | undefined): sessionKey is string {
  return Boolean(sessionKey);
}

function resolveTelegramThreadRoute(loaded: LoadedSessionEntry | undefined): DeliveryRoute | null {
  const ctx = loaded?.entry?.deliveryContext;
  if (!ctx || ctx.channel !== "telegram") {
    return null;
  }
  const to = normalizeOptionalString(ctx.to);
  const threadId =
    typeof ctx.threadId === "string" || typeof ctx.threadId === "number" ? ctx.threadId : undefined;
  if (!to || threadId === undefined || threadId === null || String(threadId).trim() === "") {
    return null;
  }
  const accountId = normalizeOptionalString(ctx.accountId);
  return {
    channel: "telegram",
    to,
    ...(accountId ? { accountId } : {}),
    threadId,
  };
}

function trimForProgressMessage(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_INLINE_OUTPUT_CHARS) {
    return trimmed;
  }
  return `${trimmed.slice(0, MAX_INLINE_OUTPUT_CHARS)}\n…[truncated ${trimmed.length - MAX_INLINE_OUTPUT_CHARS} chars in Telegram mirror; full output remains in the session transcript]`;
}

function textFromData(
  data: Record<string, unknown>,
  stateMap: Map<string, string>,
  runId: string,
): string {
  const explicitDelta = normalizeOptionalString(data.delta);
  if (explicitDelta) {
    const currentText = normalizeOptionalString(data.text);
    if (currentText) {
      stateMap.set(runId, currentText);
    }
    return explicitDelta;
  }
  const text = normalizeOptionalString(data.text);
  if (!text) {
    return "";
  }
  const previous = stateMap.get(runId) ?? "";
  stateMap.set(runId, text);
  if (previous && text.startsWith(previous)) {
    return text.slice(previous.length);
  }
  if (previous === text) {
    return "";
  }
  return text;
}

export function formatAgentEventForChannelMirror(
  evt: AgentEventPayload,
  state: Pick<MirrorState, "assistantTextByRun" | "thinkingTextByRun">,
): string | undefined {
  const data = evt.data ?? {};
  if (evt.stream === "assistant") {
    if (data.phase === "final_answer") {
      return undefined;
    }
    const text = textFromData(data, state.assistantTextByRun, evt.runId);
    return text.trim() ? `💬 ${trimForProgressMessage(text)}` : undefined;
  }

  if (evt.stream === "thinking") {
    const text = textFromData(data, state.thinkingTextByRun, evt.runId);
    return text.trim() ? `🧠 ${trimForProgressMessage(text)}` : undefined;
  }

  if (evt.stream === "item") {
    if (data.suppressChannelProgress === true) {
      return undefined;
    }
    const phase = normalizeOptionalString(data.phase) ?? "update";
    const title =
      normalizeOptionalString(data.title) ?? normalizeOptionalString(data.name) ?? "agent item";
    const status = normalizeOptionalString(data.status);
    const summary =
      normalizeOptionalString(data.summary) ?? normalizeOptionalString(data.progressText);
    const prefix = phase === "start" ? "▶️" : phase === "end" ? "✅" : "🔄";
    const statusPart = status ? ` (${status})` : "";
    const summaryPart = summary ? `\n${trimForProgressMessage(summary)}` : "";
    return `${prefix} ${title}${statusPart}${summaryPart}`;
  }

  if (evt.stream === "command_output") {
    const phase = normalizeOptionalString(data.phase) ?? "output";
    const title =
      normalizeOptionalString(data.title) ?? normalizeOptionalString(data.name) ?? "command output";
    const output = normalizeOptionalString(data.output);
    const exitCode = typeof data.exitCode === "number" ? data.exitCode : undefined;
    const exitPart = exitCode === undefined ? "" : ` exit=${exitCode}`;
    if (!output && phase !== "end") {
      return undefined;
    }
    const outputPart = output ? `\n\`\`\`\n${trimForProgressMessage(output)}\n\`\`\`` : "";
    return `📟 ${title} [${phase}${exitPart}]${outputPart}`;
  }

  if (evt.stream === "approval") {
    const title = normalizeOptionalString(data.title) ?? "approval";
    const status =
      normalizeOptionalString(data.status) ?? normalizeOptionalString(data.phase) ?? "requested";
    return `🛂 ${title} (${status})`;
  }

  if (evt.stream === "plan") {
    const title = normalizeOptionalString(data.title) ?? "plan update";
    const explanation = normalizeOptionalString(data.explanation);
    return `📝 ${title}${explanation ? `\n${trimForProgressMessage(explanation)}` : ""}`;
  }

  if (evt.stream === "error") {
    const reason =
      normalizeOptionalString(data.reason) ?? normalizeOptionalString(data.error) ?? "agent error";
    return `⚠️ ${trimForProgressMessage(reason)}`;
  }

  if (evt.stream === "lifecycle") {
    const phase = normalizeOptionalString(data.phase);
    if (phase === "start") {
      return "▶️ Agent run started";
    }
    if (phase === "error") {
      const error = normalizeOptionalString(data.error) ?? "agent run failed";
      return `❌ Agent run failed\n${trimForProgressMessage(error)}`;
    }
    return undefined;
  }

  return undefined;
}

function enqueueSessionSend(
  state: MirrorState,
  sessionKey: string,
  delayMs: number,
  task: () => Promise<void>,
): Promise<void> {
  const previous = state.queuesBySession.get(sessionKey) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(task)
    .then(async () => {
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    })
    .catch((err) => {
      log.warn(
        `agent event channel mirror send failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  state.queuesBySession.set(sessionKey, next);
  void next.finally(() => {
    if (state.queuesBySession.get(sessionKey) === next) {
      state.queuesBySession.delete(sessionKey);
    }
  });
  return next;
}

export function createAgentEventChannelMirror(deps: AgentEventChannelMirrorDeps = {}) {
  const state: MirrorState = {
    assistantTextByRun: new Map(),
    thinkingTextByRun: new Map(),
    queuesBySession: new Map(),
    seenEvents: new Set(),
  };
  const loadSessionEntry = deps.loadSessionEntry ?? defaultLoadSessionEntry;
  const sendDurableMessageBatch = deps.sendDurableMessageBatch ?? defaultSendDurableMessageBatch;
  const delayMs = deps.delayMs ?? DEFAULT_DELAY_MS;

  return async (evt: AgentEventPayload): Promise<void> => {
    const sessionKey = normalizeOptionalString(evt.sessionKey);
    if (!hasSessionKey(sessionKey)) {
      return;
    }
    const key = eventKey(evt);
    if (!rememberSeenEvent(state, key)) {
      return;
    }
    const text = formatAgentEventForChannelMirror(evt, state);
    if (!text) {
      return;
    }
    const loaded = loadSessionEntry(sessionKey);
    const route = resolveTelegramThreadRoute(loaded);
    if (!route) {
      return;
    }
    const payloads: ReplyPayload[] = [{ text }];
    await enqueueSessionSend(state, sessionKey, delayMs, async () => {
      await sendDurableMessageBatch({
        cfg: loaded.cfg,
        channel: route.channel,
        to: route.to,
        ...(route.accountId ? { accountId: route.accountId } : {}),
        threadId: route.threadId,
        payloads,
        bestEffort: true,
        session: {
          key: sessionKey,
          agentId: loaded.entry?.agentId,
          sessionId: loaded.entry?.sessionId,
        },
      });
    });
  };
}

export function startAgentEventChannelMirror(deps: AgentEventChannelMirrorDeps = {}): () => void {
  const mirror = createAgentEventChannelMirror(deps);
  return onAgentEvent((evt) => {
    void mirror(evt);
  });
}
