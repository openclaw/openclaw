import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { ToolProfileId } from "../../src/config/types.tools.js";

export type OpenAiResponsesModelServer = {
  baseUrl: string;
  close: () => Promise<void>;
};

export function createOpenAiResponsesModelConfig(params: {
  baseUrl: string;
  providerId: string;
  modelId: string;
  reasoning: boolean;
  toolProfile: ToolProfileId;
}): OpenClawConfig {
  const modelRef = `${params.providerId}/${params.modelId}`;
  return {
    plugins: { slots: { memory: "none" } },
    agents: {
      defaults: {
        model: { primary: modelRef },
        models: { [modelRef]: { agentRuntime: { id: "openclaw" } } },
        skipBootstrap: true,
        skills: [],
      },
    },
    tools: { profile: params.toolProfile },
    models: {
      mode: "replace",
      providers: {
        [params.providerId]: {
          baseUrl: `${params.baseUrl}/v1`,
          apiKey: "test-token-placeholder",
          api: "openai-responses",
          request: { allowPrivateNetwork: true },
          models: [
            {
              id: params.modelId,
              name: params.modelId,
              api: "openai-responses",
              reasoning: params.reasoning,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128_000,
              maxTokens: 4_096,
            },
          ],
        },
      },
    },
  };
}

export async function startOpenAiResponsesModelServer(params: {
  modelId: string;
  bindError: string;
  onRequest: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
}): Promise<OpenAiResponsesModelServer> {
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: params.modelId, object: "model" }] }));
        return;
      }
      if (request.method !== "POST" || url.pathname !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      await params.onRequest(request, response);
    })().catch((error: unknown) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: String(error) } }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error(params.bindError);
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
