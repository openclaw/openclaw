import { AsyncLocalStorage } from "node:async_hooks";
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
  resolveSessionTranscriptReadFence,
  runWithSessionTranscriptReadFence,
} from "../config/sessions/session-transcript-read-fence.js";
import { readOnlyWorkerScope } from "../infra/sqlite-readonly-worker-context.js";
import { createSqliteReadOnlyWorkerScope } from "../infra/sqlite-readonly-worker.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import {
  isGatewaySubordinateWorkAdmissionClosed,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../sessions/user-turn-transcript.types.js";
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
  revokeMcpLoopbackClientGrant,
} from "./mcp-grant-store.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "./mcp-http.js";
import { getActiveMcpLoopbackRuntime } from "./mcp-http.loopback-runtime.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import {
  readOperatorToolGatewayAuthority,
  runWithOperatorToolGatewayAuthority,
} from "./operator-tool-gateway-authority.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { withOperatorToolGatewayAuthority } from "./server-plugin-in-process-authority.js";
import { dispatchGatewayMethodInProcessRaw } from "./server-plugin-in-process-dispatch.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";

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
  it("does not inherit an expired operator-tool invocation from its listener creator", async () => {
    const lifetime = new AbortController();
    execute.mockImplementation(() => {
      const inherited = readOperatorToolGatewayAuthority();
      inherited?.signal.throwIfAborted();
      expect(inherited).toBeUndefined();
      return completed;
    });
    await runWithOperatorToolGatewayAuthority(
      { scopes: ["operator.write"], signal: lifetime.signal },
      () => ensureMcpLoopbackServer(),
    );
    lifetime.abort(new Error("operator tool invocation authority expired"));
    expect(await callTool()).toMatchObject({ result: { ...completed, isError: false } });
  });

  it("serves fresh request scopes after its replacement creator closes", async () => {
    const predecessor = await startFromCaller();
    await Promise.all([closeMcpLoopbackServer(), closeMcpLoopbackServer()]);
    await predecessor.drain();
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
  });

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
    const starter = createSyntheticPluginRuntimeClient({ scopes: ["operator.write"] });
    await withGatewayToolCallerIdentity(
      { agentId: "starter", sessionKey: "agent:starter:recovery" },
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

  it("keeps Gateway readers while shedding the starting turn's async stores", async () => {
    const session = { agentId: "main", sessionId: "first-turn-session" };
    const receipt: UserTurnTranscriptAdmissionReceipt = {
      ...session,
      sessionKey: "agent:main:first-turn",
      storePath: "first-turn-store",
      generation: "first-turn-generation",
      entryId: "first-turn-user",
      rawSeq: 1,
      effectiveParentId: null,
      activeMessagePosition: 0,
      logicalTurnId: "first-turn",
      role: "user",
    };
    // Stands in for turn-local stores this listener does not name explicitly.
    const turnLocal = new AsyncLocalStorage<string>();
    const readers = createSqliteReadOnlyWorkerScope();
    const readerContext = readers.run(() => readOnlyWorkerScope.getStore());
    const observed: unknown[] = [];
    execute.mockImplementation(() => {
      observed.push([
        resolveSessionTranscriptReadFence(session),
        turnLocal.getStore(),
        readOnlyWorkerScope.getStore(),
      ]);
      return completed;
    });
    try {
      await readers.run(() =>
        turnLocal.run("first-turn", () =>
          runWithSessionTranscriptReadFence(receipt, () => {
            expect(resolveSessionTranscriptReadFence(session)).toBe(receipt);
            return ensureMcpLoopbackServer();
          }),
        ),
      );
      expect(await callTool()).toMatchObject({ result: { ...completed, isError: false } });
      expect(observed).toEqual([[undefined, undefined, readerContext]]);
    } finally {
      await closeMcpLoopbackServer();
      await readers.close();
    }
  });

  it("keeps each CLI grant's own ceiling and liveness for an admin dispatch after a write-only starter", async () => {
    const adminDispatch = vi.fn(({ respond }: GatewayRequestHandlerOptions) => {
      respond(true, { allowed: true });
    });
    const registry = createGatewayMethodRegistry([
      {
        name: "scope.probe",
        owner: { kind: "core", area: "scope-proof" },
        scope: "operator.admin",
        handler: adminDispatch,
      },
    ]);
    const context = createDirectChatContext({
      getRuntimeConfig: () => ({}),
      getGatewayMethodRegistry: () => registry,
    });
    const scopeFor = (
      client: ReturnType<typeof createSyntheticPluginRuntimeClient>,
      isCurrent: () => boolean,
    ) => ({
      client,
      isWebchatConnect: () => false,
      resolveGatewayContext: () => context,
      hasCurrentClientAuthority: isCurrent,
    });
    const writeOnly = createSyntheticPluginRuntimeClient({ scopes: ["operator.write"] });
    const admin = createSyntheticPluginRuntimeClient({ scopes: ["operator.admin"] });
    let ownerCurrent = true;
    execute.mockImplementation(async () => {
      const result = await dispatchGatewayMethodInProcessRaw(
        "scope.probe",
        {},
        { resolveGatewayContext: () => context },
      );
      return {
        content: [{ type: "text", text: result.ok ? "admin-dispatched" : result.error?.message }],
      };
    });
    // A write-only restart-recovery run starts the listener with its operator authority.
    await withPluginRuntimeGatewayRequestScope(
      scopeFor(writeOnly, () => true),
      () =>
        withOperatorToolGatewayAuthority({ scopes: ["operator.write"] }, () =>
          ensureMcpLoopbackServer(),
        ),
    );
    const runtime = getActiveMcpLoopbackRuntime();
    if (!runtime) {
      throw new Error("MCP runtime missing");
    }
    const admit = async (
      runId: string,
      client: ReturnType<typeof createSyntheticPluginRuntimeClient>,
      isCurrent: () => boolean,
    ) => {
      const admission = prepareAgentRunAdmission({
        cfg: {},
        facts: {
          runId,
          agentId: "main",
          ingress: { kind: "system", boundary: "mcp-scope-proof", state: "present" },
        },
        operationalRunInstance: createOperationalRunInstanceRef(runId),
      });
      admissions.push(admission);
      const admittedRunContext = await admission.admit("gateway", `gateway-${runId}`);
      const grant = withPluginRuntimeGatewayRequestScope(scopeFor(client, isCurrent), () =>
        mintMcpLoopbackClientGrant({
          context: { sessionKey: "agent:main:scope-proof", senderIsOwner: true },
          runtimeOwnerToken: runtime.ownerToken,
          admittedRunContext,
        }),
      );
      const captureKey = `capture-${runId}`;
      expect(
        activateMcpLoopbackClientGrantCapture({
          token: grant.token,
          runtimeOwnerToken: runtime.ownerToken,
          captureKey,
        }),
      ).toBeTruthy();
      return { token: grant.token, captureKey };
    };
    const ownerGrant = await admit("mcp-owner", admin, () => ownerCurrent);
    const recoveryGrant = await admit("mcp-recovery", writeOnly, () => true);

    expect(await callTool(ownerGrant)).toMatchObject({
      result: { content: [{ text: "admin-dispatched" }], isError: false },
    });
    expect(await callTool(recoveryGrant)).toMatchObject({
      result: { content: [{ text: "missing scope: operator.admin" }] },
    });
    expect(adminDispatch).toHaveBeenCalledTimes(1);

    ownerCurrent = false;
    expect(await callTool(ownerGrant)).toMatchObject({
      result: {
        content: [{ text: "Gateway requester authority changed" }],
      },
    });
    expect(adminDispatch).toHaveBeenCalledTimes(1);
    expect(revokeMcpLoopbackClientGrant(ownerGrant.token)).toBe(true);
    const runtimeAfter = getActiveMcpLoopbackRuntime();
    const revoked = await fetch(`http://127.0.0.1:${runtimeAfter?.port}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ownerGrant.token}`,
        "content-type": "application/json",
        "x-openclaw-cli-capture-key": ownerGrant.captureKey,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "scope_probe", arguments: {} },
      }),
    });
    expect(revoked.status).toBe(401);
    expect(adminDispatch).toHaveBeenCalledTimes(1);
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
