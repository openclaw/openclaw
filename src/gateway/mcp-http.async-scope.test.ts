import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  type PreparedAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import {
  isGatewaySubordinateWorkAdmissionClosed,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { AsyncWorkScope, getAsyncWorkSignal, trackAsyncWork } from "../shared/async-work-scope.js";

const { execute, resolveTools } = vi.hoisted(() => ({ execute: vi.fn(), resolveTools: vi.fn() }));
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
  mintMcpLoopbackClientGrant,
} from "./mcp-grant-store.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "./mcp-http.js";
import { getActiveMcpLoopbackRuntime } from "./mcp-http.loopback-runtime.js";

const completed = { content: [{ type: "text", text: "tracked tool completed" }] };
const executionScopes: Array<AbortSignal | undefined> = [];
const constructionScopes: Array<AbortSignal | undefined> = [];

beforeEach(() => {
  executionScopes.length = 0;
  constructionScopes.length = 0;
  execute.mockReset().mockImplementation(() => {
    executionScopes.push(getAsyncWorkSignal());
    return trackAsyncWork(() => {
      expect(isGatewaySubordinateWorkAdmissionClosed()).toBe(false);
      return completed;
    });
  });
  resolveTools.mockReset().mockImplementation(() => {
    constructionScopes.push(getAsyncWorkSignal());
    return {
      agentId: "main",
      tools: [
        {
          name: "scope_probe",
          label: "Scope probe",
          description: "Synthetic tracked tool for lifecycle proof",
          parameters: { type: "object", properties: {} },
          execute,
        },
      ],
    };
  });
});

const admissions: PreparedAgentRunAdmission[] = [];

afterEach(async () => {
  await closeMcpLoopbackServer();
  for (const admission of admissions.splice(0)) {
    admission.close();
  }
});

async function callTool(grant?: { token: string; captureKey: string }) {
  const runtime = getActiveMcpLoopbackRuntime();
  if (!runtime) {
    throw new Error("MCP runtime missing");
  }
  const response = await fetch(`http://127.0.0.1:${runtime.port}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${grant?.token ?? runtime.ownerToken}`,
      "content-type": "application/json",
      "x-session-key": "agent:main:scope-proof",
      ...(grant ? { "x-openclaw-cli-capture-key": grant.captureKey } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "scope_probe", arguments: {} },
    }),
  });
  expect(response.status).toBe(200);
  return response.json();
}

async function startFromCaller() {
  const scope = new AsyncWorkScope();
  const admission = tryBeginGatewayRootWorkAdmission("mcp-scope-test");
  if (!admission) {
    throw new Error("Caller admission unavailable");
  }
  try {
    await admission.run(() => scope.track(() => ensureMcpLoopbackServer()));
    return scope;
  } finally {
    admission.release();
  }
}

