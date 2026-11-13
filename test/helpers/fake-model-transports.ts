// Fake provider endpoints for every built-in model transport. Each fake parses the provider
// request into the bytes that determine its prompt cache (system, tools, messages) and answers
// with one text reply or one tool call in that transport's streaming format.
import type { ServerResponse } from "node:http";
import { crc32 } from "node:zlib";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../../src/config/types.models.js";

export const FAKE_TRANSPORTS = [
  "anthropic-messages",
  "openai-responses",
  "openai-completions",
  "google-generative-ai",
  "bedrock-converse-stream",
] as const;
export type FakeTransport = (typeof FAKE_TRANSPORTS)[number];
export type FakeReply =
  | { text: string; thinking?: string }
  | { tool: string; args: Record<string, unknown> }
  | { calls: Array<{ tool: string; args: Record<string, unknown> }>; thinking?: string };
/** Canonical JSON of the cache-relevant request parts; `text` joins them for searching. */
export type WireRequest = { system: string; tools: string; messages: string[]; text: string };

const MODEL_IDS: Record<FakeTransport, string> = {
  "anthropic-messages": "claude-opus-5",
  "openai-responses": "gpt-5.4",
  "openai-completions": "gpt-5.4-mini",
  "google-generative-ai": "gemini-3-pro",
  "bedrock-converse-stream": "anthropic.claude-opus-5",
};

// Cache markers move to the newest message on every request, and a newest message may carry its
// text as a block to hold one. Providers cache the processed prompt, where a string and a single
// text block are the same content, so neither difference is a prefix change.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .filter((item) => !(item && typeof item === "object" && "cachePoint" in item))
      .map(canonical);
  }
  if (value && typeof value === "object") {
    const content = (value as { content?: unknown }).content;
    if (typeof content === "string" && "role" in value) {
      return canonical({ ...value, content: [{ type: "text", text: content }] });
    }
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "cache_control")
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

export function readWireRequest(api: FakeTransport, body: Record<string, unknown>): WireRequest {
  const json = (value: unknown) => JSON.stringify(canonical(value));
  let system: unknown;
  let tools: unknown = body.tools ?? [];
  let messages: unknown[];
  if (api === "openai-completions" || api === "openai-responses") {
    const all = ((api === "openai-responses" ? body.input : body.messages) ?? []) as Array<{
      role?: unknown;
    }>;
    // Chat Completions and Responses can carry the system prompt as leading system messages.
    const lead = Math.max(
      0,
      all.findIndex(({ role }) => role !== "system" && role !== "developer"),
    );
    system = [body.instructions ?? null, ...all.slice(0, lead)];
    messages = all.slice(lead);
  } else if (api === "google-generative-ai") {
    system = body.systemInstruction;
    messages = (body.contents ?? []) as unknown[];
  } else if (api === "bedrock-converse-stream") {
    system = body.system;
    tools = (body.toolConfig as { tools?: unknown } | undefined)?.tools ?? [];
    messages = (body.messages ?? []) as unknown[];
  } else {
    system = body.system;
    messages = (body.messages ?? []) as unknown[];
  }
  const systemJson = json(system);
  const messageJson = messages.map(json);
  return {
    system: systemJson,
    tools: json(tools),
    messages: messageJson,
    text: `${systemJson}\n${messageJson.join("\n")}`,
  };
}

/** Messages after the newest model reply: the current input, carriers and tool results. */
export function latestInput(request: WireRequest): string {
  const reply = request.messages.findLastIndex((message) => {
    const item = JSON.parse(message) as { role?: unknown; type?: unknown };
    return item.role === "assistant" || item.role === "model" || item.type === "function_call";
  });
  return request.messages.slice(reply + 1).join("\n");
}

export function hasToolResult(input: string): boolean {
  return /tool_result|"role":"tool"|function_call_output|functionResponse|"toolResult"/.test(input);
}

function sse(response: ServerResponse, chunks: unknown[], done = false) {
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
  response.end(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
      (done ? "data: [DONE]\n\n" : ""),
  );
}

