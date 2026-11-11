import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  type PreparedAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { getGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { markPluginRegistryRetired } from "../plugins/registry-lifecycle.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { bindPluginToolCallbacks } from "../plugins/tool-factory-runtime.js";
import { AsyncWorkScope, getAsyncWorkSignal, trackAsyncWork } from "../shared/async-work-scope.js";
import {
  activateMcpLoopbackClientGrantCapture,
  mintMcpLoopbackClientGrant,
  revokeMcpLoopbackClientGrant,
} from "./mcp-grant-store.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "./mcp-http.js";
import { getActiveMcpLoopbackRuntime } from "./mcp-http.loopback-runtime.js";

const fixture = vi.hoisted(() => ({ tools: [] as AnyAgentTool[] }));
// mock-isolation: Resolve the fixture session without opening a session store.
vi.mock("../config/sessions/session-accessor.js", () => ({
  resolveSessionEntryAccessTarget: () => ({ entry: undefined }),
}));
// mock-isolation: Report no paired nodes instead of probing the host.
vi.mock("../agents/node-exec-availability.js", () => ({
  loadNodeExecAvailability: async () => ({ cacheKey: "no-nodes", isAvailable: () => false }),
}));
// mock-isolation: Run tools without the host before-tool-call policy chain.
vi.mock("../agents/agent-tools.before-tool-call.js", () => ({
  runBeforeToolCallHook: async ({ params }: { params: unknown }) => ({ blocked: false, params }),
}));
// mock-isolation: Run with no global plugin hooks registered.
vi.mock("../plugins/hook-runner-global.js", () => ({ getGlobalHookRunner: () => null }));
// mock-isolation: Serve the fixture tool set instead of resolving host tools.
vi.mock("./tool-resolution.js", () => ({
  resolveGatewayScopedTools: () => ({ agentId: "main", tools: fixture.tools }),
}));

const admissions: PreparedAgentRunAdmission[] = [];
beforeEach(() => {
  setRuntimeConfigSnapshot({});
});
afterEach(async () => {
  await closeMcpLoopbackServer();
  clearRuntimeConfigSnapshot();
  for (const admission of admissions.splice(0)) {
    admission.close();
  }
  fixture.tools = [];
});

function pluginFixture(execute: AnyAgentTool["execute"]) {
  const registry = createEmptyPluginRegistry();
  registry.plugins.push(createPluginRecord({ id: "memory-fixture" }));
  const tool: AnyAgentTool = {
    name: "memory_search",
    label: "Memory search",
    description: "Search fixture memory",
    parameters: Type.Object({}),
    execute,
  };
  fixture.tools = [
    bindPluginToolCallbacks(
      {
        pluginId: "memory-fixture",
        source: "/fixture/memory.ts",
        names: [tool.name],
        optional: false,
        factory: () => tool,
      },
      registry,
      tool,
    ),
    {
      ...tool,
      name: "session_status",
      execute: async () => ({ content: [{ type: "text", text: "core ok" }], details: {} }),
    },
  ];
  return registry;
}

async function cliTurn(runId: string, sessionKey = "agent:main:heartbeat") {
  await ensureMcpLoopbackServer();
  const runtime = getActiveMcpLoopbackRuntime();
  if (!runtime) {
    throw new Error("Missing loopback runtime");
  }
  const admission = prepareAgentRunAdmission({
    cfg: {},
    facts: {
      runId,
      agentId: "main",
      ingress: { kind: "system", boundary: "mcp-work-scope-test", state: "present" },
    },
    operationalRunInstance: createOperationalRunInstanceRef(runId),
  });
  admissions.push(admission);
  const grant = mintMcpLoopbackClientGrant({
    runtimeOwnerToken: runtime.ownerToken,
    admittedRunContext: await admission.admit("gateway", `gateway-${runId}`),
    context: {
      runId,
      sessionKey,
      senderIsOwner: true,
      toolsAllow: ["memory_search", "session_status"],
    },
  });
  const captureKey = `capture-${runId}`;
  activateMcpLoopbackClientGrantCapture({
    token: grant.token,
    runtimeOwnerToken: runtime.ownerToken,
    captureKey,
  });
  return {
    runtime,
    close: () => {
      admission.close();
      revokeMcpLoopbackClientGrant(grant.token);
    },
    call: async (name: string) => {
      const response = await fetch(`http://127.0.0.1:${runtime.port}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${grant.token}`,
          "content-type": "application/json",
          "x-openclaw-cli-capture-key": captureKey,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: {} },
        }),
      });
      return { status: response.status, body: (await response.json()) as unknown };
    },
  };
}

