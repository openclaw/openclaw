import path from "node:path";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { afterAll, beforeAll, beforeEach, expect, test, vi, type MockInstance } from "vitest";
import type { RawData } from "ws";
import type { HelloOk } from "../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import type { AgentCommandOpts } from "../agents/command/types.js";
import { resolveActiveEmbeddedRunOwnerByRunId } from "../agents/embedded-agent-runner/runs.js";
import {
  clearTestEmbeddedRun as clearActiveEmbeddedRun,
  createEmbeddedRunHandle,
  registerTestEmbeddedRun as setActiveEmbeddedRun,
} from "../agents/embedded-agent-runner/runs.test-support.js";
import * as subagentControl from "../agents/subagents/registry/subagent-control.js";
import { createQueueTestRun } from "../auto-reply/reply/queue.test-helpers.js";
import * as queueCleanup from "../auto-reply/reply/queue/cleanup.js";
import { enqueueFollowupRun } from "../auto-reply/reply/queue/enqueue.js";
import { getExistingFollowupQueue } from "../auto-reply/reply/queue/state.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { getRpcSourceIdentity } from "../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../sessions/session-lifecycle-admission.test-support.js";
import { observeGatewayRunExecution } from "./agent-command.test-helpers.js";
import { callGatewayCli } from "./call.js";
import * as chatAbort from "./chat-abort.js";
import { flushPendingSessionsChangedEvents } from "./server-methods/session-change-event.js";
import {
  agentCommandMock,
  connectOk,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  onceMessage,
  prepareGatewayReplyRuntimeForTest,
  rpcReq,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const gatewayToken = "abort-authorization-test-token";
let harness: Awaited<ReturnType<typeof createGatewaySuiteHarness>>;
let registration: MockInstance<typeof chatAbort.registerChatAbortController>;
let childCancellation: MockInstance<typeof subagentControl.killAllControlledSubagentRuns>;
let queueClearing: MockInstance<typeof queueCleanup.clearSessionQueues>;

beforeAll(async () => {
  harness = await createGatewaySuiteHarness({
    serverOptions: { auth: { mode: "token", token: gatewayToken }, bind: "loopback" },
  });
  registration = vi.spyOn(chatAbort, "registerChatAbortController");
  childCancellation = vi.spyOn(subagentControl, "killAllControlledSubagentRuns");
  queueClearing = vi.spyOn(queueCleanup, "clearSessionQueues");
});

beforeEach(async () => {
  agentCommandMock.mockReset();
  registration.mockClear();
  childCancellation.mockClear();
  queueClearing.mockClear();
  await prepareGatewayReplyRuntimeForTest();
});

afterAll(async () => {
  registration.mockRestore();
  childCancellation.mockRestore();
  queueClearing.mockRestore();
  await harness.close();
});

async function openOperator(device: string, scopes = ["operator.write"]) {
  const deviceIdentityPath = path.join(
    process.env.OPENCLAW_STATE_DIR!,
    "test-device-identities",
    device,
    "client",
    "credentials.sqlite",
  );
  const ws = await harness.openWs();
  const hello = await connectOk(ws, {
    token: gatewayToken,
    scopes,
    deviceIdentityPath,
    prePairDevice: true,
  });
  expect(hello).toMatchObject({ auth: { role: "operator", scopes } });
  return {
    ws,
    hello: hello as HelloOk,
    deviceId: loadOrCreateDeviceIdentity({ path: deviceIdentityPath }).deviceId,
  };
}

async function startNativeRun(owner: Awaited<ReturnType<typeof openOperator>>, name: string) {
  const runId = `native-abort-${name}`;
  const execution = await observeGatewayRunExecution({ method: "agent", runId });
  const sessionKey = `agent:main:${name}`;
  const params = (method: string) => ({
    [method === "chat.abort" ? "sessionKey" : "key"]: sessionKey,
    runId,
  });
  const started = createDeferred();
  const finish = createDeferred();
  let requestId: string | undefined;
  let terminal: ReturnType<typeof onceMessage> | undefined;
  const finishCommand = () => {
    // Start the response deadline only when this modeled command can finish.
    terminal ??= onceMessage(
      owner.ws,
      (frame) =>
        frame.type === "res" && frame.id === requestId && frame.payload?.status !== "accepted",
    );
    void terminal.catch(() => {});
    finish.resolve();
  };
  const runController = new AbortController();
  const nativeAbort = vi.fn();
  const abort = () => {
    if (runController.signal.aborted) {
      return;
    }
    nativeAbort();
    runController.abort();
    finishCommand();
  };
  agentCommandMock.mockImplementationOnce(async (input) => {
    const command = input as AgentCommandOpts;
    expect(command.abortSignal).toBeInstanceOf(AbortSignal);
    const handle = {
      ...createEmbeddedRunHandle({ runId, abort }),
      cancel: abort,
      isAborted: () => runController.signal.aborted,
      isStreaming: () => !runController.signal.aborted,
    };
    // Production relays the admitted controller signal into the native attempt.
    command.abortSignal!.addEventListener("abort", abort, { once: true });
    setActiveEmbeddedRun(command.sessionId!, handle, sessionKey);
    await command.onExecutionStarted?.();
    started.resolve();
    try {
      await finish.promise;
    } finally {
      command.abortSignal!.removeEventListener("abort", abort);
      clearActiveEmbeddedRun(command.sessionId!, handle, sessionKey);
    }
  });
  try {
    const accepted = await rpcReq(owner.ws, "agent", {
      message: "Keep this native run active",
      sessionKey,
      idempotencyKey: runId,
    });
    requestId = accepted.id;
    expect(accepted).toMatchObject({ ok: true, payload: { runId, status: "accepted" } });
    await started.promise;
    const admission = registration.mock.calls.find(([input]) => input.runId === runId)?.[0];
    expect(admission).toBeDefined();
    const entry = rpcSourceTesting.get(runId)!;
    expect(entry.adapter).toMatchObject({
      requester: {
        connectionId: owner.hello.server.connId,
        deviceId: owner.deviceId,
      },
      kind: "agent",
    });
    expect(getRpcSourceIdentity(entry).sessionKey).toBe(sessionKey);
    expect(resolveActiveEmbeddedRunOwnerByRunId(runId)).toMatchObject({
      runId,
      sessionKey,
      sessionId: getRpcSourceIdentity(entry).sessionId,
    });
    return {
      runId,
      sessionKey,
      entry,
      nativeAbort,
      params,
      abort: (
        ws: typeof owner.ws,
        method: "sessions.abort" | "chat.abort" = "sessions.abort",
        overrides: { runId?: string; clearQueued?: boolean } = {},
      ) => rpcReq(ws, method, { ...params(method), ...overrides }),
      finish: async () => {
        finishCommand();
        try {
          await terminal;
        } finally {
          await execution.restore();
        }
      },
    };
  } catch (error) {
    finish.resolve();
    try {
      await execution.restore();
    } finally {
      owner.ws.close();
    }
    throw new Error("Native run admission fixture failed", { cause: error });
  }
}

async function subscribe(ws: Awaited<ReturnType<typeof openOperator>>["ws"]) {
  expect(await rpcReq(ws, "sessions.subscribe", {})).toMatchObject({
    ok: true,
    payload: { subscribed: true },
  });
}

async function finishRun(
  run: Awaited<ReturnType<typeof startNativeRun>>,
  ...operators: Awaited<ReturnType<typeof openOperator>>[]
) {
  await runQaGatewayFixture(run.finish, ...operators.map(({ ws }) => ws.close.bind(ws)));
}

test("rejects a foreign write-only device without cancellation effects", async () => {
  const owner = await openOperator("owner", ["operator.read", "operator.write"]);
  const foreign = await openOperator("foreign");
  expect(foreign.hello.server.connId).not.toBe(owner.hello.server.connId);
  expect(foreign.deviceId).not.toBe(owner.deviceId);
  const run = await startNativeRun(owner, "foreign");
  await subscribe(owner.ws);
  const events: string[] = [];
  const record = (data: RawData) => {
    const frame = JSON.parse(rawDataToString(data)) as {
      type?: string;
      event?: string;
      payload?: { sessionKey?: string; state?: string; reason?: string };
    };
    if (
      frame.type === "event" &&
      frame.payload?.sessionKey === run.sessionKey &&
      ((frame.event === "chat" && frame.payload.state === "aborted") ||
        (frame.event === "sessions.changed" && frame.payload.reason === "abort"))
    ) {
      events.push(frame.event);
    }
  };
  owner.ws.on("message", record);
  const queued = createQueueTestRun({ prompt: "preserve queued followup" });
  const target = run.entry.input.target!;
  queued.run = {
    ...queued.run,
    agentId: target.agentId!,
    sessionId: target.incarnation!,
    config: { session: { store: target.storeScope } },
  };
  enqueueFollowupRun(run.sessionKey, queued, { mode: "collect" });
  const queue = getExistingFollowupQueue(run.sessionKey)!;
  try {
    // A no-op on this same method proves that scope/participation gates admit
    // this client before the live controller's separate ownership check.
    expect(
      await run.abort(foreign.ws, "sessions.abort", { runId: "no-such-native-run" }),
    ).toMatchObject({ ok: true, payload: { status: "no-active-run" } });
    expect(await run.abort(foreign.ws, "chat.abort")).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: "unauthorized" },
    });
    const result = await run.abort(foreign.ws, "sessions.abort", { clearQueued: true });
    // Drain the real publisher, then cross a same-socket response barrier.
    await flushPendingSessionsChangedEvents();
    await subscribe(owner.ws);
    expect
      .soft(result)
      .toMatchObject({ ok: false, error: { code: "INVALID_REQUEST", message: "unauthorized" } });
    expect.soft(run.entry.input.abortSignal.aborted).toBe(false);
    expect.soft(run.nativeAbort).not.toHaveBeenCalled();
    expect.soft(childCancellation).not.toHaveBeenCalled();
    expect.soft(queueClearing).not.toHaveBeenCalled();
    expect.soft(getExistingFollowupQueue(run.sessionKey)).toBe(queue);
    expect.soft(queue.items).toEqual([queued]);
    expect.soft(queue.abortController.signal.aborted).toBe(false);
    expect.soft(events).toEqual([]);
    // Witness the same subscription receiving a legitimate abort so the
    // preceding absence check cannot pass merely because nothing was subscribed.
    expect(await run.abort(owner.ws)).toMatchObject({
      ok: true,
      payload: { status: "aborted", abortedRunId: run.runId },
    });
    // Join the publisher and cross a same-socket response barrier.
    await flushPendingSessionsChangedEvents();
    await subscribe(owner.ws);
    expect(events).toContain("sessions.changed");
  } finally {
    owner.ws.off("message", record);
    queueCleanup.clearSessionQueues([run.sessionKey]);
    await finishRun(run, owner, foreign);
  }
});

