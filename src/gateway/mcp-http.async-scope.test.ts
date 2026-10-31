import { AsyncLocalStorage } from "node:async_hooks";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { PreparedAgentRunAdmission } from "../agents/admitted-run-context.js";
import {
  bindCronManagementToolConstruction,
  captureCronRequesterGrantIssuer,
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
} from "../agents/cron-creator-authority-context.js";
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
import { AsyncWorkScope, getAsyncWorkSignal, trackAsyncWork } from "../shared/async-work-scope.js";
import { createFirstTurnContextFixture } from "./mcp-http.context-fixture.test-support.js";

const { execute, resolveTools } = vi.hoisted(() => ({ execute: vi.fn(), resolveTools: vi.fn() }));
vi.mock("../config/io.js", () => {
  const config = {};
  return { getRuntimeConfig: () => config };
});
vi.mock("../agents/agent-tools.before-tool-call.js", () => ({
  runBeforeToolCallHook: async ({ params }: { params: unknown }) => ({ blocked: false, params }),
}));
vi.mock("./tool-resolution.js", () => ({ resolveGatewayScopedTools: resolveTools }));

import { consumeCronCreatorAuthorityGrant } from "./cron-creator-authority-grant.js";
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
  const { session, receipt } = createFirstTurnContextFixture();
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

