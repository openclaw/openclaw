import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { getFreePort, installGatewayTestHooks } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

let startGatewayServer: typeof import("./server.js").startGatewayServer;
let createEmbeddingProviderMock: ReturnType<typeof vi.fn>;
let enabledServer: Awaited<ReturnType<typeof startServer>>;
let enabledPort: number;

beforeAll(async () => {
  vi.resetModules();
  createEmbeddingProviderMock = vi.fn(async (options: { provider: string; model: string }) => ({
    provider: {
      id: options.provider,
      model: options.model,
      embedQuery: async () => [0.1, 0.2],
      embedBatch: async (texts: string[]) =>
        texts.map((_text, index) => [index + 0.1, index + 0.2]),
    },
  }));
  vi.doMock("../memory/embeddings.js", async () => {
    const actual =
      await vi.importActual<typeof import("../memory/embeddings.js")>("../memory/embeddings.js");
    return {
      ...actual,
      createEmbeddingProvider: createEmbeddingProviderMock,
    };
  });
  ({ startGatewayServer } = await import("./server.js"));
  enabledPort = await getFreePort();
  enabledServer = await startServer(enabledPort, { openAiChatCompletionsEnabled: true });
});

afterAll(async () => {
  await enabledServer.close({ reason: "embeddings http enabled suite done" });
  vi.resetModules();
});

async function startServer(port: number, opts?: { openAiChatCompletionsEnabled?: boolean }) {
  return await startGatewayServer(port, {
    host: "127.0.0.1",
    auth: { mode: "token", token: "secret" },
    controlUiEnabled: false,
    openAiChatCompletionsEnabled: opts?.openAiChatCompletionsEnabled ?? false,
  });
}

async function postEmbeddings(body: unknown, headers?: Record<string, string>) {
  return await fetch(`http://127.0.0.1:${enabledPort}/v1/embeddings`, {
    method: "POST",
    headers: {
      authorization: "Bearer secret",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("OpenAI-compatible embeddings HTTP API (e2e)", () => {
  it("embeds string and array inputs", async () => {
    const single = await postEmbeddings({
      model: "text-embedding-3-small",
      input: "hello",
    });
    expect(single.status).toBe(200);
    const singleJson = (await single.json()) as {
      object?: string;
      data?: Array<{ object?: string; embedding?: number[]; index?: number }>;
    };
    expect(singleJson.object).toBe("list");
    expect(singleJson.data?.[0]?.object).toBe("embedding");
    expect(singleJson.data?.[0]?.embedding).toEqual([0.1, 0.2]);

    const batch = await postEmbeddings({
      model: "text-embedding-3-small",
      input: ["a", "b"],
    });
    expect(batch.status).toBe(200);
    const batchJson = (await batch.json()) as {
      data?: Array<{ embedding?: number[]; index?: number }>;
    };
    expect(batchJson.data).toEqual([
      { object: "embedding", index: 0, embedding: [0.1, 0.2] },
      { object: "embedding", index: 1, embedding: [1.1, 1.2] },
    ]);

    const qualified = await postEmbeddings({
      model: "openai/text-embedding-3-small",
      input: "hello again",
    });
    expect(qualified.status).toBe(200);
    const qualifiedJson = (await qualified.json()) as { model?: string };
    expect(qualifiedJson.model).toBe("openai/text-embedding-3-small");
    const lastCall = createEmbeddingProviderMock.mock.calls.at(-1)?.[0] as
      | { provider?: string; model?: string }
      | undefined;
    expect(lastCall).toMatchObject({
      provider: "openai",
      model: "text-embedding-3-small",
    });
  });

  it("supports base64 encoding and agent-scoped auth/config resolution", async () => {
    const res = await postEmbeddings(
      {
        model: "text-embedding-3-small",
        input: "hello",
        encoding_format: "base64",
      },
      { "x-openclaw-agent-id": "beta" },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data?: Array<{ embedding?: string }> };
    expect(typeof json.data?.[0]?.embedding).toBe("string");
    expect(createEmbeddingProviderMock).toHaveBeenCalled();
    const lastCall = createEmbeddingProviderMock.mock.calls.at(-1)?.[0] as
      | { provider?: string; model?: string; fallback?: string; agentDir?: string }
      | undefined;
    expect(lastCall?.model).toBe("text-embedding-3-small");
    expect(lastCall?.fallback).toBe("none");
    expect(lastCall?.agentDir).toBe(resolveAgentDir({}, "beta"));
  });

  it("rejects invalid input shapes", async () => {
    const res = await postEmbeddings({
      model: "text-embedding-3-small",
      input: [{ nope: true }],
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error?: { type?: string } };
    expect(json.error?.type).toBe("invalid_request_error");
  });

  it("rejects disallowed provider-prefixed model overrides", async () => {
    const res = await postEmbeddings({
      model: "ollama/nomic-embed-text",
      input: "hello",
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error?: { type?: string; message?: string } };
    expect(json.error).toEqual({
      type: "invalid_request_error",
      message: "This agent does not allow that embedding provider on `/v1/embeddings`.",
    });
  });

  it("rejects oversized batches", async () => {
    const res = await postEmbeddings({
      model: "text-embedding-3-small",
      input: Array.from({ length: 129 }, () => "x"),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error?: { type?: string; message?: string } };
    expect(json.error).toEqual({
      type: "invalid_request_error",
      message: "Too many inputs (max 128).",
    });
  });

  it("sanitizes provider failures", async () => {
    createEmbeddingProviderMock.mockRejectedValueOnce(new Error("secret upstream failure"));
    const res = await postEmbeddings({
      model: "text-embedding-3-small",
      input: "hello",
    });
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error?: { type?: string; message?: string } };
    expect(json.error).toEqual({
      type: "api_error",
      message: "internal error",
    });
  });
});
