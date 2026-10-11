import { appendTextDeltaToAssistantMessage } from "@openclaw/llm-core";
import { WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES } from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import { makeZeroUsageSnapshot } from "../agents/usage.js";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStreamLike,
} from "../llm/types.js";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import type { NativeRuntimeResolved } from "./native-runtime.js";

function stringParts(value: unknown, includeKeys: boolean, strings: string[]): string {
  let text = "";
  if (typeof value === "string") {
    strings.push(value);
    text = value;
  } else if (Array.isArray(value)) {
    for (const item of value) {
      text += stringParts(item, includeKeys, strings);
    }
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (includeKeys) {
        strings.push(key);
        text += key;
      }
      text += stringParts(item, includeKeys, strings);
    }
  }
  return text;
}

function generatedOutput(message: AssistantMessage) {
  // Fixed protocol/request tags are not generated output. Keep independent strings
  // independent: a later safe argument must not conceal an earlier field's prefix.
  const {
    content,
    role: _role,
    api: _api,
    provider: _provider,
    model: _model,
    usage: _usage,
    stopReason: _stopReason,
    timestamp: _timestamp,
    ...metadata
  } = message;
  const strings: string[] = [];
  let text = "";
  let structured = "";
  let all = "";
  for (const block of content) {
    if (block.type === "toolCall") {
      strings.push(block.id, block.name);
      const value =
        block.id +
        block.name +
        stringParts(block.arguments, true, strings) +
        stringParts(block.thoughtSignature, false, strings);
      structured += value;
      all += value;
    } else if (block.type === "text") {
      text += block.text;
      const { type: _type, text: _text, ...fields } = block;
      const value = stringParts(fields, false, strings);
      structured += value;
      all += block.text + value;
    } else {
      text += block.thinking;
      const { type: _type, thinking: _thinking, ...fields } = block;
      const value = stringParts(fields, false, strings);
      structured += value;
      all += block.thinking + value;
    }
  }
  const metadataText = stringParts(metadata, false, strings);
  structured += metadataText;
  all += metadataText;
  return { all, strings, structured, text };
}

