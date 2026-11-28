import { createServer } from "node:http";
import { streamSimpleOpenAICompletions } from "@openclaw/ai/internal/openai";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { makeProviderModelFixture } from "./provider-model-fixture.js";

type Phase = "minute-window" | "recovered" | "billing";

/** A local OpenAI-compatible endpoint; the production SDK parses every response. */
export async function createSenseNovaFaultTransport() {
  const requests: Array<{ model: string; status: number }> = [];
  const transportErrors: Array<{ errorCode?: string; errorType?: string; errorBody?: string }> = [];
  const transport = { phase: "minute-window" as Phase, requests, transportErrors };
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      const model = String((JSON.parse(body) as { model?: unknown }).model);
      const status =
        transport.phase === "billing"
          ? 402
          : transport.phase === "minute-window" && model === "deepseek-v4-flash"
            ? 429
            : 200;
      requests.push({ model, status });
      if (status !== 200) {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error:
              status === 429
                ? {
                    code: "insufficient_quota",
                    type: "rate_limit_error",
                    message: "inference exceeds tpm/rpm limit",
                  }
                : {
                    code: "billing_hard_limit_reached",
                    type: "billing_error",
                    message: "account has no credits",
                  },
          }),
        );
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const reply =
        transport.phase === "minute-window" ? "fallback recovered" : "next turn recovered";
      response.end(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: reply }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing loopback server address");
  }
  return {
    ...transport,
    setPhase: (phase: Phase) => {
      transport.phase = phase;
    },
    getPhase: () => transport.phase,
    call: async (provider: string, modelId: string): Promise<AssistantMessage> => {
      const model = makeProviderModelFixture<"openai-completions">({
        id: modelId,
        provider,
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
      });
      const stream = streamSimpleOpenAICompletions(
        model,
        {
          messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
        },
        { apiKey: "synthetic-test-key" },
      );
      for await (const event of stream) {
        void event;
      }
      const assistant = await stream.result();
      if (assistant.stopReason === "error") {
        transportErrors.push({
          errorCode: assistant.errorCode,
          errorType: assistant.errorType,
          errorBody: assistant.errorBody,
        });
      }
      return assistant;
    },
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    },
  };
}
