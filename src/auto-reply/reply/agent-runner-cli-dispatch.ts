// Builds CLI runtime dispatch inputs for agent runner executions.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { runCliAgent } from "../../agents/cli-runner.js";
import type { RunCliAgentParams } from "../../agents/cli-runner/types.js";
import { clearCliSession } from "../../agents/cli-session.js";
import { extractToolResultText } from "../../agents/embedded-agent-subscribe.tools.js";
import { inferToolMetaFromArgs } from "../../agents/embedded-agent-utils.js";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent.js";
import {
  isAgentRunRestartAbortReason,
  resolveAgentRunAbortLifecycleFields,
} from "../../agents/run-termination.js";
import { updateSessionStore, type SessionEntry } from "../../config/sessions.js";
import type { AgentEventPayload } from "../../infra/agent-events.js";
import {
  emitAgentEvent,
  onAgentEvent,
  withAgentRunLifecycleGeneration,
} from "../../infra/agent-events.js";
import { formatToolAggregate } from "../tool-meta.js";

function isClaudeCliProvider(provider: string): boolean {
  return normalizeLowercaseStringOrEmpty(provider) === "claude-cli";
}

function shouldBridgeCliAssistantTextToReasoning(provider: string): boolean {
  return isClaudeCliProvider(provider);
}

function createAgentEventBridge<T>(params: {
  runId: string;
  suppressed?: boolean;
  read: (evt: AgentEventPayload) => T | undefined;
  deliver?: (payload: T) => Promise<void>;
}) {
  const deliver = params.deliver;
  if (!deliver) {
    return {
      unsubscribe: () => undefined,
      drain: async (): Promise<void> => undefined,
    };
  }
  let unsubscribed = false;
  let delivery = Promise.resolve();
  const rawUnsubscribe = onAgentEvent((evt) => {
    if (evt.runId !== params.runId) {
      return;
    }
    if (params.suppressed) {
      return;
    }
    const payload = params.read(evt);
    if (payload === undefined) {
      return;
    }
    delivery = delivery.then(() => deliver(payload)).catch(() => undefined);
  });
  return {
    unsubscribe() {
      if (unsubscribed) {
        return;
      }
      unsubscribed = true;
      rawUnsubscribe();
    },
    async drain(): Promise<void> {
      await delivery;
    },
  };
}

type AgentEventBridge = {
  unsubscribe: () => void;
  drain: () => Promise<void>;
};

type CommentaryTextPayload = {
  text: string;
  itemId?: string;
};

async function stopAgentEventBridges(bridges: readonly AgentEventBridge[]): Promise<void> {
  for (const bridge of bridges) {
    bridge.unsubscribe();
  }
  for (const bridge of bridges) {
    await bridge.drain();
  }
}

function createAssistantTextBridge(params: {
  runId: string;
  suppressed?: boolean;
  deliver?: (text: string) => Promise<void>;
}) {
  let lastText: string | undefined;
  return createAgentEventBridge({
    runId: params.runId,
    suppressed: params.suppressed,
    deliver: params.deliver,
    read: (evt) => {
      if (evt.stream !== "assistant") {
        return undefined;
      }
      const text = typeof evt.data.text === "string" ? evt.data.text : undefined;
      if (text === undefined || text === lastText) {
        return undefined;
      }
      lastText = text;
      return text;
    },
  });
}

function readCommentaryTextPayload(evt: AgentEventPayload): CommentaryTextPayload | undefined {
  if (evt.stream !== "item" || evt.data.kind !== "preamble") {
    return undefined;
  }
  const text = typeof evt.data.progressText === "string" ? evt.data.progressText.trim() : "";
  if (!text) {
    return undefined;
  }
  return { text, itemId: typeof evt.data.itemId === "string" ? evt.data.itemId : undefined };
}

export type CliToolEventPayload = {
  name: string | undefined;
  phase: "start" | "update" | "result";
  args: Record<string, unknown> | undefined;
  toolCallId?: string;
  isError?: boolean;
  result?: unknown;
};

export function keepCliSessionBindingOnlyWhenReused(params: {
  result: EmbeddedAgentRunResult;
  existingSessionId?: string;
  onDroppedReplacement?: () => void;
}): EmbeddedAgentRunResult {
  const existingSessionId = normalizeOptionalString(params.existingSessionId);
  const agentMeta = params.result.meta.agentMeta;
  const returnedSessionId = normalizeOptionalString(agentMeta?.cliSessionBinding?.sessionId);
  const shouldClearStoredSession = agentMeta?.clearCliSessionBinding === true;
  if (
    agentMeta === undefined ||
    (!shouldClearStoredSession && existingSessionId === undefined) ||
    returnedSessionId === existingSessionId
  ) {
    return params.result;
  }
  if (returnedSessionId || shouldClearStoredSession) {
    params.onDroppedReplacement?.();
  }
  return {
    ...params.result,
    meta: {
      ...params.result.meta,
      agentMeta: {
        ...agentMeta,
        sessionId: "",
        cliSessionBinding: undefined,
        clearCliSessionBinding: undefined,
      },
    },
  };
}