const pluginOk = {
  status: 200,
  body: { result: { content: [{ type: "text", text: "plugin ok" }] } },
};

describe("MCP loopback work ownership", () => {
  it("keeps plugin calls live across the starter turn closing and later CLI grants", async () => {
    const callerRuns: unknown[] = [];
    const execute = vi.fn(async () => {
      callerRuns.push(getGatewayToolCallerIdentity()?.operationalRunInstance);
      return { content: [{ type: "text" as const, text: "plugin ok" }], details: {} };
    });
    const registry = pluginFixture(execute);
    const firstWork = new AsyncWorkScope();
    const first = await firstWork.track(() => cliTurn("first"));
    expect(await first.call("memory_search")).toMatchObject(pluginOk);
    first.close();
    await firstWork.drain();

    for (const [runId, sessionKey] of [
      ["next-turn", "agent:main:heartbeat"],
      ["other-session", "agent:other:heartbeat"],
    ] as const) {
      const turn = await cliTurn(runId, sessionKey);
      expect(turn.runtime).toEqual(first.runtime);
      expect(await turn.call("session_status")).toMatchObject({
        body: { result: { content: [{ type: "text", text: "core ok" }] } },
      });
      expect(await turn.call("memory_search")).toMatchObject(pluginOk);
      turn.close();
      expect((await turn.call("memory_search")).status).toBe(401);
    }
    expect(execute).toHaveBeenCalledTimes(3);
    expect(new Set(callerRuns).size).toBe(3);

    const final = await cliTurn("retired-plugin");
    markPluginRegistryRetired(registry);
    const retired = await final.call("memory_search");
    expect(retired.body).toMatchObject({ result: { isError: true } });
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("joins plugin cleanup tails when the loopback runtime closes", async () => {
    const release = createDeferred();
    let workSignal: AbortSignal | undefined;
    let descendant: Promise<void> | undefined;
    pluginFixture(async () => {
      workSignal = getAsyncWorkSignal();
      if (!workSignal) {
        throw new Error("Plugin work needs a runtime owner");
      }
      descendant = trackAsyncWork(() => release.promise);
      return { content: [{ type: "text", text: "plugin ok" }], details: {} };
    });
    const firstWork = new AsyncWorkScope();
    const turn = await firstWork.track(() => cliTurn("cleanup"));
    let closed = false;
    try {
      expect(await turn.call("memory_search")).toMatchObject(pluginOk);
      const shutdown = closeMcpLoopbackServer().then(() => {
        closed = true;
      });
      expect(workSignal?.aborted).toBe(true);
      expect(closed).toBe(false);
      release.resolve();
      await shutdown;
      expect(closed).toBe(true);
    } finally {
      release.resolve();
      await descendant;
      await firstWork.drain();
    }
  });

  it("aborts a pending cooperating tool call when the loopback runtime closes", async () => {
    const started = createDeferred();
    let toolAborted = false;
    pluginFixture(async (_toolCallId, _params, signal) => {
      started.resolve();
      await new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      toolAborted = true;
      return { content: [{ type: "text", text: "plugin ok" }], details: {} };
    });
    const firstWork = new AsyncWorkScope();
    const turn = await firstWork.track(() => cliTurn("pending-close"));
    try {
      const pending = turn.call("memory_search");
      await started.promise;
      // Without runtime shutdown reaching the tool signal, this waits on the open response.
      await closeMcpLoopbackServer();
      expect(toolAborted).toBe(true);
      await pending;
    } finally {
      turn.close();
      await firstWork.drain();
    }
  });
});
