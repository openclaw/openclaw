import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { PreparedAgentRunAdmission } from "../agents/admitted-run-context.js";
import {
  getGatewayToolCallerIdentity as getToolCaller,
  withGatewayToolCallerIdentity as withToolCaller,
} from "../agents/tools/gateway-caller-context.js";
import {
  resolveSessionTranscriptReadFence as readTranscriptFence,
  runWithSessionTranscriptReadFence as withTranscriptFence,
} from "../config/sessions/session-transcript-read-fence.js";
import { readOnlyWorkerScope } from "../infra/sqlite-readonly-worker-context.js";
import { createSqliteReadOnlyWorkerScope } from "../infra/sqlite-readonly-worker.js";
import {
  getPluginRuntimeGatewayRequestScope as getGatewayScope,
  withPluginRuntimeGatewayRequestScope as withGatewayScope,
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

import { revokeMcpLoopbackClientGrant } from "./mcp-grant-store.js";
import * as mcp from "./mcp-http-request.test-support.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "./mcp-http.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import {
  readOperatorToolGatewayAuthority,
  runWithOperatorToolGatewayAuthority as runWithOperatorAuthority,
} from "./operator-tool-gateway-authority.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { withOperatorToolGatewayAuthority as withOperatorAuthority } from "./server-plugin-in-process-authority.js";
import { dispatchGatewayMethodInProcessRaw as dispatchMethod } from "./server-plugin-in-process-dispatch.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";

const completed = { content: [{ type: "text", text: "tracked tool completed" }] };
type RuntimeClient = ReturnType<typeof createSyntheticPluginRuntimeClient>;
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
    return mcp.probeTools("scope_probe", execute);
  });
});

const admissions: PreparedAgentRunAdmission[] = [];

afterEach(async () => {
  await closeMcpLoopbackServer();
  admissions.splice(0).forEach((admission) => admission.close());
});

function callTool(grant?: { token: string; captureKey: string }) {
  return mcp
    .request(mcp.runtime(), mcp.toolCall("scope_probe"), {
      ...grant,
      sessionKey: "agent:main:scope-proof",
    })
    .then(mcp.json);
}

async function startFromCaller() {
  const scope = new AsyncWorkScope();
  const admission = tryBeginGatewayRootWorkAdmission("mcp-scope-test");
  if (!admission) {
    throw new Error("Caller admission unavailable");
  }
  try {
    await admission.run(() => scope.track(ensureMcpLoopbackServer));
    return scope;
  } finally {
    admission.release();
  }
}

it.each(["operator invocation", "Gateway caller"])(
  "does not retain its listener creator's %s",
  async (source) => {
    const lifetime = new AbortController();
    const resolveGatewayContext = vi.fn();
    execute.mockImplementation(() => {
      if (source === "operator invocation") {
        const inherited = readOperatorToolGatewayAuthority();
        inherited?.signal.throwIfAborted();
        expect(inherited).toBeUndefined();
      } else {
        const scope = getGatewayScope();
        expect({
          client: scope?.client,
          resolveGatewayContext: scope?.resolveGatewayContext,
          callerAgentId: getToolCaller()?.agentId,
        }).toEqual({ client: undefined, resolveGatewayContext, callerAgentId: undefined });
      }
      return completed;
    });
    if (source === "operator invocation") {
      await runWithOperatorAuthority(
        { scopes: ["operator.write"], signal: lifetime.signal },
        ensureMcpLoopbackServer,
      );
      lifetime.abort(new Error("operator tool invocation authority expired"));
    } else {
      const client = createSyntheticPluginRuntimeClient({ scopes: ["operator.write"] });
      await withToolCaller({ agentId: "starter", sessionKey: "agent:starter:recovery" }, () =>
        withGatewayScope(
          { client, resolveGatewayContext, isWebchatConnect: () => false },
          ensureMcpLoopbackServer,
        ),
      );
    }
    expect(await callTool()).toMatchObject({ result: { ...completed, isError: false } });
    expect(execute).toHaveBeenCalledOnce();
  },
);

it("serves fresh request scopes after its replacement creator closes", async () => {
  const predecessor = await startFromCaller();
  await Promise.all([closeMcpLoopbackServer(), closeMcpLoopbackServer()]);
  await predecessor.drain();
  const creator = await startFromCaller();
  await creator.drain();
  expect(await callTool()).toMatchObject({ result: { ...completed, isError: false } });
  expect(await callTool()).toMatchObject({ result: { ...completed, isError: false } });
  expect(resolveTools).toHaveBeenCalledTimes(1);
  expect(constructionScopes.map((signal) => signal?.aborted)).toEqual([false]);
  expect(executionScopes.map((signal) => signal?.aborted)).toEqual([true, true]);
  expect(new Set([creator.signal, ...constructionScopes, ...executionScopes]).size).toBe(4);
  await closeMcpLoopbackServer();
  expect(constructionScopes[0]?.aborted).toBe(true);
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
      readTranscriptFence(session),
      turnLocal.getStore(),
      readOnlyWorkerScope.getStore(),
    ]);
    return completed;
  });
  try {
    await readers.run(() =>
      turnLocal.run("first-turn", () =>
        withTranscriptFence(receipt, () => {
          expect(readTranscriptFence(session)).toBe(receipt);
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
  const adminDispatch = vi.fn(({ respond }: GatewayRequestHandlerOptions) =>
    respond(true, { allowed: true }),
  );
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
  const scopeFor = (client: RuntimeClient, isCurrent: () => boolean) => ({
    client,
    isWebchatConnect: () => false,
    resolveGatewayContext: () => context,
    hasCurrentClientAuthority: isCurrent,
  });
  const writeOnly = createSyntheticPluginRuntimeClient({ scopes: ["operator.write"] });
  const admin = createSyntheticPluginRuntimeClient({ scopes: ["operator.admin"] });
  let ownerCurrent = true;
  execute.mockImplementation(async () => {
    const result = await dispatchMethod(
      "scope.probe",
      {},
      { resolveGatewayContext: () => context },
    );
    return {
      content: [{ type: "text", text: result.ok ? "admin-dispatched" : result.error?.message }],
    };
  });
  // A write-only restart-recovery run starts the listener with its operator authority.
  await withGatewayScope(
    scopeFor(writeOnly, () => true),
    () => withOperatorAuthority({ scopes: ["operator.write"] }, ensureMcpLoopbackServer),
  );
  const runtime = mcp.runtime();
  const admit = async (runId: string, client: RuntimeClient, isCurrent: () => boolean) => {
    const admission = mcp.prepareAdmission(runId, "mcp-scope-proof");
    admissions.push(admission);
    const admittedRunContext = await admission.admit("gateway", `gateway-${runId}`);
    return withGatewayScope(scopeFor(client, isCurrent), () =>
      mcp.captureGrant(
        {
          context: { sessionKey: "agent:main:scope-proof", senderIsOwner: true },
          runtimeOwnerToken: runtime.ownerToken,
          admittedRunContext,
          toolPolicyConfig: {},
        },
        `capture-${runId}`,
      ),
    );
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
    result: { content: [{ text: "Gateway requester authority changed" }] },
  });
  expect(adminDispatch).toHaveBeenCalledTimes(1);
  expect(revokeMcpLoopbackClientGrant(ownerGrant.token)).toBe(true);
  const revoked = await mcp.request(runtime, mcp.toolCall("scope_probe"), ownerGrant);
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
