import assert from "node:assert/strict";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi, type Mock } from "vitest";
import { validateGatewaySuspendStatusResult } from "../../packages/gateway-protocol/src/index.js";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { createGatewayHostLifecycle } from "../cli/gateway-cli/host-lifecycle.js";
import {
  consumeGatewaySuspendHandoff,
  getGatewaySuspendStatus,
  markGatewaySuspendExiting,
  prepareGatewaySuspend,
  resetGatewaySuspendCoordinatorForLifecycleRestart,
  resumeGatewaySuspend,
} from "../infra/gateway-suspend-coordinator.js";
import {
  beginGatewayRestartSignalAdmission,
  beginGatewayRootWorkAdmissionWhenOpen,
  captureGatewayRootWorkAdmissionContinuationScope,
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  retainGatewayRootWorkAdmissionContinuation,
  tryBeginGatewayRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import { runSessionMutation } from "../sessions/session-controller.lifecycle.js";
import { retireSessionControllerInput } from "../sessions/session-controller.mailbox.js";
import { rpcSourceTesting } from "../sessions/session-lifecycle-admission.test-support.js";
import { getAsyncWorkSignal, trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createPluginGatewayMethodDescriptor } from "./methods/descriptor.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { getGatewayProcessInstanceId } from "./process-instance.js";
import { runWithGatewayRequestEnvelope } from "./server-methods.js";
import { createRequestGate, expectRejected } from "./server-methods.request-gate.test-support.js";
import { dispatchSuspensionRequest } from "./server-methods.suspension-admission.test-support.js";
import { createLazyCoreHandlers } from "./server-methods/lazy-core-handlers.js";
import { suspendHandlers } from "./server-methods/suspend.js";
import type { GatewayRequestContext, GatewayRequestHandler } from "./server-methods/types.js";
import { GatewayRequestEntryLifetime } from "./server-request-entry.js";
import { TerminalSessionManager } from "./terminal/session-manager.js";
import { baseOpenRequest, makeFakePty } from "./terminal/session-manager.test-helpers.js";
import { createRpcSourceForTest } from "./test-helpers.rpc-source.js";

type DispatchOptions = Omit<
  Parameters<typeof dispatchSuspensionRequest>[0],
  "method" | "handler" | "scope"
> & {
  scope?: Parameters<typeof dispatchSuspensionRequest>[0]["scope"];
};
function dispatch(method: string, handler: GatewayRequestHandler, options: DispatchOptions = {}) {
  return dispatchSuspensionRequest({ scope: "operator.admin", ...options, method, handler });
}

async function startHeldWork(method: string, payload: Record<string, unknown>) {
  const gate = createRequestGate();
  const active = dispatch(
    method,
    async ({ respond }) => {
      await gate.pause();
      respond(true, payload);
    },
    { scope: "operator.write" },
  );
  await gate.entered;
  return { active, finish: { resolve: gate.release } };
}

function createSuspendContext(
  terminalSessions: { size: number },
  logGateway: { warn: Mock; info?: Mock } = {
    warn: vi.fn(),
  },
) {
  const cron = {
    pauseScheduling: vi.fn(),
    resumeScheduling: vi.fn(),
    getSuspensionBlockerCount: vi.fn(() => 0),
  };
  const context = {
    getRuntimeConfig: () => ({}),
    cron,
    logGateway,
    terminalSessions,
  } as unknown as GatewayRequestContext;
  return { context, cron };
}

function suspensionRpc(
  context: GatewayRequestContext,
  action: "prepare" | "status" | "resume",
  requestParams: unknown,
  core = false,
) {
  return requestSuspension(action, requestParams, {
    context,
    core,
    scope: action === "status" ? "operator.read" : "operator.admin",
  });
}

/** Retain terminal write custody after execution retires so suspension can observe it. */
async function registerTerminalPersistenceFixture(
  runId: string,
  identity: { sessionId: string; sessionKey: string },
) {
  const terminalPersistence = createDeferredCore();
  const source = createRpcSourceForTest(
    {
      controlUiVisible: true,
      projectSessionTerminalPending: true,
      onSettled: () => terminalPersistence.promise,
    },
    { ...identity, runId },
  );
  rpcSourceTesting.set(runId, source);
  retireSessionControllerInput(source.input);
  const settle = async () => {
    terminalPersistence.resolve();
    await source.input.settlement.promise;
  };
  onTestFinished(settle);
  return { source, settle };
}

beforeEach(() => {
  resetGatewaySuspendCoordinatorForLifecycleRestart();
  resetGatewayWorkAdmission();
});

afterEach(() => {
  resetGatewaySuspendCoordinatorForLifecycleRestart();
  resetGatewayWorkAdmission();
  vi.useRealTimers();
});

function expectStatus(respond: unknown, fields: Record<string, unknown>) {
  expect(respond).toHaveBeenCalledWith(true, expect.objectContaining(fields));
}

function expectFailure(respond: unknown, fields: Record<string, unknown>) {
  expect(respond).toHaveBeenCalledWith(false, undefined, expect.objectContaining(fields));
}

function expectHandoff(host: ReturnType<typeof createGatewayHostLifecycle>, value: boolean) {
  expect(consumeGatewaySuspendHandoff(host.capability.externalRestart)).toEqual({
    ok: true,
    value,
  });
}

type SuspensionMethod = "status" | "prepare" | "resume" | "handoff";

async function requestSuspension(
  operation: SuspensionMethod,
  requestParams: unknown,
  options: Partial<Parameters<typeof dispatchSuspensionRequest>[0]> = {},
) {
  const method = `gateway.suspend.${operation}` as const;
  const result = dispatchSuspensionRequest({
    method,
    requestParams,
    scope: "operator.admin",
    core: true,
    handler: suspendHandlers[method]!,
    ...options,
  });
  await result.request;
  return result.respond;
}

function expectDraining(respond: unknown, activeCount: number, fields = {}) {
  expectStatus(respond, { status: "draining", activeCount, ...fields });
}

function expectConflict(respond: unknown) {
  expectFailure(respond, {
    details: expect.objectContaining({ reason: "gateway-suspension-conflict" }),
  });
}

function createHost(options: Partial<Parameters<typeof createGatewayHostLifecycle>[0]> = {}) {
  return createGatewayHostLifecycle({
    processOwner: { ownsProcessLifecycle: true, supervisor: "external" },
    isCurrent: () => true,
    isServing: () => true,
    acceptStop: () => {},
    ...options,
  });
}

const restartTarget = { pid: process.pid, ownerId: "gateway-owner", port: 18_789 };

describe("gateway request suspension admission", () => {
  it.each([false, true])(
    "reopens user RPCs after an abandoned drain, even with renewal: %s",
    async (renew) => {
      vi.useFakeTimers();
      const log = { warn: vi.fn(), info: vi.fn() };
      const { context, cron } = createSuspendContext({ size: 1 }, log);
      const params = { requestId: "abandoned-controller", drain: true };
      const prepare = () => suspensionRpc(context, "prepare", params, true);
      const read = () =>
        dispatch("sessions.list", ({ respond }) => respond(true, { sessions: [] }), {
          scope: "operator.read",
          context,
          core: true,
        });
      const initial = await prepare();
      expectStatus(initial, { status: "draining" });
      const fenced = read();
      await fenced.request;
      expectRejected(fenced.respond);
      await vi.advanceTimersByTimeAsync(30_000);
      if (renew) {
        const renewal = await prepare();
        expectStatus(renewal, { status: "draining" });
      }
      await vi.advanceTimersByTimeAsync(15_000);
      const reopened = read();
      await reopened.request;
      expect(reopened.respond).toHaveBeenCalledWith(true, { sessions: [] });
      expect(cron.resumeScheduling).toHaveBeenCalledOnce();
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("drain deadline expired"));
    },
  );

  it("refuses a committed service-stop read when close overtakes lazy preparation", async () => {
    markGatewayRestartDraining("stop (SIGTERM)");
    using gate = createRequestGate();
    const requestEntryLifetime = new GatewayRequestEntryLifetime();
    const handler = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true, { run: null }));
    const handlers = createLazyCoreHandlers({
      methods: ["update.runs.get"],
      loadHandlers: async () => {
        await gate.pause();
        return { "update.runs.get": handler };
      },
    });
    const read = dispatch(
      "update.runs.get",
      expectDefined(handlers["update.runs.get"], "lazy update-run handler"),
      {
        core: true,
        context: { ...createSuspendContext({ size: 0 }).context, requestEntryLifetime },
      },
    );
    await gate.entered;
    requestEntryLifetime.beginClose();
    gate.release();
    await expect(read.request).rejects.toThrow("Gateway request entry is closed");
    await requestEntryLifetime.sealAndJoin();
    expect(handler).not.toHaveBeenCalled();
    expect(read.respond).not.toHaveBeenCalled();
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it.each(["signal", "drain"] as const)(
    "keeps only authorized update-run reads available during restart %s",
    async (phase) => {
      if (phase === "signal") {
        expect(beginGatewayRestartSignalAdmission()).not.toBeNull();
      } else {
        markGatewayRestartDraining();
      }
      const handler = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true, { run: null }));
      const read = dispatch("update.runs.get", handler, { core: true });
      await read.request;
      if (phase === "signal") {
        expectRejected(read.respond);
        expect(handler).not.toHaveBeenCalled();
      } else {
        expect(read.respond).toHaveBeenCalledWith(true, { run: null });
        expect(handler).toHaveBeenCalledOnce();
      }

      for (const method of ["update.status", "update.run", "update.hold"]) {
        const blocked = dispatch(method, handler, { core: true });
        await blocked.request;
        expectRejected(blocked.respond);
      }
      const unauthorized = dispatch("update.runs.get", handler, {
        core: true,
        clientScopes: ["operator.read"],
      });
      await unauthorized.request;
      expectRejected(unauthorized.respond, { message: expect.stringContaining("operator.admin") });
      expect(handler).toHaveBeenCalledTimes(phase === "signal" ? 0 : 1);
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    },
  );

  it("refuses update-run reads during suspension preparation", async () => {
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension).not.toBeNull();
    const handler = vi.fn<GatewayRequestHandler>();
    const result = dispatch("update.runs.get", handler, { core: true });
    await result.request;
    expectRejected(result.respond);
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(["handoff", "installation-replaced"] as const)(
    "reports held and settled custody before %s without interrupting 200 admitted requests",
    async (restart) => {
      vi.useFakeTimers();
      const roots = Array.from({ length: 200 }, () => tryBeginGatewayRootWorkAdmission());
      const writing = createDeferredCore();
      const written = createDeferredCore();
      let mutation: Promise<void> | undefined;
      const host = createHost();
      const { context, cron } = createSuspendContext({ size: 0 }, { warn: vi.fn(), info: vi.fn() });
      context.hostLifecycle = host.capability;
      const request = (method: SuspensionMethod, params: unknown) =>
        requestSuspension(method, params, { context });
      try {
        const prepared = await request("prepare", {
          requestId: "release-update",
          terminalPolicy: "terminate",
          drain: true,
        });
        expectDraining(prepared, 200);
        const { suspensionId } = expectDefined(
          prepared.mock.calls[0],
          "suspension prepare response",
        )[1] as { suspensionId: string };
        const status = (includeLifecycle = false) =>
          request("status", {
            suspensionId,
            ...(includeLifecycle ? { includeLifecycle } : {}),
          });
        expectDraining(await status(), 200);
        const blocked = Promise.allSettled(
          Array.from({ length: 200 }, () => beginGatewayRootWorkAdmissionWhenOpen()),
        );
        await vi.advanceTimersByTimeAsync(30_000);
        mutation = runSessionMutation({
          scope: "suspension-status",
          identities: ["session"],
          run: async () => {
            writing.resolve();
            await written.promise;
          },
        });
        await writing.promise;
        expectDraining(await status(), 201, {
          writeCustody: [{ phase: "session-mutation", count: 1 }],
        });
        written.resolve();
        await mutation;
        expectDraining(await status(), 200, { writeCustody: [] });
        if (restart === "handoff") {
          expectStatus(
            await request("handoff", {
              suspensionId,
              target: { pid: process.pid, processInstanceId: getGatewayProcessInstanceId() },
            }),
            { status: "armed" },
          );
          expectHandoff(host, true);
        }
        await host.retire();
        markGatewayRestartDraining(
          restart === "handoff"
            ? "stop (SIGTERM)"
            : "restart (SIGUSR2: gateway.installation_replaced)",
        );
        expect((await blocked).every((result) => result.status === "rejected")).toBe(true);
        const owned = await status();
        expectDraining(owned, 200);
        const legacy = expectDefined(owned.mock.calls[0], "legacy suspension status response")[1];
        expect(legacy).not.toHaveProperty("ownerId");
        expect(legacy).not.toHaveProperty("phase");
        expectStatus(await status(true), {
          status: "draining",
          ownerId: "release-update",
          phase: "interrupting",
        });
        expect(validateGatewaySuspendStatusResult(legacy)).toBe(true);
        // Expiry cannot reopen a committed shutdown, even after all old roots settle.
        roots.forEach((root) => root?.release());
        await vi.advanceTimersByTimeAsync(120_000);
        expectDraining(await status(true), 0, { phase: "interrupting" });
        expectConflict(await request("status", { suspensionId: "foreign" }));
        expect(cron.resumeScheduling).not.toHaveBeenCalled();
        expectFailure(await request("resume", { suspensionId }), {
          code: "UNAVAILABLE",
          message: "gateway shutdown is committed",
        });
        expectHandoff(host, false);
        markGatewaySuspendExiting();
        expect(getGatewaySuspendStatus(suspensionId, true)).toMatchObject({
          status: "draining",
          ownerId: "release-update",
          phase: "exiting",
        });
        resetGatewayWorkAdmission();
        markGatewayRestartDraining();
        expect(getGatewaySuspendStatus(suspensionId)).toEqual({ status: "running" });
      } finally {
        written.resolve();
        await mutation;
        roots.forEach((root) => root?.release());
        await host.retire();
        resetGatewaySuspendCoordinatorForLifecycleRestart();
        vi.useRealTimers();
      }
    },
  );

  it.each([
    "armed",
    "committed",
    "unsupported-commit",
    "read-scope",
    "other-pid",
    "new-process-same-pid",
    "retired-host",
  ])("binds an external handoff to the authenticated live owner: %s", async (mode) => {
    const host = createHost({
      commitExternalStop:
        mode === "committed"
          ? () => {
              expectHandoff(host, true);
              markGatewayRestartDraining("stop (SIGTERM)");
            }
          : undefined,
    });
    const lease = prepareGatewaySuspend({
      requestId: "handoff-route",
      pauseScheduling: () => {},
      resumeScheduling: () => {},
      drain: true,
      inspect: { getRootRequests: () => 1, getTerminalPersistence: () => 0 },
    });
    assert(lease.status === "draining", "expected a held drain");
    try {
      const result = dispatchSuspensionRequest({
        method: "gateway.suspend.handoff",
        scope: "operator.admin",
        core: true,
        handler: suspendHandlers["gateway.suspend.handoff"]!,
        requestParams: {
          suspensionId: lease.suspensionId,
          ...(["committed", "unsupported-commit"].includes(mode) ? { commit: true } : {}),
          target: {
            pid: mode === "other-pid" ? process.pid + 1 : process.pid,
            processInstanceId:
              mode === "new-process-same-pid" ? "different-process" : getGatewayProcessInstanceId(),
          },
        },
        clientScopes: [mode === "read-scope" ? "operator.read" : "operator.admin"],
        context: {
          getRuntimeConfig: () => ({}),
          hostLifecycle: host.capability,
          logGateway: { warn: vi.fn() },
        } as unknown as GatewayRequestContext,
      });
      // Retire after async dispatch but before the synchronous commit.
      if (mode === "retired-host") {
        await host.retire();
      }
      await result.request;
      if (mode === "armed" || mode === "committed") {
        expect(result.respond).toHaveBeenCalledWith(true, {
          status: mode,
          suspensionId: lease.suspensionId,
          expiresAtMs: lease.expiresAtMs,
        });
      }
      if (mode === "committed") {
        expect(resumeGatewaySuspend(lease.suspensionId)).toEqual({
          ok: false,
          reason: "gateway-restarting",
        });
      } else if (mode !== "armed") {
        expect(result.respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
      }
      expectHandoff(host, mode === "armed");
    } finally {
      await host.retire();
      resumeGatewaySuspend(lease.suspensionId);
    }
  });

  it("keeps a facade continuation on the same admitted root", async () => {
    const methodRegistry = createGatewayMethodRegistry([
      createPluginGatewayMethodDescriptor({
        pluginId: "suspend-proof",
        name: "agent",
        handler: vi.fn(),
        scope: "operator.write",
      }),
    ]);
    const { context } = createSuspendContext({ size: 0 });
    let releaseContinuation: (() => void) | null = null;

    await runWithGatewayRequestEnvelope(
      "agent",
      null,
      async () => {
        releaseContinuation = retainGatewayRootWorkAdmissionContinuation();
      },
      {
        context,
        isWebchatConnect: () => false,
        methodRegistry,
        reject: (error) => {
          throw new Error(error.message);
        },
      },
    );

    expect(releaseContinuation).toBeTypeOf("function");
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension).not.toBeNull();
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    suspension?.rollback();
    const release = releaseContinuation as (() => void) | null;
    release?.();
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it("keeps an observation root busy until accepted child work settles", async () => {
    const draining = createDeferredCore();
    const finishChild = createDeferredCore();
    const settledChild = vi.fn();
    let child: Promise<void> | undefined;
    const observation = dispatch(
      "agent.wait",
      ({ respond }) => {
        const signal = expectDefined(getAsyncWorkSignal(), "observation lifetime");
        const admission = expectDefined(
          captureGatewayRootWorkAdmissionContinuationScope(),
          "admitted observation",
        );
        const acceptedChild = trackAsyncWork(async () => {
          signal.addEventListener("abort", () => draining.resolve(), { once: true });
          await finishChild.promise;
          admission.runSync(settledChild);
        });
        child = acceptedChild;
        void acceptedChild.catch(() => {});
        respond(true, { status: "ok" });
      },
      { core: true, requestParams: { runId: "observed-run" } },
    );
    try {
      await awaitGateBeforeSettlement(
        draining.promise,
        observation.request,
        "Observation returned before draining its accepted child",
      );
      expect(observation.respond).toHaveBeenCalledExactlyOnceWith(true, { status: "ok" });
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      expect(settledChild).not.toHaveBeenCalled();
    } finally {
      finishChild.resolve();
      await Promise.allSettled([observation.request, child]);
    }
    await observation.request;
    await child;
    expect(settledChild).toHaveBeenCalledOnce();
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it("reports a concurrent root as busy then excludes its own prepare request", async () => {
    const { active, finish } = await startHeldWork("suspend-proof.concurrent", { ok: true });

    const { context } = createSuspendContext({ size: 2 });
    const busy = await suspensionRpc(context, "prepare", {
      requestId: "request-concurrent-root",
      terminalPolicy: "terminate",
    });

    expectStatus(busy, {
      status: "busy",
      reason: "active-work",
      activeCount: 1,
      blockers: expect.arrayContaining([
        expect.objectContaining({ kind: "root-request", count: 1 }),
      ]),
    });

    finish.resolve();
    await active.request;
    const ready = await suspensionRpc(context, "prepare", {
      requestId: "request-own-root-excluded",
      terminalPolicy: "terminate",
    });

    expectStatus(ready, { status: "ready", activeCount: 0, blockers: [] });
    const readyPayload = ready.mock.calls[0]?.[1] as { suspensionId?: string } | undefined;
    expect(readyPayload?.suspensionId).toBeTypeOf("string");
    expect(resumeGatewaySuspend(readyPayload?.suspensionId ?? "missing")).toMatchObject({
      ok: true,
      resumed: true,
    });
  });

  it.each(["preserve", "terminate"] as const)(
    "drains admitted work and final-state writes with %s terminal policy",
    async (terminalPolicy) => {
      const preservingTerminals = terminalPolicy === "preserve";
      const { active, finish } = await startHeldWork("suspend-proof.admitted", { delivered: true });

      const pty = makeFakePty();
      const terminalSessions = new TerminalSessionManager({
        emit: vi.fn(),
        spawn: async () => pty,
      });
      await terminalSessions.open(baseOpenRequest());
      rpcSourceTesting.reset();
      const terminalPersistence = await registerTerminalPersistenceFixture("reply-pending", {
        sessionId: "session-pending",
        sessionKey: "agent:main:session-pending",
      });
      const { context, cron } = createSuspendContext(terminalSessions, {
        warn: vi.fn(),
        info: vi.fn(),
      });

      let suspensionId: string | undefined;
      try {
        const prepared = await suspensionRpc(context, "prepare", {
          requestId: "request-terminal-policy-drain",
          terminalPolicy,
          drain: true,
        });

        const result = expectDefined(
          prepared.mock.calls[0]?.[1] as { suspensionId: string; expiresAtMs: number } | undefined,
          "owned draining suspension lease",
        );
        suspensionId = result?.suspensionId;
        expect(prepared).toHaveBeenCalledWith(true, {
          status: "draining",
          suspensionId: expect.any(String),
          expiresAtMs: expect.any(Number),
          retryAfterMs: 5_000,
          activeCount: preservingTerminals ? 3 : 2,
          writeCustody: [{ phase: "terminal-persistence", count: 1 }],
          blockers: expect.arrayContaining([
            expect.objectContaining({ kind: "root-request", count: 1 }),
            expect.objectContaining({ kind: "terminal-persistence", count: 1 }),
            ...(preservingTerminals
              ? [expect.objectContaining({ kind: "terminal-session", count: 1 })]
              : []),
          ]),
        });
        expect(context.logGateway.info).toHaveBeenCalledWith(
          expect.stringContaining("run=reply-pending session=agent:main:session-pending"),
        );
        expect(cron.pauseScheduling).toHaveBeenCalledOnce();
        expect(cron.resumeScheduling).not.toHaveBeenCalled();

        const unrelatedHandler = vi.fn<GatewayRequestHandler>();
        const unrelated = dispatch("suspend-proof.unrelated", unrelatedHandler, {
          scope: "operator.write",
          context,
        });
        await unrelated.request;
        expect(unrelatedHandler).not.toHaveBeenCalled();
        expectRejected(unrelated.respond, {
          code: "UNAVAILABLE",
          details: expect.objectContaining({ phase: "draining" }),
        });

        expect(terminalSessions.size).toBe(1);
        expect(pty.killed).toBe(false);
        finish.resolve();
        await active.request;
        if (preservingTerminals) {
          terminalSessions.disposeAll();
        }

        const lease = { suspensionId: result.suspensionId };
        const pending = await suspensionRpc(context, "status", lease);
        expect(pending).toHaveBeenCalledWith(true, {
          status: "draining",
          expiresAtMs: result.expiresAtMs,
          retryAfterMs: 5_000,
          activeCount: 1,
          blockers: [expect.objectContaining({ kind: "terminal-persistence", count: 1 })],
          writeCustody: [{ phase: "terminal-persistence", count: 1 }],
        });

        await terminalPersistence.settle();
        const ready = await suspensionRpc(context, "status", lease);
        expect(ready).toHaveBeenCalledWith(true, {
          status: "ready",
          expiresAtMs: result.expiresAtMs,
          writeCustody: [],
        });
        expect(cron.resumeScheduling).not.toHaveBeenCalled();

        const resumed = await suspensionRpc(context, "resume", lease);
        expect(resumed).toHaveBeenCalledWith(true, { ok: true, status: "running", resumed: true });
        expect(cron.resumeScheduling).toHaveBeenCalledOnce();
        expect(terminalSessions.size).toBe(preservingTerminals ? 0 : 1);
        expect(pty.killed).toBe(preservingTerminals);
      } finally {
        finish.resolve();
        await active.request;
        if (suspensionId) {
          resumeGatewaySuspend(suspensionId);
        }
        terminalSessions.disposeAll();
      }
    },
  );

  it("rejects new read and write handlers outside the suspension allowlist", async () => {
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);

    const handler = vi.fn<GatewayRequestHandler>(({ respond }) =>
      respond(true, { state: "visible" }),
    );
    for (const [method, scope, retryAfterMs] of [
      ["suspend-proof.write", "operator.write", undefined],
      ["suspend-proof.read", "operator.read", 1_000],
      ["agent.identity.get", "operator.read", 60_000],
    ] as const) {
      const blocked = dispatch(method, handler, {
        scope,
        core: method === "agent.identity.get",
      });
      await blocked.request;
      expect(handler).not.toHaveBeenCalled();
      expectRejected(blocked.respond, {
        code: "UNAVAILABLE",
        retryable: true,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        details: expect.objectContaining({ reason: "gateway-suspending" }),
      });
    }
    suspension?.release();
  });

  it.each([
    ["exact targeted", true, { target: restartTarget, restartIntent: { waitMs: 5_000 } }],
    ["untargeted", false, { reason: "operator" }],
    ["safe targeted", false, { safe: true, target: restartTarget }],
    ["malformed target", false, { target: { ...restartTarget, ownerId: "" } }],
    [
      "malformed intent",
      false,
      { target: restartTarget, restartIntent: { force: true, waitMs: 1 } },
    ],
  ] as const)(
    "%s restart during suspension (admitted: %s)",
    async (_name, admitted, requestParams) => {
      const suspension = tryBeginGatewaySuspendAdmission(() => {});
      expect(suspension?.commit()).toBe(true);
      const handler = admitted
        ? vi.fn<GatewayRequestHandler>(({ respond }) => {
            expect(getActiveGatewayRootWorkCount()).toBe(1);
            respond(true, { ok: true });
          })
        : vi.fn<GatewayRequestHandler>();
      const result = dispatch("gateway.restart.request", handler, { requestParams });
      await result.request;
      if (admitted) {
        expect(handler).toHaveBeenCalledOnce();
        expect(result.respond).toHaveBeenCalledWith(true, { ok: true });
      } else {
        expect(handler).not.toHaveBeenCalled();
        expectRejected(result.respond, {
          code: "UNAVAILABLE",
          details: expect.objectContaining({
            method: "gateway.restart.request",
            reason: "gateway-suspending",
            phase: "prepared",
          }),
        });
      }
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect(suspension?.release()).toBe(true);
    },
  );

  it("rejects suspension preparation nested inside another root request", async () => {
    const root = tryBeginGatewayRootWorkAdmission();
    expect(root?.ownsRoot).toBe(true);
    const handler = vi.fn<GatewayRequestHandler>();

    await root?.run(async () => {
      const nested = dispatch("gateway.suspend.prepare", handler);
      await nested.request;
      expectRejected(nested.respond, {
        code: "UNAVAILABLE",
        retryable: true,
        details: expect.objectContaining({ reason: "nested-gateway-request" }),
      });
    });

    root?.release();
    expect(handler).not.toHaveBeenCalled();
  });
});
