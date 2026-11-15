import { createServer } from "node:http";
import {
  closeHttpServer,
  listenLoopback,
  readRequestText,
} from "../../../../helpers/gateway-integration-fixtures.js";

/** Synthetic provider output only; the real dispatched worker executes the write. */
export async function publicationProcessProvider() {
  let requests = 0;
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ data: [{ id: "gpt-5.6-luna", object: "model" }] }));
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      requests++;
      const body = JSON.parse(await readRequestText(request));
      const done = body.input.some(
        (item: { type: string; call_id?: string }) =>
          item.type === "function_call_output" && item.call_id === "call_publication_write",
      );
      const item = done
        ? {
            type: "message",
            id: "msg_publication",
            role: "assistant",
            phase: "final_answer",
            status: "completed",
            content: [{ type: "output_text", text: "PUBLICATION-WRITE-COMPLETE", annotations: [] }],
          }
        : {
            type: "function_call",
            id: "fc_publication_write",
            call_id: "call_publication_write",
            name: "write",
            arguments: JSON.stringify({
              path: "restart-proof.txt",
              content: "retained original publication\n",
            }),
          };
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      const emit = (event: unknown) => response.write(`data: ${JSON.stringify(event)}\n\n`);
      emit({
        type: "response.output_item.added",
        output_index: 0,
        item: done ? { ...item, content: [] } : { ...item, arguments: "" },
      });
      emit(
        done
          ? {
              type: "response.output_text.delta",
              item_id: item.id,
              output_index: 0,
              content_index: 0,
              delta: "PUBLICATION-WRITE-COMPLETE",
            }
          : {
              type: "response.function_call_arguments.delta",
              item_id: item.id,
              output_index: 0,
              delta: item.arguments,
            },
      );
      emit({ type: "response.output_item.done", output_index: 0, item });
      emit({
        type: "response.completed",
        response: {
          id: "resp_publication_" + requests,
          status: "completed",
          output: [item],
          usage: { input_tokens: 32, output_tokens: 12, total_tokens: 44 },
        },
      });
      response.end("data: [DONE]\n\n");
    })().catch((error: unknown) => {
      console.error("PUBLICATION_PROVIDER_FIXTURE", String(error));
      response.destroy();
    });
  });
  return {
    baseUrl: await listenLoopback(server),
    get requests() {
      return requests;
    },
    close: () => closeHttpServer(server),
  };
}
