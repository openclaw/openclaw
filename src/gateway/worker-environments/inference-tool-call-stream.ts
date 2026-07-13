import { isDeepStrictEqual } from "node:util";
import type { WorkerInferenceEventParams } from "../../../packages/gateway-protocol/src/schema/worker-inference.js";
import type { AssistantMessage, ToolCall } from "../../llm/types.js";

const MAX_PENDING_TOOL_DELTA_BYTES = 1024 * 1024;
const MAX_PENDING_TOOL_DELTAS = 4096;

export type ToolCallEmissionResult = "ok" | "invalid" | "cancelled";

function contentAt(message: AssistantMessage, index: number) {
  return message.content[index];
}

export function createWorkerToolCallStream(params: {
  emit: (event: WorkerInferenceEventParams["event"]) => void;
  isCurrent: () => boolean;
}) {
  const pendingDeltas = new Map<number, string[]>();
  let pendingDeltaBytes = 0;
  let pendingDeltaCount = 0;
  const started = new Set<number>();
  const ended = new Set<number>();
  const identities = new Map<number, { id: string; name: string }>();
  const emittedArgumentDeltas = new Map<number, string[]>();
  let retainedArgumentBytes = 0;
  let retainedArgumentDeltas = 0;

  const emitDelta = (contentIndex: number, delta: string): ToolCallEmissionResult => {
    if (!params.isCurrent()) {
      return "cancelled";
    }
    const deltaBytes = Buffer.byteLength(delta, "utf8");
    if (
      retainedArgumentBytes + deltaBytes > MAX_PENDING_TOOL_DELTA_BYTES ||
      retainedArgumentDeltas + 1 > MAX_PENDING_TOOL_DELTAS
    ) {
      return "invalid";
    }
    params.emit({ type: "toolcall_delta", contentIndex, delta });
    const emitted = emittedArgumentDeltas.get(contentIndex) ?? [];
    emitted.push(delta);
    emittedArgumentDeltas.set(contentIndex, emitted);
    retainedArgumentBytes += deltaBytes;
    retainedArgumentDeltas += 1;
    return params.isCurrent() ? "ok" : "cancelled";
  };

  const start = (contentIndex: number, partial: AssistantMessage): ToolCallEmissionResult => {
    if (started.has(contentIndex)) {
      return params.isCurrent() ? "ok" : "cancelled";
    }
    const content = contentAt(partial, contentIndex);
    if (content?.type !== "toolCall" || !content.id || !content.name) {
      return "invalid";
    }
    if (!params.isCurrent()) {
      return "cancelled";
    }
    started.add(contentIndex);
    identities.set(contentIndex, { id: content.id, name: content.name });
    params.emit({ type: "toolcall_start", contentIndex, id: content.id, toolName: content.name });
    if (!params.isCurrent()) {
      return "cancelled";
    }
    for (const delta of pendingDeltas.get(contentIndex) ?? []) {
      const result = emitDelta(contentIndex, delta);
      pendingDeltaBytes -= Buffer.byteLength(delta, "utf8");
      pendingDeltaCount -= 1;
      if (result !== "ok") {
        return result;
      }
    }
    pendingDeltas.delete(contentIndex);
    return "ok";
  };

  const delta = (
    contentIndex: number,
    value: string,
    partial: AssistantMessage,
  ): ToolCallEmissionResult => {
    if (started.has(contentIndex)) {
      return emitDelta(contentIndex, value);
    }
    const pending = pendingDeltas.get(contentIndex) ?? [];
    pendingDeltaBytes += Buffer.byteLength(value, "utf8");
    pendingDeltaCount += 1;
    if (
      pendingDeltaBytes > MAX_PENDING_TOOL_DELTA_BYTES ||
      pendingDeltaCount > MAX_PENDING_TOOL_DELTAS
    ) {
      return "invalid";
    }
    pending.push(value);
    pendingDeltas.set(contentIndex, pending);
    const result = start(contentIndex, partial);
    return result === "invalid" ? "ok" : result;
  };

  const reconcile = (contentIndex: number, complete: ToolCall): ToolCallEmissionResult => {
    const identity = identities.get(contentIndex);
    if (!identity || identity.id !== complete.id || identity.name !== complete.name) {
      return "invalid";
    }
    const emittedJson = (emittedArgumentDeltas.get(contentIndex) ?? []).join("");
    if (!emittedJson) {
      try {
        const completeJson = JSON.stringify(complete.arguments);
        return typeof completeJson === "string" ? emitDelta(contentIndex, completeJson) : "invalid";
      } catch {
        return "invalid";
      }
    }
    try {
      return isDeepStrictEqual(JSON.parse(emittedJson), complete.arguments)
        ? params.isCurrent()
          ? "ok"
          : "cancelled"
        : "invalid";
    } catch {
      // The protocol has no argument reset event, so incomplete raw JSON fails closed.
      return "invalid";
    }
  };

  const end = (
    contentIndex: number,
    partial: AssistantMessage,
    complete: ToolCall,
  ): ToolCallEmissionResult => {
    if (ended.has(contentIndex)) {
      return reconcile(contentIndex, complete);
    }
    const startResult = start(contentIndex, partial);
    if (startResult !== "ok") {
      return startResult;
    }
    const reconcileResult = reconcile(contentIndex, complete);
    if (reconcileResult !== "ok") {
      return reconcileResult;
    }
    ended.add(contentIndex);
    params.emit({ type: "toolcall_end", contentIndex });
    return params.isCurrent() ? "ok" : "cancelled";
  };

  return {
    delta,
    end,
    matchesTerminal: (message: AssistantMessage) => {
      const terminal = new Set(
        message.content.flatMap((content, contentIndex) =>
          content.type === "toolCall" ? [contentIndex] : [],
        ),
      );
      return (
        terminal.size === started.size &&
        [...started].every((contentIndex) => terminal.has(contentIndex) && ended.has(contentIndex))
      );
    },
    start,
  };
}