export async function clearDroppedCliSessionBinding(params: {
  provider: string;
  sessionKey?: string;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  activeSessionEntry?: SessionEntry;
}): Promise<void> {
  const updatedAt = Date.now();
  const clearEntry = (entry: SessionEntry | undefined) => {
    if (!entry) {
      return;
    }
    clearCliSession(entry, params.provider);
    entry.updatedAt = updatedAt;
  };
  clearEntry(params.activeSessionEntry);
  clearEntry(params.sessionKey ? params.sessionStore?.[params.sessionKey] : undefined);
  if (!params.storePath || !params.sessionKey) {
    return;
  }
  await updateSessionStore(params.storePath, (store) => {
    clearEntry(store[params.sessionKey!]);
  });
}

function createToolEventBridge(params: {
  runId: string;
  suppressed?: boolean;
  deliver?: (payload: CliToolEventPayload) => Promise<void>;
}) {
  return createAgentEventBridge({
    runId: params.runId,
    suppressed: params.suppressed,
    deliver: params.deliver,
    read: (evt) => {
      if (evt.stream !== "tool") {
        return undefined;
      }
      const phaseValue = evt.data.phase;
      if (phaseValue !== "start" && phaseValue !== "update" && phaseValue !== "result") {
        return undefined;
      }
      const phase: CliToolEventPayload["phase"] =
        phaseValue === "start" ? "start" : phaseValue === "update" ? "update" : "result";
      return {
        name: typeof evt.data.name === "string" ? evt.data.name : undefined,
        phase,
        args: isRecord(evt.data.args) ? evt.data.args : undefined,
        toolCallId: typeof evt.data.toolCallId === "string" ? evt.data.toolCallId : undefined,
        ...(phase === "result"
          ? {
              isError: evt.data.isError === true,
              result: evt.data.result,
            }
          : {}),
      };
    },
  });
}

/**
 * Tracks CLI tool start/result events and renders the same durable tool
 * summaries the embedded runner emits: a formatToolAggregate line per result
 * (args-derived meta captured at start), plus the output block under full
 * verbose. Keeps CLI runs at tool-summary parity with embedded runs.
 */
export function createCliToolSummaryTracker(params: {
  detailMode?: "explain" | "raw";
  shouldEmitToolResult: () => boolean;
  shouldEmitToolOutput: () => boolean;
  deliver: (payload: { text: string; isError?: boolean }) => Promise<void> | void;
}) {
  const metaByCallId = new Map<string, string | undefined>();
  return {
    noteToolEvent: async (payload: CliToolEventPayload): Promise<void> => {
      if (payload.phase === "start") {
        if (payload.toolCallId && payload.name) {
          metaByCallId.set(
            payload.toolCallId,
            inferToolMetaFromArgs(payload.name, payload.args, {
              detailMode: params.detailMode ?? "explain",
            }),
          );
        }
        return;
      }
      if (payload.phase !== "result") {
        return;
      }
      const meta = payload.toolCallId ? metaByCallId.get(payload.toolCallId) : undefined;
      if (payload.toolCallId) {
        metaByCallId.delete(payload.toolCallId);
      }
      if (!params.shouldEmitToolResult()) {
        return;
      }
      const aggregate = formatToolAggregate(payload.name, meta ? [meta] : undefined, {
        markdown: true,
      });
      let text = aggregate;
      if (params.shouldEmitToolOutput()) {
        const output = extractToolResultText(payload.result)?.trim();
        if (output) {
          text = `${aggregate}\n\`\`\`txt\n${output}\n\`\`\``;
        }
      }
      if (!text.trim()) {
        return;
      }
      await params.deliver({ text, ...(payload.isError === true ? { isError: true } : {}) });
    },
  };
}

function createCommentaryEventBridge(params: {
  runId: string;
  suppressed?: boolean;
  deliver?: (payload: CommentaryTextPayload) => Promise<void>;
}) {
  return createAgentEventBridge({
    runId: params.runId,
    suppressed: params.suppressed,
    deliver: params.deliver,
    read: readCommentaryTextPayload,
  });
}

type RunCliAgentWithLifecycleParams = {
  runId: string;
  lifecycleGeneration?: string;
  provider: string;
  runParams: RunCliAgentParams;
  startedAt?: number;
  emitLifecycleStart?: boolean;
  emitLifecycleTerminal?: boolean;
  onAgentRunStart?: () => void;
  suppressAssistantBridge?: boolean;
  onAssistantText?: (text: string) => Promise<void>;
  onReasoningText?: (text: string) => Promise<void>;
  onToolEvent?: (payload: CliToolEventPayload) => Promise<void>;
  onCommentaryText?: (payload: { text: string; itemId?: string }) => Promise<void>;
  onErrorBeforeLifecycle?: (err: unknown) => Promise<void>;
  transformResult?: (result: EmbeddedAgentRunResult) => EmbeddedAgentRunResult;
};

export function runCliAgentWithLifecycle(
  params: RunCliAgentWithLifecycleParams,
): Promise<EmbeddedAgentRunResult> {
  if (!params.lifecycleGeneration) {
    return runCliAgentWithLifecycleInternal(params);
  }
  return withAgentRunLifecycleGeneration(params.lifecycleGeneration, () =>
    runCliAgentWithLifecycleInternal(params),
  );
}

