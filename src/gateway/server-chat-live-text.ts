import type { ChatEvent } from "../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { AgentEventPayload } from "../infra/agent-events.js";
import { setSafeTimeout } from "../utils/timer-delay.js";
import { resolveAssistantTextInput } from "./agent-event-assistant-text.js";
import {
  appendChatCanvasBlocksToMessage,
  type ChatCanvasBlock,
} from "./chat-display-projection.canvas.js";
import type { GatewayBroadcastOpts } from "./server-broadcast-types.js";
import type { ChatRunState } from "./server-chat-state.js";

type ChatRunRecord = ReturnType<ChatRunState["getOrCreate"]>;
type LiveTextStream = "chat" | "agent";

type LiveTextDelivery = NonNullable<GatewayBroadcastOpts["liveText"]>;

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
  event: AgentEventPayload,
  clientRunId: string,
  state: ChatRunState,
  isCurrent: () => boolean,
): AgentEventPayload {
  let payload = event.runId === clientRunId ? event : { ...event, runId: clientRunId };
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
  return payload;
}

export function mergeAgentTextPayload(previous: unknown, next: unknown): AgentEventPayload {
  // SAFETY: this callback only merges the same typed agent producer and stream/item key.
  const payload = next as AgentEventPayload;
  // SAFETY: the coalescing key prevents mixing agent payloads with other event shapes.
  const delta = (previous as AgentEventPayload).data.delta;
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

export function cancelPendingLiveTextFlush(run: ChatRunRecord, stream: LiveTextStream): void {
  const pending = run.pendingTextFlushes?.[stream];
  if (!pending) {
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
  }, delayMs);
  timer.unref?.();
  pendingFlushes[stream] = { timer, flush };
}
