import { createServer } from "node:http";
import path from "node:path";
import { Type } from "typebox";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../../packages/ai/src/host.js";
import { streamOpenAICompletions } from "../../packages/ai/src/providers/openai-completions.js";
import { createOpenAICompletionsTransportStreamFn } from "../../packages/ai/src/transports/openai-completions-transport.js";
import type { Context, Model } from "../../packages/llm-core/src/index.js";
import { resolveOpenAIStrictToolSetting } from "../../src/agents/openai-strict-tool-setting.js";
import { resolveProviderRequestCapabilities } from "../../src/agents/provider-attribution.js";
import { normalizeModelCompat } from "../../src/plugins/provider-model-compat.js";

const publicUrl = "https://openrouter.ai/api/v1";
const routes = [
  { name: "OpenAI", id: "openai/gpt-5.4-mini", provider: "openrouter", baseUrl: publicUrl },
  {
    name: "Anthropic",
    id: "anthropic/claude-sonnet-4.6",
    provider: "openrouter",
    baseUrl: publicUrl,
  },
  {
    name: "Gemini",
    id: "google/gemini-3-flash-preview",
    provider: "openrouter",
    baseUrl: publicUrl,
  },
  { name: "automatic", id: "openrouter/auto", provider: "openrouter", baseUrl: publicUrl },
  {
    name: "custom provider at public endpoint",
    id: "openai/gpt-5.4-mini",
    provider: "custom",
    baseUrl: publicUrl,
  },
  {
    name: "custom proxy",
    id: "openai/gpt-5.4-mini",
    provider: "openrouter",
    baseUrl: "https://proxy.example.test/v1",
    omitStrict: true,
  },
  {
    name: "explicit opt-out",
    id: "openai/gpt-5.4-mini",
    provider: "openrouter",
    baseUrl: publicUrl,
    omitStrict: true,
    compat: { supportsStrictMode: false },
  },
  {
    name: "native OpenAI",
    id: "gpt-5.4-mini",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    native: true,
  },
] as const;
const context: Context = {
  messages: [{ role: "user", content: "List the open tabs.", timestamp: 0 }],
  tools: [
    {
      name: "browser",
      description: "Manage browser tabs.",
      parameters: Type.Object({ action: Type.String(), targetId: Type.Optional(Type.String()) }),
    },
  ],
};

type RequestBody = {
  model: string;
  tools: Array<{
    function: { strict?: boolean; parameters: { required: string[]; properties: unknown } };
  }>;
};

describe("OpenRouter tool schemas over SDK HTTP", () => {
  const originalHost = getAiTransportHost();
  const requests: RequestBody[] = [];
  const urls: string[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push(JSON.parse(body));
      // A fixed valid stream acknowledges every request without modelling tool arguments.
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({
          id: "chatcmpl-schema",
          object: "chat.completion.chunk",
          created: 1,
          model: "synthetic",
          choices: [
            { index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: "stop" },
          ],
        })}\n\ndata: [DONE]\n\n`,
      );
    });
  });
  beforeAll(async () => {
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.join(process.cwd(), "extensions"));
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Missing loopback server address");
    }
    configureAiTransportHost({
      ...originalHost,
      resolveProviderRequestCapabilities,
      resolveOpenAIStrictToolSetting,
      // Preserve classification and SDK serialization; redirect only network I/O.
      buildModelFetch: () => async (input, init) => {
        const request = new Request(input, init);
        urls.push(request.url);
        const body = await request.arrayBuffer();
        return fetch(`http://127.0.0.1:${address.port}/chat/completions`, {
          method: request.method,
          headers: request.headers,
          body,
          signal: request.signal,
        });
      },
    });
  });
  afterAll(async () => {
    configureAiTransportHost(originalHost);
    vi.unstubAllEnvs();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it.each(
    (["managed", "direct"] as const).flatMap((mode) => routes.map((route) => ({ mode, route }))),
  )("preserves tool schema policy on $mode $route.name routes", async ({ mode, route }) => {
    const input: Model<"openai-completions"> = {
      id: route.id,
      name: route.name,
      api: "openai-completions",
      provider: route.provider,
      baseUrl: route.baseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 1024,
      ...("compat" in route ? { compat: route.compat } : {}),
    };
    const normalized = normalizeModelCompat(input);
    expect(normalized.api).toBe(input.api);
    const model = { ...normalized, api: input.api };
    // Native strict mode requires a fully required, closed schema. The optional
    // browser schema legitimately triggers the existing strict-mode downgrade.
    const activeContext: Context =
      "native" in route
        ? {
            ...context,
            tools: [
              {
                ...context.tools![0]!,
                parameters: Type.Object(
                  {
                    action: Type.String(),
                    targetId: Type.String(),
                  },
                  { additionalProperties: false },
                ),
              },
            ],
          }
        : context;
    const stream = await (mode === "managed"
      ? createOpenAICompletionsTransportStreamFn()(model, activeContext, {
          apiKey: "synthetic-key",
        })
      : streamOpenAICompletions(model, activeContext, { apiKey: "synthetic-key" }));
    const output = await stream.result();
    expect(output.stopReason, route.name).toBe("stop");
    expect(urls.at(-1), route.name).toBe(`${route.baseUrl}/chat/completions`);
    const request = requests.at(-1)!;
    expect(request.model, route.name).toBe(route.id);
    const tool = request.tools[0]!.function;
    const nativeStrict = "native" in route && mode === "managed";
    if ("omitStrict" in route) {
      expect(Object.hasOwn(tool, "strict"), route.name).toBe(false);
    } else {
      expect(tool.strict, route.name).toBe(nativeStrict);
    }
    expect(tool.parameters.required, route.name).toEqual(
      "native" in route ? ["action", "targetId"] : ["action"],
    );
    expect(tool.parameters.properties, route.name).toHaveProperty("targetId");
  });
});
