import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_GATEWAY_TOKEN = "test-gateway-token-1234567890";

let cfg: Record<string, unknown> = {};

vi.mock("../config/config.js", () => ({
  loadConfig: () => cfg,
}));

vi.mock("../config/sessions.js", () => ({
  resolveMainSessionKey: () => "agent:main:main",
}));

vi.mock("./auth.js", () => ({
  authorizeHttpGatewayConnect: async () => ({ ok: true }),
}));

vi.mock("../logger.js", () => ({
  logWarn: () => {},
}));

vi.mock("../plugins/config-state.js", () => ({
  isTestDefaultMemorySlotDisabled: () => false,
}));

vi.mock("../plugins/tools.js", () => ({
  getPluginToolMeta: () => undefined,
}));

vi.mock("../agents/openclaw-tools.js", () => {
  const tools = [
    {
      name: "cron",
      parameters: { type: "object", properties: { action: { type: "string" } } },
      execute: async () => ({ ok: true, via: "cron" }),
    },
    {
      name: "gateway",
      parameters: { type: "object", properties: { action: { type: "string" } } },
      execute: async () => ({ ok: true, via: "gateway" }),
    },
  ];
  return {
    createOpenClawTools: () => tools,
  };
});

const { handleToolsInvokeHttpRequest } = await import("./tools-invoke-http.js");

let port = 0;
let server: ReturnType<typeof createServer> | undefined;

beforeAll(async () => {
  server = createServer((req, res) => {
    void handleToolsInvokeHttpRequest(req, res, {
      auth: { mode: "token", token: TEST_GATEWAY_TOKEN, allowTailscale: false },
    }).then((handled) => {
      if (handled) {
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server?.once("error", reject);
    server?.listen(0, "127.0.0.1", () => {
      const address = server?.address() as AddressInfo | null;
      port = address?.port ?? 0;
      resolve();
    });
  });
});

afterAll(async () => {
  if (!server) {
    return;
  }
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
});

beforeEach(() => {
  cfg = {};
});

async function invoke(tool: string) {
  return await fetch(`http://127.0.0.1:${port}/tools/invoke`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TEST_GATEWAY_TOKEN}`,
    },
    body: JSON.stringify({ tool, action: "status", args: {}, sessionKey: "main" }),
  });
}

describe("tools invoke HTTP denylist", () => {
  it("blocks cron and gateway by default", async () => {
    const gatewayRes = await invoke("gateway");
    const cronRes = await invoke("cron");

    expect(gatewayRes.status).toBe(404);
    expect(cronRes.status).toBe(404);
  });

  it("allows cron only when explicitly enabled in gateway.tools.allow", async () => {
    cfg = {
      gateway: {
        tools: {
          allow: ["cron"],
        },
      },
    };

    const cronRes = await invoke("cron");

    expect(cronRes.status).toBe(200);
  });

  it("keeps cron available under coding profile without exposing gateway", async () => {
    cfg = {
      tools: {
        profile: "coding",
      },
      gateway: {
        tools: {
          allow: ["cron"],
        },
      },
    };

    const cronRes = await invoke("cron");
    const gatewayRes = await invoke("gateway");

    expect(cronRes.status).toBe(200);
    expect(gatewayRes.status).toBe(404);
  });
});
