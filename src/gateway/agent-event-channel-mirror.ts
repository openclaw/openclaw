import { sendDurableMessageBatch as defaultSendDurableMessageBatch } from "../channels/message/runtime.js";
import type { DurableMessageBatchSendResult } from "../channels/message/send.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AgentEventPayload } from "../infra/agent-events.js";
import { getAgentRunContext, onAgentEvent } from "../infra/agent-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  buildChannelProgressDraftLineForEntry,
  formatChannelProgressDraftText,
  mergeChannelProgressDraftLine,
  resolveChannelPreviewStreamMode,
  resolveChannelProgressDraftMaxLines,
  resolveChannelStreamingPreviewToolProgress,
  type ChannelProgressDraftLine,
} from "../plugin-sdk/channel-streaming.js";
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

type ProgressPreviewParams = {
  cfg: OpenClawConfig;
  to: string;
  accountId?: string;
  threadId: string | number;
  text: string;
  sessionKey: string;
};

type SendProgressPreview = (
  params: ProgressPreviewParams,
) => Promise<{ messageId: string }> | { messageId: string };

type EditProgressPreview = (
  params: ProgressPreviewParams & { messageId: string },
) => Promise<void> | void;

type DeleteProgressPreview = (
  params: Omit<ProgressPreviewParams, "text"> & { messageId: string },
) => Promise<void> | void;

type AgentEventChannelMirrorDeps = {
  loadSessionEntry?: (sessionKey: string) => LoadedSessionEntry;
  sendDurableMessageBatch?: SendDurableMessageBatch;
  sendProgressPreview?: SendProgressPreview;
  editProgressPreview?: EditProgressPreview;
  deleteProgressPreview?: DeleteProgressPreview;
  delayMs?: number;
};

type ProgressPreviewLine = string | ChannelProgressDraftLine;

type ProgressPreviewState = {
  lines: ProgressPreviewLine[];
  activeSessionKeys: Set<string>;
  messageId?: string;
  lastText?: string;
};

type MirrorState = {
  assistantTextByRun: Map<string, string>;
  thinkingTextByRun: Map<string, string>;
  queuesBySession: Map<string, Promise<void>>;
  previewsByRoute: Map<string, ProgressPreviewState>;
  seenEvents: Set<string>;
};

type DeliveryRoute = {
  channel: "telegram";
  to: string;
  accountId?: string;
  threadId: string | number;
};

type TelegramRuntimeApi = typeof import("../../extensions/telegram/runtime-api.js");

let telegramRuntimeApiPromise: Promise<TelegramRuntimeApi> | undefined;

async function loadTelegramRuntimeApi(): Promise<TelegramRuntimeApi> {
  telegramRuntimeApiPromise ??= import("../../extensions/telegram/runtime-api.js");
  return await telegramRuntimeApiPromise;
}

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

