import { randomUUID } from "node:crypto";
import type { WorkerLiveEvent } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  mergeAgentRunAttemptTerminal,
  normalizeAgentRunAttemptTerminal,
  projectAgentRunAttemptTerminal,
  type AgentRunAttemptTerminal,
} from "../agents/agent-run-terminal-outcome.js";
import { redactAgentDiagnosticPayload } from "../agents/diagnostic-redaction.js";
import { hasModelFallbackStop } from "../agents/failover-error.js";
import type { AgentMessage } from "../agents/runtime/index.js";
import type { AgentSessionEvent } from "../agents/sessions/agent-session.js";
import { parseReplyDirectives } from "../auto-reply/reply/reply-directives.js";
import { createStreamingDirectiveAccumulator } from "../auto-reply/reply/streaming-directives.js";
import {
  bindAgentAssistantSource,
  readAgentAssistantSource,
  type AgentAssistantSourceReceipt,
} from "../infra/agent-events.js";
import { formatErrorMessage } from "../infra/errors.js";
import { jsonUtf8BytesOrInfinity } from "../infra/json-utf8-bytes.js";
import {
  resolveAssistantMessagePhase,
  type AssistantPhase,
} from "../shared/chat-message-content.js";
import { truncateUtf8Prefix } from "../utils/utf8-truncate.js";

const MAX_LIVE_EVENT_BYTES = 32 * 1024;
const MAX_LIVE_PREVIEW_BYTES = 4 * 1024;
const LIVE_PREVIEW_INTERVAL_MS = 75;

function truncateLiveText(value: string): string {
  if (
    value.length <= MAX_LIVE_PREVIEW_BYTES &&
    Buffer.byteLength(value, "utf8") <= MAX_LIVE_PREVIEW_BYTES
  ) {
    return value;
  }
  const suffix = "…";
  return `${truncateUtf8Prefix(
    value,
    MAX_LIVE_PREVIEW_BYTES - Buffer.byteLength(suffix, "utf8"),
  )}${suffix}`;
}

function boundLiveValue(value: unknown): unknown {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      return null;
    }
    if (Buffer.byteLength(serialized, "utf8") <= MAX_LIVE_PREVIEW_BYTES) {
      return value;
    }
    return { truncated: true, preview: truncateLiveText(serialized) };
  } catch {
    return { truncated: true, preview: "[unserializable live payload]" };
  }
}

function redactLiveText(value: string): string {
  const redacted = redactAgentDiagnosticPayload(value);
  return truncateLiveText(typeof redacted === "string" ? redacted : "[unreadable diagnostic text]");
}

function boundLiveEvent(event: WorkerLiveEvent): WorkerLiveEvent {
  const textExceedsLimit =
    (event.kind === "assistant" || event.kind === "thinking") &&
    event.payload.text.length > MAX_LIVE_EVENT_BYTES;
  if (!textExceedsLimit && jsonUtf8BytesOrInfinity(event) <= MAX_LIVE_EVENT_BYTES) {
    return event;
  }
  let bounded: WorkerLiveEvent;
  if (event.kind === "assistant") {
    const text = truncateLiveText(event.payload.text);
    bounded = {
      kind: "assistant",
      payload: {
        ...event.payload,
        text,
        delta: text,
        replace: true,
      },
    };
  } else if (event.kind === "thinking") {
    bounded = {
      kind: "thinking",
      payload: {
        ...event.payload,
        text: truncateLiveText(event.payload.text),
        delta: truncateLiveText(event.payload.delta),
      },
    };
  } else if (event.kind === "tool") {
    bounded = {
      kind: "tool",
      payload: {
        ...event.payload,
        ...(event.payload.phase === "start"
          ? { args: boundLiveValue(event.payload.args) }
          : event.payload.phase === "update"
            ? { partialResult: boundLiveValue(event.payload.partialResult) }
            : { result: boundLiveValue(event.payload.result) }),
      },
    };
  } else {
    throw new Error(`worker live ${event.kind} event exceeds the protocol payload limit`);
  }
  if (jsonUtf8BytesOrInfinity(bounded) > MAX_LIVE_EVENT_BYTES) {
    throw new Error(`worker live ${event.kind} event cannot fit the protocol payload limit`);
  }
  return bounded;
}

