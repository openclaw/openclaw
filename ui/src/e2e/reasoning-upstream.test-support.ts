import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { writeOpenAiResponsesSse } from "../../../test/helpers/openai-responses-sse.js";

// A provider that thinks before it answers, modeled on measured Ollama Cloud reasoning
// models: it spends `reasoningTokens` output tokens on reasoning, then says "OK". An
// output cap at or below that budget ends the reply with no visible text, as real
// reasoning models do. Serves OpenAI chat completions, OpenAI Responses and Anthropic
// Messages so one fixture covers each API family's connection check.
export type ReasoningUpstream = {
  requests: { route: string; maxTokens: number | undefined }[];
  server: ReturnType<typeof createServer>;
};

const CAP_FIELDS = ["max_tokens", "max_completion_tokens", "max_output_tokens"] as const;

function readCap(body: Record<string, unknown>): number | undefined {
  for (const field of CAP_FIELDS) {
    if (typeof body[field] === "number") {
      return body[field];
    }
  }
  return undefined;
}

function sse(response: ServerResponse, frames: string[]) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(frames.join(""));
}

function completions(response: ServerResponse, model: unknown, reasoning: number, answer: boolean) {
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
    `data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  sse(response, [
    chunk({ role: "assistant", reasoning_content: "" }),
    ...Array.from({ length: reasoning }, () => chunk({ reasoning_content: "hmm " })),
    ...(answer ? [chunk({ content: "OK" })] : []),
    chunk({}, answer ? "stop" : "length"),
    "data: [DONE]\n\n",
  ]);
}

function messages(response: ServerResponse, model: unknown, reasoning: number, answer: boolean) {
  const event = (type: string, data: Record<string, unknown>) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  sse(response, [
    event("message_start", {
      message: { id: "msg_fixture", type: "message", role: "assistant", model, content: [] },
    }),
    event("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }),
    ...Array.from({ length: reasoning }, () =>
      event("content_block_delta", {
        index: 0,
        delta: { type: "thinking_delta", thinking: "hmm " },
      }),
    ),
    event("content_block_stop", { index: 0 }),
    ...(answer
      ? [
          event("content_block_start", { index: 1, content_block: { type: "text", text: "" } }),
          event("content_block_delta", { index: 1, delta: { type: "text_delta", text: "OK" } }),
          event("content_block_stop", { index: 1 }),
        ]
      : []),
    event("message_delta", {
      delta: { stop_reason: answer ? "end_turn" : "max_tokens" },
      usage: { output_tokens: reasoning + (answer ? 1 : 0) },
    }),
    event("message_stop", {}),
  ]);
}

function responses(response: ServerResponse, reasoning: number, answer: boolean) {
  const message = {
    type: "message",
    id: "msg_fixture",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "OK", annotations: [] }],
  };
  const usage = { input_tokens: 10, output_tokens: reasoning + (answer ? 1 : 0), total_tokens: 0 };
  writeOpenAiResponsesSse(
    response,
    answer
      ? [
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { ...message, content: [] },
          },
          {
            type: "response.output_text.delta",
            item_id: message.id,
            output_index: 0,
            content_index: 0,
            delta: "OK",
          },
          { type: "response.output_item.done", output_index: 0, item: message },
          {
            type: "response.completed",
            response: { id: "resp_fixture", status: "completed", output: [message], usage },
          },
        ]
      : [
          {
            type: "response.incomplete",
            response: {
              id: "resp_fixture",
              status: "incomplete",
              incomplete_details: { reason: "max_output_tokens" },
              output: [],
              usage,
            },
          },
        ],
  );
}

/** Answers one model request as a provider that reasons for `reasoningTokens` before "OK". */
export function respondAsReasoningModel(
  route: string,
  body: Record<string, unknown>,
  response: ServerResponse,
  reasoningTokens: number,
): boolean {
  const cap = readCap(body);
  const answer = cap === undefined || cap > reasoningTokens;
  const reasoning = cap === undefined ? reasoningTokens : Math.min(cap, reasoningTokens);
  if (route.endsWith("/chat/completions")) {
    completions(response, body.model, reasoning, answer);
  } else if (route.endsWith("/messages")) {
    messages(response, body.model, reasoning, answer);
  } else if (route.endsWith("/responses")) {
    responses(response, reasoning, answer);
  } else {
    return false;
  }
  return true;
}

export function createReasoningUpstream(reasoningTokens: number): ReasoningUpstream {
  const requests: ReasoningUpstream["requests"] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const route = new URL(request.url ?? "/", "http://fixture").pathname;
      const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
      requests.push({ route, maxTokens: readCap(body) });
      // A provider that rejects one request header proves checks send chat's rewrites.
      if (request.headers["x-fixture-break"]) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: { message: "Unsupported header", type: "invalid_request_error" },
          }),
        );
        return;
      }
      if (!respondAsReasoningModel(route, body, response, reasoningTokens)) {
        response.writeHead(404).end();
      }
    });
  });
  return { requests, server };
}
