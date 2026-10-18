// QA Lab product proof for the Gateway's public HTTP API boundaries.
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createConfigIO, resetConfigRuntimeState } from "../../../../src/config/config.js";
import { resolveMainSessionKeyFromConfig } from "../../../../src/config/sessions.js";
import { startGenericEmbeddingServer } from "../../../../src/gateway/embeddings-http.test-helpers.js";
import {
  agentCommandMock,
  getGatewayTestPort,
  installGatewayTestHooks,
  startTestGatewayServer,
  testState,
} from "../../../../src/gateway/test-helpers.js";
import { peekSystemEventEntries } from "../../../../src/infra/system-events.js";

installGatewayTestHooks();

const GATEWAY_TOKEN = "qa-gateway-token";
const HOOK_TOKEN = "qa-hook-token";
const JSON_HEADERS = {
  authorization: `Bearer ${GATEWAY_TOKEN}`,
  "content-type": "application/json",
};

type JsonRecord = Record<string, unknown>;

async function fetchJson(port: number, pathname: string, init?: RequestInit) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, init);
  return { response, body: (await response.json()) as JsonRecord };
}

it("serves OpenAI-compatible, tool invocation, and hook ingress APIs over TCP", async () => {
  const embeddingFixture = await startGenericEmbeddingServer();
  let gateway: Awaited<ReturnType<typeof startTestGatewayServer>> | undefined;

  try {
    const configPath = createConfigIO().configPath;
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify({
        memory: {
          search: {
            provider: "openai-compatible",
            model: "qa-embedding",
            documentInputType: "document",
            remote: { baseUrl: embeddingFixture.baseUrl },
          },
        },
      }),
      "utf8",
    );
    resetConfigRuntimeState();

    testState.agentConfig = { systemAgent: { agentId: "main" } };
    testState.agentsConfig = {
      ownership: "explicit",
      entries: {
        main: { tools: { allow: ["agents_list"] } },
        beta: {},
      },
    };
    testState.hooksConfig = { enabled: true, token: HOOK_TOKEN };
    agentCommandMock
      .mockResolvedValueOnce({ payloads: [{ text: "qa chat response" }] } as never)
      .mockResolvedValueOnce({ payloads: [{ text: "qa responses response" }] } as never);

    const port = await getGatewayTestPort();
    const post = (pathname: string, body: JsonRecord, headers = JSON_HEADERS) =>
      fetchJson(port, pathname, { method: "POST", headers, body: JSON.stringify(body) });
    gateway = await startTestGatewayServer(port, {
      host: "127.0.0.1",
      auth: { mode: "token", token: GATEWAY_TOKEN },
      controlUiEnabled: false,
      openAiChatCompletionsEnabled: true,
      openResponsesEnabled: true,
    });

    const models = await fetchJson(port, "/v1/models", { headers: JSON_HEADERS });
    expect(models.response.status).toBe(200);
    expect(models.body.object).toBe("list");
    expect((models.body.data as Array<{ id?: string }>).map((model) => model.id)).toEqual(
      expect.arrayContaining(["openclaw/main", "openclaw/beta"]),
    );

    const chat = await post("/v1/chat/completions", {
      model: "openclaw/main",
      stream: false,
      messages: [{ role: "user", content: "qa chat request" }],
    });
    expect(chat.response.status).toBe(200);
    const choices = chat.body.choices as Array<{ message?: { content?: string } }>;
    expect(choices[0]?.message?.content).toBe("qa chat response");

    const responses = await post("/v1/responses", {
      model: "openclaw/main",
      stream: false,
      input: "qa responses request",
    });
    expect(responses.response.status).toBe(200);
    expect(responses.body.status).toBe("completed");
    const output = responses.body.output as Array<{
      content?: Array<{ type?: string; text?: string }>;
    }>;
    expect(output[0]?.content?.[0]).toEqual({
      type: "output_text",
      text: "qa responses response",
    });
    expect(agentCommandMock).toHaveBeenCalledTimes(2);
    expect(agentCommandMock.mock.calls.map((call) => call[0])).toMatchObject([
      {
        message: "qa chat request",
        sessionKey: expect.stringMatching(/^agent:main:openai:/),
      },
      {
        message: "qa responses request",
        sessionKey: expect.stringMatching(/^agent:main:openresponses:/),
      },
    ]);

    const embeddings = await post("/v1/embeddings", {
      model: "openclaw/main",
      input: ["alpha", "beta"],
    });
    expect(embeddings.response.status).toBe(200);
    expect(embeddings.body.data).toEqual([
      expect.objectContaining({ index: 0, embedding: [9.1, 9.2] }),
      expect.objectContaining({ index: 1, embedding: [10.1, 9.2] }),
    ]);
    expect(embeddingFixture.requests).toMatchObject([
      {
        method: "POST",
        url: "/v1/embeddings",
        body: {
          model: "qa-embedding",
          input: ["alpha", "beta"],
          input_type: "document",
        },
      },
    ]);

    const tool = await post("/tools/invoke", {
      tool: "agents_list",
      action: "json",
      args: {},
      sessionKey: "main",
    });
    expect(tool.response.status, JSON.stringify(tool.body)).toBe(200);
    expect(tool.body.ok).toBe(true);
    expect(tool.body.result).toMatchObject({
      details: {
        requester: "main",
        allowAny: false,
        agents: [expect.objectContaining({ id: "main", configured: true })],
      },
    });

    const malformedTool = await post("/tools/invoke", {});
    expect(malformedTool.response.status).toBe(400);
    expect(malformedTool.body).toEqual({
      ok: false,
      error: {
        type: "invalid_request",
        message: "tools.invoke requires name",
      },
    });

    const mainSessionKey = resolveMainSessionKeyFromConfig();
    const unauthenticatedWake = await fetch(`http://127.0.0.1:${port}/hooks/wake`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "must not queue", mode: "next-heartbeat" }),
    });
    expect(unauthenticatedWake.status).toBe(401);
    expect(await unauthenticatedWake.text()).toBe("Unauthorized");
    expect(peekSystemEventEntries(mainSessionKey)).toHaveLength(0);

    const authenticatedWake = await post(
      "/hooks/wake",
      { text: "Gateway HTTP QA wake", mode: "next-heartbeat" },
      {
        authorization: `Bearer ${HOOK_TOKEN}`,
        "content-type": "application/json",
      },
    );
    expect(authenticatedWake.response.status).toBe(200);
    expect(authenticatedWake.body).toEqual({
      ok: true,
      mode: "next-heartbeat",
      eventOutcome: "queued",
    });
    expect(peekSystemEventEntries(mainSessionKey).map((event) => event.text)).toEqual([
      "Gateway HTTP QA wake",
    ]);
  } finally {
    await gateway?.close({ reason: "Gateway HTTP API QA proof complete" });
    await embeddingFixture.close();
  }
}, 60_000);
