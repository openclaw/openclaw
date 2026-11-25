const events = [
  {
    type: "response.output_item.added",
    item: {
      type: "message",
      id: "msg_test_1",
      role: "assistant",
      content: [],
      status: "in_progress",
    },
  },
  {
    type: "response.output_item.done",
    item: {
      type: "message",
      id: "msg_test_1",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "ok", annotations: [] }],
    },
  },
  {
    type: "response.completed",
    response: {
      status: "completed",
      usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
    },
  },
];
const sse = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;

// The sole consumer proves Gateway admission/abort, not model-driven tool execution.
export function installOpenAiResponsesMock(params?: { baseUrl?: string }) {
  const originalFetch = globalThis.fetch;
  const baseUrl = params?.baseUrl ?? "https://api.openai.com/v1";
  const responsesUrl = `${baseUrl}/responses`;
  globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (
      url === responsesUrl ||
      url.startsWith(`${responsesUrl}/`) ||
      url.startsWith(`${responsesUrl}?`)
    ) {
      const body = init?.body;
      const text =
        typeof body === "string"
          ? body
          : body instanceof Uint8Array
            ? Buffer.from(body).toString("utf8")
            : body instanceof ArrayBuffer
              ? Buffer.from(new Uint8Array(body)).toString("utf8")
              : body === undefined && input instanceof Request
                ? await input.clone().text()
                : "";
      if (text) {
        JSON.parse(text);
      }
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (url.startsWith(baseUrl)) {
      throw new Error(`unexpected OpenAI request in mock test: ${url}`);
    }
    if (!originalFetch) {
      throw new Error(`fetch is not available (url=${url})`);
    }
    return originalFetch(input, init);
  };
  return {
    baseUrl,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}
