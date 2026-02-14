import type { AddressInfo } from "node:net";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_GATEWAY_TOKEN = "test-gateway-token-1234567890";

// Perf: the real tool factory instantiates many tools per request; for these HTTP
// routing/policy tests we only need a small set of tool names.
vi.mock("../agents/openclaw-tools.js", () => {
  const toolInputError = (message: string) => {
    const err = new Error(message);
    err.name = "ToolInputError";
    return err;
  };

  const tools = [
    {
      name: "session_status",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ ok: true }),
    },
    {
      name: "agents_list",
      parameters: { type: "object", properties: { action: { type: "string" } } },
      execute: async () => ({ ok: true, result: [] }),
    },
    {
      name: "sessions_spawn",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ ok: true }),
    },
    {
      name: "sessions_send",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ ok: true }),
    },
    {
      name: "gateway",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        throw toolInputError("invalid args");
      },
    },
    {
      name: "tools_invoke_test",
      parameters: {
        type: "object",
        properties: {
          mode: { type: "string" },
        },
        required: ["mode"],
        additionalProperties: false,
      },
      execute: async (_toolCallId: string, args: unknown) => {
        const mode = (args as { mode?: unknown })?.mode;
        if (mode === "input") {
          throw toolInputError("mode invalid");
        }
        if (mode === "crash") {
          throw new Error("boom");
        }
        return { ok: true };
      },
    },
  ];

  return {
    createOpenClawTools: () => tools,
  };
});

const { testState } = await import("./test-helpers.mocks.js");
const { clearConfigCache, writeConfigFile } = await import("../config/config.js");
const { handleToolsInvokeHttpRequest } = await import("./tools-invoke-http.js");

let pluginHttpHandlers: Array<(req: IncomingMessage, res: ServerResponse) => Promise<boolean>> = [];

let sharedPort = 0;
let sharedServer: ReturnType<typeof createServer> | undefined;

beforeAll(async () => {
  sharedServer = createServer((req, res) => {
    void (async () => {
      const handled = await handleToolsInvokeHttpRequest(req, res, {
        auth: { mode: "token", token: TEST_GATEWAY_TOKEN, allowTailscale: false },
      });
      if (handled) {
        return;
      }
      for (const handler of pluginHttpHandlers) {
        if (await handler(req, res)) {
          return;
        }
      }
      res.statusCode = 404;
      res.end("not found");
    })().catch((err) => {
      res.statusCode = 500;
      res.end(String(err));
    });
  });

  await new Promise<void>((resolve, reject) => {
    sharedServer?.once("error", reject);
    sharedServer?.listen(0, "127.0.0.1", () => {
      const address = sharedServer?.address() as AddressInfo | null;
      sharedPort = address?.port ?? 0;
      resolve();
    });
  });
});

