import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestGatewayHttpServer } from "./http-server.test-support.js";

const TEST_GATEWAY_TOKEN = "test-gateway-token-1234567890";
let cfg: Record<string, unknown> = {};

// mock-isolation: Keep HTTP denylist configuration independent of the host config store.
vi.mock("../config/config.js", () => ({ getRuntimeConfig: () => cfg }));
// mock-isolation: Supply the same fixture config without loading host config files.
vi.mock("../config/io.js", () => ({ getRuntimeConfig: () => cfg }));

// mock-isolation: Admit transport authentication so the test exercises the tool denylist.
vi.mock("./auth.js", () => ({
  authorizeHttpGatewayConnect: async () => ({ ok: true as const }),
}));

// mock-isolation: Supply loop policy without initializing the real agent tool runtime.
vi.mock("../agents/agent-tools.js", () => ({
  resolveToolLoopDetectionConfig: () => ({ warnAt: 3 }),
}));

// mock-isolation: Bypass unrelated agent hooks while retaining the HTTP denylist boundary.
vi.mock("../agents/agent-tools.before-tool-call.js", () => ({
  runBeforeToolCallHook: async ({ params }: { params: unknown }) => ({
    blocked: false as const,
    params,
  }),
}));

// mock-isolation: Exercise the HTTP denylist with inert automation and Gateway tools.
vi.mock("../agents/openclaw-tools.js", () => {
  const tools = ["automations", "gateway"].map((name) => ({
    name,
    parameters: { type: "object", properties: { action: { type: "string" } } },
    execute: async () => ({ ok: true, via: name }),
  }));
  return { createOpenClawToolsAsync: async () => tools };
});

const { handleToolsInvokeHttpRequest } = await import("./tools-invoke-http.js");

let url: string;
const server = createTestGatewayHttpServer((req, res) =>
  handleToolsInvokeHttpRequest(req, res, {
    auth: { mode: "token", token: TEST_GATEWAY_TOKEN, allowTailscale: false },
  }),
);
beforeAll(async () => {
  url = `http://127.0.0.1:${await server.listen()}/tools/invoke`;
});
afterAll(() => server.close());

async function invoke(tool: string, scopes = "operator.write") {
  return await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TEST_GATEWAY_TOKEN}`,
      "x-openclaw-scopes": scopes,
    },
    body: JSON.stringify({ tool, action: "status", args: {}, sessionKey: "main" }),
  });
}

it.each([
  {
    name: "defaults",
    config: {},
    checks: [
      ["gateway", 404],
      ["cron", 404],
    ],
  },
  {
    name: "normalized deny over canonical allow",
    config: { gateway: { tools: { allow: ["automations"], deny: [" CRON "] } } },
    checks: [["cron", 404]],
  },
  {
    name: "explicit cron allow under coding profile",
    config: { tools: { profile: "coding" }, gateway: { tools: { allow: ["cron"] } } },
    checks: [
      ["cron", 200],
      ["gateway", 404],
    ],
  },
] as const)("HTTP tool denylist: $name", async ({ config, checks }) => {
  cfg = config;
  for (const [tool, status] of checks) {
    const scopes = tool === "cron" ? "operator.admin" : "operator.write";
    expect((await invoke(tool, scopes)).status).toBe(status);
  }
});
