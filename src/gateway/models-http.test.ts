import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { startOpenAiCompatGatewayServer } from "./openai-compatible-http.test-helpers.js";
import { installGatewayTestHooks } from "./test-helpers.js";
import { testState } from "./test-helpers.runtime-state.js";

installGatewayTestHooks({ scope: "suite" });

const READ_SCOPE_HEADER = { "x-openclaw-scopes": "operator.read" };

let startGatewayServer: typeof import("./server.js").startGatewayServer;
let enabledServer: Awaited<ReturnType<typeof startOpenAiCompatGatewayServer>>;
let enabledPort: number;

async function startModels(
  auth: Parameters<typeof startOpenAiCompatGatewayServer>[0]["auth"] = { mode: "none" },
) {
  const port = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
  const server = await startOpenAiCompatGatewayServer({
    startGatewayServer,
    auth,
    openAiChatCompletionsEnabled: true,
    port,
  });
  return { server, port: port.port };
}

beforeAll(async () => {
  ({ startGatewayServer } = await import("./server.js"));
  ({ server: enabledServer, port: enabledPort } = await startModels());
});

afterAll(async () => {
  await enabledServer.close({ reason: "models http enabled suite done" });
});

function getModels(pathname: string, headers?: Record<string, string>) {
  return fetch(`http://127.0.0.1:${enabledPort}${pathname}`, {
    headers: { ...READ_SCOPE_HEADER, ...headers },
  });
}

async function modelIds(response: Promise<Response>) {
  const res = await response;
  expect(res.status).toBe(200);
  const json = (await res.json()) as { object?: string; data?: Array<{ id?: string }> };
  expect(json.object).toBe("list");
  return json.data?.map((entry) => entry.id);
}

async function expectMissingReadScope(res: Response) {
  expect(res.status).toBe(403);
  await expect(res.json()).resolves.toEqual({
    ok: false,
    error: {
      type: "forbidden",
      message: "missing scope: operator.read",
      details: {
        code: "MISSING_SCOPE",
        missingScope: "operator.read",
        requiredScopes: ["operator.read"],
      },
    },
  });
}

describe("OpenAI-compatible models HTTP API (e2e)", () => {
  it("serves /v1/models without trusting malformed Host headers", async () => {
    const ids = await modelIds(getModels("/v1/models", { Host: "[" }));
    expect(ids).toEqual(expect.arrayContaining(["openclaw", "openclaw/default"]));
    expect(ids?.every((id) => typeof id === "string" && id.startsWith("openclaw"))).toBe(true);
  });

  it("rejects agent-specific model ids outside the configured roster", async () => {
    const res = await getModels("/v1/models/openclaw%2Fnonexistent");
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      error: {
        message: "Model 'openclaw/nonexistent' not found.",
        type: "invalid_request_error",
      },
    });
  });

  it("keeps generic aliases available for ownerless explicit fleets", async () => {
    try {
      testState.agentsConfig = {
        ownership: "explicit",
        entries: { main: {}, research: {} },
      };
      expect(await modelIds(getModels("/v1/models"))).toContain("openclaw/default");

      const detail = await getModels("/v1/models/openclaw%2Fdefault");
      expect(detail.status).toBe(200);
      await expect(detail.json()).resolves.toMatchObject({ id: "openclaw/default" });
    } finally {
      testState.agentsConfig = undefined;
    }
  });

  it.each([
    ["operator.sessions.read", "/v1/models"],
    ["operator.sessions.read", "/v1/models/openclaw"],
    ["", "/v1/models"],
  ])("rejects scope '%s' for %s", async (scope, pathname) => {
    await expectMissingReadScope(await getModels(pathname, { "x-openclaw-scopes": scope }));
  });

  it("treats shared-secret bearer auth as full compat operator access", async () => {
    const { server, port } = await startModels({ mode: "token", token: "secret" });
    try {
      const response = fetch(`http://127.0.0.1:${port}/v1/models`, {
        headers: {
          authorization: "Bearer secret",
          "x-openclaw-scopes": "operator.approvals",
        },
      });
      expect(await modelIds(response)).toContain("openclaw/default");
    } finally {
      await server.close({ reason: "models token auth compat test done" });
    }
  });
});
