import type { ServerResponse } from "node:http";
import { respondJson } from "../../../helpers/gateway-integration-fixtures.js";
import {
  closeNativeProvider,
  createNativeProvider,
  listenNativeProvider,
} from "./native-provider-proof-fixture.js";

export async function startMemoryProofProvider(
  respond: (response: ServerResponse, body: string) => void | Promise<void>,
  embeddingSlot: (text: string) => number = () => 0,
) {
  const server = createNativeProvider(
    async (request, response, body) => {
      if (request.method === "GET" && request.url === "/v1/models") {
        respondJson(response, { data: [{ id: "gpt-5.6-luna", object: "model" }] });
      } else if (request.method === "POST" && request.url === "/v1/embeddings") {
        const inputs = JSON.parse(body) as { input?: string | string[] };
        const texts = Array.isArray(inputs.input) ? inputs.input : [inputs.input ?? ""];
        respondJson(response, {
          object: "list",
          model: "text-embedding-3-small",
          data: texts.map((text, index) => ({
            object: "embedding",
            index,
            embedding: Array.from({ length: 64 }, (_, slot) =>
              slot === embeddingSlot(text) ? 1 : 0,
            ),
          })),
          usage: { prompt_tokens: 1, total_tokens: 1 },
        });
      } else if (request.method === "POST" && request.url === "/v1/responses") {
        await respond(response, body);
      } else {
        response.writeHead(404).end();
      }
    },
    (error, response) => {
      if (!response.headersSent) {
        response.writeHead(500);
      }
      response.end(error instanceof Error ? error.message : String(error));
    },
  );
  return { baseUrl: await listenNativeProvider(server), stop: () => closeNativeProvider(server) };
}
