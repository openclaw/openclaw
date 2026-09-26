import { appendTextDeltaToAssistantMessage } from "../../packages/agent-core/src/agent-stream-response.js";
import { WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES } from "../../packages/gateway-protocol/src/schema/worker-inference.js";
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
  for (const block of content) {
    if (block.type === "toolCall") {
      strings.push(block.id, block.name);
      text += stringParts(block.arguments, true, strings);
      stringParts(block.thoughtSignature, false, strings);
    } else {
      text += block.type === "text" ? block.text : block.thinking;
      const { type: _type, ...fields } = block;
      stringParts(fields, false, strings);
    }
  }
  stringParts(metadata, false, strings);
  return { text, strings };
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
      let currentMessage: AssistantMessage | undefined;
      try {
        const source = await start();
        const toolArgumentDeltas = new Map<number, string>();
        const incompleteToolArguments = new Set<number>();
        const publish = (raw: AssistantMessageEvent) => {
          signal?.throwIfAborted();
          const event = structuredClone(raw);
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
          native.assertProtocolSafe(text);
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
            const delta = (toolArgumentDeltas.get(event.contentIndex) ?? "") + event.delta;
            if (Buffer.byteLength(delta) > WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES) {
              throw new Error("Native tool arguments exceeded the protocol budget");
            }
            toolArgumentDeltas.set(event.contentIndex, delta);
            strings.push(delta);
            try {
              // JSON escape spelling is not credential spelling. Do not publish
              // raw previews until all their strings can be checked decoded.
              stringParts(JSON.parse(delta) as unknown, true, strings);
              incompleteToolArguments.delete(event.contentIndex);
            } catch (error) {
              if (!(error instanceof SyntaxError)) {
                throw error;
              }
              incompleteToolArguments.add(event.contentIndex);
            }
          }
          native.assertProtocolSafe(strings);
          if (
            !terminal &&
            (incompleteToolArguments.size > 0 ||
              native.hasCredentialPrefix(text) ||
              strings.some(native.hasCredentialPrefix))
          ) {
            bytes += Buffer.byteLength(JSON.stringify(event));
            if (bytes > WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES) {
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
          }
          pending = [];
          bytes = 0;
          output.push(event);
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
        const final = structuredClone(await source.result());
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
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          },
        });
      } finally {
        output.end();
      }
    })();
    return output;
  };
}
