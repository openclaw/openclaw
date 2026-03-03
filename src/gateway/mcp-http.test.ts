import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFreePortBlockWithPermissionFallback } from "../test-utils/ports.js";
import { startMcpLoopbackServer } from "./mcp-http.js";

type MockConfig = {
  marker: string;
  session?: { mainKey?: string };
};

const groupPolicyMock = vi.hoisted(() => vi.fn());
let runtimeConfig: MockConfig = {
  marker: "a",
  session: { mainKey: "main" },
};

vi.mock("../config/config.js", () => ({
  loadConfig: () => runtimeConfig,
}));

vi.mock("../config/sessions.js", () => ({
  resolveMainSessionKey: (cfg?: { session?: { mainKey?: string } }) =>
    `agent:main:${cfg?.session?.mainKey ?? "main"}`,
}));

vi.mock("../agents/openclaw-tools.js", () => ({
  createOpenClawTools: (options?: { config?: MockConfig }) => {
    const marker = options?.config?.marker ?? "unknown";
    return [
      {
        name: `tool-${marker}`,
        description: `tool ${marker}`,
        parameters: { type: "object", properties: {} },
        execute: async () => ({
          content: [{ type: "text", text: `ok-${marker}` }],
        }),
      },
    ];
  },
}));

vi.mock("../agents/pi-tools.policy.js", () => ({
  resolveEffectiveToolPolicy: () => ({
    agentId: "main",
    globalPolicy: undefined,
    globalProviderPolicy: undefined,
    agentPolicy: undefined,
    agentProviderPolicy: undefined,
    profile: undefined,
    providerProfile: undefined,
    profileAlsoAllow: undefined,
    providerProfileAlsoAllow: undefined,
  }),
  resolveGroupToolPolicy: (...args: unknown[]) => groupPolicyMock(...args),
  resolveSubagentToolPolicy: () => undefined,
}));

vi.mock("../agents/tool-policy-pipeline.js", () => ({
  applyToolPolicyPipeline: (params: { tools: unknown[] }) => params.tools,
  buildDefaultToolPolicyPipelineSteps: () => [],
}));

vi.mock("../agents/tool-policy.js", () => ({
  collectExplicitAllowlist: () => [],
  mergeAlsoAllowPolicy: (policy: unknown) => policy,
  resolveToolProfilePolicy: () => undefined,
}));

vi.mock("../plugins/tools.js", () => ({
  getPluginToolMeta: () => undefined,
}));

vi.mock("../routing/session-key.js", () => ({
  isSubagentSessionKey: () => false,
}));

let server: Awaited<ReturnType<typeof startMcpLoopbackServer>> | null = null;

async function sendJsonRpc(params: {
  port: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}) {
  const response = await fetch(`http://127.0.0.1:${params.port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...params.headers,
    },
    body: JSON.stringify(params.body),
  });
  return await response.json();
}

describe("mcp-http", () => {
  beforeEach(() => {
    runtimeConfig = {
      marker: "a",
      session: { mainKey: "main" },
    };
    groupPolicyMock.mockReset();
    groupPolicyMock.mockReturnValue(undefined);
  });

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it("refreshes tool cache when runtime config snapshot changes", async () => {
    const port = await getFreePortBlockWithPermissionFallback({
      offsets: [0],
      fallbackBase: 47_000,
    });
    server = await startMcpLoopbackServer(port);

    const first = (await sendJsonRpc({
      port,
      body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    })) as { result?: { tools?: Array<{ name?: string }> } };
    expect(first.result?.tools?.[0]?.name).toBe("tool-a");

    runtimeConfig = {
      marker: "b",
      session: { mainKey: "main" },
    };

    const second = (await sendJsonRpc({
      port,
      body: { jsonrpc: "2.0", id: 2, method: "tools/list" },
    })) as { result?: { tools?: Array<{ name?: string }> } };
    expect(second.result?.tools?.[0]?.name).toBe("tool-b");
  });

  it("passes message channel and account headers into group tool policy resolution", async () => {
    const port = await getFreePortBlockWithPermissionFallback({
      offsets: [0],
      fallbackBase: 48_000,
    });
    server = await startMcpLoopbackServer(port);

    await sendJsonRpc({
      port,
      body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      headers: {
        "x-session-key": "agent:main:telegram:group:chat123",
        "x-openclaw-message-channel": "telegram",
        "x-openclaw-account-id": "work",
      },
    });

    const lastCall = groupPolicyMock.mock.calls.at(-1)?.[0] as
      | { sessionKey?: string; messageProvider?: string; accountId?: string | null }
      | undefined;
    expect(lastCall?.sessionKey).toBe("agent:main:telegram:group:chat123");
    expect(lastCall?.messageProvider).toBe("telegram");
    expect(lastCall?.accountId).toBe("work");
  });
});
