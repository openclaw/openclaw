import { Type } from "typebox";
import { beforeEach, expect, it, vi } from "vitest";
import { getGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import type { resolveGatewayScopedTools } from "./tool-resolution.js";

const resolveTools = vi.hoisted(() => vi.fn<typeof resolveGatewayScopedTools>());
vi.mock("../config/io.js", () => {
  const config = {};
  return { getRuntimeConfig: () => config };
});
vi.mock("../agents/agent-tools.before-tool-call.js", () => ({
  runBeforeToolCallHook: async ({ params }: { params: unknown }) => ({ blocked: false, params }),
}));
vi.mock("./tool-resolution.js", () => ({ resolveGatewayScopedTools: resolveTools }));

import { mintAttachGrant, revokeAttachGrant } from "./mcp-grant-store.js";
import * as mcp from "./mcp-http.test-support.js";

const completed = { content: [{ type: "text" as const, text: "authority inspected" }] };
const activeRuntime = mcp.useLoopbackServerForTest();
const execute = vi.fn(async () => {
  expect(getGatewayToolCallerIdentity()?.operatorAuthority).toBeUndefined();
  return { ...completed, details: {} };
});

async function sendRequest(token: string, method: "tools/list" | "tools/call") {
  const response = await mcp.sendRaw({
    port: activeRuntime().port,
    token,
    headers: mcp.jsonHeaders({
      "x-session-key": "agent:main:archive-authority-spoofed",
      "x-openclaw-sender-is-owner": "true",
    }),
    body: method === "tools/call" ? mcp.mcpToolCallBody("authority_probe") : mcp.mcpToolsListBody(),
  });
  const body = await response.text();
  expect(response.status, body).toBe(200);
  return JSON.parse(body);
}

beforeEach(() => {
  execute.mockClear();
  resolveTools.mockReset().mockResolvedValue(
    mcp.scopedToolFixture(
      [
        {
          name: "authority_probe",
          label: "Authority probe",
          description: "Inspect the host-owned source at the MCP tool boundary",
          parameters: Type.Object({}),
          execute,
        },
      ],
      "/workspace/archive-authority",
    ),
  );
});

it.each(["owner", "attach"] as const)(
  "does not invent an operator source from %s credentials or spoofed headers",
  async (kind) => {
    const attachGrant =
      kind === "attach"
        ? mintAttachGrant({ sessionKey: "agent:main:archive-authority-attach" })
        : undefined;
    const token = attachGrant?.token ?? activeRuntime().ownerToken;
    try {
      expect(await sendRequest(token, "tools/list")).toMatchObject({
        result: { tools: [{ name: "authority_probe" }] },
      });
      expect(resolveTools).toHaveBeenCalledTimes(1);
      expect(resolveTools.mock.calls[0]?.[0]).toMatchObject({
        sessionKey: attachGrant?.sessionKey ?? "agent:main:archive-authority-spoofed",
        senderIsOwner: kind === "owner",
        admittedRunContext: undefined,
      });

      expect(await sendRequest(token, "tools/call")).toMatchObject({
        result: { ...completed, isError: false },
      });
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      if (attachGrant) {
        revokeAttachGrant(attachGrant.token);
      }
    }
  },
);