test.each(["same-device", "admin"])("preserves Stop by %s", async (requester) => {
  const owner = await openOperator(`owner-${requester}`);
  const stopper = await openOperator(
    requester === "same-device" ? `owner-${requester}` : "admin",
    requester === "admin" ? ["operator.admin"] : ["operator.write"],
  );
  expect(stopper.hello.server.connId).not.toBe(owner.hello.server.connId);
  if (requester === "same-device") {
    expect(stopper.deviceId).toBe(owner.deviceId);
  }
  const run = await startNativeRun(owner, requester);
  try {
    expect(await run.abort(stopper.ws)).toMatchObject({
      ok: true,
      payload: { status: "aborted", abortedRunId: run.runId },
    });
    expect(run.entry.input.abortSignal.aborted).toBe(true);
    expect(run.nativeAbort).toHaveBeenCalledTimes(1);
  } finally {
    await finishRun(run, owner, stopper);
  }
});

test.each(["chat.abort", "sessions.abort"])(
  "lets a local shared-token CLI cancel another connection's native run with %s",
  async (method) => {
    const owner = await openOperator(`cli-owner-${method}`);
    const run = await startNativeRun(owner, `cli-${method}`);
    const options = {
      url: `ws://127.0.0.1:${harness.port}`,
      token: gatewayToken,
      method,
      params: run.params(method),
    };
    try {
      // Explicit scope restrictions still reach, and fail, run ownership checks.
      await expect(callGatewayCli({ ...options, scopes: ["operator.write"] })).rejects.toThrow(
        "unauthorized",
      );
      expect(run.entry.input.abortSignal.aborted).toBe(false);
      expect(run.nativeAbort).not.toHaveBeenCalled();

      await expect(callGatewayCli(options)).resolves.toMatchObject(
        method === "chat.abort"
          ? { aborted: true, runIds: [run.runId] }
          : { status: "aborted", abortedRunId: run.runId },
      );
      expect(run.entry.input.abortSignal.aborted).toBe(true);
      expect(run.nativeAbort).toHaveBeenCalledTimes(1);
    } finally {
      await finishRun(run, owner);
    }
  },
);

test("preserves controller-less native Stop", async () => {
  const owner = await openOperator("recovered-owner");
  const sessionKey = "agent:main:recovered";
  const runId = "native-recovered";
  const stopped = createDeferred();
  const abort = vi.fn(() => stopped.resolve());
  const handle = createEmbeddedRunHandle({ runId, abort });
  setActiveEmbeddedRun("recovered-session", handle, sessionKey);
  const request = rpcReq(owner.ws, "sessions.abort", { key: sessionKey, runId });
  try {
    const first = await Promise.race([
      stopped.promise.then(() => "stopped"),
      request.then((result) => ({ result })),
    ]);
    expect(first).toBe("stopped");
    expect(abort).toHaveBeenCalledTimes(1);
    clearActiveEmbeddedRun("recovered-session", handle, sessionKey);
    expect(await request).toMatchObject({
      ok: true,
      payload: { status: "aborted", abortedRunId: runId },
    });
  } finally {
    clearActiveEmbeddedRun("recovered-session", handle, sessionKey);
    owner.ws.close();
    await request.catch(() => {});
  }
});
