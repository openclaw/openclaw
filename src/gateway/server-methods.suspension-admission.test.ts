import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi, type Mock } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import {
  resetGatewaySuspendCoordinatorForLifecycleRestart,
  resumeGatewaySuspend,
} from "../infra/gateway-suspend-coordinator.js";
import {
  beginGatewayRestartSignalAdmission,
  captureGatewayRootWorkAdmissionContinuationScope,
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  retainGatewayRootWorkAdmissionContinuation,
  tryBeginGatewayRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import { retireSessionControllerInput } from "../sessions/session-controller.mailbox.js";
import { rpcSourceTesting } from "../sessions/session-lifecycle-admission.test-support.js";
import { getAsyncWorkSignal, trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createPluginGatewayMethodDescriptor } from "./methods/descriptor.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { runWithGatewayRequestEnvelope } from "./server-methods.js";
import { createRequestGate, expectRejected } from "./server-methods.request-gate.test-support.js";
import { dispatchSuspensionRequest } from "./server-methods.suspension-admission.test-support.js";
import {
  registerSuspensionHandoffLifecycleTests,
  registerSuspensionHandoffAuthorizationTests,
} from "./server-methods.suspension-handoff.test-support.js";
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

async function suspensionRpc(
  context: GatewayRequestContext,
  action: "prepare" | "status" | "resume",
  requestParams: unknown,
  core = false,
) {
  const method = `gateway.suspend.${action}` as const;
  const result = dispatch(method, expectDefined(suspendHandlers[method], method), {
    scope: action === "status" ? "operator.read" : "operator.admin",
    requestParams,
    context,
    core,
  });
  await result.request;
  return result.respond;
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
      expect(initial).toHaveBeenCalledWith(true, expect.objectContaining({ status: "draining" }));
      const fenced = read();
      await fenced.request;
      expectRejected(fenced.respond);
      await vi.advanceTimersByTimeAsync(30_000);
      if (renew) {
        const renewal = await prepare();
        expect(renewal).toHaveBeenCalledWith(true, expect.objectContaining({ status: "draining" }));
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

  registerSuspensionHandoffLifecycleTests();
  registerSuspensionHandoffAuthorizationTests();

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

    expect(busy).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        status: "busy",
        reason: "active-work",
        activeCount: 1,
        blockers: expect.arrayContaining([
          expect.objectContaining({ kind: "root-request", count: 1 }),
        ]),
      }),
    );

    finish.resolve();
    await active.request;
    const ready = await suspensionRpc(context, "prepare", {
      requestId: "request-own-root-excluded",
      terminalPolicy: "terminate",
    });

    expect(ready).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ status: "ready", activeCount: 0, blockers: [] }),
    );
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