describe("MCP HTTP work ownership", () => {
  it.each([false, true])(
    "serves fresh request scopes after its creator closes (replacement=%s)",
    async (replace) => {
      if (replace) {
        const predecessor = await startFromCaller();
        await Promise.all([closeMcpLoopbackServer(), closeMcpLoopbackServer()]);
        await predecessor.drain();
      }
      const creator = await startFromCaller();
      await creator.drain();
      expect(await callTool()).toMatchObject({ result: { ...completed, isError: false } });
      expect(await callTool()).toMatchObject({ result: { ...completed, isError: false } });
      expect(resolveTools).toHaveBeenCalledTimes(1);
      expect(constructionScopes[0]).toBeDefined();
      expect(constructionScopes[0]?.aborted).toBe(false);
      expect(constructionScopes[0]).not.toBe(creator.signal);
      expect(executionScopes[0]).toBeDefined();
      expect(executionScopes[1]).toBeDefined();
      expect(executionScopes[0]).not.toBe(executionScopes[1]);
      for (const signal of executionScopes) {
        expect(signal).not.toBe(constructionScopes[0]);
        expect(signal?.aborted).toBe(true);
      }
      await closeMcpLoopbackServer();
      expect(constructionScopes[0]?.aborted).toBe(true);
    },
  );

  it("does not retain the Gateway caller of the request that started it", async () => {
    const observed: unknown[] = [];
    execute.mockImplementation(() => {
      const scope = getPluginRuntimeGatewayRequestScope();
      observed.push({
        client: scope?.client,
        resolveGatewayContext: scope?.resolveGatewayContext,
        callerAgentId: getGatewayToolCallerIdentity()?.agentId,
      });
      return completed;
    });
    const resolveGatewayContext = vi.fn();
    // A restart-recovery continuation is a write-only system caller; a later owner
    // turn must not be capped by it just because it happened to start the listener.
    const starter = {
      connect: { role: "operator", scopes: ["operator.write"] },
    } as unknown as NonNullable<
      Parameters<typeof withPluginRuntimeGatewayRequestScope>[0]["client"]
    >;
    await withGatewayToolCallerIdentity(
      { agentId: "starter", sessionKey: "agent:starter:recovery" } as NonNullable<
        Parameters<typeof withGatewayToolCallerIdentity>[0]
      >,
      () =>
        withPluginRuntimeGatewayRequestScope(
          { client: starter, resolveGatewayContext, isWebchatConnect: () => false },
          () => ensureMcpLoopbackServer(),
        ),
    );

    expect(await callTool()).toMatchObject({ result: { ...completed, isError: false } });
    expect(observed).toEqual([
      { client: undefined, resolveGatewayContext, callerAgentId: undefined },
    ]);
  });

  it("runs each CLI grant's tool calls in the request scope that minted it", async () => {
    type ScopeClient = NonNullable<
      Parameters<typeof withPluginRuntimeGatewayRequestScope>[0]["client"]
    >;
    const clientWith = (scope: string) =>
      ({ connect: { role: "operator", scopes: [scope] } }) as unknown as ScopeClient;
    const scopeFor = (client: ScopeClient) => ({ client, isWebchatConnect: () => false });
    const observed: unknown[] = [];
    execute.mockImplementation(() => {
      observed.push(getPluginRuntimeGatewayRequestScope()?.client);
      return completed;
    });
    // A write-only restart-recovery run starts the listener. A later owner run must see
    // its own client, and the recovery run must stay capped by its own.
    const recovery = clientWith("operator.write");
    const owner = clientWith("operator.admin");
    await withPluginRuntimeGatewayRequestScope(scopeFor(recovery), () => ensureMcpLoopbackServer());
    const runtime = getActiveMcpLoopbackRuntime();
    if (!runtime) {
      throw new Error("MCP runtime missing");
    }
    const callForRun = async (runId: string, client?: ScopeClient) => {
      const admission = prepareAgentRunAdmission({
        cfg: {},
        facts: {
          runId,
          agentId: "main",
          ingress: { kind: "system", boundary: "mcp-scope-test", state: "present" },
        },
        operationalRunInstance: createOperationalRunInstanceRef(runId),
      });
      admissions.push(admission);
      const admittedRunContext = await admission.admit("gateway", `gateway-${runId}`);
      const mint = () =>
        mintMcpLoopbackClientGrant({
          context: { sessionKey: "agent:main:scope-proof", senderIsOwner: true },
          runtimeOwnerToken: runtime.ownerToken,
          admittedRunContext,
        });
      const { token } = client
        ? withPluginRuntimeGatewayRequestScope(scopeFor(client), mint)
        : mint();
      const captureKey = `capture-${runId}`;
      expect(
        activateMcpLoopbackClientGrantCapture({
          token,
          runtimeOwnerToken: runtime.ownerToken,
          captureKey,
        }),
      ).toBeTruthy();
      expect(await callTool({ token, captureKey })).toMatchObject({
        result: { ...completed, isError: false },
      });
    };

    await callForRun("run-owner", owner);
    await callForRun("run-recovery", recovery);
    await callForRun("run-unscoped");

    expect(observed).toEqual([owner, recovery, undefined]);
  });

  it("joins accepted tool cleanup without closing a replacement listener", async () => {
    const releaseCleanup = createDeferred();
    const cleanupStarted = createDeferred();
    let cleanup: Promise<unknown> | undefined;
    execute.mockImplementationOnce(() => {
      cleanup = trackAsyncWork(async () => {
        cleanupStarted.resolve();
        await releaseCleanup.promise;
        return trackAsyncWork(() => completed);
      });
      return completed;
    });
    await ensureMcpLoopbackServer();
    let closed = false;
    let closing: Promise<void> | undefined;
    try {
      expect(await callTool()).toMatchObject({ result: { isError: false } });
      await cleanupStarted.promise;
      closing = closeMcpLoopbackServer().then(() => {
        closed = true;
      });
      await ensureMcpLoopbackServer();
      expect(await callTool()).toMatchObject({ result: { isError: false } });
      expect(closed).toBe(false);
      releaseCleanup.resolve();
      await closing;
      await expect(cleanup).resolves.toEqual(completed);
      expect(await callTool()).toMatchObject({ result: { isError: false } });
    } finally {
      releaseCleanup.resolve();
      await cleanup;
      await closing;
    }
  });
});
