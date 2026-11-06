import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { RpcSourceRef } from "../../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
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
  createActiveRun as createUnscopedRun,
  createChatAbortContext,
  invokeChatAbortHandler,
} from "./chat.abort.test-helpers.js";

vi.mock("../session-utils.js", async () => ({
  ...(await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js")),
  loadGatewaySessionEntryReadOnlyInWorker: async () => ({
    entry: { sessionId: "main-session" },
    storePath: "/synthetic/chat-abort/session-controller.sqlite",
  }),
}));

const storeScope = "/synthetic/chat-abort/session-controller.sqlite";
const singleContext = () => createSingleAbortContext({ storeScope });

function expectResult(
  respond: Awaited<ReturnType<typeof invokeAbort>>,
  runIds: string[],
  aborted = true,
) {
  expectAbortPayload(requireLastRespondCall(respond)[1], { aborted, runIds });
}

function invokeLifecycle(
  context: Parameters<typeof invokeChatAbortHandler>[0]["context"],
  request: Parameters<typeof invokeChatAbortHandler>[0]["request"] = { sessionKey: "main" },
  options: Partial<Parameters<typeof invokeChatAbortHandler>[0]> = {},
) {
  return invokeChatAbortHandler({
    handler: handleChatAbortRequestWithLifecycle,
    context,
    request,
    client: { connect: { scopes: ["operator.admin"] } },
    ...options,
  });
}

function createActiveRun(...[sessionKey, options]: Parameters<typeof createUnscopedRun>) {
  return createUnscopedRun(sessionKey, {
    ...(sessionKey === "main" ? { agentId: "main" } : {}),
    storeScope,
    ...options,
  });
}

function abortAsOwner(params: Omit<Parameters<typeof invokeAbort>[0], "connId" | "deviceId">) {
  return invokeAbort({ ...params, connId: "conn-owner", deviceId: "dev-owner" });
}

function queuedTurn(owner?: string): RpcSourceRef {
  return createActiveRun("main", {
    queued: true,
    owner:
      owner === "none"
        ? undefined
        : { connId: `conn-${owner ?? "owner"}`, deviceId: `dev-${owner ?? "owner"}` },
  });
}

function workerContext(
  cancel: Parameters<typeof createWorkerInferenceCancellationService>[2],
  runIds = ["worker-run"],
  context = createChatAbortContext(),
) {
  context.workerEnvironmentService = createWorkerInferenceCancellationService(
    "main-session",
    runIds,
    cancel,
  );
  return context;
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
    const context = singleContext();
    const active = rpcSourceTesting.get("run-1");
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
    expect(rpcSourceTesting.get("run-1")).toBe(active);
    expect(active?.input.abortSignal.aborted).toBe(false);
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
    expectResult(await abortAsAdmin({ context, runId: "worker-run" }), ["worker-run"]);
    expect(cancel).toHaveBeenCalledWith({
      sessionId: "original-worker-session",
      runId: "worker-run",
    });
  });

  it("rejects non-admin worker-only inference aborts", async () => {
    const cancelInferenceForSession = vi.fn(() => ["worker-run"]);
    const context = workerContext(cancelInferenceForSession);
    for (const runId of [undefined, "worker-run"]) {
      const respond = await abortAsOther({ context, runId });
      expect(requireLastRespondCall(respond)[0]).toBe(false);
      expect(requireLastRespondCall(respond)[2]?.message).toBe("unauthorized");
    }
    expect(cancelInferenceForSession).not.toHaveBeenCalled();

    expectResult(await abortAsAdmin({ context, runId: "worker-run" }), ["worker-run"]);
    expect(cancelInferenceForSession).toHaveBeenCalledWith({
      sessionId: "main-session",
      runId: "worker-run",
    });
  });

  it("does not let a local run owner cancel worker inference", async () => {
    for (const runId of [undefined, "run-1"]) {
      const cancelInferenceForSession = vi.fn(() => ["run-1"]);
      const context = workerContext(cancelInferenceForSession, ["run-1"], singleContext());
      expectResult(await abortAsOwner({ context, runId }), ["run-1"]);
      expect(cancelInferenceForSession).not.toHaveBeenCalled();
    }
  });

  it.each([
    { requester: "other client", invoke: abortAsOther, allowed: false },
    { requester: "operator.admin", invoke: abortAsAdmin, allowed: true },
  ])("applies exact-run ownership to $requester", async ({ invoke, allowed }) => {
    const respond = await invoke({ context: singleContext(), runId: "run-1" });
    const [ok, payload, error] = requireLastRespondCall(respond);
    expect(ok).toBe(allowed);
    if (allowed) {
      expectAbortPayload(payload, { aborted: true, runIds: ["run-1"] });
    } else {
      expect(payload).toBeUndefined();
      expect(error).toMatchObject({ code: "INVALID_REQUEST", message: "unauthorized" });
      expect(rpcSourceTesting.has("run-1")).toBe(true);
    }
  });

  it("does not reveal a foreign hidden run to ordinary session aborts", async () => {
    const hidden = createActiveRun("main", {
      controlUiVisible: false,
      owner: { connId: "conn-hidden", deviceId: "dev-hidden" },
    });
    const context = createChatAbortContext({ sources: [["run-hidden", hidden]] });

    const respond = await abortAsOther({ context });

    const [ok, payload] = requireLastRespondCall(respond);
    expect(ok).toBe(true);
    expectAbortPayload(payload, { aborted: false, runIds: [] });
    expect(hidden.input.abortSignal.aborted).toBe(false);
    expect(rpcSourceTesting.has("run-hidden")).toBe(true);
  });
});