describe("MCP HTTP keepalive", () => {
  let send: (method: "GET" | "POST", message?: unknown) => Promise<Response>;
  beforeEach(async () => {
    execute.mockReset();
    resolveTools.mockImplementation(() => mcp.probeTools("wait_probe", execute));
    // Keep real network I/O and deadlines; only advance the heartbeat intervals.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    await ensureMcpLoopbackServer();
    const runtime = mcp.runtime();
    send = (method, message) => mcp.request(runtime, message, { method });
  });
  afterEach(async () => {
    try {
      await closeMcpLoopbackServer();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  async function within<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("HTTP idle timeout")), 500);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  const toolCall = mcp.toolCall("wait_probe");
  const heartbeatResult = { content: [{ type: "text", text: "completed once" }] };
  const decoder = new TextDecoder();
  const readText = async (reader: ReadableStreamDefaultReader<Uint8Array>) =>
    decoder.decode((await within(reader.read())).value);

  async function drain(read: () => ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>) {
    let body = "";
    for (let chunk = await read(); !chunk.done; chunk = await read()) {
      body += decoder.decode(chunk.value);
    }
    return body;
  }

  it("disables connection reuse for consecutive completed tool calls", async () => {
    execute.mockResolvedValue(heartbeatResult);
    for (let id = 1; id <= 2; id++) {
      const response = await send("POST", { ...toolCall, id });
      expect(response.status).toBe(200);
      expect(response.headers.get("connection")).toBe("close");
      expect(await response.json()).toMatchObject({
        id,
        result: { ...heartbeatResult, isError: false },
      });
    }
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it.each(["success", "serialization-error", "notification"])(
    "keeps pending calls alive without writing notification bodies: %s",
    async (outcome) => {
      const entered = createDeferred();
      const release = createDeferred();
      const block = {
        ...heartbeatResult.content[0],
        ...(outcome === "serialization-error" ? { _meta: { invalid: 1n } } : {}),
      };
      execute.mockImplementation(async () => {
        entered.resolve();
        await release.promise;
        return { content: [block] };
      });
      const serverTimers = vi.getTimerCount();
      const { id: _id, ...notification } = toolCall;
      const responsePromise = send("POST", outcome === "notification" ? notification : toolCall);
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        await within(entered.promise);
        if (outcome === "notification") {
          expect(vi.getTimerCount()).toBe(serverTimers);
          await vi.advanceTimersByTimeAsync(60_000);
          release.resolve();
          const response = await within(responsePromise);
          expect(response.status).toBe(202);
          expect(response.headers.get("connection")).toBe("close");
          expect(await response.text()).toBe("");
          expect(vi.getTimerCount()).toBe(serverTimers);
          return;
        }
        expect(vi.getTimerCount()).toBe(serverTimers + 1);
        await vi.advanceTimersByTimeAsync(30_000);
        const response = await within(responsePromise);
        expect(response.headers.get("content-type")).toBe("application/json");
        expect(response.headers.get("connection")).toBe("close");
        reader = expectDefined(response.body, "response body").getReader();
        let body = await readText(reader);
        expect(body.trim()).toBe("");
        await vi.advanceTimersByTimeAsync(30_000);
        body += await readText(reader);
        expect(body.trim()).toBe("");
        release.resolve();
        const activeReader = reader;
        body += await drain(() => within(activeReader.read()));
        expect(JSON.parse(body)).toEqual({
          jsonrpc: "2.0",
          id: 1,
          ...(outcome === "serialization-error"
            ? { error: { code: -32603, message: "Internal error" } }
            : { result: { ...heartbeatResult, isError: false } }),
        });
        expect(execute).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(serverTimers);
      } finally {
        release.resolve();
        if (reader) {
          await reader.cancel();
        } else if (outcome !== "notification") {
          await (await responsePromise).body?.cancel();
        }
      }
    },
  );

  it("keeps a GET notification stream alive and releases it during shutdown", async () => {
    const response = await send("GET");
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("connection")).toBe("close");
    const reader = expectDefined(response.body, "notification stream").getReader();
    try {
      expect(await readText(reader)).toBe(":\n\n");
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await readText(reader)).toMatch(/^(?::\n\n)+$/);
      await within(closeMcpLoopbackServer());
      const buffered = await within(drain(() => reader.read()));
      expect(buffered).toMatch(/^(?::\n\n)*$/);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  });
});

it("keeps requester grant minting at execution when management needs a construction identity", async () => {
  await ensureMcpLoopbackServer();
  const runId = "mcp-management-and-requester";
  const admission = mcp.prepareAdmission(runId, "mcp-management-requester-proof");
  admissions.push(admission);
  const admittedRunContext = await admission.admit("gateway", runId);
  const scope = expectDefined(
    createCronCreatorAuthorityCapability(runId, { kind: "local" }, { source: "control-ui-admin" }),
    "Cron run scope",
  );
  const constructionIssuers: boolean[] = [];
  resolveTools.mockImplementation(() => {
    expect(getToolCaller()?.approvalAuthority).toBeDefined();
    constructionIssuers.push(getToolCaller()?.mintCronRequesterGrant !== undefined);
    return mcp.probeTools("scope_probe", execute);
  });
  execute.mockImplementation(() => {
    const mint = expectDefined(getToolCaller()?.mintCronRequesterGrant, "execution issuer");
    const grant = mint();
    const redeemed = consumeCronCreatorAuthorityGrant(grant);
    expect(redeemed.authority).toBeUndefined();
    redeemed.assertCurrent();
    expect(() => consumeCronCreatorAuthorityGrant(grant)).toThrow(/no longer active/);
    return completed;
  });
  await runWithCronCreatorAuthorityCapability(scope, async () => {
    const grant = mcp.captureGrant(
      {
        context: { sessionKey: "agent:main:scope-proof", runId, senderIsOwner: true },
        runtimeOwnerToken: mcp.runtime().ownerToken,
        admittedRunContext,
        toolPolicyConfig: {},
        cronRequesterGrantIssuer: captureCronRequesterGrantIssuer(runId),
        withCronManagementToolConstruction: bindCronManagementToolConstruction(runId),
      },
      "management-and-requester-capture",
    );
    await mcp.json(
      await mcp.request(mcp.runtime(), { jsonrpc: "2.0", id: 1, method: "tools/list" }, grant),
    );
    expect(scope.grantTokens.size).toBe(0);
    expect(await callTool(grant)).toMatchObject({ result: { ...completed, isError: false } });
    expect(execute).toHaveBeenCalledOnce();
    expect(constructionIssuers).toEqual([false]);
    expect(scope.grantTokens.size).toBe(0);
  });
});