afterAll(async () => {
  const server = sharedServer;
  if (!server) {
    return;
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  sharedServer = undefined;
});

beforeEach(async () => {
  // Ensure these tests are not affected by host env vars.
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  delete process.env.OPENCLAW_GATEWAY_PASSWORD;

  pluginHttpHandlers = [];
  testState.agentConfig = undefined;
  testState.agentsConfig = undefined;
  testState.sessionConfig = undefined;
  testState.gatewayAuth = { mode: "token", token: TEST_GATEWAY_TOKEN };
  await writeConfigFile({});
  clearConfigCache();
});

const resolveGatewayToken = (): string => {
  const token = (testState.gatewayAuth as { token?: string } | undefined)?.token;
  if (!token) {
    throw new Error("test gateway token missing");
  }
  return token;
};

const allowAgentsListForMain = () => {
  testState.agentsConfig = {
    list: [
      {
        id: "main",
        tools: {
          allow: ["agents_list"],
        },
      },
    ],
    // oxlint-disable-next-line typescript/no-explicit-any
  } as any;
};

const invokeAgentsList = async (params: {
  port: number;
  headers?: Record<string, string>;
  sessionKey?: string;
}) => {
  const body: Record<string, unknown> = { tool: "agents_list", action: "json", args: {} };
  if (params.sessionKey) {
    body.sessionKey = params.sessionKey;
  }
  return await fetch(`http://127.0.0.1:${params.port}/tools/invoke`, {
    method: "POST",
    headers: { "content-type": "application/json", ...params.headers },
    body: JSON.stringify(body),
  });
};

const invokeTool = async (params: {
  port: number;
  tool: string;
  args?: Record<string, unknown>;
  action?: string;
  headers?: Record<string, string>;
  sessionKey?: string;
}) => {
  const body: Record<string, unknown> = {
    tool: params.tool,
    args: params.args ?? {},
  };
  if (params.action) {
    body.action = params.action;
  }
  if (params.sessionKey) {
    body.sessionKey = params.sessionKey;
  }
  return await fetch(`http://127.0.0.1:${params.port}/tools/invoke`, {
    method: "POST",
    headers: { "content-type": "application/json", ...params.headers },
    body: JSON.stringify(body),
  });
};

describe("POST /tools/invoke", () => {
  it("invokes a tool and returns {ok:true,result}", async () => {
    allowAgentsListForMain();
    const token = resolveGatewayToken();

    const res = await invokeAgentsList({
      port: sharedPort,
      headers: { authorization: `Bearer ${token}` },
      sessionKey: "main",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body).toHaveProperty("result");
  });

  it("supports tools.alsoAllow in profile and implicit modes", async () => {
    testState.agentsConfig = {
      list: [{ id: "main" }],
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;

    await writeConfigFile({
      tools: { profile: "minimal", alsoAllow: ["agents_list"] },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any);
    clearConfigCache();
    const token = resolveGatewayToken();

    const resProfile = await invokeAgentsList({
      port: sharedPort,
      headers: { authorization: `Bearer ${token}` },
      sessionKey: "main",
    });

    expect(resProfile.status).toBe(200);
    const profileBody = await resProfile.json();
    expect(profileBody.ok).toBe(true);

    await writeConfigFile({
      tools: { alsoAllow: ["agents_list"] },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any);
    clearConfigCache();
    const resImplicit = await invokeAgentsList({
      port: sharedPort,
      headers: { authorization: `Bearer ${token}` },
      sessionKey: "main",
    });
    expect(resImplicit.status).toBe(200);
    const implicitBody = await resImplicit.json();
    expect(implicitBody.ok).toBe(true);
  });

  it("routes tools invoke before plugin HTTP handlers", async () => {
    const pluginHandler = vi.fn(async (_req: IncomingMessage, res: ServerResponse) => {
      res.statusCode = 418;
      res.end("plugin");
      return true;
    });
    allowAgentsListForMain();
    pluginHttpHandlers = [async (req, res) => pluginHandler(req, res)];

    const token = resolveGatewayToken();
    const res = await invokeAgentsList({
      port: sharedPort,
      headers: { authorization: `Bearer ${token}` },
      sessionKey: "main",
    });

    expect(res.status).toBe(200);
    expect(pluginHandler).not.toHaveBeenCalled();
  });

  it("returns 404 when denylisted or blocked by tools.profile", async () => {
    testState.agentsConfig = {
      list: [
        {
          id: "main",
          tools: {
            deny: ["agents_list"],
          },
        },
      ],
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;
    const token = resolveGatewayToken();

    const denyRes = await invokeAgentsList({
      port: sharedPort,
      headers: { authorization: `Bearer ${token}` },
      sessionKey: "main",
    });
    expect(denyRes.status).toBe(404);

    allowAgentsListForMain();

    await writeConfigFile({
      tools: { profile: "minimal" },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any);
    clearConfigCache();

    const profileRes = await invokeAgentsList({
      port: sharedPort,
      headers: { authorization: `Bearer ${token}` },
      sessionKey: "main",
    });
    expect(profileRes.status).toBe(404);
  });

  it("denies sessions_spawn via HTTP even when agent policy allows", async () => {
    testState.agentsConfig = {
      list: [
        {
          id: "main",
          tools: { allow: ["sessions_spawn"] },
        },
      ],
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;

    const token = resolveGatewayToken();

    const res = await invokeTool({
      port: sharedPort,
      tool: "sessions_spawn",
      args: { task: "test" },
      headers: { authorization: `Bearer ${token}` },
      sessionKey: "main",
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.type).toBe("not_found");
  });

  it("denies sessions_send via HTTP gateway", async () => {
    testState.agentsConfig = {
      list: [{ id: "main", tools: { allow: ["sessions_send"] } }],
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;

    const token = resolveGatewayToken();

    const res = await invokeTool({
      port: sharedPort,
      tool: "sessions_send",
      headers: { authorization: `Bearer ${token}` },
      sessionKey: "main",
    });

    expect(res.status).toBe(404);
  });

  it("denies gateway tool via HTTP", async () => {
    testState.agentsConfig = {
      list: [{ id: "main", tools: { allow: ["gateway"] } }],
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;

    const token = resolveGatewayToken();

    const res = await invokeTool({
      port: sharedPort,
      tool: "gateway",
      headers: { authorization: `Bearer ${token}` },
      sessionKey: "main",
    });

    expect(res.status).toBe(404);
  });

  it("allows gateway tool via HTTP when explicitly enabled in gateway.tools.allow", async () => {
    testState.agentsConfig = {
      list: [{ id: "main", tools: { allow: ["gateway"] } }],
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;
    await writeConfigFile({
      gateway: { tools: { allow: ["gateway"] } },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any);
    clearConfigCache();

    const token = resolveGatewayToken();

    try {
      const res = await invokeTool({
        port: sharedPort,
        tool: "gateway",
        headers: { authorization: `Bearer ${token}` },
        sessionKey: "main",
      });

      // Ensure we didn't hit the HTTP deny list (404). Invalid args should map to 400.
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error?.type).toBe("tool_error");
    } finally {
      await writeConfigFile({
        // oxlint-disable-next-line typescript/no-explicit-any
      } as any);
      clearConfigCache();
    }
  });

  it("treats gateway.tools.deny as higher priority than gateway.tools.allow", async () => {
    testState.agentsConfig = {
      list: [{ id: "main", tools: { allow: ["gateway"] } }],
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;
    await writeConfigFile({
      gateway: { tools: { allow: ["gateway"], deny: ["gateway"] } },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any);
    clearConfigCache();

    const token = resolveGatewayToken();

    try {
      const res = await invokeTool({
        port: sharedPort,
        tool: "gateway",
        headers: { authorization: `Bearer ${token}` },
        sessionKey: "main",
      });

      expect(res.status).toBe(404);
    } finally {
      await writeConfigFile({
        // oxlint-disable-next-line typescript/no-explicit-any
      } as any);
      clearConfigCache();
    }
  });

  it("uses the configured main session key when sessionKey is missing or main", async () => {
    testState.agentsConfig = {
      list: [
        {
          id: "main",
          tools: {
            deny: ["agents_list"],
          },
        },
        {
          id: "ops",
          default: true,
          tools: {
            allow: ["agents_list"],
          },
        },
      ],
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;
    testState.sessionConfig = { mainKey: "primary" };

    const token = resolveGatewayToken();

    const resDefault = await invokeAgentsList({
      port: sharedPort,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(resDefault.status).toBe(200);

    const resMain = await invokeAgentsList({
      port: sharedPort,
      headers: { authorization: `Bearer ${token}` },
      sessionKey: "main",
    });
    expect(resMain.status).toBe(200);
  });

  it("maps tool input errors to 400 and unexpected execution errors to 500", async () => {
    testState.agentsConfig = {
      list: [{ id: "main", tools: { allow: ["tools_invoke_test"] } }],
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;

    const token = resolveGatewayToken();

    const inputRes = await invokeTool({
      port: sharedPort,
      tool: "tools_invoke_test",
      args: { mode: "input" },
      headers: { authorization: `Bearer ${token}` },
      sessionKey: "main",
    });
    expect(inputRes.status).toBe(400);
    const inputBody = await inputRes.json();
    expect(inputBody.ok).toBe(false);
    expect(inputBody.error?.type).toBe("tool_error");
    expect(inputBody.error?.message).toBe("mode invalid");

    const crashRes = await invokeTool({
      port: sharedPort,
      tool: "tools_invoke_test",
      args: { mode: "crash" },
      headers: { authorization: `Bearer ${token}` },
      sessionKey: "main",
    });
    expect(crashRes.status).toBe(500);
    const crashBody = await crashRes.json();
    expect(crashBody.ok).toBe(false);
    expect(crashBody.error?.type).toBe("tool_error");
    expect(crashBody.error?.message).toBe("tool execution failed");
  });
});