describe("chat.abort queued-turn contract", () => {
  it("cancels queued inputs before active cancellation", async () => {
    const order: string[] = [];
    const queued = queuedTurn();
    queued.input.abortSignal.addEventListener("abort", () => order.push("queued-abort"));
    const active = createActiveRun("main", {
      owner: { connId: "conn-owner", deviceId: "dev-owner" },
    });
    active.input.abortSignal.addEventListener("abort", () => order.push("active-abort"));
    const context = createChatAbortContext({
      sources: [
        ["active-1", active],
        ["queued-1", queued],
      ],
    });
    const respond = await abortAsOwner({ context });
    expect(requireLastRespondCall(respond)[0]).toBe(true);
    expectResult(respond, ["queued-1", "active-1"]);
    expect(order).toEqual(["queued-abort", "active-abort"]);
  });

  it("cancels a waiting channel input outside the RPC registry", async () => {
    const waiting = createActiveRun("main", { queued: true });
    expectResult(await abortAsAdmin({ context: createChatAbortContext() }), []);
    expect(waiting.input.abortSignal.aborted).toBe(true);
  });

  it("aborts a queued turn by runId after active registration is gone", async () => {
    const queued = queuedTurn();
    const context = createChatAbortContext({ sources: [["queued-1", queued]] });

    const respond = await abortAsOwner({ context, runId: "queued-1" });
    const call = requireLastRespondCall(respond);
    expect(call[0]).toBe(true);
    expectAbortPayload(call[1], { aborted: true, runIds: ["queued-1"] });
    expect(queued.input.abortSignal.aborted).toBe(true);
    expect(rpcSourceTesting.has("queued-1")).toBe(false);
  });

  it.each([
    { name: "explicit foreign run", runId: "queued-1" },
    { name: "foreign session", runId: undefined },
    { name: "mismatched ownerless session", runId: "queued-1", sessionKey: "other", owner: "none" },
  ])("rejects $name without clearing queued input", async ({ runId, sessionKey, owner }) => {
    const queued = queuedTurn(owner);
    const context = createChatAbortContext({ sources: [["queued-1", queued]] });
    const call = requireLastRespondCall(await abortAsOther({ context, runId, sessionKey }));
    expect(call[0]).toBe(false);
    if (sessionKey) {
      expect(call[2]?.message).toBe("runId does not match sessionKey");
    }
    expect(queued.input.abortSignal.aborted).toBe(false);
    expect(rpcSourceTesting.has("queued-1")).toBe(true);
  });

  it.each([
    {
      owner: undefined,
      agentId: "research",
      error: expect.stringContaining("has no explicit owner"),
    },
    { owner: "ops", agentId: "ops", error: undefined },
    {
      owner: "retired",
      agentId: "research",
      error: 'session key belongs to retired agent "retired"',
    },
  ])(
    "resolves bare global abort with fixed-store owner $owner",
    async ({ owner, agentId, error }) => {
      const active = createActiveRun("global", { agentId });
      const runId = `run-${agentId}`;
      const context = createChatAbortContext({
        sources: [[runId, active]],
        getRuntimeConfig: () => ({
          agents: {
            ownership: "explicit",
            ...(owner ? { defaults: { sessionStore: { agentId: owner } } } : {}),
            entries: { ops: {}, research: {} },
          },
          session: { scope: "global", ...(owner ? { store: "/tmp/shared-sessions.sqlite" } : {}) },
        }),
      });
      const respond = await invokeChatAbortHandler({
        handler: handleChatAbortRequestWithLifecycle,
        context,
        request: { sessionKey: "global", runId },
      });
      if (error) {
        expect(respond.mock.lastCall?.[2]).toMatchObject({
          code: "INVALID_REQUEST",
          message: error,
        });
      } else {
        expect(respond.mock.lastCall?.[0]).toBe(true);
      }
      expect(active.input.abortSignal.aborted).toBe(!error);
    },
  );
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
      settled: Promise.resolve(),
      executing: false,
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
    const run = createActiveRun("main");
    rpcSourceTesting.set("parent-run", run);
    context.chatRunState.getOrCreate("parent-run").buffer = "captured parent output";
    using _ = vi
      .spyOn(abortDescendants, "abortControlledSubagents")
      .mockImplementationOnce(async (params) => {
        await params.prepareSelection?.prepare();
        await params.beforeKill?.(() => {});
        throw descendantFailure;
      });
    using persist = vi
      .spyOn(persistence, "persistAbortedPartials")
      .mockRejectedValueOnce(partialFailure);
    const respond = vi.fn();
    await expect(
      invokeLifecycle(context, { sessionKey: "main", runId: "parent-run" }, { respond }),
    ).rejects.toMatchObject({ errors: [descendantFailure, partialFailure] });
    expect(run.input.abortSignal.aborted).toBe(true);
    expect(persist).toHaveBeenCalledOnce();
    expect(respond).not.toHaveBeenCalled();
  });

  it.each([undefined, "worker-run"])(
    "waits for worker cancellation persistence before responding to Stop with runId=%s",
    async (runId) => {
      const { cancelled, workerPersistence, service } = createDeferredWorkerCancellation();
      const respond = vi.fn();
      const stopping = invokeLifecycle(
        createChatAbortContext({ workerEnvironmentService: service }),
        { sessionKey: "main", ...(runId ? { runId } : {}) },
        { respond },
      );
      try {
        await cancelled.promise;
        expect(respond).not.toHaveBeenCalled();
      } finally {
        workerPersistence.resolve(["worker-run"]);
        await stopping;
      }
      expectResult(respond, ["worker-run"]);
    },
  );

  it("preserves worker cancellation and partial persistence failures after synchronous Stop", async () => {
    const { cancelled, workerPersistence, service } = createDeferredWorkerCancellation();
    const workerFailure = new Error("worker cancellation write failed");
    const partialFailure = new Error("partial output write failed");
    const context = createChatAbortContext({ workerEnvironmentService: service });
    const run = createActiveRun("main");
    rpcSourceTesting.set("worker-run", run);
    context.chatRunState.getOrCreate("worker-run").buffer = "captured output";
    using persist = vi
      .spyOn(persistence, "persistAbortedPartials")
      .mockRejectedValue(partialFailure);
    const respond = vi.fn();
    const stopping = invokeLifecycle(context, { sessionKey: "main" }, { respond });
    const rejected = expect(stopping).rejects.toMatchObject({
      errors: [workerFailure, partialFailure],
    });
    try {
      await cancelled.promise;
      expect(run.input.abortSignal.aborted).toBe(true);
      expect(respond).not.toHaveBeenCalled();
      workerPersistence.reject(workerFailure);
      await rejected;
      expect(persist).toHaveBeenCalledOnce();
      expect(respond).not.toHaveBeenCalled();
    } finally {
      workerPersistence.resolve([]);
      await stopping.catch(() => undefined);
    }
  });

  it.each(["queued", "active"] as const)(
    "stops subsequent effects after a synchronous %s cancellation revokes authority",
    async (firstEffect) => {
      let current = true;
      const cancelInferenceForSession = vi.fn(() => ["worker"]);
      const context = workerContext(cancelInferenceForSession, ["worker"]);
      const first = createActiveRun("main", { queued: firstEffect === "queued" });
      const second = createActiveRun("main", { queued: true });
      rpcSourceTesting.set("first", first);
      rpcSourceTesting.set("second", second);
      if (firstEffect === "active") {
        context.chatRunState.getOrCreate("first").buffer = "committed partial";
        context.chatRunState.getOrCreate("second").buffer = "untouched partial";
      }
      let secondPartialAtRevocation: string | undefined;
      first.input.abortSignal.addEventListener(
        "abort",
        () => {
          secondPartialAtRevocation = context.chatRunState.resolveBuffer("second", {
            final: true,
          }).text;
          current = false;
        },
        { once: true },
      );
      setPendingRegistrations(context);
      const pending = [...context.dedupe];
      using persist = vi.spyOn(persistence, "persistAbortedPartials").mockResolvedValue(undefined);
      await expect(
        invokeLifecycle(context, undefined, {
          handler: (options) =>
            handleChatAbortRequestWithLifecycle({
              ...options,
              hasCurrentClientAuthority: () => current,
            }),
        }),
      ).rejects.toMatchObject({
        message: "Chat cancellation and persistence failed",
        errors: [
          expect.objectContaining({ message: "Gateway requester authority changed" }),
          expect.objectContaining({ message: "Gateway requester authority changed" }),
        ],
      });
      expect(first.input.abortSignal.aborted).toBe(true);
      // A successor waits behind the active first turn, so Stop withdraws it
      // before the first turn revokes authority. Two pending inputs keep FIFO order.
      expect(second.input.abortSignal.aborted).toBe(firstEffect === "active");
      expect([...context.dedupe]).toEqual(pending);
      expect(cancelInferenceForSession).not.toHaveBeenCalled();
      if (firstEffect === "active") {
        expect(persist).toHaveBeenCalledOnce();
        expect(persist.mock.calls[0]?.[0].snapshots.map((snapshot) => snapshot.runId)).toEqual([
          "first",
        ]);
        expect(secondPartialAtRevocation).toBe("");
        expect(context.chatRunState.resolveBuffer("second", { final: true }).text).toBe("");
      } else {
        expect(persist.mock.calls.flatMap(([call]) => call.snapshots)).toEqual([]);
        expect(persist).not.toHaveBeenCalled();
      }
    },
  );

  it("withdraws selected pending input without adopting reentrant replacement registrations", async () => {
    const context = createChatAbortContext();
    const first = createActiveRun("main");
    const stale = createActiveRun("main", { queued: true });
    let replacement: RpcSourceRef | undefined;
    rpcSourceTesting.set("first", first);
    rpcSourceTesting.set("reused", stale);
    setPendingRegistrations(context, 1, "old");
    let pending: Array<[string, unknown]> = [];
    first.input.abortSignal.addEventListener(
      "abort",
      () => {
        replacement = createActiveRun("main", { queued: true });
        rpcSourceTesting.set("reused", replacement);
        setPendingRegistrations(context, 2, "new");
        pending = [...context.dedupe];
      },
      { once: true },
    );
    expectResult(await abortAsAdmin({ context }), ["reused", "first"]);
    expect(stale.input.abortSignal.aborted).toBe(true);
    expect(replacement).toBeDefined();
    expect(replacement?.input.abortSignal.aborted).toBe(false);
    expect(rpcSourceTesting.get("reused")).toBe(replacement);
    expect([...context.dedupe]).toEqual(pending);
  });

  it.each(["active", "queued", "pending-chat", "agent", "worker"] as const)(
    "retains the original source and target fence before explicit %s cancellation",
    async (kind) => {
      for (const changed of ["source", "target"] as const) {
        const cancelInferenceForSession = vi.fn(() => ["run-1"]);
        const run = createActiveRun("agent:main:main", {
          agentId: "main",
          queued: kind === "queued",
        });
        const context = workerContext(
          cancelInferenceForSession,
          kind === "worker" ? ["run-1"] : [],
        );
        if (kind === "active" || kind === "queued") {
          rpcSourceTesting.set("run-1", run);
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
        expect(run.input.abortSignal.aborted).toBe(false);
        expect(rpcSourceTesting.has("run-1")).toBe(kind === "active" || kind === "queued");
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
      expectResult(await abortAsAdmin({ context, runId }), [], false);
    }
    expect(captureSessionCancellation).not.toHaveBeenCalled();
  });
});
