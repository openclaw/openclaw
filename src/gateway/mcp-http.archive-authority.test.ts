import { Type } from "typebox";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAdmittedRunOperatorAuthority,
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import { getGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import type { resolveGatewayScopedTools } from "./tool-resolution.js";

const { execute, resolveTools } = vi.hoisted(() => ({
  execute: vi.fn(),
  resolveTools: vi.fn<typeof resolveGatewayScopedTools>(),
}));
vi.mock("../config/io.js", () => {
  const config = {};
  return { getRuntimeConfig: () => config };
});
vi.mock("../agents/agent-tools.before-tool-call.js", () => ({
  runBeforeToolCallHook: async ({ params }: { params: unknown }) => ({ blocked: false, params }),
}));
vi.mock("./tool-resolution.js", () => ({ resolveGatewayScopedTools: resolveTools }));

import {
  activateMcpLoopbackClientGrantCapture,
  mintAttachGrant,
  mintMcpLoopbackClientGrant,
  revokeAttachGrant,
  revokeMcpLoopbackClientGrant,
} from "./mcp-grant-store.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "./mcp-http.js";
import { getActiveMcpLoopbackRuntime } from "./mcp-http.loopback-runtime.js";

const completed = { content: [{ type: "text", text: "authority inspected" }] };
let toolCallerIdentity: ReturnType<typeof getGatewayToolCallerIdentity>;

function activeRuntime() {
  const runtime = getActiveMcpLoopbackRuntime();
  if (!runtime) {
    throw new Error("expected active MCP loopback runtime");
  }
  return runtime;
}

async function sendRequest(
  token: string,
  method: "tools/list" | "tools/call",
  headers: Record<string, string> = {},
) {
  const response = await fetch(`http://127.0.0.1:${activeRuntime().port}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-session-key": "agent:main:archive-authority-spoofed",
      "x-openclaw-sender-is-owner": "true",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      ...(method === "tools/call" ? { params: { name: "authority_probe", arguments: {} } } : {}),
    }),
  });
  const body = await response.text();
  expect(response.status, body).toBe(200);
  return JSON.parse(body);
}

describe("MCP HTTP session archive authority", () => {
  beforeAll(() => ensureMcpLoopbackServer());
  afterAll(closeMcpLoopbackServer);

  beforeEach(() => {
    toolCallerIdentity = undefined;
    execute.mockReset().mockImplementation(async () => {
      toolCallerIdentity = getGatewayToolCallerIdentity();
      return completed;
    });
    resolveTools.mockReset().mockReturnValue({
      agentId: "main",
      workspaceDir: "/workspace/archive-authority",
      captureFinalCronCreatorTools: undefined,
      tools: [
        {
          name: "authority_probe",
          label: "Authority probe",
          description: "Inspect the host-owned source at the MCP tool boundary",
          parameters: Type.Object({}),
          execute,
        },
      ],
    });
  });

  it("forwards the bound admission's exact operator source to discovery and execution", async () => {
    const operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "archive-operator",
      scopes: ["operator.sessions.write"],
      assertCurrent: () => {},
    });
    const runId = "mcp-archive-authority";
    const admission = prepareAgentRunAdmission({
      cfg: {},
      operatorAuthority,
      operationalRunInstance: createOperationalRunInstanceRef(runId),
      facts: {
        runId,
        agentId: "main",
        ingress: { kind: "system", boundary: "mcp-archive-authority-test", state: "present" },
      },
    });
    let grantToken: string | undefined;
    try {
      const admittedRunContext = await admission.admit("gateway", "archive-authority-gateway");
      const runtimeOwnerToken = activeRuntime().ownerToken;
      const sessionKey = "agent:main:archive-authority-bound";
      const grant = mintMcpLoopbackClientGrant({
        context: { sessionKey, agentId: "main", runId, senderIsOwner: false },
        runtimeOwnerToken,
        admittedRunContext,
      });
      grantToken = grant.token;
      const captureKey = "archive-authority-capture";
      expect(
        activateMcpLoopbackClientGrantCapture({
          token: grant.token,
          runtimeOwnerToken,
          captureKey,
        }),
      ).not.toBe(false);
      const headers = { "x-openclaw-cli-capture-key": captureKey };

      expect(await sendRequest(grant.token, "tools/list", headers)).toMatchObject({
        result: { tools: [{ name: "authority_probe" }] },
      });
      expect(resolveTools).toHaveBeenCalledTimes(1);
      expect(resolveTools.mock.calls[0]?.[0]).toMatchObject({ sessionKey, senderIsOwner: false });
      expect(resolveTools.mock.calls[0]?.[0].admittedRunContext).toBe(admittedRunContext);
      expect(execute).not.toHaveBeenCalled();

      expect(await sendRequest(grant.token, "tools/call", headers)).toMatchObject({
        result: { ...completed, isError: false },
      });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(resolveTools).toHaveBeenCalledTimes(1);
      expect(toolCallerIdentity?.operatorAuthority).toBe(operatorAuthority);
      expect(toolCallerIdentity?.operationalRunInstance).toBe(
        admittedRunContext.operationalRunInstance,
      );
      expect(toolCallerIdentity?.sessionKey).toBe(sessionKey);
    } finally {
      if (grantToken) {
        revokeMcpLoopbackClientGrant(grantToken);
      }
      admission.close();
    }
  });

  it.each(["owner", "non-owner", "attach"] as const)(
    "does not invent an operator source from %s credentials or spoofed headers",
    async (kind) => {
      const runtime = activeRuntime();
      const attachGrant =
        kind === "attach"
          ? mintAttachGrant({ sessionKey: "agent:main:archive-authority-attach" })
          : undefined;
      const token =
        attachGrant?.token ?? (kind === "owner" ? runtime.ownerToken : runtime.nonOwnerToken);
      try {
        expect(await sendRequest(token, "tools/list")).toMatchObject({
          result: { tools: [{ name: "authority_probe" }] },
        });
        expect(resolveTools).toHaveBeenCalledTimes(1);
        expect(resolveTools.mock.calls[0]?.[0]).toMatchObject({
          sessionKey: attachGrant?.sessionKey ?? "agent:main:archive-authority-spoofed",
          senderIsOwner: kind === "owner",
        });
        expect(resolveTools.mock.calls[0]?.[0].admittedRunContext).toBeUndefined();

        expect(await sendRequest(token, "tools/call")).toMatchObject({
          result: { ...completed, isError: false },
        });
        expect(execute).toHaveBeenCalledTimes(1);
        expect(toolCallerIdentity?.operatorAuthority).toBeUndefined();
      } finally {
        if (attachGrant) {
          revokeAttachGrant(attachGrant.token);
        }
      }
    },
  );
});
