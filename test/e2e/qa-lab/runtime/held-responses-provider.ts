import { createServer, type ServerResponse } from "node:http";
import { writeOpenAiResponsesSse } from "../../../helpers/openai-responses-sse.js";

function writeAssistantResponse(response: ServerResponse, terminalText: string): void {
  const message = {
    type: "message",
    id: "qa-session-dedup-message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: terminalText, annotations: [] }],
  };
  writeOpenAiResponsesSse(response, [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: {
        id: "qa-session-dedup-response",
        status: "completed",
        output: [message],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    },
  ]);
}

/** Hold a real provider response until the caller has observed committed user custody. */
export async function startHeldResponsesProvider(options: {
  modelRef: string;
  terminalText: string;
}) {
  let releaseResponse!: () => void;
  const responseGate = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  const requests: Array<Record<string, unknown>> = [];
  const pending = new Set<Promise<void>>();
  const server = createServer((request, response) => {
    const task = (async () => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            data: [
              { id: options.modelRef.slice(options.modelRef.indexOf("/") + 1), object: "model" },
            ],
          }),
        );
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      await responseGate;
      writeAssistantResponse(response, options.terminalText);
    })().catch((error: unknown) => {
      response.writeHead(500).end(error instanceof Error ? error.message : String(error));
    });
    pending.add(task);
    void task.finally(() => pending.delete(task));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("controlled provider did not bind a loopback port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    release: releaseResponse,
    stop: async () => {
      releaseResponse();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await Promise.all(pending);
    },
  };
}
