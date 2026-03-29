import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getFreePort, installGatewayTestHooks } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const READ_SCOPE_HEADER = { "x-openclaw-scopes": "operator.read" };

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

async function getModels(
  pathname: string,
  headers?: Record<string, string>,
  opts?: { includeDefaultScopeHeader?: boolean; port?: number; token?: string },
) {
  const includeDefaultScopeHeader = opts?.includeDefaultScopeHeader ?? true;
  const port = opts?.port ?? enabledPort;
  return await fetch(`http://127.0.0.1:${port}${pathname}`, {
    headers: {
      authorization: `Bearer ${opts?.token ?? "secret"}`,
      ...(includeDefaultScopeHeader ? READ_SCOPE_HEADER : {}),
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

  it("serves /v1/models with headerless bearer auth", async () => {
    const res = await getModels("/v1/models", undefined, { includeDefaultScopeHeader: false });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { object?: string; data?: Array<{ id?: string }> };
    expect(json.object).toBe("list");
    expect((json.data?.length ?? 0) > 0).toBe(true);
  });

  it("serves /v1/models/{id} with headerless bearer auth", async () => {
    const list = (await (await getModels("/v1/models")).json()) as {
      data?: Array<{ id?: string }>;
    };
    const firstId = list.data?.[0]?.id;
    expect(typeof firstId).toBe("string");
    const res = await getModels(`/v1/models/${encodeURIComponent(firstId!)}`, undefined, {
      includeDefaultScopeHeader: false,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { id?: string; object?: string };
    expect(json.object).toBe("model");
    expect(json.id).toBe(firstId);
  });

  it("rejects operator scopes that lack read access", async () => {
    const res = await getModels("/v1/models", { "x-openclaw-scopes": "operator.approvals" });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      error: {
        type: "forbidden",
        message: "missing scope: operator.read",
      },
    });
  });

  it("rejects requests with no declared operator scopes", async () => {
    const res = await getModels("/v1/models", { "x-openclaw-scopes": "" });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      error: {
        type: "forbidden",
        message: "missing scope: operator.read",
      },
    });
  });

  it("rejects /v1/models/{id} without read access", async () => {
    const list = (await (await getModels("/v1/models")).json()) as {
      data?: Array<{ id?: string }>;
    };
    const firstId = list.data?.[0]?.id;
    expect(typeof firstId).toBe("string");
    const res = await getModels(`/v1/models/${encodeURIComponent(firstId!)}`, {
      "x-openclaw-scopes": "operator.approvals",
    });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      error: {
        type: "forbidden",
        message: "missing scope: operator.read",
      },
    });
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

  it("serves /v1/models with headerless password auth", async () => {
    const port = await getFreePort();
    const server = await startGatewayServer(port, {
      host: "127.0.0.1",
      auth: { mode: "password", password: "pw-secret" },
      controlUiEnabled: false,
      openAiChatCompletionsEnabled: true,
    });
    try {
      const res = await getModels("/v1/models", undefined, {
        includeDefaultScopeHeader: false,
        port,
        token: "pw-secret",
      });
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ object: "list" });
    } finally {
      await server.close({ reason: "models password auth test done" });
    }
  });
});