/** Guard provider output before the shared loop can publish it or execute generated tools. */
export function createNativeInferenceStreamGuard(native: NativeRuntimeResolved) {
  let completedText = "";
  return (
    start: () => AssistantMessageEventStreamLike | Promise<AssistantMessageEventStreamLike>,
    signal?: AbortSignal,
  ): AssistantMessageEventStreamLike => {
    const output = createAssistantMessageEventStream();
    void (async () => {
      let pending: AssistantMessageEvent[] = [];
      let bytes = 0;
      let toolArgumentBytes = 0;
      let currentMessage: AssistantMessage | undefined;
      try {
        const source = await start();
        const toolArgumentDeltas = new Map<number, string>();
        const incompleteToolArguments = new Set<number>();
        const clearToolArguments = (contentIndex: number) => {
          const delta = toolArgumentDeltas.get(contentIndex);
          if (delta !== undefined) {
            toolArgumentBytes -= Buffer.byteLength(delta);
            toolArgumentDeltas.delete(contentIndex);
          }
          incompleteToolArguments.delete(contentIndex);
        };
        const removePendingToolDelta = (contentIndex: number) => {
          const priorIndex = pending.findIndex(
            (held) => held.type === "toolcall_delta" && held.contentIndex === contentIndex,
          );
          if (priorIndex >= 0) {
            const prior = pending[priorIndex];
            if (prior) {
              bytes -= Buffer.byteLength(JSON.stringify(prior));
              pending.splice(priorIndex, 1);
            }
          }
        };
        const publish = (raw: AssistantMessageEvent) => {
          signal?.throwIfAborted();
          let event = structuredClone(raw);
          const terminal = event.type === "done" || event.type === "error";
          const snapshot =
            event.type === "done"
              ? event.message
              : event.type === "error"
                ? event.error
                : event.partial;
          currentMessage =
            snapshot ??
            (event.type === "text_delta" && currentMessage
              ? appendTextDeltaToAssistantMessage(currentMessage, event.contentIndex, event.delta)
              : undefined);
          if (!currentMessage) {
            throw new Error("Native stream delta has no message owner");
          }
          native.assertProtocolSafe(event);
          const generated = generatedOutput(currentMessage);
          const text = completedText + generated.text;
          const generatedSequences = [text, generated.structured, generated.all];
          native.assertProtocolSafe(generatedSequences);
          const strings = generated.strings;
          if ("delta" in event) {
            strings.push(event.delta);
          }
          if ("content" in event) {
            strings.push(event.content);
          }
          if (event.type === "toolcall_end") {
            strings.push(
              ...generatedOutput({ ...currentMessage, content: [event.toolCall] }).strings,
            );
          }
          if (event.type === "toolcall_delta") {
            // Parsed argument snapshots can lag an incomplete JSON key/value.
            const priorDelta = toolArgumentDeltas.get(event.contentIndex) ?? "";
            const delta = priorDelta + event.delta;
            if (Buffer.byteLength(delta) > WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES) {
              throw new Error("Native tool arguments exceeded the protocol budget");
            }
            toolArgumentBytes += Buffer.byteLength(delta) - Buffer.byteLength(priorDelta);
            if (toolArgumentBytes > WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES) {
              throw new Error("Native tool arguments exceeded the aggregate protocol budget");
            }
            toolArgumentDeltas.set(event.contentIndex, delta);
            strings.push(delta);
            try {
              // JSON escape spelling is not credential spelling. Do not publish
              // raw previews until all their strings can be checked decoded.
              strings.push(stringParts(JSON.parse(delta) as unknown, true, strings));
              incompleteToolArguments.delete(event.contentIndex);
            } catch (error) {
              if (!(error instanceof SyntaxError)) {
                throw error;
              }
              incompleteToolArguments.add(event.contentIndex);
            }
            event = { ...event, delta };
            removePendingToolDelta(event.contentIndex);
          } else if (event.type === "toolcall_end") {
            removePendingToolDelta(event.contentIndex);
            clearToolArguments(event.contentIndex);
          }
          native.assertProtocolSafe(strings);
          const hasCredentialPrefix =
            generatedSequences.some(native.hasCredentialPrefix) ||
            strings.some(native.hasCredentialPrefix);
          if (terminal && hasCredentialPrefix) {
            throw new Error("Native stream ended with an unresolved credential prefix");
          }
          if (!terminal && (incompleteToolArguments.size > 0 || hasCredentialPrefix)) {
            bytes += Buffer.byteLength(JSON.stringify(event));
            if (bytes + toolArgumentBytes > WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES) {
              throw new Error("Native credential-prefix buffer exceeded");
            }
            pending.push(event);
            return;
          }
          if (terminal && incompleteToolArguments.size > 0) {
            // An interrupted/malformed preview is not certified by a later
            // snapshot. Preserve the checked authoritative result, not raw fragments.
            pending = [];
          }
          if (event.type === "error" && pending.length) {
            throw new Error("Native stream failed with an unresolved credential prefix");
          }
          for (const held of pending) {
            output.push(held);
            if (held.type === "toolcall_delta") {
              clearToolArguments(held.contentIndex);
            }
          }
          pending = [];
          bytes = 0;
          output.push(event);
          if (event.type === "toolcall_delta") {
            clearToolArguments(event.contentIndex);
          }
          if (event.type === "done") {
            completedText = text;
          }
        };
        let terminalSeen = false;
        for await (const event of source) {
          signal?.throwIfAborted();
          if (terminalSeen) {
            throw new Error("Native stream continued after its terminal event");
          }
          if (event.type === "done" || event.type === "error") {
            native.assertProtocolSafe(event);
            terminalSeen = true;
          } else {
            publish(event);
          }
        }
        // result() is authoritative, including end(result) without a terminal event.
        // Guard it before allowing the output stream to settle or release held events.
        const final = await source.result();
        publish(
          final.stopReason === "error" || final.stopReason === "aborted"
            ? { type: "error", reason: final.stopReason, error: final }
            : { type: "done", reason: final.stopReason, message: final },
        );
      } catch {
        // Provider exceptions can contain headers/keys. Keep failures fixed and credential-free.
        const aborted = signal?.aborted === true;
        output.push({
          type: "error",
          reason: aborted ? "aborted" : "error",
          error: {
            role: "assistant",
            content: [],
            provider: native.model.provider,
            model: native.model.id,
            api: native.model.api,
            timestamp: Date.now(),
            stopReason: aborted ? "aborted" : "error",
            errorMessage: aborted
              ? "Runtime-local inference cancelled"
              : "Runtime-local inference failed its output boundary",
            usage: makeZeroUsageSnapshot(),
          },
        });
      } finally {
        output.end();
      }
    })();
    return output;
  };
}