function readAssistantSnapshot(message: AgentMessage): { text: string; phase?: AssistantPhase } {
  if (message.role !== "assistant") {
    return { text: "" };
  }
  // A late commentary signature applies to its block, not unphased siblings.
  const blocks = message.content.flatMap((part) =>
    part.type === "text"
      ? [{ text: part.text, phase: resolveAssistantMessagePhase({ ...message, content: [part] }) }]
      : [],
  );
  const firstPhase = blocks[0]?.phase;
  const phase = blocks.every((block) => block.phase === firstPhase) ? firstPhase : undefined;
  return {
    text: blocks
      .filter((block) => phase === "commentary" || block.phase !== "commentary")
      .map((block) => block.text)
      .join(""),
    phase,
  };
}

function readAssistantThinking(message: AgentMessage): string {
  if (message.role !== "assistant") {
    return "";
  }
  return message.content
    .filter((part) => part.type === "thinking")
    .map((part) => part.thinking)
    .join("");
}

export type WorkerLiveClient = {
  enqueuePreview: (event: WorkerLiveEvent) => boolean;
  emitTerminal: (event: WorkerLiveEvent) => Promise<void>;
};

export function createWorkerLiveRuntime(client: WorkerLiveClient) {
  let previewEnabled = true;
  const enqueueLive = (event: WorkerLiveEvent) => {
    if (previewEnabled) {
      previewEnabled = client.enqueuePreview(boundLiveEvent(event));
    }
  };
  const startedAt = Date.now();
  // Terminal lifecycle events are deferred past the final transcript flush so the
  // gateway never sees an end/error before the authoritative transcript commit.
  let terminalLiveEvent: WorkerLiveEvent | undefined;
  let terminalOutcome: AgentRunAttemptTerminal = { kind: "ok" };
  let replayInvalid = false;
  const enqueueTerminal = (input: { aborted?: boolean; error?: string; stopReason?: string }) => {
    // Cleanup can fail after agent_end. Merge through the attempt owner so it
    // promotes success to failure without replacing an earlier cancellation.
    terminalOutcome = mergeAgentRunAttemptTerminal(
      terminalOutcome,
      normalizeAgentRunAttemptTerminal({ aborted: input.aborted, promptError: input.error }),
    );
    const terminal = projectAgentRunAttemptTerminal(terminalOutcome);
    const stopReason = terminal.aborted ? "aborted" : terminal.failed ? "error" : input.stopReason;
    terminalLiveEvent = {
      kind: "lifecycle",
      payload: {
        phase: "finishing",
        startedAt,
        endedAt: Date.now(),
        ...(stopReason ? { stopReason } : {}),
        ...(terminal.aborted ? { aborted: true } : {}),
        ...(replayInvalid ? { replayInvalid: true } : {}),
        ...(typeof terminal.promptError === "string"
          ? { error: redactLiveText(terminal.promptError) }
          : {}),
      },
    };
  };
  let streamedText = "";
  let streamedPhase: AssistantPhase | undefined;
  let assistantSource: AgentAssistantSourceReceipt | undefined;
  let streamedThinking = "";
  const emitAssistantSnapshot = (message: AgentMessage, complete = false) => {
    const { text: rawText, phase } = readAssistantSnapshot(message);
    // Cancellation can synthesize an empty final after checked text was streamed.
    if (complete && !rawText && message.role === "assistant" && message.stopReason === "aborted") {
      return;
    }
    const protocol = createStreamingDirectiveAccumulator();
    protocol.consume(rawText, { final: complete });
    const text = protocol.sourceText;
    const mediaUrls = complete ? parseReplyDirectives(text).mediaUrls : undefined;
    if (text === streamedText && phase === streamedPhase && !mediaUrls?.length) {
      return;
    }
    // Commentary never contributed to the answer, even if a final repeats its prefix.
    const previousText =
      streamedPhase === "commentary" && phase !== "commentary" ? "" : streamedText;
    const replace = !text.startsWith(previousText);
    enqueueLive({
      kind: "assistant",
      payload: {
        text,
        delta: replace ? text : text.slice(previousText.length),
        ...(mediaUrls?.length ? { mediaUrls } : {}),
        ...(replace ? { replace: true as const } : {}),
        ...(phase ? { phase } : {}),
        itemId: readAgentAssistantSource(message)?.itemId,
      },
    });
    streamedText = text;
    streamedPhase = phase;
  };
  const emitThinkingSnapshot = (message: AgentMessage, delta?: string) => {
    const text = readAssistantThinking(message);
    if (text === streamedThinking) {
      return;
    }
    enqueueLive({
      kind: "thinking",
      payload: { text, delta: delta ?? text, itemId: readAgentAssistantSource(message)?.itemId },
    });
    streamedThinking = text;
  };
  let pendingMessage: AgentMessage | undefined;
  let pendingThinkingDelta: string | undefined;
  let nextPreviewAt = 0;
  const flushPreview = () => {
    const message = pendingMessage;
    const thinkingDelta = pendingThinkingDelta;
    pendingMessage = undefined;
    pendingThinkingDelta = undefined;
    if (!message || !previewEnabled) {
      return;
    }
    nextPreviewAt = Date.now() + LIVE_PREVIEW_INTERVAL_MS;
    if (thinkingDelta !== undefined) {
      emitThinkingSnapshot(message, thinkingDelta);
    } else {
      emitAssistantSnapshot(message);
    }
  };
  const handleSessionEvent = (event: AgentSessionEvent) => {
    const updateType =
      event.type === "message_update" ? event.assistantMessageEvent.type : undefined;
    const isDelta = updateType === "text_delta" || updateType === "thinking_delta";
    if (!isDelta) {
      // Materialize previews at semantic boundaries, before changing occurrence identity.
      flushPreview();
    }
    if (
      (event.type === "message_start" ||
        event.type === "message_update" ||
        event.type === "message_end") &&
      event.message.role === "assistant"
    ) {
      if (event.type === "message_start" || !assistantSource) {
        assistantSource = { itemId: randomUUID() };
      }
      // Persistence still needs occurrence identity after optional previews degrade.
      bindAgentAssistantSource(event.message, assistantSource);
    }
    // Disabled previews no longer need snapshots or diagnostics, but agent_end
    // still owns the terminal result deferred until the transcript is durable.
    if (!previewEnabled && event.type !== "agent_end") {
      return;
    }
    if (event.type === "agent_start") {
      enqueueLive({ kind: "lifecycle", payload: { phase: "start", startedAt } });
      return;
    }
    if (event.type === "message_start" && event.message.role === "assistant") {
      streamedText = "";
      streamedPhase = undefined;
      streamedThinking = "";
      nextPreviewAt = 0;
      return;
    }
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta" || update.type === "thinking_delta") {
        const thinking = update.type === "thinking_delta";
        if (pendingMessage && (pendingThinkingDelta !== undefined) !== thinking) {
          flushPreview();
        }
        // Keep the provider-owned message lazy; copying its cumulative text here
        // makes each small delta pay for the whole answer before wire pacing.
        pendingMessage = event.message;
        if (thinking) {
          pendingThinkingDelta = (pendingThinkingDelta ?? "") + update.delta;
        }
        if (Date.now() >= nextPreviewAt) {
          flushPreview();
        }
      } else if (update.type === "text_end") {
        emitAssistantSnapshot(event.message);
      }
      return;
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      emitAssistantSnapshot(event.message, true);
      emitThinkingSnapshot(event.message);
      return;
    }
    if (
      event.type === "tool_execution_start" ||
      event.type === "tool_execution_update" ||
      event.type === "tool_execution_end"
    ) {
      const tool = { name: event.toolName, toolCallId: event.toolCallId };
      enqueueLive({
        kind: "tool",
        payload: {
          ...(event.type === "tool_execution_start"
            ? { phase: "start" as const, ...tool, args: redactAgentDiagnosticPayload(event.args) }
            : event.type === "tool_execution_update"
              ? {
                  phase: "update" as const,
                  ...tool,
                  partialResult: redactAgentDiagnosticPayload(event.partialResult),
                }
              : {
                  phase: "result" as const,
                  ...tool,
                  isError: event.isError,
                  result: redactAgentDiagnosticPayload(event.result),
                }),
          ...(event.hideFromChannelProgress ? { hideFromChannelProgress: true } : {}),
        },
      });
      return;
    }
    if (event.type === "agent_end") {
      const lastAssistant = event.messages.findLast((message) => message.role === "assistant");
      enqueueTerminal({
        stopReason: lastAssistant?.stopReason,
        aborted: lastAssistant?.stopReason === "aborted",
        ...(lastAssistant?.stopReason === "error"
          ? { error: lastAssistant.errorMessage ?? "Worker inference failed." }
          : {}),
      });
    }
  };
  const enqueueRunFailure = (failure: { aborted: boolean; error: Error }) => {
    flushPreview();
    // Later terminal merges cannot reopen replay after an owned cleanup failure.
    replayInvalid ||= hasModelFallbackStop(failure.error);
    enqueueTerminal({ aborted: failure.aborted, error: formatErrorMessage(failure.error) });
  };
  // Emits directly (not via the degradable preview queue): finishing is the durable
  // result fence that must reach the Gateway before post-worker reconciliation.
  const emitTerminal = async () => {
    if (!terminalLiveEvent) {
      return;
    }
    await client.emitTerminal(boundLiveEvent(terminalLiveEvent));
  };
  return { handleSessionEvent, enqueueRunFailure, emitTerminal };
}
