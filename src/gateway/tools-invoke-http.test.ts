import type { IncomingMessage, ServerResponse } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { resetTestPluginRegistry, setTestPluginRegistry, testState } from "./test-helpers.mocks.js";
import { installGatewayTestHooks, getFreePort, startGatewayServer } from "./test-helpers.server.js";

installGatewayTestHooks({ scope: "suite" });

beforeEach(() => {
  // Ensure these tests are not affected by host env vars.
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  delete process.env.OPENCLAW_GATEWAY_PASSWORD;
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

describe("POST /tools/invoke", () => {
  let sharedPort = 0;
  let sharedServer: Awaited<ReturnType<typeof startGatewayServer>>;

  beforeAll(async () => {
    sharedPort = await getFreePort();
    sharedServer = await startGatewayServer(sharedPort, {
      bind: "loopback",
    });
  });

  afterAll(async () => {
    await sharedServer.close();
  });

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

    const { writeConfigFile } = await import("../config/config.js");
    await writeConfigFile({
      tools: { profile: "minimal", alsoAllow: ["agents_list"] },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any);
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
    const resImplicit = await invokeAgentsList({
      port: sharedPort,
      headers: { authorization: `Bearer ${token}` },
      sessionKey: "main",
    });
    expect(resImplicit.status).toBe(200);
    const implicitBody = await resImplicit.json();
    expect(implicitBody.ok).toBe(true);
  });

  it("handles dedicated auth modes for password accept and token reject", async () => {
    allowAgentsListForMain();

    const passwordPort = await getFreePort();
    const passwordServer = await startGatewayServer(passwordPort, {
      bind: "loopback",
      auth: { mode: "password", password: "secret" },
    });
    try {
      const passwordRes = await invokeAgentsList({
        port: passwordPort,
        headers: { authorization: "Bearer secret" },
        sessionKey: "main",
      });
      expect(passwordRes.status).toBe(200);
    } finally {
      await passwordServer.close();
    }

    const tokenPort = await getFreePort();
    const tokenServer = await startGatewayServer(tokenPort, {
      bind: "loopback",
      auth: { mode: "token", token: "t" },
    });
    try {
      const tokenRes = await invokeAgentsList({
        port: tokenPort,
        sessionKey: "main",
      });
      expect(tokenRes.status).toBe(401);
    } finally {
      await tokenServer.close();
    }
  });

  it("routes tools invoke before plugin HTTP handlers", async () => {
    const pluginHandler = vi.fn(async (_req: IncomingMessage, res: ServerResponse) => {
      res.statusCode = 418;
      res.end("plugin");
      return true;
    });
    const registry = createTestRegistry();
    registry.httpHandlers = [
      {
        pluginId: "test-plugin",
        source: "test",
        handler: pluginHandler as unknown as (
          req: import("node:http").IncomingMessage,
          res: import("node:http").ServerResponse,
        ) => Promise<boolean>,
      },
    ];
    setTestPluginRegistry(registry);

    allowAgentsListForMain();
    try {
      const token = resolveGatewayToken();
      const res = await invokeAgentsList({
        port: sharedPort,
        headers: { authorization: `Bearer ${token}` },
        sessionKey: "main",
      });

      expect(res.status).toBe(200);
      expect(pluginHandler).not.toHaveBeenCalled();
    } finally {
      resetTestPluginRegistry();
    }
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

    const { writeConfigFile } = await import("../config/config.js");
    await writeConfigFile({
      tools: { profile: "minimal" },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any);

    const profileRes = await invokeAgentsList({
      port: sharedPort,
      headers: { authorization: `Bearer ${token}` },
      sessionKey: "main",
    });
    expect(profileRes.status).toBe(404);
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
});
