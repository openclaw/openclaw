// Test-only observers. Never retain content in the returned diagnostic record.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { collectTextContentBlocks } from "./content-blocks.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent-runner/types.js";

export function nonceTextMetrics(text: string, nonce: string | undefined) {
  return {
    bytes: Buffer.byteLength(text),
    nonceCount: nonce ? text.split(nonce).length - 1 : null,
  };
}

export function nonceStopCategory(value: unknown) {
  return typeof value === "string" &&
    [
      "completed",
      "stop",
      "end_turn",
      "toolUse",
      "tool_calls",
      "length",
      "error",
      "aborted",
      "timeout",
      "incomplete",
      "failed",
    ].includes(value)
    ? value
    : value === undefined
      ? "absent"
      : "other";
}

export function summarizeNonceRequest(
  request: ResponseCreateParamsStreaming,
  nonce: string | undefined,
) {
  const results = Array.isArray(request.input)
    ? request.input.filter((item) => item.type === "function_call_output")
    : [];
  return {
    toolResultCount: results.length,
    // Only actual tool output, not prompts, arguments, or unrelated metadata.
    toolResults: results.map((item) => nonceTextMetrics(JSON.stringify(item.output), nonce)),
  };
}

type NonceMetrics = ReturnType<typeof nonceTextMetrics>;

interface NonceResponseDiagnostic {
  httpStatus: number;
  terminal: string;
  streamEnded: boolean;
  observationIncomplete: boolean;
  malformedFrames: number;
  itemSnapshots: NonceMetrics[];
  terminalSnapshot: NonceMetrics[] | null;
}

function summarizeMessageSnapshot(item: unknown, nonce: string | undefined): NonceMetrics[] {
  if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) {
    return [];
  }
  const text = item.content
    .filter(isRecord)
    .map((part) => (part.type === "output_text" || part.type === "text" ? part.text : part.refusal))
    .filter((part): part is string => typeof part === "string")
    .join("");
  return [nonceTextMetrics(text, nonce)];
}

export type NonceDispatch = {
  request: ReturnType<typeof summarizeNonceRequest>;
  response?: ReturnType<typeof observeNonceResponse>["diagnostic"];
};

/** Reserve the pair before dispatch; a rejected fetch leaves its own response absent. */
export async function observeNonceDispatch(
  dispatches: NonceDispatch[],
  request: ResponseCreateParamsStreaming,
  getNonce: () => string | undefined,
  fetchResponse: () => Promise<Response>,
): Promise<Response> {
  const dispatch: NonceDispatch = { request: summarizeNonceRequest(request, getNonce()) };
  dispatches.push(dispatch);
  const observed = observeNonceResponse(await fetchResponse(), getNonce);
  dispatch.response = observed.diagnostic;
  return observed.response;
}

/** Observe the bytes consumed by the real transport, without a second reader or request. */
export function observeNonceResponse(response: Response, getNonce: () => string | undefined) {
  const diagnostic: NonceResponseDiagnostic = {
    httpStatus: response.status,
    terminal: "unobserved",
    streamEnded: false,
    observationIncomplete: false,
    malformedFrames: 0,
    itemSnapshots: [],
    terminalSnapshot: null,
  };
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
    diagnostic.observationIncomplete = true;
    return { response, diagnostic };
  }
  const decoder = new TextDecoder();
  let pending = "";
  let disabled = false;
  const consume = (frame: string) => {
    const data = frame
      .split(/\r\n|\n|\r/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") {
      return;
    }
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      diagnostic.malformedFrames++;
      diagnostic.observationIncomplete = true;
      return;
    }
    if (!isRecord(event)) {
      diagnostic.malformedFrames++;
      diagnostic.observationIncomplete = true;
      return;
    }
    // Item-done and terminal output are separate snapshots, never summed with deltas.
    if (event.type === "response.output_item.done") {
      diagnostic.itemSnapshots.push(...summarizeMessageSnapshot(event.item, getNonce()));
    } else if (
      event.type === "response.completed" ||
      event.type === "response.failed" ||
      event.type === "response.incomplete"
    ) {
      diagnostic.terminal = event.type.slice("response.".length);
      if (isRecord(event.response) && Array.isArray(event.response.output)) {
        diagnostic.terminalSnapshot = event.response.output.flatMap((item) =>
          summarizeMessageSnapshot(item, getNonce()),
        );
      } else {
        diagnostic.observationIncomplete = true;
      }
    } else if (event.type === "error") {
      diagnostic.terminal = "error";
    }
  };
  const feed = (text: string, end = false) => {
    if (disabled) {
      return;
    }
    pending += text;
    if (pending.length > 1_048_576) {
      disabled = true;
      pending = "";
      diagnostic.observationIncomplete = true;
      return;
    }
    const frames = pending.split(/\r\n\r\n|\n\n|\r\r/);
    pending = frames.pop() ?? "";
    for (const frame of frames) {
      consume(frame);
    }
    if (end && pending) {
      consume(pending);
      pending = "";
    }
  };
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        // Observation must not convert a parser failure into a provider failure.
        try {
          feed(decoder.decode(chunk, { stream: true }));
        } catch {
          disabled = true;
          pending = "";
          diagnostic.observationIncomplete = true;
        }
        controller.enqueue(chunk);
      },
      flush() {
        try {
          feed(decoder.decode(), true);
        } catch {
          diagnostic.observationIncomplete = true;
        }
        diagnostic.streamEnded = true;
      },
    }),
  );
  return {
    response: new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
    diagnostic,
  };
}

export function summarizeNonceRun(
  messages: Array<{ role: string; content: unknown; stopReason?: unknown }>,
  result: EmbeddedAgentRunResult | undefined,
  nonce: string | undefined,
) {
  return {
    transcript: messages.flatMap((message) =>
      message.role === "toolResult" || message.role === "assistant"
        ? [
            {
              role: message.role,
              ...nonceTextMetrics(collectTextContentBlocks(message.content).join("\n"), nonce),
              stop: nonceStopCategory(message.stopReason),
            },
          ]
        : [],
    ),
    selectedAssistant: {
      present: result?.meta.finalAssistantVisibleText !== undefined,
      ...nonceTextMetrics(result?.meta.finalAssistantVisibleText ?? "", nonce),
    },
    payloads:
      result?.payloads?.map((payload) => ({
        ...nonceTextMetrics(payload.text ?? "", nonce),
        isError: payload.isError === true,
      })) ?? [],
    run: {
      returned: result !== undefined,
      aborted: result?.meta.aborted === true,
      hasError: result?.meta.error !== undefined,
      stop: nonceStopCategory(result?.meta.stopReason),
      timeout: result?.meta.timeoutPhase !== undefined,
    },
  };
}
