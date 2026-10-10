import { Type } from "typebox";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import { getGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { callInProcessGatewayTool } from "../agents/tools/in-process-gateway.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  getActiveGatewayRootWorkCount,
  tryBeginGatewayRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
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
  deactivateMcpLoopbackClientGrantCapture,
  mintMcpLoopbackClientGrant,
  revokeMcpLoopbackClientGrant,
  mintAttachGrant,
  revokeAttachGrant,
} from "./mcp-grant-store.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "./mcp-http.js";
import { getActiveMcpLoopbackRuntime } from "./mcp-http.loopback-runtime.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";

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
  expectedStatus = 200,
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
  expect(response.status, body).toBe(expectedStatus);
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
    resolveTools.mockReset().mockResolvedValue({
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

  it("continues an admitted turn's native RPC during drain and releases its completed capture", async () => {
    const root = tryBeginGatewayRootWorkAdmission("mcp-existing-turn");
    if (!root) {
      throw new Error("expected accepting admission");
    }
    const admission = prepareAgentRunAdmission({
      cfg: {},
      operationalRunInstance: createOperationalRunInstanceRef("mcp-existing-turn"),
      facts: {
        runId: "mcp-existing-turn",
        agentId: "main",
        ingress: { kind: "system", boundary: "mcp-continuation-test", state: "present" },
      },
    });
    const context = createContext();
    context.resolveGatewayContext = () => context;
    const handler = vi.fn(({ respond }: GatewayRequestHandlerOptions) =>
      respond(true, { jobs: [] }),
    );
    context.getGatewayMethodRegistry = () =>
      createGatewayMethodRegistry([
        {
          name: "cron.list",
          scope: "operator.read",
          owner: { kind: "core", area: "cron" },
          handler,
        },
      ]);
    let token: string | undefined;
    let unrootedToken: string | undefined;
    let unrootedAdmission: ReturnType<typeof prepareAgentRunAdmission> | undefined;
    let suspension: ReturnType<typeof tryBeginGatewaySuspendAdmission> = null;
    const captureKey = "mcp-continuation-capture";
    try {
      const admittedRunContext = await admission.admit("gateway");
      const runtimeOwnerToken = activeRuntime().ownerToken;
      await root.run(async () =>
        withPluginRuntimeGatewayRequestScope(
          {
            resolveGatewayContext: context.resolveGatewayContext,
            isWebchatConnect: () => false,
          },
          () => {
            token = mintMcpLoopbackClientGrant({
              runtimeOwnerToken,
              admittedRunContext,
              context: {
                sessionKey: "agent:main:mcp-existing-turn",
                agentId: "main",
                runId: "mcp-existing-turn",
                senderIsOwner: false,
              },
            }).token;
            expect(
              activateMcpLoopbackClientGrantCapture({ token, runtimeOwnerToken, captureKey }),
            ).not.toBe(false);
          },
        ),
      );
      execute.mockImplementation(async () => {
        expect(getGatewayToolCallerIdentity()?.operatorAuthority).toBeUndefined();
        expect(await callInProcessGatewayTool("cron.list", {})).toEqual({ jobs: [] });
        return completed;
      });
      suspension = tryBeginGatewaySuspendAdmission(() => {});
      expect(suspension?.drain()).toBe(true);
      root.release();
      const headers = { "x-openclaw-cli-capture-key": captureKey };
      expect(await sendRequest(token!, "tools/call", headers)).toMatchObject({
        result: { ...completed, isError: false },
      });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      admission.close();
      await sendRequest(token!, "tools/call", headers, 401);
      expect(
        deactivateMcpLoopbackClientGrantCapture({ token: token!, runtimeOwnerToken, captureKey }),
      ).toBe(true);
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      unrootedAdmission = prepareAgentRunAdmission({
        cfg: {},
        operationalRunInstance: createOperationalRunInstanceRef("mcp-unrooted-turn"),
        facts: {
          runId: "mcp-unrooted-turn",
          agentId: "main",
          ingress: { kind: "system", boundary: "mcp-continuation-test", state: "present" },
        },
      });
      const unrootedContext = await unrootedAdmission.admit("gateway");
      withPluginRuntimeGatewayRequestScope(
        { resolveGatewayContext: context.resolveGatewayContext, isWebchatConnect: () => false },
        () => {
          unrootedToken = mintMcpLoopbackClientGrant({
            runtimeOwnerToken,
            admittedRunContext: unrootedContext,
            context: {
              sessionKey: "agent:main:mcp-unrooted-turn",
              agentId: "main",
              runId: "mcp-unrooted-turn",
              senderIsOwner: false,
            },
          }).token;
          expect(
            activateMcpLoopbackClientGrantCapture({
              token: unrootedToken,
              runtimeOwnerToken,
              captureKey,
            }),
          ).not.toBe(false);
        },
      );
      expect(await sendRequest(unrootedToken!, "tools/call", headers)).toMatchObject({
        result: {
          isError: true,
          content: [
            {
              type: "text",
              text: expect.stringContaining("unavailable during gateway suspension"),
            },
          ],
        },
      });
      expect(handler).toHaveBeenCalledTimes(1);
      revokeMcpLoopbackClientGrant(unrootedToken!);
      await sendRequest(unrootedToken!, "tools/call", headers, 401);
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      if (token) {
        revokeMcpLoopbackClientGrant(token);
      }
      if (unrootedToken) {
        revokeMcpLoopbackClientGrant(unrootedToken);
      }
      unrootedAdmission?.close();
      admission.close();
      root.release();
      suspension?.release();
    }
  });

  it.each(["owner", "attach"] as const)(
    "does not invent an operator source from %s credentials or spoofed headers",
    async (kind) => {
      const runtime = activeRuntime();
      const attachGrant =
        kind === "attach"
          ? mintAttachGrant({ sessionKey: "agent:main:archive-authority-attach" })
          : undefined;
      const token = attachGrant?.token ?? runtime.ownerToken;
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
