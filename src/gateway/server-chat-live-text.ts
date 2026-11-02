import { asOptionalRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import { Value } from "typebox/value";
import {
  ChatStatusEventSchema,
  type ChatEvent,
  type ChatStatusEvent,
} from "../../packages/gateway-protocol/src/schema/logs-chat.js";
import { TOOL_CALL_RAW_TOOL_NAME } from "../agents/tool-search-types.js";
import type { AgentEventPayload, AgentEventRuntimePayload } from "../infra/agent-events.js";
import { readAutomationDisplayState } from "../infra/agent-run-registry.automation.js";
import { ASSISTANT_DISPLAY_CONTENT_FIELD } from "../shared/assistant-display-content.js";
import { setSafeTimeout } from "../utils/timer-delay.js";
import { resolveAssistantTextInput } from "./agent-event-assistant-text.js";
import {
  appendChatCanvasBlocks,
  appendChatCanvasBlocksToMessage,
  type ChatCanvasBlock,
} from "./chat-display-projection.canvas.js";
import { projectPluginInlineView } from "./chat-display-projection.inline-view.js";
import type { GatewayBroadcastOpts } from "./server-broadcast-types.js";
import type { ChatRunState } from "./server-chat-state.js";

type ChatRunRecord = ReturnType<ChatRunState["getOrCreate"]>;
type LiveTextStream = "chat" | "agent";

type LiveTextDelivery = NonNullable<GatewayBroadcastOpts["liveText"]>;

const CHAT_RETRY_REASONS = new Set<string>(
  ChatStatusEventSchema.properties.retry.properties.reason.anyOf.map((reason) => reason.const),
);

export function projectChatStatusEvent(
  event: Pick<AgentEventPayload, "seq" | "data">,
  identity: { runId: string; sessionKey: string; agentId?: string; spawnedBy?: string | null },
): ChatStatusEvent | undefined {
  const payload = {
    runId: identity.runId,
    sessionKey: identity.sessionKey,
    ...(identity.agentId ? { agentId: identity.agentId } : {}),
    ...(identity.spawnedBy ? { spawnedBy: identity.spawnedBy } : {}),
    seq: event.seq,
    state: "status" as const,
    ...(event.data.phase === "retrying"
      ? {
          phase: "starting_model",
          ...(CHAT_RETRY_REASONS.has(String(event.data.reason))
            ? {
                retry: {
                  attempt: event.data.attempt,
                  maxAttempts: event.data.maxAttempts,
                  reason: event.data.reason,
                  ...(typeof event.data.retryAt === "number" && Number.isFinite(event.data.retryAt)
                    ? { retryAt: event.data.retryAt }
                    : {}),
                },
              }
            : {}),
        }
      : {
          phase: event.data.phase,
          ...(event.data.phase === "waiting_for_model" ? { waitReason: event.data.reason } : {}),
        }),
  };
  return Value.Check(ChatStatusEventSchema, payload) ? payload : undefined;
}

function projectChatWireDelta(value: unknown): ChatEvent {
  // SAFETY: the private delivery key binds this callback to the typed chat producer.
  const { message: _message, ...payload } = value as Extract<ChatEvent, { state: "delta" }>;
  return payload;
}

function projectAssistantWireDelta(value: unknown): AgentEventPayload {
  // SAFETY: only the typed assistant producer supplies this projection; its input stays intact.
  const payload = value as AgentEventPayload;
  const { text: _text, ...data } = payload.data;
  return { ...payload, data };
}

export function liveTextDelivery(
  state: ChatRunState,
  runId: string,
  coalesce?: LiveTextDelivery["coalesce"],
  isCurrent?: () => boolean,
  projection?: LiveTextDelivery["projection"],
): GatewayBroadcastOpts["liveText"] {
  const run = coalesce || projection ? state.getOrCreate(runId) : state.runs.get(runId);
  const group =
    run &&
    (coalesce || projection ? (run.liveTextGroup ??= new AbortController()) : run.liveTextGroup);
  return group
    ? {
        group: group.signal,
        sourceEpoch: run?.liveTextEpoch,
        coalesce,
        projection,
        isCurrent: coalesce || projection ? isCurrent : undefined,
      }
    : undefined;
}

export function chatWireProjection(params: {
  key: string;
  text: string;
  now: number;
  canvasBlocks?: ChatCanvasBlock[];
  replace?: true;
}): LiveTextDelivery["projection"] {
  return {
    key: params.key,
    delta: projectChatWireDelta,
    version: params.canvasBlocks,
    snapshot: params.replace,
    snapshotBytes: (_payload, deltaBytes) =>
      deltaBytes +
      Buffer.byteLength(',"message":') +
      params.text.length * 6 +
      Buffer.byteLength(
        JSON.stringify(
          appendChatCanvasBlocksToMessage(
            { role: "assistant", content: [{ type: "text", text: "" }], timestamp: params.now },
            params.canvasBlocks ?? [],
          ),
        ),
      ),
  };
}

export function projectChatTerminalMessage(params: {
  runId: string;
  text: string;
  displayText?: string;
  timestamp: number;
  canvasBlocks: ChatCanvasBlock[];
  idempotencyKey?: string;
}) {
  const { text, displayText, timestamp, canvasBlocks, runId, idempotencyKey } = params;
  return appendChatCanvasBlocksToMessage(
    {
      role: "assistant",
      content: text ? [{ type: "text", text }] : [],
      timestamp,
      ...(displayText === undefined
        ? {}
        : {
            [ASSISTANT_DISPLAY_CONTENT_FIELD]: appendChatCanvasBlocks(
              displayText ? [{ type: "text", text: displayText }] : [],
              canvasBlocks,
            ),
          }),
      ...(idempotencyKey ? { __openclaw: { runId, idempotencyKey } } : {}),
    },
    canvasBlocks,
  );
}

export function assistantWireProjection(
  payload: AgentEventPayload,
  sessionKey: string | undefined,
  agentId: string | undefined,
  controlUiVisible: boolean,
): LiveTextDelivery["projection"] {
  const text = payload.data.text;
  if (payload.stream !== "assistant" || typeof text !== "string") {
    return undefined;
  }
  return {
    key: JSON.stringify(["agent", "assistant", sessionKey, agentId, controlUiVisible]),
    version: payload.data.itemId,
    delta: projectAssistantWireDelta,
    text: {
      snapshot: text,
      delta: typeof payload.data.delta === "string" ? payload.data.delta : "",
    },
    snapshot:
      payload.data.replace === true ||
      typeof payload.data.delta !== "string" ||
      payload.data.delta === "" ||
      typeof payload.data.mediaUrl === "string" ||
      (Array.isArray(payload.data.mediaUrls) && payload.data.mediaUrls.length > 0),
    snapshotBytes: (_payload, deltaBytes) =>
      deltaBytes + Buffer.byteLength(',"text":""') + text.length * 6,
  };
}

export function prepareAgentWirePayload(
  event: AgentEventRuntimePayload,
  clientRunId: string,
  state: ChatRunState,
  isCurrent: () => boolean,
): AgentEventPayload {
  let payload = event.runId === clientRunId ? event : { ...event, runId: clientRunId };
  if (
    event.stream === "tool" &&
    event.data.phase === "result" &&
    event.data.name === TOOL_CALL_RAW_TOOL_NAME
  ) {
    const result = readRecord(event.data.result);
    const details = readRecord(result?.details);
    if (details) {
      // The dispatcher keeps raw target results for internal consumers, not display clients.
      const { tool: _tool, result: _result, ...liveDetails } = details;
      payload = {
        ...payload,
        data: { ...event.data, result: { ...result, details: liveDetails } },
      };
    }
  }
  if (event.stream === "tool" && event.data.phase === "result") {
    const result = readRecord(payload.data.result);
    const inline = !event.data.isError && projectPluginInlineView(result?.details, event.data);
    if (inline && result) {
      payload = {
        ...payload,
        data: {
          ...payload.data,
          result: {
            ...result,
            details: { ...readRecord(result.details), pluginView: inline },
          },
        },
      };
    }
  }
  if (event.stream === "item" && event.data.kind === "preamble") {
    payload = {
      ...payload,
      preamble: event.assistantProjection?.replace
        ? { retainedText: event.assistantProjection.text }
        : {},
    };
  }
  if (event.stream === "assistant") {
    const input = resolveAssistantTextInput(event.data);
    if (input) {
      const run = state.getOrCreate(clientRunId);
      const textState = ((run.agentText ??= {}).assistant ??= {});
      const previous = textState.snapshot;
      const text =
        input.text ??
        (input.replace || previous?.itemId !== input.itemId ? "" : (previous?.text ?? "")) +
          (input.delta ?? "");
      textState.snapshot = { text, itemId: input.itemId };
      run.bufferIsCurrent = isCurrent;
      if (input.text === undefined) {
        payload = { ...payload, data: { ...event.data, text } };
      }
    }
  }
  if (
    (event.stream === "tool" || event.stream === "item") &&
    event.data.hideFromChannelProgress === true &&
    readAutomationDisplayState(event.runId) !== "ordinary"
  ) {
    // Hiding an activity headline alone still leaves its raw tool card. Keep the
    // execution event intact, but omit routine checks from chat and its replay.
    payload = { ...payload, data: { ...payload.data, display: false } };
  }
  return payload;
}

export function mergeAgentTextPayload(previous: unknown, next: unknown): AgentEventPayload {
  // SAFETY: this callback only merges the same typed agent producer and stream/item key.
  const payload = next as AgentEventPayload;
  // SAFETY: the coalescing key prevents mixing agent payloads with other event shapes.
  const prior = previous as AgentEventPayload;
  if (
    payload.stream === "item" &&
    payload.data.kind === "preamble" &&
    payload.preamble?.retainedText === undefined &&
    prior.preamble?.retainedText !== undefined
  ) {
    return { ...payload, preamble: prior.preamble };
  }
  const delta = prior.data.delta;
  const nextDelta = payload.data.delta;
  return payload.stream !== "item" && typeof delta === "string" && typeof nextDelta === "string"
    ? { ...payload, data: { ...payload.data, delta: `${delta}${nextDelta}` } }
    : payload;
}

export function mergeChatTextPayload(previous: unknown, next: unknown): ChatEvent {
  type Delta = Extract<ChatEvent, { state: "delta" }>;
  // SAFETY: only append deltas use this callback; replacements and terminal events flush it.
  const payload = next as Delta;
  // SAFETY: both values share the same chat-delta delivery key and buffering generation.
  return { ...payload, deltaText: `${(previous as Delta).deltaText}${payload.deltaText}` };
}

export function cancelPendingLiveTextFlush(
  run: ChatRunRecord | undefined,
  stream: LiveTextStream,
): void {
  const pending = run?.pendingTextFlushes?.[stream];
  if (!run || !pending) {
    return;
  }
  clearTimeout(pending.timer);
  delete run.pendingTextFlushes?.[stream];
  if (run.pendingTextFlushes && Object.keys(run.pendingTextFlushes).length === 0) {
    delete run.pendingTextFlushes;
  }
}

export function scheduleLiveTextFlush(
  run: ChatRunRecord,
  stream: LiveTextStream,
  delayMs: number,
  flush: () => void,
): void {
  const pendingFlushes = (run.pendingTextFlushes ??= {});
  const existing = pendingFlushes[stream];
  if (existing) {
    existing.flush = flush;
    return;
  }
  const timer = setSafeTimeout(() => {
    const pending = run.pendingTextFlushes?.[stream];
    if (!pending || pending.timer !== timer) {
      return;
    }
    cancelPendingLiveTextFlush(run, stream);
    pending.flush();
  }, delayMs).unref();
  pendingFlushes[stream] = { timer, flush };
}