async function runCliAgentWithLifecycleInternal(
  params: RunCliAgentWithLifecycleParams,
): Promise<EmbeddedAgentRunResult> {
  const startedAt = params.startedAt ?? Date.now();
  const emitLifecycleStart = params.emitLifecycleStart ?? true;
  const emitLifecycleTerminal = params.emitLifecycleTerminal ?? true;
  params.onAgentRunStart?.();
  if (emitLifecycleStart) {
    emitAgentEvent({
      runId: params.runId,
      ...(params.runParams.sessionKey ? { sessionKey: params.runParams.sessionKey } : {}),
      ...(params.runParams.sessionId ? { sessionId: params.runParams.sessionId } : {}),
      ...(params.lifecycleGeneration ? { lifecycleGeneration: params.lifecycleGeneration } : {}),
      stream: "lifecycle",
      data: {
        phase: "start",
        startedAt,
      },
    });
  }
  const assistantBridge = createAssistantTextBridge({
    runId: params.runId,
    suppressed: params.suppressAssistantBridge,
    deliver: params.onAssistantText,
  });
  const reasoningBridge = createAssistantTextBridge({
    runId: params.runId,
    suppressed: params.suppressAssistantBridge,
    deliver: shouldBridgeCliAssistantTextToReasoning(params.provider)
      ? params.onReasoningText
      : undefined,
  });
  const toolBridge = createToolEventBridge({
    runId: params.runId,
    suppressed: params.suppressAssistantBridge,
    deliver: params.onToolEvent,
  });
  const commentaryBridge = createCommentaryEventBridge({
    runId: params.runId,
    suppressed: params.suppressAssistantBridge,
    deliver: params.onCommentaryText,
  });
  const bridges = [assistantBridge, reasoningBridge, toolBridge, commentaryBridge].filter(
    (bridge): bridge is AgentEventBridge => bridge !== undefined,
  );
  let lifecycleTerminalEmitted = false;
  try {
    const rawResult = await runCliAgent({
      ...params.runParams,
      emitCommentaryText: Boolean(params.onCommentaryText),
    });
    const restartAbortReason = params.runParams.abortSignal?.reason;
    if (isAgentRunRestartAbortReason(restartAbortReason)) {
      throw restartAbortReason;
    }
    const result = params.transformResult?.(rawResult) ?? rawResult;
    await stopAgentEventBridges(bridges);

    const cliText = normalizeOptionalString(result.payloads?.[0]?.text);
    if (cliText) {
      emitAgentEvent({
        runId: params.runId,
        stream: "assistant",
        data: { text: cliText },
      });
    }

    if (emitLifecycleTerminal) {
      emitAgentEvent({
        runId: params.runId,
        ...(params.runParams.sessionKey ? { sessionKey: params.runParams.sessionKey } : {}),
        ...(params.runParams.sessionId ? { sessionId: params.runParams.sessionId } : {}),
        ...(params.lifecycleGeneration ? { lifecycleGeneration: params.lifecycleGeneration } : {}),
        stream: "lifecycle",
        data: {
          phase: "end",
          startedAt,
          endedAt: Date.now(),
          ...resolveAgentRunAbortLifecycleFields(params.runParams.abortSignal),
        },
      });
      lifecycleTerminalEmitted = true;
    }
    return result;
  } catch (err) {
    await stopAgentEventBridges(bridges);
    await params.onErrorBeforeLifecycle?.(err);
    if (emitLifecycleTerminal) {
      emitAgentEvent({
        runId: params.runId,
        ...(params.runParams.sessionKey ? { sessionKey: params.runParams.sessionKey } : {}),
        ...(params.runParams.sessionId ? { sessionId: params.runParams.sessionId } : {}),
        ...(params.lifecycleGeneration ? { lifecycleGeneration: params.lifecycleGeneration } : {}),
        stream: "lifecycle",
        data: {
          phase: "error",
          startedAt,
          endedAt: Date.now(),
          error: String(err),
          ...resolveAgentRunAbortLifecycleFields(params.runParams.abortSignal),
        },
      });
      lifecycleTerminalEmitted = true;
    }
    throw err;
  } finally {
    for (const bridge of bridges) {
      bridge.unsubscribe();
    }
    if (emitLifecycleTerminal && !lifecycleTerminalEmitted) {
      emitAgentEvent({
        runId: params.runId,
        ...(params.runParams.sessionKey ? { sessionKey: params.runParams.sessionKey } : {}),
        ...(params.runParams.sessionId ? { sessionId: params.runParams.sessionId } : {}),
        ...(params.lifecycleGeneration ? { lifecycleGeneration: params.lifecycleGeneration } : {}),
        stream: "lifecycle",
        data: {
          phase: "error",
          startedAt,
          endedAt: Date.now(),
          error: "CLI run completed without lifecycle terminal event",
          ...resolveAgentRunAbortLifecycleFields(params.runParams.abortSignal),
        },
      });
    }
  }
}
