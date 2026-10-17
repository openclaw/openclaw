import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, expect, it } from "vitest";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";

type CapturedChatRequest = {
  path: string;
  model?: string;
  messages?: Array<{ role?: string; content?: unknown }>;
  stream?: boolean;
};

const HF_LOCAL_APP_CASES = [
  ["GGUF llama.cpp", "llama-cpp", "ggml-org/gemma-4-E4B-it-GGUF:Q4_K_M"],
  ["MLX LM", "mlx-lm", "mlx-community/Qwen3-0.6B-4bit"],
] as const;

const instances: OpenClawTestInstance[] = [];
const fakeServers: Awaited<ReturnType<typeof startFakeOpenAiServer>>[] = [];

afterEach(async () => {
  await Promise.allSettled(instances.splice(0).map((instance) => instance.cleanup()));
  await Promise.allSettled(fakeServers.splice(0).map((server) => server.close()));
});

it.each(HF_LOCAL_APP_CASES)(
  "Hugging Face OpenClaw local-app CLI contract: onboard and agent for %s",
  async (_name, providerId, modelId) => {
    const fakeServer = await startFakeOpenAiServer({ modelId });
    fakeServers.push(fakeServer);
    const instance = await createOpenClawTestInstance({
      name: `hf-local-app-${providerId}`,
      env: {
        CUSTOM_API_KEY: undefined,
        OPENCLAW_TEST_FAST: "1",
      },
    });
    instances.push(instance);

    const onboard = await instance.cli(
      [
        "onboard",
        "--non-interactive",
        ...Object.entries({
          mode: "local",
          "auth-choice": "custom-api-key",
          "custom-base-url": fakeServer.baseUrl,
          "custom-model-id": modelId,
          "custom-provider-id": providerId,
          "custom-compatibility": "openai",
        }).flatMap(([flag, value]) => [`--${flag}`, value]),
        "--custom-text-input",
        "--accept-risk",
        "--skip-health",
      ],
      { timeoutMs: 120_000 },
    );

    expect(onboard.code, onboard.stderr).toBe(0);
    expect(onboard.stdout).toContain("Updated config");
    const config: OpenClawConfig = JSON.parse(await fs.readFile(instance.configPath, "utf8"));
    expect(config).toMatchObject({
      models: {
        providers: {
          [providerId]: {
            api: "openai-completions",
            baseUrl: fakeServer.baseUrl,
            models: expect.arrayContaining([expect.objectContaining({ id: modelId })]),
          },
        },
      },
      agents: { defaults: { model: { primary: `${providerId}/${modelId}` } } },
    });

    const agent = await instance.cli(
      ["agent", "--local", "--agent", "main", "--message", "Hello from Hugging Face"],
      { timeoutMs: 120_000 },
    );

    expect(agent.code, agent.stderr).toBe(0);
    expect(agent.stdout).toContain(`hf local app ok: ${providerId}`);
    expect(fakeServer.requests).toMatchObject([
      {
        path: "/v1/chat/completions",
        model: modelId,
        stream: true,
      },
    ]);
    expect(fakeServer.requests[0]?.messages?.some(messageContainsHello)).toBe(true);
  },
  180_000,
);

function messageContainsHello(message: { content?: unknown }): boolean {
  const containsHello = (text: string) => text.includes("Hello from Hugging Face");
  const content = message.content;
  if (typeof content === "string") {
    return containsHello(content);
  }
  return (
    Array.isArray(content) &&
    content.some((part) =>
      typeof part === "string"
        ? containsHello(part)
        : part && typeof part === "object" && "text" in part && containsHello(String(part.text)),
    )
  );
}

async function startFakeOpenAiServer(params: { modelId: string }) {
  const requests: CapturedChatRequest[] = [];
  const server = createServer((req, res) => {
    void handleFakeOpenAiRequest(req, res, params.modelId, requests);
  });
  const close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await close();
    throw new Error("fake OpenAI server did not bind a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close,
  };
}

async function handleFakeOpenAiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  modelId: string,
  requests: CapturedChatRequest[],
): Promise<void> {
  if (req.method === "GET" && req.url === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: modelId, object: "model" }] }));
    return;
  }

  if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `unexpected ${req.method} ${req.url}` } }));
    return;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const payload: Omit<CapturedChatRequest, "path"> = JSON.parse(
    Buffer.concat(chunks).toString("utf8"),
  );
  requests.push({
    path: req.url,
    messages: payload.messages,
    model: payload.model,
    stream: payload.stream,
  });

  res.writeHead(200, {
    "cache-control": "no-cache",
    connection: "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
  });
  const providerId = modelId.startsWith("mlx-community/") ? "mlx-lm" : "llama-cpp";
  const chunk = {
    id: "chatcmpl-hf-openclaw-contract",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: modelId,
  };
  const send = (delta: object, finish_reason: null | "stop", usage?: object) =>
    res.write(
      `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta, finish_reason }], usage })}\n\n`,
    );
  send({ role: "assistant", content: `hf local app ok: ${providerId}` }, null);
  send({}, "stop", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
  res.end("data: [DONE]\n\n");
}
