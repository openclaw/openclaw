import { asPositiveFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { Value } from "typebox/value";
import { AgentActivityItemSchema } from "../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { runCliAgent } from "../../agents/cli-runner.js";
import { cliAssistantItemId } from "../../agents/cli-runner/assistant-identity.js";
import { stripOpenClawMcpToolPrefix } from "../../agents/cli-runner/tool-policy.js";
import type { RunCliAgentParams } from "../../agents/cli-runner/types.js";
import type { MediaImageLayout } from "../../agents/embedded-agent-runner/run/prompt-image-metadata.js";
import { extractToolResultText } from "../../agents/embedded-agent-tool-results.js";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent.js";
import {
  DEFAULT_FAST_MODE_AUTO_ON_SECONDS,
  formatFastModeAutoProgressText,
  resolveFastModeForElapsed,
  type FastModeAutoProgressState,
} from "../../agents/fast-mode.js";
import { isAgentRunRestartAbortReason } from "../../agents/run-termination.js";
import { inferToolMetaFromArgsCore, isCommandBearingToolCall } from "../../agents/tool-display.js";
import { normalizeAgentPlanSteps } from "../../channels/streaming.js";
import type { AgentEventPayload } from "../../infra/agent-events.js";
import { emitAgentEvent, withAgentRunLifecycleGeneration } from "../../infra/agent-events.js";
import { isAgentPlanProgressToolName } from "../../session-cards/progress-card-input.js";
import { FAST_MODE_AUTO_PROGRESS_KIND } from "../reply-payload.js";
import { formatToolAggregate } from "../tool-meta.js";
import type { GetReplyOptions } from "../types.js";
import {
  createAgentEventBridge,
  createAgentEventDeliveryStartOrder,
  type AgentEventBridgeParams,
} from "./agent-event-bridge.js";

type RunCliAgentInternalParams = RunCliAgentParams & {
  mediaImageLayout?: MediaImageLayout;
};

type AgentEventBridge = ReturnType<typeof createAgentEventBridge>;

async function stopAgentEventBridges(bridges: readonly AgentEventBridge[]): Promise<void> {
  for (const bridge of bridges) {
    bridge.unsubscribe();
  }
  for (const bridge of bridges) {
    await bridge.drain();
  }
}

type ReasoningTextPayload = {
  text: string;
  isReasoningSnapshot?: boolean;
};

type AssistantTextDelivery =
  | { text: string; completed: false }
  | { text: string; completed: true; assistantMessageIndex: number };

export function createCliReasoningStreamBridge(
  onReasoningStream: GetReplyOptions["onReasoningStream"] | undefined,
): ((payload: ReasoningTextPayload) => Promise<void>) | undefined {
  if (!onReasoningStream) {
    return undefined;
  }
  return async ({ text, isReasoningSnapshot }) => {
    await onReasoningStream({
      text,
      ...(isReasoningSnapshot ? { isReasoningSnapshot } : {}),
      requiresReasoningProgressOptIn: true,
    });
  };
}

type CommentaryTextPayload = {
  text: string;
  itemId?: string;
};

type CliToolEventPayload = {
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

function readToolEventPayload(evt: AgentEventPayload): CliToolEventPayload | undefined {
  const phase = evt.data.phase;
  if (phase !== "start" && phase !== "update" && phase !== "result") {
    return undefined;
  }
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
}

/** CLI result summaries use start-event metadata; full verbosity also carries raw output. */
export function createCliToolSummaryTracker(params: {
  detailMode?: "explain" | "raw";
  commandDetailsVisible: boolean;
  shouldEmitToolResult: () => boolean;
  shouldEmitToolOutput: () => boolean;
  deliver: NonNullable<GetReplyOptions["onToolResult"]>;
}) {
  const toolByCallId = new Map<string, { name: string; meta?: string; commandBearing: boolean }>();
  return {
    noteToolEvent: async (payload: CliToolEventPayload): Promise<boolean> => {
      if (payload.phase === "start") {
        if (payload.toolCallId && payload.name) {
          const name = stripOpenClawMcpToolPrefix(payload.name);
          toolByCallId.set(payload.toolCallId, {
            name,
            meta: inferToolMetaFromArgsCore(name, payload.args, {
              detailMode: params.detailMode ?? "explain",
            }),
            commandBearing: isCommandBearingToolCall(name, payload.args),
          });
        }
        return false;
      }
      if (payload.phase !== "result") {
        return false;
      }
      const storedTool = payload.toolCallId ? toolByCallId.get(payload.toolCallId) : undefined;
      const toolName =
        payload.name === undefined ? storedTool?.name : stripOpenClawMcpToolPrefix(payload.name);
      const meta =
        params.commandDetailsVisible || !storedTool?.commandBearing ? storedTool?.meta : undefined;
      if (payload.toolCallId) {
        toolByCallId.delete(payload.toolCallId);
      }
      if (payload.isError !== true && isAgentPlanProgressToolName(toolName ?? "")) {
        return false;
      }
      if (!params.shouldEmitToolResult()) {
        return storedTool?.commandBearing === true;
      }
      const aggregate = formatToolAggregate(toolName, meta ? [meta] : undefined, {
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
        return storedTool?.commandBearing === true;
      }
      await params.deliver({ text, ...(payload.isError === true ? { isError: true } : {}) });
      return storedTool?.commandBearing === true;
    },
  };
}

type RunCliAgentWithLifecycleParams = {
  runId: string;
  lifecycleGeneration?: string;
  runParams: RunCliAgentInternalParams;
  startedAt?: number;
  onAgentRunStart?: () => void;
  suppressAssistantBridge?: boolean;
  /**
   * Stamped before every delivered CLI progress event (assistant, reasoning,
   * tool, commentary, fast-mode). Callers wire this to the reply operation's
   * activity evidence; per-callback stamps at call sites drift and a missed
   * stamp lets stale-takeover reclaim a healthy run.
   */
  onActivity?: () => void;
  preserveProgressCallbackStartOrder?: boolean;
  onAssistantText?: (text: string) => Promise<boolean | void>;
  onCompletedReply?: (text: string, assistantMessageIndex: number) => Promise<void>;
  onReasoningText?: (payload: ReasoningTextPayload) => Promise<void>;
  onReasoningProgress?: GetReplyOptions["onReasoningProgress"];
  onCompactionStart?: GetReplyOptions["onCompactionStart"];
  onCompactionEnd?: GetReplyOptions["onCompactionEnd"];
  onToolEvent?: (payload: CliToolEventPayload) => Promise<void>;
  onItemEvent?: GetReplyOptions["onItemEvent"];
  onCommentaryText?: (payload: CommentaryTextPayload) => Promise<void>;
  onPlanUpdate?: GetReplyOptions["onPlanUpdate"];
  onFastModeAutoProgress?: GetReplyOptions["onToolResult"];
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
  const fastModeStartedAtMs = params.runParams.fastModeStartedAtMs ?? startedAt;
  const fastModeAutoOnSeconds =
    params.runParams.fastModeAutoOnSeconds ?? DEFAULT_FAST_MODE_AUTO_ON_SECONDS;
  const fastModeAutoProgressState: FastModeAutoProgressState = params.runParams
    .fastModeAutoProgressState ?? {
    offAnnounced: false,
    resetAnnounced: false,
  };
  const emitFastModeAutoProgress = async (payload: {
    enabled: boolean;
    elapsedSeconds: number;
    fastAutoOnSeconds?: number;
  }) => {
    const summary = formatFastModeAutoProgressText(payload);
    emitAgentEvent({
      runId: params.runId,
      stream: "item",
      data: {
        kind: "status",
        title: "Fast",
        phase: "update",
        summary,
      },
      ...(params.runParams.sessionKey ? { sessionKey: params.runParams.sessionKey } : {}),
    });
    try {
      await params.onFastModeAutoProgress?.({
        text: summary,
        channelData: { openclawProgressKind: FAST_MODE_AUTO_PROGRESS_KIND },
      });
    } catch {
      // Progress hints are best-effort; a channel failure must not fail the agent turn.
    }
  };
  const maybeAnnounceFastModeAutoOff = async () => {
    if (params.runParams.fastMode !== "auto" || fastModeAutoProgressState.offAnnounced) {
      return;
    }
    const next = resolveFastModeForElapsed({
      mode: "auto",
      startedAtMs: fastModeStartedAtMs,
      fastAutoOnSeconds: fastModeAutoOnSeconds,
    });
    if (next.enabled) {
      return;
    }
    fastModeAutoProgressState.offAnnounced = true;
    await emitFastModeAutoProgress(next);
  };
  params.onAgentRunStart?.();
  emitAgentEvent({
    runId: params.runId,
    ...(params.runParams.agentId ? { agentId: params.runParams.agentId } : {}),
    ...(params.runParams.sessionKey ? { sessionKey: params.runParams.sessionKey } : {}),
    ...(params.runParams.sessionId ? { sessionId: params.runParams.sessionId } : {}),
    ...(params.lifecycleGeneration ? { lifecycleGeneration: params.lifecycleGeneration } : {}),
    stream: "lifecycle",
    data: { phase: "start", startedAt },
  });
  const progressStartOrder = createAgentEventDeliveryStartOrder({
    preserveCallbackStartOrder: params.preserveProgressCallbackStartOrder === true,
  });
  const progressBridgeParams = {
    runId: params.runId,
    suppressed: params.suppressAssistantBridge,
    startOrder: progressStartOrder,
  };
  const createProgressBridge = <T>(
    stream: AgentEventPayload["stream"],
    options: Pick<AgentEventBridgeParams<T>, "read" | "deliver" | "waitForEarlierDeliveries">,
  ) =>
    createAgentEventBridge({
      ...progressBridgeParams,
      ...options,
      read: (event) => (event.stream === stream ? options.read(event) : undefined),
    });
  const { onAssistantText, onCompletedReply } = params;
  let lastAssistantText: string | undefined;
  let finalReasoningText: string | undefined;
  let lastReasoningText: string | undefined;
  let lastProgressTokens: number | undefined;
  const bridges = [
    // Silent runs still need activity evidence for the stale-takeover window.
    params.onActivity
      ? createAgentEventBridge<Record<string, never>>({
          runId: params.runId,
          read: () => ({}),
          deliver: async () => {
            params.onActivity?.();
          },
        })
      : undefined,
    createProgressBridge<AssistantTextDelivery>("assistant", {
      waitForEarlierDeliveries: (payload) => payload.completed,
      deliver: async (payload) => {
        if (payload.completed) {
          await onCompletedReply?.(payload.text, payload.assistantMessageIndex);
        } else {
          await onAssistantText?.(payload.text);
        }
      },
      read: (evt) => {
        if (
          typeof evt.data.completedText === "string" &&
          typeof evt.data.assistantMessageIndex === "number"
        ) {
          return {
            text: evt.data.completedText,
            completed: true,
            assistantMessageIndex: evt.data.assistantMessageIndex,
          };
        }
        const text = typeof evt.data.text === "string" ? evt.data.text : undefined;
        if (text === undefined || text === lastAssistantText) {
          return undefined;
        }
        lastAssistantText = text;
        return { text, completed: false };
      },
    }),
    createProgressBridge<ReasoningTextPayload>("thinking", {
      read: (evt) => {
        const text = typeof evt.data.text === "string" ? evt.data.text : undefined;
        if (text === undefined || text === lastReasoningText) {
          return undefined;
        }
        lastReasoningText = text;
        return {
          text,
          ...(evt.data.isReasoningSnapshot === true ? { isReasoningSnapshot: true } : {}),
        };
      },
      deliver: async (payload) => {
        finalReasoningText = normalizeOptionalString(payload.text);
        await params.onReasoningText?.(payload);
      },
    }),
    createProgressBridge("thinking", {
      read: (evt) => {
        const progressTokens = asPositiveFiniteNumber(evt.data.progressTokens);
        if (progressTokens === undefined || progressTokens === lastProgressTokens) {
          return undefined;
        }
        lastProgressTokens = progressTokens;
        return { progressTokens };
      },
      deliver: params.onReasoningProgress,
    }),
    createProgressBridge<{ phase: "start" } | { completed: boolean; phase: "end" }>("compaction", {
      deliver: async (event) => {
        if (event.phase === "start") {
          await params.onCompactionStart?.();
        } else {
          await params.onCompactionEnd?.({ completed: event.completed });
        }
      },
      read: (evt) => {
        if (evt.data.phase === "start") {
          return { phase: "start" };
        }
        return evt.data.phase === "end"
          ? { phase: "end", completed: evt.data.completed === true }
          : undefined;
      },
    }),
    createProgressBridge("tool", {
      deliver: params.onToolEvent,
      read: readToolEventPayload,
    }),
    createProgressBridge<CommentaryTextPayload>("item", {
      deliver: params.onCommentaryText,
      read: (evt) => {
        if (evt.data.kind !== "preamble") {
          return undefined;
        }
        const text = typeof evt.data.progressText === "string" ? evt.data.progressText.trim() : "";
        return text
          ? { text, ...(typeof evt.data.itemId === "string" ? { itemId: evt.data.itemId } : {}) }
          : undefined;
      },
    }),
    createProgressBridge("item", {
      read: (evt) =>
        evt.data.kind !== "preamble" && Value.Check(AgentActivityItemSchema, evt.data)
          ? evt.data
          : undefined,
      deliver: params.onItemEvent ? (item) => params.onItemEvent?.(item) : undefined,
    }),
    createProgressBridge("plan", {
      deliver: params.onPlanUpdate,
      read: (evt) => ({
        phase: normalizeOptionalString(evt.data.phase),
        title: normalizeOptionalString(evt.data.title),
        explanation: normalizeOptionalString(evt.data.explanation),
        ...(evt.data.explanationFormat === "plain" ? { explanationFormat: "plain" as const } : {}),
        steps: normalizeAgentPlanSteps(evt.data.steps),
        source: normalizeOptionalString(evt.data.source),
      }),
    }),
    createAgentEventBridge({
      runId: params.runId,
      suppressed: params.suppressAssistantBridge,
      deliver: maybeAnnounceFastModeAutoOff,
      read: (evt) => {
        if (evt.stream !== "tool") {
          return undefined;
        }
        const phase = typeof evt.data.phase === "string" ? evt.data.phase : "";
        return ["completed", "end", "error", "result"].includes(phase) ? true : undefined;
      },
    }),
  ].filter((bridge): bridge is AgentEventBridge => bridge !== undefined);
  try {
    const rawResult = await runCliAgent({
      ...params.runParams,
      emitCommentaryText: params.runParams.emitCommentaryText ?? Boolean(params.onCommentaryText),
    });
    const restartAbortReason = params.runParams.abortSignal?.reason;
    if (isAgentRunRestartAbortReason(restartAbortReason)) {
      throw restartAbortReason;
    }
    const result = params.transformResult?.(rawResult) ?? rawResult;
    await stopAgentEventBridges(bridges);

    const cliText = result.payloads?.length
      ? (normalizeOptionalString(result.meta.finalAssistantVisibleText) ??
        normalizeOptionalString(result.payloads[0]?.text))
      : undefined;
    const resultWithReasoning = finalReasoningText
      ? {
          ...result,
          payloads: [{ text: finalReasoningText, isReasoning: true }, ...(result.payloads ?? [])],
        }
      : result;
    if (cliText) {
      emitAgentEvent({
        runId: params.runId,
        stream: "assistant",
        data: { itemId: cliAssistantItemId(params.runId), text: cliText },
      });
    }

    return resultWithReasoning;
  } catch (err) {
    await stopAgentEventBridges(bridges);
    await params.onErrorBeforeLifecycle?.(err);
    throw err;
  } finally {
    if (
      params.runParams.isFinalFallbackAttempt !== false &&
      params.runParams.fastMode === "auto" &&
      fastModeAutoProgressState.offAnnounced &&
      !fastModeAutoProgressState.resetAnnounced
    ) {
      fastModeAutoProgressState.resetAnnounced = true;
      await emitFastModeAutoProgress({
        enabled: true,
        elapsedSeconds: 0,
        fastAutoOnSeconds: fastModeAutoOnSeconds,
      });
    }
  }
}
