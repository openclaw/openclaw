import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Type } from "typebox";
import { beforeEach, expect, it, vi } from "vitest";
import type { OpenClawToolsOptions } from "../agents/openclaw-tools.types.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type { GatewayMethodRegistry } from "./methods/registry.js";
import type { GatewayContextResolver } from "./server-methods/types.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams } from "./server-request-context.test-support.js";
import type { handleToolsInvokeHttpRequest } from "./tools-invoke-http.js";

let useRealSessionSpawnTool = false;

export async function createToolsInvokeSessionSpawnFixture(
  options: OpenClawToolsOptions,
): Promise<AnyAgentTool> {
  if (useRealSessionSpawnTool) {
    const { createSessionsSpawnTool } = await import("../agents/tools/sessions-spawn-tool.js");
    return createSessionsSpawnTool(options);
  }
  return {
    name: "sessions_spawn",
    label: "Spawn",
    description: "HTTP spawn context fixture",
    parameters: Type.Object({}),
    execute: async () => ({
      content: [],
      details: {},
      ok: true,
      route: { agentTo: options.agentTo, agentThreadId: options.agentThreadId },
      inheritedToolDenylist: options.inheritedToolDenylist,
    }),
  };
}

export function registerToolsInvokeSpawnWorkspaceTests(params: {
  sessionEntries: Map<string, Record<string, unknown>>;
  setConfig: (config: Record<string, unknown>) => void;
  invoke: (input: {
    tool: string;
    args: Record<string, unknown>;
    sessionKey: string;
  }) => Promise<Response>;
}) {
  beforeEach(() => {
    useRealSessionSpawnTool = false;
  });
  it.each([
    { name: "restricted rootless workspace", restricted: true, explicitRoot: false },
    { name: "restricted explicit root", restricted: true, explicitRoot: true },
    { name: "unrestricted inherited tools", restricted: false, explicitRoot: true },
  ])("preserves the HTTP hidden-spawn boundary for $name", async (scenario) => {
    const configuredWorkspace = "/tmp/http-configured-agent-workspace";
    const storedWorkspace = "/tmp/http-requester-workspace";
    const explicitRoot = "/tmp/http-requester-workspace/scoped";
    const sessionKey = "agent:main:subagent:http-requester";
    params.setConfig({
      agents: { entries: { main: { workspace: configuredWorkspace } } },
      tools: { allow: ["read", "sessions_spawn"] },
      gateway: { tools: { allow: ["sessions_spawn"] } },
    });
    params.sessionEntries.set(sessionKey, {
      sessionId: "http-requester-session",
      updatedAt: 1,
      spawnedBy: "agent:main:main",
      spawnDepth: 1,
      inheritedToolPolicyVersion: 1,
      ...(scenario.restricted ? { inheritedToolPolicySource: "sender" } : {}),
      inheritedToolAllow: ["read", "sessions_spawn"],
      spawnedWorkspaceDir: storedWorkspace,
      permissionMode: "guarded",
      ...(scenario.explicitRoot ? { sessionRoot: explicitRoot } : {}),
    });
    const spawnRuntime = await import("../agents/subagents/spawn/subagent-spawn.js");
    using spawn = vi.spyOn(spawnRuntime, "spawnSubagentDirect").mockResolvedValue({
      status: "accepted",
      context: "isolated",
      childSessionKey: "agent:main:subagent:http-helper",
      runId: "http-helper-run",
    });
    useRealSessionSpawnTool = true;
    const response = await params.invoke({
      tool: "sessions_spawn",
      sessionKey,
      args: { task: "Inspect the inherited workspace", agentId: "main", visible: false },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      result: { details: { status: "accepted" } },
    });
    expect(spawn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ task: "Inspect the inherited workspace", agentId: "main" }),
      expect.objectContaining({
        agentSessionKey: sessionKey,
        inheritedToolPolicySource: scenario.restricted ? "sender" : undefined,
        workspaceDir: scenario.restricted ? storedWorkspace : configuredWorkspace,
        sessionPermissionPolicy: scenario.restricted
          ? { mode: "guarded", root: scenario.explicitRoot ? explicitRoot : storedWorkspace }
          : undefined,
      }),
    );
  });
}

/** Shared loopback transport with an independently reset Gateway context for each test. */
export function createToolsInvokeHttpTestServer(params: {
  handleToolsInvoke: typeof handleToolsInvokeHttpRequest;
  getPluginHandlers?: () => ReadonlyArray<
    (req: IncomingMessage, res: ServerResponse) => Promise<boolean>
  >;
}) {
  let resolveGatewayContext: GatewayContextResolver | undefined;
  const server = createServer((req, res) => {
    void (async () => {
      if (
        await params.handleToolsInvoke(req, res, {
          auth: { mode: "none", allowTailscale: false },
          resolveGatewayContext,
        })
      ) {
        return;
      }
      for (const handler of params.getPluginHandlers?.() ?? []) {
        if (await handler(req, res)) {
          return;
        }
      }
      res.statusCode = 404;
      res.end("not found");
    })().catch((error: unknown) => {
      res.statusCode = 500;
      res.end(String(error));
    });
  });
  return {
    async listen() {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected loopback HTTP server address");
      }
      return address.port;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
    setMethodRegistry(this: void, registry: GatewayMethodRegistry) {
      const context = resolveGatewayContext?.();
      if (!context) {
        throw new Error("Expected initialized Gateway context");
      }
      context.getGatewayMethodRegistry = () => registry;
    },
    resetContext() {
      const context = createGatewayRequestContext(makeContextParams());
      resolveGatewayContext = () => context;
      context.resolveGatewayContext = resolveGatewayContext;
    },
  };
}

export const expectOkInvokeResponse = async (res: Response) => {
  expect(res.status).toBe(200);
  const body: unknown = await res.json();
  if (
    !isRecord(body) ||
    typeof body.ok !== "boolean" ||
    (body.result !== undefined && !isRecord(body.result))
  ) {
    throw new Error("Expected an object tool response");
  }
  expect(body.ok).toBe(true);
  return { ok: body.ok, result: body.result };
};
