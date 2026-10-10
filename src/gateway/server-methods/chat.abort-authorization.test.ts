import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { QueuedChatTurnEntry } from "../chat-queued-turns.js";
import { registerWorkerInferenceSessionControl } from "../worker-environments/inference-control-internal.js";
import { createWorkerInferenceCancellationService } from "../worker-environments/inference-control.test-helpers.js";
import * as abortDescendants from "./chat-abort-descendants.js";
import { handleChatAbortRequestWithLifecycle } from "./chat-abort-handler.js";
import * as persistence from "./chat-transcript-persistence.js";
import {
  createSingleAbortContext,
  expectAbortPayload,
  invokeAbort,
  requireLastRespondCall,
} from "./chat.abort-authorization.test-helpers.js";
import {
  createActiveRun,
  createChatAbortContext,
  invokeChatAbortHandler,
} from "./chat.abort.test-helpers.js";

vi.mock("../session-utils.js", async () => ({
  ...(await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js")),
  loadSessionEntry: () => ({ entry: { sessionId: "main-session" } }),
}));

function abortAsOwner(params: Omit<Parameters<typeof invokeAbort>[0], "connId" | "deviceId">) {
  return invokeAbort({ ...params, connId: "conn-owner", deviceId: "dev-owner" });
}

function queuedTurn(controller: AbortController, owner = "owner"): QueuedChatTurnEntry {
  return {
    controller,
    sessionId: "main-session",
    sessionKey: "main",
    ownerConnId: `conn-${owner}`,
    ownerDeviceId: `dev-${owner}`,
  };
}

function abortAsOther(params: Omit<Parameters<typeof invokeAbort>[0], "connId" | "deviceId">) {
  return invokeAbort({ ...params, connId: "conn-other", deviceId: "dev-other" });
}

function abortAsAdmin(
  params: Omit<Parameters<typeof invokeAbort>[0], "connId" | "deviceId" | "scopes">,
) {
  return invokeAbort({
    ...params,
    connId: "conn-admin",
    deviceId: "dev-admin",
    scopes: ["operator.admin"],
  });
}

function pendingRun(
  runId: string,
  owner = "owner",
  extra: { controlUiVisible?: false; dedupeKeys?: string[]; turnKind?: "btw" } = {},
) {
  return {
    ts: Date.now(),
    ok: true,
    payload: {
      runId,
      sessionKey: "main",
      status: "accepted",
      ownerConnId: `conn-${owner}`,
      ownerDeviceId: `dev-${owner}`,
      ...extra,
    },
  };
}

describe("chat.abort authorization", () => {
  it.each([
    { sessionKey: "main", runId: undefined, message: "requires an exact runId" },
    {
      sessionKey: "agent:main:other",
      runId: "run-1",
      message: "does not match sessionKey",
    },
    {
      sessionKey: "agent:main:dashboard:incognito-private",
      runId: "run-1",
      message: "unavailable in incognito sessions",
    },
  ])("requires an exact discard target ($sessionKey, $runId)", async (target) => {
    const context = createSingleAbortContext();
    const active = context.chatAbortControllers.get("run-1");
    const respond = await invokeChatAbortHandler({
      handler: handleChatAbortRequestWithLifecycle,
      context,
      request: {
        sessionKey: target.sessionKey,
        runId: target.runId,
        discardPendingInput: true,
      },
      client: {
        connId: "conn-owner",
        connect: { device: { id: "dev-owner" }, scopes: ["operator.admin"] },
      },
    });
    const [ok, , error] = requireLastRespondCall(respond);
    expect(ok).toBe(false);
    expect(error?.message).toContain(target.message);
    expect(context.chatAbortControllers.get("run-1")).toBe(active);
    expect(active?.controller.signal.aborted).toBe(false);
  });

  it("cancels the admitted worker session after the selected store changes", async () => {
    const cancel = vi.fn(() => ["worker-run"]);
    const context = createChatAbortContext({
      workerEnvironmentService: createWorkerInferenceCancellationService(
        "original-worker-session",
        ["worker-run"],
        cancel,
        {
          agentId: "main",
          sessionId: "original-worker-session",
          sessionKey: "agent:main:main",
          storePath: "/original-worker-store/sessions.json",
        },
      ),
    });
    const respond = await abortAsAdmin({
      context,
      runId: "worker-run",
    });
    expectAbortPayload(requireLastRespondCall(respond)[1], {
      aborted: true,
      runIds: ["worker-run"],
    });
    expect(cancel).toHaveBeenCalledWith({
      sessionId: "original-worker-session",
      runId: "worker-run",
    });
  });

  it("rejects non-admin worker-only inference aborts", async () => {
    const cancelInferenceForSession = vi.fn(() => ["worker-run"]);
    const context = createChatAbortContext({
      workerEnvironmentService: createWorkerInferenceCancellationService(
        "main-session",
        ["worker-run"],
        cancelInferenceForSession,
      ),
    });
    for (const runId of [undefined, "worker-run"]) {
      const respond = await abortAsOther({
        context,
        runId,
      });
      expect(requireLastRespondCall(respond)[2]?.message).toBe("unauthorized");
    }
    expect(cancelInferenceForSession).not.toHaveBeenCalled();

    const admin = await abortAsAdmin({
      context,
      runId: "worker-run",
    });
    expectAbortPayload(requireLastRespondCall(admin)[1], {
      aborted: true,
      runIds: ["worker-run"],
    });
    expect(cancelInferenceForSession).toHaveBeenCalledWith({
      sessionId: "main-session",
      runId: "worker-run",
    });
  });

  it("does not let a local run owner cancel worker inference", async () => {
    for (const runId of [undefined, "run-1"]) {
      const cancelInferenceForSession = vi.fn(() => ["run-1"]);
      const context = createSingleAbortContext();
      context.workerEnvironmentService = createWorkerInferenceCancellationService(
        "main-session",
        ["run-1"],
        cancelInferenceForSession,
      );
      const respond = await abortAsOwner({
        context,
        ...(runId ? { runId } : {}),
      });
      expectAbortPayload(requireLastRespondCall(respond)[1], {
        aborted: true,
        runIds: ["run-1"],
      });
      expect(cancelInferenceForSession).not.toHaveBeenCalled();
    }
  });

  it("rejects explicit run aborts from other clients", async () => {
    const context = createSingleAbortContext();

    const respond = await abortAsOther({
      context,
      runId: "run-1",
      scopes: ["operator.write"],
    });

    const [ok, payload, error] = requireLastRespondCall(respond);
    expect(ok).toBe(false);
    expect(payload).toBeUndefined();
    expect(error?.code).toBe("INVALID_REQUEST");
    expect(error?.message).toBe("unauthorized");
    expect(context.chatAbortControllers.has("run-1")).toBe(true);
  });

  it("allows the same paired device to abort after reconnecting", async () => {
    const context = createChatAbortContext({
      chatAbortControllers: new Map([
        ["run-1", createActiveRun("main", { owner: { connId: "conn-old", deviceId: "dev-1" } })],
      ]),
    });

    const respond = await invokeAbort({
      context,
      runId: "run-1",
      connId: "conn-new",
      deviceId: "dev-1",
    });

    const [ok, payload] = requireLastRespondCall(respond);
    expect(ok).toBe(true);
    expectAbortPayload(payload, { aborted: true, runIds: ["run-1"] });
    expect(context.chatAbortControllers.has("run-1")).toBe(false);
  });

  it("does not reveal a foreign hidden run to ordinary session aborts", async () => {
    const hidden = createActiveRun("main", {
      controlUiVisible: false,
      owner: { connId: "conn-hidden", deviceId: "dev-hidden" },
    });
    const context = createChatAbortContext({
      chatAbortControllers: new Map([["run-hidden", hidden]]),
    });

    const respond = await abortAsOther({
      context,
    });

    const [ok, payload] = requireLastRespondCall(respond);
    expect(ok).toBe(true);
    expectAbortPayload(payload, { aborted: false, runIds: [] });
    expect(hidden.controller.signal.aborted).toBe(false);
    expect(context.chatAbortControllers.has("run-hidden")).toBe(true);
  });

  it("preserves BTW runs waiting for chat admission", async () => {
    const onAuthorizedAfterQueuedAbort = vi.fn(() => true);
    const context = createChatAbortContext();
    context.dedupe.set("pending-chat:run-btw", pendingRun("run-btw", "owner", { turnKind: "btw" }));

    const respond = await abortAsOwner({
      context,
      preserveSideRuns: true,
      onAuthorizedAfterQueuedAbort,
    });

    const [ok, payload] = requireLastRespondCall(respond);
    expect(ok).toBe(true);
    expectAbortPayload(payload, { aborted: false, runIds: [] });
    expect(onAuthorizedAfterQueuedAbort).not.toHaveBeenCalled();
    expect(context.dedupe.get("pending-chat:run-btw")).toEqual(
      expect.objectContaining({
        payload: expect.objectContaining({ status: "accepted", turnKind: "btw" }),
      }),
    );
  });

  it("allows operator.admin clients to bypass owner checks", async () => {
    const context = createSingleAbortContext();

    const respond = await abortAsAdmin({
      context,
      runId: "run-1",
    });

    const [ok, payload] = requireLastRespondCall(respond);
    expect(ok).toBe(true);
    expectAbortPayload(payload, { aborted: true, runIds: ["run-1"] });
  });
});

describe("chat.abort queued-turn contract", () => {
  it("cancels queued turns before session cleanup and the active run", async () => {
    const order: string[] = [];
    const queuedController = new AbortController();
    queuedController.signal.addEventListener("abort", () => order.push("queued-abort"));
    const active = createActiveRun("main", {
      owner: { connId: "conn-owner", deviceId: "dev-owner" },
    });
    active.controller.signal.addEventListener("abort", () => order.push("active-abort"));
    const context = createChatAbortContext({
      chatAbortControllers: new Map([["active-1", active]]),
      chatQueuedTurns: new Map([["queued-1", queuedTurn(queuedController)]]),
    });

    const respond = await abortAsOwner({
      context,
      onAuthorizedAfterQueuedAbort: () => {
        order.push("session-cleanup");
        return true;
      },
    });

    expect(requireLastRespondCall(respond)[0]).toBe(true);
    expect(order).toEqual(["queued-abort", "session-cleanup", "active-abort"]);
  });

  it("allows operator.write session cleanup when no chat run is registered", async () => {
    const onAuthorizedAfterQueuedAbort = vi.fn(() => true);
    const respond = await abortAsOwner({
      context: createChatAbortContext(),
      onAuthorizedAfterQueuedAbort,
    });

    expect(onAuthorizedAfterQueuedAbort).toHaveBeenCalledTimes(1);
    expectAbortPayload(requireLastRespondCall(respond)[1], { aborted: true, runIds: [] });
  });

  it("aborts only requester runs without session cleanup in a mixed-owner session", async () => {
    const onAuthorizedAfterQueuedAbort = vi.fn(() => true);
    const mine = createActiveRun("main", {
      owner: { connId: "conn-owner", deviceId: "dev-owner" },
    });
    const foreign = createActiveRun("main", {
      owner: { connId: "conn-other", deviceId: "dev-other" },
    });
    const context = createChatAbortContext({
      chatAbortControllers: new Map([
        ["run-mine", mine],
        ["run-foreign", foreign],
      ]),
    });
    const respond = await abortAsOwner({ context, onAuthorizedAfterQueuedAbort });

    expectAbortPayload(requireLastRespondCall(respond)[1], {
      aborted: true,
      runIds: ["run-mine"],
    });
    expect(onAuthorizedAfterQueuedAbort).not.toHaveBeenCalled();
    expect(mine.controller.signal.aborted).toBe(true);
    expect(context.chatAbortControllers.has("run-mine")).toBe(false);
    expect(foreign.controller.signal.aborted).toBe(false);
    expect(context.chatAbortControllers.has("run-foreign")).toBe(true);
  });

  it("does not let session cleanup bypass a worker run", async () => {
    const onAuthorizedAfterQueuedAbort = vi.fn(() => false);
    const cancelInferenceForSession = vi.fn(() => ["worker-run"]);
    const context = createChatAbortContext({
      workerEnvironmentService: createWorkerInferenceCancellationService(
        "main-session",
        ["worker-run"],
        cancelInferenceForSession,
      ),
    });

    const respond = await abortAsOther({
      context,
      onAuthorizedAfterQueuedAbort,
    });

    const call = requireLastRespondCall(respond);
    expect(call[0]).toBe(false);
    expect(call[2]?.message).toBe("unauthorized");
    expect(onAuthorizedAfterQueuedAbort).not.toHaveBeenCalled();
    expect(cancelInferenceForSession).not.toHaveBeenCalled();
  });

  it("protects hidden worker runs only from injected lifecycle cleanup", async () => {
    const onAuthorizedAfterQueuedAbort = vi.fn(() => true);
    const cancelInferenceForSession = vi.fn(() => ["run-hidden"]);
    const hidden = createActiveRun("main", {
      controlUiVisible: false,
      owner: { connId: "conn-owner", deviceId: "dev-owner" },
    });
    const context = createChatAbortContext({
      chatAbortControllers: new Map([["run-hidden", hidden]]),
      workerEnvironmentService: createWorkerInferenceCancellationService(
        "main-session",
        ["run-hidden"],
        cancelInferenceForSession,
      ),
    });

    const lifecycleRespond = await abortAsOwner({
      context,
      onAuthorizedAfterQueuedAbort,
    });

    expectAbortPayload(requireLastRespondCall(lifecycleRespond)[1], {
      aborted: false,
      runIds: [],
    });
    expect(onAuthorizedAfterQueuedAbort).not.toHaveBeenCalled();
    expect(cancelInferenceForSession).not.toHaveBeenCalled();
    expect(hidden.controller.signal.aborted).toBe(false);

    const ordinaryRespond = await abortAsAdmin({
      context,
    });
    expectAbortPayload(requireLastRespondCall(ordinaryRespond)[1], {
      aborted: true,
      runIds: ["run-hidden"],
    });
    expect(cancelInferenceForSession).toHaveBeenCalledWith({ sessionId: "main-session" });
  });

  it("allows cleanup for duplicate pending identities owned by the requester", async () => {
    const onAuthorizedAfterQueuedAbort = vi.fn(() => true);
    const pending = pendingRun("run-pending", "owner", { dedupeKeys: ["agent:run-pending-alias"] });
    const context = createChatAbortContext({
      dedupe: new Map([
        ["agent:run-pending", pending],
        ["agent:run-pending-alias", pending],
      ]),
    });

    const respond = await abortAsOwner({
      context,
      onAuthorizedAfterQueuedAbort,
    });

    expectAbortPayload(requireLastRespondCall(respond)[1], {
      aborted: true,
      runIds: ["run-pending"],
    });
    expect(onAuthorizedAfterQueuedAbort).toHaveBeenCalledTimes(1);
  });

  it("protects foreign hidden pending work across ordinary and lifecycle aborts", async () => {
    const context = createChatAbortContext();
    context.dedupe.set(
      "agent:run-hidden",
      pendingRun("run-hidden", "hidden", { controlUiVisible: false }),
    );

    const respond = await abortAsOther({
      context,
    });

    const [ok, payload] = requireLastRespondCall(respond);
    expect(ok).toBe(true);
    expectAbortPayload(payload, { aborted: false, runIds: [] });

    const onAuthorizedAfterQueuedAbort = vi.fn(() => true);
    const lifecycleRespond = await abortAsOther({
      context,
      onAuthorizedAfterQueuedAbort,
    });
    const lifecycleCall = requireLastRespondCall(lifecycleRespond);
    expect(lifecycleCall[0]).toBe(false);
    expect(lifecycleCall[2]?.message).toBe("unauthorized");
    expect(onAuthorizedAfterQueuedAbort).not.toHaveBeenCalled();
    expect(context.dedupe.get("agent:run-hidden")).toEqual(
      expect.objectContaining({
        payload: expect.objectContaining({ status: "accepted", controlUiVisible: false }),
      }),
    );
  });

  it("skips session cleanup when a pending run has a foreign owner", async () => {
    const onAuthorizedAfterQueuedAbort = vi.fn(() => true);
    const context = createChatAbortContext();
    context.dedupe.set("agent:run-mine", pendingRun("run-mine", "owner"));
    context.dedupe.set("agent:run-foreign", pendingRun("run-foreign", "other"));

    const respond = await abortAsOwner({
      context,
      onAuthorizedAfterQueuedAbort,
    });

    expectAbortPayload(requireLastRespondCall(respond)[1], {
      aborted: true,
      runIds: ["run-mine"],
    });
    expect(onAuthorizedAfterQueuedAbort).not.toHaveBeenCalled();
    expect(context.dedupe.get("agent:run-foreign")).toEqual(
      expect.objectContaining({
        payload: expect.objectContaining({ status: "accepted" }),
      }),
    );
  });

  it("aborts a queued turn by runId after active registration is gone", async () => {
    const controller = new AbortController();
    const context = createChatAbortContext({
      chatQueuedTurns: new Map([["queued-1", queuedTurn(controller)]]),
    });

    const respond = await abortAsOwner({
      context,
      runId: "queued-1",
    });
    const call = requireLastRespondCall(respond);
    expect(call[0]).toBe(true);
    expectAbortPayload(call[1], { aborted: true, runIds: ["queued-1"] });
    expect(controller.signal.aborted).toBe(true);
    expect(context.chatQueuedTurns.has("queued-1")).toBe(false);
  });

  it("rejects queued-turn abort from other clients", async () => {
    const controller = new AbortController();
    const context = createChatAbortContext({
      chatQueuedTurns: new Map([["queued-1", queuedTurn(controller)]]),
    });

    const respond = await abortAsOther({
      context,
      runId: "queued-1",
    });
    const call = requireLastRespondCall(respond);
    expect(call[0]).toBe(false);
    expect(controller.signal.aborted).toBe(false);
    expect(context.chatQueuedTurns.has("queued-1")).toBe(true);
  });

  it("rejects a mismatched session for ownerless queued turns", async () => {
    const controller = new AbortController();
    const context = createChatAbortContext({
      chatQueuedTurns: new Map([
        [
          "queued-ownerless",
          {
            controller,
            sessionId: "main-session",
            sessionKey: "main",
          },
        ],
      ]),
    });

    const respond = await abortAsOther({
      context,
      sessionKey: "other",
      runId: "queued-ownerless",
    });
    const call = requireLastRespondCall(respond);
    expect(call[0]).toBe(false);
    expect(call[2]?.message).toBe("runId does not match sessionKey");
    expect(controller.signal.aborted).toBe(false);
    expect(context.chatQueuedTurns.has("queued-ownerless")).toBe(true);
  });

  it("aborts only requester queues without session cleanup in a mixed-owner session", async () => {
    const onAuthorizedAfterQueuedAbort = vi.fn(() => true);
    const mine = new AbortController();
    const foreign = new AbortController();
    const context = createChatAbortContext({
      chatQueuedTurns: new Map([
        ["queued-mine", queuedTurn(mine)],
        ["queued-foreign", queuedTurn(foreign, "other")],
      ]),
    });

    const respond = await abortAsOwner({
      context,
      onAuthorizedAfterQueuedAbort,
    });

    expectAbortPayload(requireLastRespondCall(respond)[1], {
      aborted: true,
      runIds: ["queued-mine"],
    });
    expect(onAuthorizedAfterQueuedAbort).not.toHaveBeenCalled();
    expect(mine.signal.aborted).toBe(true);
    expect(foreign.signal.aborted).toBe(false);
    expect(context.chatQueuedTurns.has("queued-foreign")).toBe(true);
  });

  it("rejects an ownerless global abort on an explicit fleet", async () => {
    const active = createActiveRun("global", { agentId: "research" });
    const context = createChatAbortContext({
      chatAbortControllers: new Map([["run-research", active]]),
      getRuntimeConfig: () => ({
        agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
        session: { scope: "global" },
      }),
    });
    const respond = await invokeChatAbortHandler({
      handler: handleChatAbortRequestWithLifecycle,
      context,
      request: { sessionKey: "global", runId: "run-research" },
    });
    expect(respond.mock.calls.at(-1)?.[2]).toMatchObject({
      code: "INVALID_REQUEST",
      message: expect.stringContaining("has no explicit owner"),
    });
    expect(active.controller.signal.aborted).toBe(false);
  });

  it("uses the persisted fixed-store owner for a bare global abort", async () => {
    const active = createActiveRun("global", { agentId: "ops" });
    const context = createChatAbortContext({
      chatAbortControllers: new Map([["run-ops", active]]),
      getRuntimeConfig: () => ({
        agents: {
          ownership: "explicit",
          defaults: { sessionStore: { agentId: "ops" } },
          entries: { ops: {}, research: {} },
        },
        session: { scope: "global", store: "/tmp/shared-sessions.sqlite" },
      }),
    });

    const respond = await invokeChatAbortHandler({
      handler: handleChatAbortRequestWithLifecycle,
      context,
      request: { sessionKey: "global", runId: "run-ops" },
    });

    expect(respond.mock.calls.at(-1)?.[0]).toBe(true);
    expect(active.controller.signal.aborted).toBe(true);
  });

  it("rejects a bare global abort owned by a retired fixed-store agent", async () => {
    const active = createActiveRun("global", { agentId: "research" });
    const context = createChatAbortContext({
      chatAbortControllers: new Map([["run-research", active]]),
      getRuntimeConfig: () => ({
        agents: {
          ownership: "explicit",
          defaults: { sessionStore: { agentId: "retired" } },
          entries: { ops: {}, research: {} },
        },
        session: { scope: "global", store: "/tmp/shared-sessions.sqlite" },
      }),
    });

    const respond = await invokeChatAbortHandler({
      handler: handleChatAbortRequestWithLifecycle,
      context,
      request: { sessionKey: "global", runId: "run-research" },
    });

    expect(respond.mock.calls.at(-1)?.[2]).toMatchObject({
      code: "INVALID_REQUEST",
      message: 'session key belongs to retired agent "retired"',
    });
    expect(active.controller.signal.aborted).toBe(false);
  });
});

function createDeferredWorkerCancellation() {
  const cancelled = createDeferred();
  const workerPersistence = createDeferred<string[]>();
  const service = {};
  registerWorkerInferenceSessionControl(service, {
    hasSession: () => true,
    reserveSessionDrain: () => {
      throw new Error("unexpected drain reservation");
    },
    resolveSessionTargetForRunId: () => undefined,
    captureSessionCancellation: () => ({
      runIds: ["worker-run"],
      cancel: (control) => {
        control?.assertCurrent?.();
        control?.onCancelled?.("worker-run");
        cancelled.resolve();
        return workerPersistence.promise;
      },
    }),
  });
  return { cancelled, workerPersistence, service };
}

function setPendingRegistrations(
  context: ReturnType<typeof createChatAbortContext>,
  ts = 1,
  attemptId?: string,
) {
  for (const prefix of ["agent", "pending-chat"]) {
    context.dedupe.set(`${prefix}:pending`, {
      ts,
      ok: true,
      payload: {
        runId: "pending",
        status: "accepted",
        sessionKey: "main",
        agentId: "main",
        ...(attemptId ? { reservationId: attemptId, attemptId } : {}),
      },
    });
  }
}

describe("chat.abort original authority and registration", () => {
  it("preserves exact-run descendant and partial persistence failures after parent Stop", async () => {
    const descendantFailure = new Error("descendant cancellation failed");
    const partialFailure = new Error("partial persistence failed");
    const context = createChatAbortContext();
    const run = createActiveRun("main", { sessionId: "main-session", agentId: "main" });
    context.chatAbortControllers.set("parent-run", run);
    context.chatRunState.getOrCreate("parent-run").buffer = "captured parent output";
    const descendants = vi
      .spyOn(abortDescendants, "abortControlledSubagents")
      .mockImplementationOnce(async (params) => {
        await params.beforeKill?.(() => {});
        throw descendantFailure;
      });
    const persist = vi
      .spyOn(persistence, "persistAbortedPartials")
      .mockRejectedValueOnce(partialFailure);
    const respond = vi.fn();
    try {
      await expect(
        invokeChatAbortHandler({
          handler: handleChatAbortRequestWithLifecycle,
          context,
          request: { sessionKey: "main", runId: "parent-run" },
          client: { connect: { scopes: ["operator.admin"] } },
          respond,
        }),
      ).rejects.toMatchObject({ errors: [descendantFailure, partialFailure] });
      expect(run.controller.signal.aborted).toBe(true);
      expect(persist).toHaveBeenCalledOnce();
      expect(respond).not.toHaveBeenCalled();
    } finally {
      descendants.mockRestore();
      persist.mockRestore();
    }
  });

  it.each([undefined, "worker-run"])(
    "waits for worker cancellation persistence before responding to Stop with runId=%s",
    async (runId) => {
      const { cancelled, workerPersistence, service } = createDeferredWorkerCancellation();
      const respond = vi.fn();
      const stopping = invokeChatAbortHandler({
        handler: handleChatAbortRequestWithLifecycle,
        context: createChatAbortContext({ workerEnvironmentService: service }),
        request: { sessionKey: "main", ...(runId ? { runId } : {}) },
        client: { connect: { scopes: ["operator.admin"] } },
        respond,
      });
      try {
        await cancelled.promise;
        expect(respond).not.toHaveBeenCalled();
      } finally {
        workerPersistence.resolve(["worker-run"]);
        await stopping;
      }
      expectAbortPayload(requireLastRespondCall(respond)[1], {
        aborted: true,
        runIds: ["worker-run"],
      });
    },
  );

  it("preserves worker cancellation and partial persistence failures after synchronous Stop", async () => {
    const { cancelled, workerPersistence, service } = createDeferredWorkerCancellation();
    const workerFailure = new Error("worker cancellation write failed");
    const partialFailure = new Error("partial output write failed");
    const context = createChatAbortContext({ workerEnvironmentService: service });
    const run = createActiveRun("main", { sessionId: "main-session", agentId: "main" });
    context.chatAbortControllers.set("worker-run", run);
    context.chatRunState.getOrCreate("worker-run").buffer = "captured output";
    const persist = vi
      .spyOn(persistence, "persistAbortedPartials")
      .mockRejectedValue(partialFailure);
    const respond = vi.fn();
    const stopping = invokeChatAbortHandler({
      handler: handleChatAbortRequestWithLifecycle,
      context,
      request: { sessionKey: "main" },
      client: { connect: { scopes: ["operator.admin"] } },
      respond,
    });
    const rejected = expect(stopping).rejects.toMatchObject({
      errors: [workerFailure, partialFailure],
    });
    try {
      await cancelled.promise;
      expect(run.controller.signal.aborted).toBe(true);
      expect(respond).not.toHaveBeenCalled();
      workerPersistence.reject(workerFailure);
      await rejected;
      expect(persist).toHaveBeenCalledOnce();
      expect(respond).not.toHaveBeenCalled();
    } finally {
      workerPersistence.resolve([]);
      await stopping.catch(() => undefined);
      persist.mockRestore();
    }
  });

  it.each(["queued", "active", "lifecycle"] as const)(
    "stops subsequent effects after a synchronous %s cancellation revokes authority",
    async (firstEffect) => {
      let current = true;
      const cancelInferenceForSession = vi.fn(() => ["worker"]);
      const context = createChatAbortContext({
        workerEnvironmentService: createWorkerInferenceCancellationService(
          "main-session",
          ["worker"],
          cancelInferenceForSession,
        ),
      });
      const first = createActiveRun("main", { sessionId: "main-session", agentId: "main" });
      const second = createActiveRun("main", { sessionId: "main-session", agentId: "main" });
      if (firstEffect === "queued") {
        context.chatQueuedTurns.set("first", first);
        context.chatQueuedTurns.set("second", second);
      } else {
        context.chatAbortControllers.set("first", first);
        context.chatAbortControllers.set("second", second);
        context.chatRunState.getOrCreate("first").buffer = "committed partial";
        context.chatRunState.getOrCreate("second").buffer = "untouched partial";
      }
      if (firstEffect !== "lifecycle") {
        first.controller.signal.addEventListener(
          "abort",
          () => {
            current = false;
          },
          { once: true },
        );
      }
      const lifecycle = vi.fn(() => {
        if (firstEffect === "lifecycle") {
          current = false;
        }
        return true;
      });
      setPendingRegistrations(context);
      const pending = [...context.dedupe];
      const persist = vi.spyOn(persistence, "persistAbortedPartials").mockResolvedValue(undefined);
      try {
        await expect(
          invokeChatAbortHandler({
            handler: (options) =>
              handleChatAbortRequestWithLifecycle(
                {
                  ...options,
                  hasCurrentClientAuthority: () => current,
                },
                { onAuthorizedAfterQueuedAbort: lifecycle },
              ),
            context,
            request: { sessionKey: "main" },
            client: { connect: { scopes: ["operator.admin"] } },
          }),
        ).rejects.toThrow("requester authority changed");
        expect(first.controller.signal.aborted).toBe(firstEffect !== "lifecycle");
        expect(second.controller.signal.aborted).toBe(false);
        expect([...context.dedupe]).toEqual(pending);
        expect(cancelInferenceForSession).not.toHaveBeenCalled();
        expect(lifecycle).toHaveBeenCalledTimes(firstEffect === "queued" ? 0 : 1);
        if (firstEffect === "active") {
          expect(persist).toHaveBeenCalledOnce();
          expect(persist.mock.calls[0]?.[0].snapshots.map((snapshot) => snapshot.runId)).toEqual([
            "first",
          ]);
          expect(context.chatRunState.resolveBuffer("second", { final: true }).text).toBe(
            "untouched partial",
          );
        } else {
          expect(persist.mock.calls.flatMap(([call]) => call.snapshots)).toEqual([]);
          if (firstEffect === "queued") {
            expect(persist).not.toHaveBeenCalled();
          } else {
            expect(context.chatRunState.resolveBuffer("first", { final: true }).text).toBe(
              "committed partial",
            );
            expect(context.chatRunState.resolveBuffer("second", { final: true }).text).toBe(
              "untouched partial",
            );
          }
        }
      } finally {
        persist.mockRestore();
      }
    },
  );

  it("does not adopt replacement active and pending registrations during a session-wide Stop", async () => {
    const context = createChatAbortContext();
    const first = createActiveRun("main", { sessionId: "main-session", agentId: "main" });
    const stale = createActiveRun("main", { sessionId: "main-session", agentId: "main" });
    const replacement = createActiveRun("main", { sessionId: "main-session", agentId: "main" });
    context.chatAbortControllers.set("first", first);
    context.chatAbortControllers.set("reused", stale);
    setPendingRegistrations(context, 1, "old");
    let pending: Array<[string, unknown]> = [];
    first.controller.signal.addEventListener(
      "abort",
      () => {
        context.chatAbortControllers.set("reused", replacement);
        setPendingRegistrations(context, 2, "new");
        pending = [...context.dedupe];
      },
      { once: true },
    );
    const response = await invokeAbort({
      context,
      sessionKey: "main",
      connId: "owner",
      deviceId: "device",
      scopes: ["operator.admin"],
    });
    expectAbortPayload(requireLastRespondCall(response)[1], { aborted: true, runIds: ["first"] });
    expect(stale.controller.signal.aborted).toBe(false);
    expect(replacement.controller.signal.aborted).toBe(false);
    expect([...context.dedupe]).toEqual(pending);
  });

  it.each(["active", "queued", "pending-chat", "agent", "worker"] as const)(
    "retains the original source and target fence before explicit %s cancellation",
    async (kind) => {
      for (const changed of ["source", "target"] as const) {
        const cancelInferenceForSession = vi.fn(() => ["run-1"]);
        const run = createActiveRun("agent:main:main", { agentId: "main" });
        const context = createChatAbortContext({
          workerEnvironmentService: createWorkerInferenceCancellationService(
            "main-session",
            kind === "worker" ? ["run-1"] : [],
            cancelInferenceForSession,
          ),
        });
        if (kind === "active") {
          context.chatAbortControllers.set("run-1", run);
        } else if (kind === "queued") {
          context.chatQueuedTurns.set("run-1", run);
        } else if (kind !== "worker") {
          context.dedupe.set(`${kind}:run-1`, {
            ts: Date.now(),
            ok: true,
            payload: {
              runId: "run-1",
              sessionKey: "agent:main:main",
              agentId: "main",
              status: "accepted",
            },
          });
        }
        const before = [...context.dedupe];
        await expect(
          invokeChatAbortHandler({
            handler: (options) =>
              handleChatAbortRequestWithLifecycle({
                ...options,
                hasCurrentClientAuthority: () => changed !== "source",
                sessionMutationAuthorization: {
                  assertCurrent: () => {
                    throw new Error("target changed");
                  },
                  assertTargetCurrent: () => {
                    throw new Error("target changed");
                  },
                },
              }),
            context,
            request: { sessionKey: "agent:main:main", runId: "run-1" },
            client: { connId: "owner", connect: { scopes: ["operator.admin"] } },
          }),
        ).rejects.toThrow(changed === "source" ? "requester authority changed" : "target changed");
        expect(run.controller.signal.aborted).toBe(false);
        expect(context.chatAbortControllers.has("run-1")).toBe(kind === "active");
        expect(context.chatQueuedTurns.has("run-1")).toBe(kind === "queued");
        expect([...context.dedupe]).toEqual(before);
        expect(cancelInferenceForSession).not.toHaveBeenCalled();
      }
    },
  );

  it("does not fall back to live worker queries without a registered capture owner", async () => {
    const captureSessionCancellation = vi.fn(() => ({
      runIds: ["worker-run"],
      cancel: async () => ["worker-run"],
    }));
    const context = createChatAbortContext({
      workerEnvironmentService: {
        captureSessionCancellation,
        hasSession: () => true,
      },
    });
    for (const runId of [undefined, "worker-run"]) {
      const response = await invokeAbort({
        context,
        runId,
        connId: "admin",
        deviceId: "admin",
        scopes: ["operator.admin"],
      });
      expectAbortPayload(requireLastRespondCall(response)[1], { aborted: false, runIds: [] });
    }
    expect(captureSessionCancellation).not.toHaveBeenCalled();
  });
});