// AWS event-stream framing: prelude (total and header lengths, CRC), string headers, payload, CRC.
function eventStreamMessage(eventType: string, payload: unknown): Buffer {
  const headers = Buffer.concat(
    Object.entries({
      ":event-type": eventType,
      ":content-type": "application/json",
      ":message-type": "event",
    }).map(([name, value]) => {
      const nameBytes = Buffer.from(name);
      const valueBytes = Buffer.from(value);
      const header = Buffer.alloc(1 + nameBytes.length + 3 + valueBytes.length);
      header.writeUInt8(nameBytes.length, 0);
      nameBytes.copy(header, 1);
      header.writeUInt8(7, 1 + nameBytes.length);
      header.writeUInt16BE(valueBytes.length, 2 + nameBytes.length);
      valueBytes.copy(header, 4 + nameBytes.length);
      return header;
    }),
  );
  const body = Buffer.from(JSON.stringify(payload));
  const total = 12 + headers.length + body.length + 4;
  const prelude = Buffer.alloc(12);
  prelude.writeUInt32BE(total, 0);
  prelude.writeUInt32BE(headers.length, 4);
  prelude.writeUInt32BE(crc32(prelude.subarray(0, 8)), 8);
  const message = Buffer.concat([prelude, headers, body, Buffer.alloc(4)]);
  message.writeUInt32BE(crc32(message.subarray(0, total - 4)), total - 4);
  return message;
}

/** Tool calls of a reply; `thinking` is sent as a signed thinking block where the transport has one. */
function replyCalls(reply: FakeReply): Array<{ tool: string; args: Record<string, unknown> }> {
  return "calls" in reply
    ? reply.calls
    : "tool" in reply
      ? [{ tool: reply.tool, args: reply.args }]
      : [];
}

