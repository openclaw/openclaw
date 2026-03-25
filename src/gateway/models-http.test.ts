import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getFreePort, installGatewayTestHooks } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

let startGatewayServer: typeof import("./server.js").startGatewayServer;
let enabledServer: Awaited<ReturnType<typeof startServer>>;
let enabledPort: number;

beforeAll(async () => {
  ({ startGatewayServer } = await import("./server.js"));
  enabledPort = await getFreePort();
  enabledServer = await startServer(enabledPort, { openAiChatCompletionsEnabled: true });
});

afterAll(async () => {
  await enabledServer.close({ reason: "models http enabled suite done" });
});

async function startServer(port: number, opts?: { openAiChatCompletionsEnabled?: boolean }) {
  return await startGatewayServer(port, {
    host: "127.0.0.1",
    auth: { mode: "token", token: "secret" },
    controlUiEnabled: false,
    openAiChatCompletionsEnabled: opts?.openAiChatCompletionsEnabled ?? false,
  });
}

async function getModels(pathname: string, headers?: Record<string, string>) {
  return await fetch(`http://127.0.0.1:${enabledPort}${pathname}`, {
    headers: {
      authorization: "Bearer secret",
      ...headers,
    },
  });
}

describe("OpenAI-compatible models HTTP API (e2e)", () => {
  it("serves /v1/models when compatibility endpoints are enabled", async () => {
    const res = await getModels("/v1/models");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { object?: string; data?: Array<{ id?: string }> };
    expect(json.object).toBe("list");
    expect(Array.isArray(json.data)).toBe(true);
    expect((json.data?.length ?? 0) > 0).toBe(true);
    expect(json.data?.map((entry) => entry.id)).toContain("openclaw");
    expect(json.data?.map((entry) => entry.id)).toContain("openclaw/default");
    expect(
      json.data?.every((entry) => typeof entry.id === "string" && entry.id?.startsWith("openclaw")),
    ).toBe(true);
  });

  it("serves /v1/models/{id}", async () => {
    const list = (await (await getModels("/v1/models")).json()) as {
      data?: Array<{ id?: string }>;
    };
    const firstId = list.data?.[0]?.id;
    expect(typeof firstId).toBe("string");
    const res = await getModels(`/v1/models/${encodeURIComponent(firstId!)}`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { id?: string; object?: string };
    expect(json.object).toBe("model");
    expect(json.id).toBe(firstId);
  });

  it("rejects when disabled", async () => {
    const port = await getFreePort();
    const server = await startServer(port, { openAiChatCompletionsEnabled: false });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/models`, {
        headers: { authorization: "Bearer secret" },
      });
      expect(res.status).toBe(404);
    } finally {
      await server.close({ reason: "models disabled test done" });
    }
  });
});