function routeKey(route: DeliveryRoute): string {
  return `telegram:${route.accountId ?? "default"}:${route.to}:topic:${String(route.threadId)}`;
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

function resolveTelegramStreamingEntry(
  cfg: OpenClawConfig,
  accountId: string | undefined,
): Record<string, unknown> | null {
  const telegram = cfg.channels?.telegram;
  if (!telegram || typeof telegram !== "object") {
    return null;
  }
  const base = telegram as Record<string, unknown>;
  const accounts = base.accounts;
  const account =
    accountId && accountId !== "default" && accounts && typeof accounts === "object"
      ? (accounts as Record<string, unknown>)[accountId]
      : undefined;
  if (account && typeof account === "object" && !Array.isArray(account)) {
    const accountRecord = account as Record<string, unknown>;
    return {
      ...base,
      ...accountRecord,
      streaming: accountRecord.streaming ?? base.streaming,
    };
  }
  return base;
}

function shouldMirrorTelegramProgress(loaded: LoadedSessionEntry, route: DeliveryRoute): boolean {
  const entry = resolveTelegramStreamingEntry(loaded.cfg, route.accountId);
  if (!entry) {
    return false;
  }
  const mode = resolveChannelPreviewStreamMode(entry, "partial");
  if (mode === "off" || mode === "block") {
    return false;
  }
  return resolveChannelStreamingPreviewToolProgress(entry, true);
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

const CURRENT_TOOL_PROGRESS_LINE_ID = "current-tool";

function lineWithId<TLine extends ChannelProgressDraftLine | undefined>(
  line: TLine,
  id: string | undefined,
): TLine {
  if (!line || !id) {
    return line;
  }
  return { ...line, id } as TLine;
}

function formatAgentEventForChannelMirrorLine(
  evt: AgentEventPayload,
  state: Pick<MirrorState, "assistantTextByRun" | "thinkingTextByRun">,
  entry: Record<string, unknown> | null,
): ProgressPreviewLine | undefined {
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
    return lineWithId(
      buildChannelProgressDraftLineForEntry(entry, {
        event: "item",
        itemKind: normalizeOptionalString(data.kind),
        title: normalizeOptionalString(data.title),
        name: normalizeOptionalString(data.name),
        phase: normalizeOptionalString(data.phase),
        status: normalizeOptionalString(data.status),
        summary: normalizeOptionalString(data.summary),
        progressText: normalizeOptionalString(data.progressText),
        meta: normalizeOptionalString(data.meta),
      }),
      CURRENT_TOOL_PROGRESS_LINE_ID,
    );
  }

  if (evt.stream === "command_output") {
    return lineWithId(
      buildChannelProgressDraftLineForEntry(entry, {
        event: "command-output",
        phase: normalizeOptionalString(data.phase),
        title: normalizeOptionalString(data.title),
        name: normalizeOptionalString(data.name),
        status: normalizeOptionalString(data.status),
        exitCode: typeof data.exitCode === "number" ? data.exitCode : null,
      }),
      CURRENT_TOOL_PROGRESS_LINE_ID,
    );
  }

  if (evt.stream === "approval") {
    return lineWithId(
      buildChannelProgressDraftLineForEntry(entry, {
        event: "approval",
        phase: normalizeOptionalString(data.phase),
        title: normalizeOptionalString(data.title),
        command: normalizeOptionalString(data.command),
        reason: normalizeOptionalString(data.reason),
        message: normalizeOptionalString(data.message),
      }),
      CURRENT_TOOL_PROGRESS_LINE_ID,
    );
  }

  if (evt.stream === "plan") {
    return buildChannelProgressDraftLineForEntry(entry, {
      event: "plan",
      phase: normalizeOptionalString(data.phase),
      title: normalizeOptionalString(data.title),
      explanation: normalizeOptionalString(data.explanation),
      steps: Array.isArray(data.steps)
        ? data.steps.filter((step): step is string => typeof step === "string")
        : undefined,
    });
  }

  if (evt.stream === "patch") {
    const stringArray = (value: unknown): string[] | undefined =>
      Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === "string")
        : undefined;
    return lineWithId(
      buildChannelProgressDraftLineForEntry(entry, {
        event: "patch",
        phase: normalizeOptionalString(data.phase),
        title: normalizeOptionalString(data.title),
        name: normalizeOptionalString(data.name),
        added: stringArray(data.added),
        modified: stringArray(data.modified),
        deleted: stringArray(data.deleted),
        summary: normalizeOptionalString(data.summary),
      }),
      CURRENT_TOOL_PROGRESS_LINE_ID,
    );
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

export function formatAgentEventForChannelMirror(
  evt: AgentEventPayload,
  state: Pick<MirrorState, "assistantTextByRun" | "thinkingTextByRun">,
): string | undefined {
  const line = formatAgentEventForChannelMirrorLine(evt, state, null);
  if (!line) {
    return undefined;
  }
  return typeof line === "string" ? line : line.text;
}

function isTerminalMirrorEvent(evt: AgentEventPayload): boolean {
  const data = evt.data ?? {};
  if (evt.stream === "assistant" && data.phase === "final_answer") {
    return true;
  }
  if (evt.stream === "lifecycle") {
    const phase = normalizeOptionalString(data.phase);
    return phase === "end" || phase === "error";
  }
  return false;
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

function resolveMessageIdFromDurableSend(
  result: DurableMessageBatchSendResult,
): string | undefined {
  if ("receipt" in result) {
    const receiptId =
      result.receipt.primaryPlatformMessageId ?? result.receipt.platformMessageIds[0];
    if (receiptId) {
      return String(receiptId);
    }
  }
  if ("results" in result) {
    const resultId = result.results.find((entry) => entry.messageId)?.messageId;
    if (resultId) {
      return String(resultId);
    }
  }
  return undefined;
}

function defaultSendProgressPreview(
  sendDurableMessageBatch: SendDurableMessageBatch,
): SendProgressPreview {
  return async (params) => {
    const result = await sendDurableMessageBatch({
      cfg: params.cfg,
      channel: "telegram",
      to: params.to,
      ...(params.accountId ? { accountId: params.accountId } : {}),
      threadId: params.threadId,
      payloads: [{ text: params.text }],
      bestEffort: true,
      session: {
        key: params.sessionKey,
      },
    });
    const messageId = resolveMessageIdFromDurableSend(result);
    if (!messageId) {
      throw new Error("Telegram progress preview send returned no message id");
    }
    return { messageId };
  };
}

const defaultEditProgressPreview: EditProgressPreview = async (params) => {
  const { editMessageTelegram } = await loadTelegramRuntimeApi();
  await editMessageTelegram(params.to, params.messageId, params.text, {
    cfg: params.cfg,
    ...(params.accountId ? { accountId: params.accountId } : {}),
    linkPreview: false,
  });
};

const defaultDeleteProgressPreview: DeleteProgressPreview = async (params) => {
  const { deleteMessageTelegram } = await loadTelegramRuntimeApi();
  await deleteMessageTelegram(params.to, params.messageId, {
    cfg: params.cfg,
    ...(params.accountId ? { accountId: params.accountId } : {}),
  });
};

export function createAgentEventChannelMirror(deps: AgentEventChannelMirrorDeps = {}) {
  const state: MirrorState = {
    assistantTextByRun: new Map(),
    thinkingTextByRun: new Map(),
    queuesBySession: new Map(),
    previewsByRoute: new Map(),
    seenEvents: new Set(),
  };
  const loadSessionEntry = deps.loadSessionEntry ?? defaultLoadSessionEntry;
  const sendDurableMessageBatch = deps.sendDurableMessageBatch ?? defaultSendDurableMessageBatch;
  const sendProgressPreview =
    deps.sendProgressPreview ?? defaultSendProgressPreview(sendDurableMessageBatch);
  const editProgressPreview = deps.editProgressPreview ?? defaultEditProgressPreview;
  const deleteProgressPreview = deps.deleteProgressPreview ?? defaultDeleteProgressPreview;
  const delayMs = deps.delayMs ?? DEFAULT_DELAY_MS;

  return async (evt: AgentEventPayload): Promise<void> => {
    const sessionKey =
      normalizeOptionalString(evt.sessionKey) ??
      normalizeOptionalString(getAgentRunContext(evt.runId)?.sessionKey);
    if (!hasSessionKey(sessionKey)) {
      return;
    }
    const key = eventKey(evt);
    if (!rememberSeenEvent(state, key)) {
      return;
    }

    const loaded = loadSessionEntry(sessionKey);
    const route = resolveTelegramThreadRoute(loaded);
    if (!route) {
      return;
    }

    const previewKey = routeKey(route);

    if (isTerminalMirrorEvent(evt)) {
      const preview = state.previewsByRoute.get(previewKey);
      if (!preview) {
        return;
      }
      preview.activeSessionKeys.delete(sessionKey);
      if (preview.activeSessionKeys.size > 0) {
        return;
      }
      await enqueueSessionSend(state, previewKey, delayMs, async () => {
        state.previewsByRoute.delete(previewKey);
        const messageId = preview.messageId;
        preview.messageId = undefined;
        preview.lines = [];
        preview.lastText = undefined;
        if (!messageId) {
          return;
        }
        await deleteProgressPreview({
          cfg: loaded.cfg,
          to: route.to,
          ...(route.accountId ? { accountId: route.accountId } : {}),
          threadId: route.threadId,
          messageId,
          sessionKey,
        });
      });
      return;
    }

    if (!shouldMirrorTelegramProgress(loaded, route)) {
      return;
    }

    const entry = resolveTelegramStreamingEntry(loaded.cfg, route.accountId);
    const line = formatAgentEventForChannelMirrorLine(evt, state, entry);
    if (!line) {
      return;
    }

    let preview = state.previewsByRoute.get(previewKey);
    if (!preview) {
      preview = { activeSessionKeys: new Set(), lines: [] };
      state.previewsByRoute.set(previewKey, preview);
    }
    preview.activeSessionKeys.add(sessionKey);
    const maxLines = resolveChannelProgressDraftMaxLines(entry, 8);
    preview.lines = mergeChannelProgressDraftLine(preview.lines, line, { maxLines });
    const text = formatChannelProgressDraftText({
      entry,
      lines: preview.lines,
      seed: sessionKey,
    });
    if (!text.trim() || text === preview.lastText) {
      return;
    }

    await enqueueSessionSend(state, previewKey, delayMs, async () => {
      const params = {
        cfg: loaded.cfg,
        to: route.to,
        ...(route.accountId ? { accountId: route.accountId } : {}),
        threadId: route.threadId,
        text,
        sessionKey,
      } satisfies ProgressPreviewParams;
      if (!preview.messageId) {
        const sent = await sendProgressPreview(params);
        preview.messageId = sent.messageId;
        preview.lastText = text;
        return;
      }
      await editProgressPreview({ ...params, messageId: preview.messageId });
      preview.lastText = text;
    });
  };
}

export function startAgentEventChannelMirror(deps: AgentEventChannelMirrorDeps = {}): () => void {
  const mirror = createAgentEventChannelMirror(deps);
  return onAgentEvent((evt) => {
    void mirror(evt);
  });
}