export function writeReply(
  api: FakeTransport,
  response: ServerResponse,
  reply: FakeReply,
  n: number,
) {
  const calls = replyCalls(reply);
  const isText = calls.length === 0;
  const text = "text" in reply ? reply.text : "";
  const thinking = "thinking" in reply ? reply.thinking : undefined;
  if (api === "anthropic-messages") {
    const blocks: Array<{ start: unknown; delta?: unknown }> = [];
    if (thinking) {
      blocks.push(
        { start: { type: "thinking", thinking: "" }, delta: { type: "thinking_delta", thinking } },
        {
          start: { type: "thinking", thinking: "" },
          delta: { type: "signature_delta", signature: `sig_${n}` },
        },
      );
    }
    if (isText) {
      blocks.push({ start: { type: "text", text: "" }, delta: { type: "text_delta", text } });
    }
    calls.forEach((call, index) =>
      blocks.push({
        start: { type: "tool_use", id: `toolu_${n}_${index}`, name: call.tool, input: {} },
        delta: { type: "input_json_delta", partial_json: JSON.stringify(call.args) },
      }),
    );
    // A signed thinking block is one content block with two deltas.
    const merged = thinking
      ? [
          { start: blocks[0]!.start, deltas: [blocks[0]!.delta, blocks[1]!.delta] },
          ...blocks.slice(2).map((b) => ({ start: b.start, deltas: [b.delta] })),
        ]
      : blocks.map((b) => ({ start: b.start, deltas: [b.delta] }));
    const events = [
      {
        type: "message_start",
        message: {
          id: `msg_${n}`,
          type: "message",
          role: "assistant",
          model: MODEL_IDS[api],
          content: [],
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
      ...merged.flatMap((block, index) => [
        { type: "content_block_start", index, content_block: block.start },
        ...block.deltas.map((delta) => ({ type: "content_block_delta", index, delta })),
        { type: "content_block_stop", index },
      ]),
      {
        type: "message_delta",
        delta: { stop_reason: isText ? "end_turn" : "tool_use", stop_sequence: null },
        usage: { output_tokens: 5 },
      },
      { type: "message_stop" },
    ];
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    response.end(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""));
  } else if (api === "openai-completions") {
    const chunk = (delta: unknown, finish: string | null) => ({
      id: `chatcmpl_${n}`,
      object: "chat.completion.chunk",
      created: 0,
      model: MODEL_IDS[api],
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } : {}),
    });
    const delta = isText
      ? { role: "assistant", content: text }
      : {
          role: "assistant",
          tool_calls: calls.map((call, index) => ({
            index,
            id: `call_${n}_${index}`,
            type: "function",
            function: { name: call.tool, arguments: JSON.stringify(call.args) },
          })),
        };
    sse(response, [chunk(delta, null), chunk({}, isText ? "stop" : "tool_calls")], true);
  } else if (api === "openai-responses") {
    const items = isText
      ? [
          {
            type: "message",
            id: `msg_${n}`,
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text, annotations: [] }],
          },
        ]
      : calls.map((call, index) => ({
          type: "function_call",
          id: `fc_${n}_${index}`,
          call_id: `call_${n}_${index}`,
          name: call.tool,
          arguments: JSON.stringify(call.args),
          status: "completed",
        }));
    sse(response, [
      ...items.flatMap((item, index) => [
        { type: "response.output_item.added", output_index: index, item },
        { type: "response.output_item.done", output_index: index, item },
      ]),
      {
        type: "response.completed",
        response: {
          id: `resp_${n}`,
          object: "response",
          status: "completed",
          model: MODEL_IDS[api],
          output: items,
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
      },
    ]);
  } else if (api === "google-generative-ai") {
    sse(response, [
      {
        candidates: [
          {
            index: 0,
            content: {
              role: "model",
              parts: isText
                ? [{ text }]
                : calls.map((call) => ({ functionCall: { name: call.tool, args: call.args } })),
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
      },
    ]);
  } else {
    const blocks = isText
      ? [{ start: {}, delta: { text } }]
      : calls.map((call, index) => ({
          start: { toolUse: { toolUseId: `tooluse_${n}_${index}`, name: call.tool } },
          delta: { toolUse: { input: JSON.stringify(call.args) } },
        }));
    response.writeHead(200, { "content-type": "application/vnd.amazon.eventstream" });
    response.end(
      Buffer.concat([
        eventStreamMessage("messageStart", { role: "assistant" }),
        ...blocks.flatMap((block, index) => [
          eventStreamMessage("contentBlockStart", { contentBlockIndex: index, start: block.start }),
          eventStreamMessage("contentBlockDelta", { contentBlockIndex: index, delta: block.delta }),
          eventStreamMessage("contentBlockStop", { contentBlockIndex: index }),
        ]),
        eventStreamMessage("messageStop", { stopReason: isText ? "end_turn" : "tool_use" }),
        eventStreamMessage("metadata", {
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          metrics: { latencyMs: 1 },
        }),
      ]),
    );
  }
}

export function buildFakeProvider(api: FakeTransport, origin: string) {
  const id = MODEL_IDS[api];
  const providerId = `fake-${api}`;
  const model: ModelDefinitionConfig = {
    id,
    name: `Fake ${id}`,
    api,
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 4096,
  };
  const baseUrl =
    api === "anthropic-messages" || api === "bedrock-converse-stream"
      ? origin
      : api === "google-generative-ai"
        ? `${origin}/v1beta`
        : `${origin}/v1`;
  const config: ModelProviderConfig = {
    baseUrl,
    api,
    ...(api === "bedrock-converse-stream"
      ? { auth: "aws-sdk" as const }
      : { apiKey: "fake-transport-key" }), // pragma: allowlist secret
    // The fake provider listens on loopback.
    request: { allowPrivateNetwork: true },
    models: [model],
  };
  return { providerId, modelRef: `${providerId}/${id}`, config } as const;
}

/** Bundled plugins that own a transport, and the environment its client needs. */
export function fakeTransportRuntime(api: FakeTransport): {
  pluginId?: string;
  env: Record<string, string>;
} {
  if (api === "google-generative-ai") {
    return { pluginId: "google", env: {} };
  }
  if (api === "bedrock-converse-stream") {
    return {
      pluginId: "amazon-bedrock",
      env: {
        AWS_ACCESS_KEY_ID: "fake-access-key", // pragma: allowlist secret
        AWS_SECRET_ACCESS_KEY: "fake-secret-key", // pragma: allowlist secret
        AWS_REGION: "us-east-1",
        AWS_BEDROCK_FORCE_HTTP1: "1",
      },
    };
  }
  return { env: {} };
}
