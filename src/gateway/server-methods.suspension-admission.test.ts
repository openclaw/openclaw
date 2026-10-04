// Proves dispatcher root-work accounting and fail-closed suspension behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { getAsyncWorkSignal, trackAsyncWork } from "../shared/async-work-scope.js";
import { createPluginGatewayMethodDescriptor } from "./methods/descriptor.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { runWithGatewayRequestEnvelope, type handleGatewayRequest } from "./server-methods.js";
import { dispatchSuspensionRequest as dispatch } from "./server-methods.suspension-admission.test-support.js";
import {
  registerSuspensionHandoffLifecycleTests,
  registerSuspensionHandoffAuthorizationTests,
} from "./server-methods.suspension-handoff.test-support.js";
import { createLazyCoreHandlers } from "./server-methods/lazy-core-handlers.js";
import { suspendHandlers } from "./server-methods/suspend.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";
import { GatewayRequestEntryLifetime } from "./server-request-entry.js";
import { TerminalSessionManager } from "./terminal/session-manager.js";
import { baseOpenRequest, makeFakePty } from "./terminal/session-manager.test-helpers.js";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  resetGatewaySuspendCoordinatorForLifecycleRestart();
  resetGatewayWorkAdmission();
});

afterEach(() => {
  resetGatewaySuspendCoordinatorForLifecycleRestart();
  resetGatewayWorkAdmission();
});

describe("gateway request suspension admission", () => {
  registerSuspensionHandoffLifecycleTests();

  it("refuses a committed service-stop read when close overtakes lazy preparation", async () => {
    markGatewayRestartDraining("stop (SIGTERM)");
    const preparing = deferred();
    const prepared = deferred();
    const requestEntryLifetime = new GatewayRequestEntryLifetime();
    const handler = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true, { run: null }));
    const handlers = createLazyCoreHandlers({
      methods: ["update.runs.get"],
      loadHandlers: async () => {
        preparing.resolve();
        await prepared.promise;
        return { "update.runs.get": handler };
      },
    });
    const read = dispatch({
      method: "update.runs.get",
      scope: "operator.admin",
      core: true,
      handler: expectDefined(handlers["update.runs.get"], "lazy update-run handler"),
      context: { requestEntryLifetime, logGateway: { warn: vi.fn() } } as unknown as Parameters<
        typeof handleGatewayRequest
      >[0]["context"],
    });
    await preparing.promise;
    requestEntryLifetime.beginClose();
    prepared.resolve();
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
      const handler = vi.fn<GatewayRequestHandler>(({ respond }) => {
        respond(true, { run: null });
      });
      const read = dispatch({
        method: "update.runs.get",
        scope: "operator.admin",
        core: true,
        handler,
      });
      await read.request;
      if (phase === "signal") {
        expect(read.respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "UNAVAILABLE" }),
        );
        expect(handler).not.toHaveBeenCalled();
      } else {
        expect(read.respond).toHaveBeenCalledWith(true, { run: null });
        expect(handler).toHaveBeenCalledOnce();
      }

      for (const method of ["update.status", "update.run", "update.hold"]) {
        const blocked = dispatch({ method, scope: "operator.admin", core: true, handler });
        await blocked.request;
        expect(blocked.respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "UNAVAILABLE" }),
        );
      }
      const unauthorized = dispatch({
        method: "update.runs.get",
        scope: "operator.admin",
        core: true,
        clientScopes: ["operator.read"],
        handler,
      });
      await unauthorized.request;
      expect(unauthorized.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: expect.stringContaining("operator.admin") }),
      );
      expect(handler).toHaveBeenCalledTimes(phase === "signal" ? 0 : 1);
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    },
  );

  it.each(["preparing", "draining", "prepared"] as const)(
    "refuses update-run reads during %s suspension",
    async (phase) => {
      const suspension = tryBeginGatewaySuspendAdmission(() => {});
      expect(suspension).not.toBeNull();
      if (phase === "draining") {
        expect(suspension?.drain()).toBe(true);
      } else if (phase === "prepared") {
        expect(suspension?.commit()).toBe(true);
      }
      const handler = vi.fn<GatewayRequestHandler>();
      const result = dispatch({
        method: "update.runs.get",
        scope: "operator.admin",
        core: true,
        handler,
      });
      await result.request;
      expect(result.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "UNAVAILABLE" }),
      );
      expect(handler).not.toHaveBeenCalled();
    },
  );

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
    const context = {
      logGateway: { warn: vi.fn() },
    } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"];
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
    const draining = deferred();
    const finishChild = deferred();
    const settledChild = vi.fn();
    let child: Promise<void> | undefined;
    const observation = dispatch({
      method: "agent.wait",
      scope: "operator.admin",
      core: true,
      requestParams: { runId: "observed-run" },
      handler: ({ respond }) => {
        const signal = expectDefined(getAsyncWorkSignal(), "observation lifetime");
        const admission = expectDefined(
          captureGatewayRootWorkAdmissionContinuationScope(),
          "admitted observation",
        );
        child = trackAsyncWork(async () => {
          signal.addEventListener("abort", draining.resolve, { once: true });
          await finishChild.promise;
          admission.runSync(settledChild);
        });
        void child.catch(() => {});
        respond(true, { status: "ok" });
      },
    });
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
    const started = deferred();
    const finish = deferred();
    const active = dispatch({
      method: "suspend-proof.concurrent",
      scope: "operator.write",
      handler: async ({ respond }) => {
        started.resolve();
        await finish.promise;
        respond(true, { ok: true });
      },
    });
    await started.promise;

    const prepareHandler = suspendHandlers["gateway.suspend.prepare"];
    expect(prepareHandler).toBeTypeOf("function");
    if (!prepareHandler) {
      throw new Error("expected gateway suspension prepare handler");
    }
    const cron = {
      pauseScheduling: vi.fn(),
      resumeScheduling: vi.fn(),
      getSuspensionBlockerCount: vi.fn(() => 0),
    };
    const context = {
      cron,
      logGateway: { warn: vi.fn() },
      chatAbortControllers: new Map(),
      chatQueuedTurns: new Map(),
      terminalSessions: { size: 2 },
    } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"];
    const busy = dispatch({
      method: "gateway.suspend.prepare",
      scope: "operator.admin",
      handler: prepareHandler,
      requestParams: { requestId: "request-concurrent-root", terminalPolicy: "terminate" },
      context,
    });
    await busy.request;

    expect(busy.respond).toHaveBeenCalledWith(
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
    const ready = dispatch({
      method: "gateway.suspend.prepare",
      scope: "operator.admin",
      handler: prepareHandler,
      requestParams: { requestId: "request-own-root-excluded", terminalPolicy: "terminate" },
      context,
    });
    await ready.request;

    expect(ready.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        status: "ready",
        activeCount: 0,
        blockers: [],
      }),
    );
    const readyPayload = ready.respond.mock.calls[0]?.[1] as { suspensionId?: string } | undefined;
    expect(readyPayload?.suspensionId).toBeTypeOf("string");
    expect(resumeGatewaySuspend(readyPayload?.suspensionId ?? "missing")).toMatchObject({
      ok: true,
      resumed: true,
    });
  });

  it("applies terminal policy at the suspension RPC boundary", async () => {
    const prepareHandler = suspendHandlers["gateway.suspend.prepare"];
    expect(prepareHandler).toBeTypeOf("function");
    if (!prepareHandler) {
      throw new Error("expected gateway suspension prepare handler");
    }
    const context = {
      cron: {
        pauseScheduling: vi.fn(),
        resumeScheduling: vi.fn(),
        getSuspensionBlockerCount: vi.fn(() => 0),
      },
      logGateway: { warn: vi.fn() },
      chatAbortControllers: new Map(),
      chatQueuedTurns: new Map(),
      terminalSessions: { size: 2 },
    } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"];

    for (const [suffix, requestParams] of [
      ["default", { requestId: "request-terminal-default" }],
      ["preserve", { requestId: "request-terminal-preserve", terminalPolicy: "preserve" }],
    ] as const) {
      const blocked = dispatch({
        method: "gateway.suspend.prepare",
        scope: "operator.admin",
        handler: prepareHandler,
        requestParams,
        context,
      });
      await blocked.request;
      expect(blocked.respond, suffix).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          status: "busy",
          activeCount: 2,
          blockers: [expect.objectContaining({ kind: "terminal-session", count: 2 })],
        }),
      );
    }

    const ready = dispatch({
      method: "gateway.suspend.prepare",
      scope: "operator.admin",
      handler: prepareHandler,
      requestParams: { requestId: "request-terminal-terminate", terminalPolicy: "terminate" },
      context,
    });
    await ready.request;
    expect(ready.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ status: "ready", activeCount: 0, blockers: [] }),
    );
    const readyPayload = ready.respond.mock.calls[0]?.[1] as { suspensionId?: string } | undefined;
    expect(resumeGatewaySuspend(readyPayload?.suspensionId ?? "missing")).toMatchObject({
      ok: true,
      resumed: true,
    });

    context.chatAbortControllers.set("persisting", {
      controller: new AbortController(),
      sessionId: "session-persisting",
      sessionKey: "agent:main:session-persisting",
      startedAtMs: 1,
      expiresAtMs: 2,
      registrationCleanupRequested: true,
      controlUiVisible: true,
      projectSessionTerminalPending: true,
    });
    const persisting = dispatch({
      method: "gateway.suspend.prepare",
      scope: "operator.admin",
      handler: prepareHandler,
      requestParams: {
        requestId: "request-terminal-persistence",
        terminalPolicy: "terminate",
      },
      context,
    });
    await persisting.request;
    expect(persisting.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        status: "busy",
        activeCount: 1,
        blockers: [expect.objectContaining({ kind: "terminal-persistence", count: 1 })],
      }),
    );
  });

  it.each(["preserve", "terminate"] as const)(
    "drains admitted work and final-state writes with %s terminal policy",
    async (terminalPolicy) => {
      const preservingTerminals = terminalPolicy === "preserve";
      const started = deferred();
      const finish = deferred();
      const active = dispatch({
        method: "suspend-proof.admitted",
        scope: "operator.write",
        handler: async ({ respond }) => {
          started.resolve();
          await finish.promise;
          respond(true, { delivered: true });
        },
      });
      await started.promise;

      const cron = {
        pauseScheduling: vi.fn(),
        resumeScheduling: vi.fn(),
        getSuspensionBlockerCount: vi.fn(() => 0),
      };
      const pty = makeFakePty();
      const terminalSessions = new TerminalSessionManager({
        emit: vi.fn(),
        spawn: async () => pty,
      });
      await terminalSessions.open(baseOpenRequest());
      const chatAbortControllers = new Map([
        [
          "reply-pending",
          {
            controller: new AbortController(),
            sessionId: "session-pending",
            sessionKey: "agent:main:session-pending",
            startedAtMs: 1,
            expiresAtMs: 2,
            registrationCleanupRequested: true,
            controlUiVisible: true,
            projectSessionTerminalPending: true,
          },
        ],
      ]);
      const context = {
        cron,
        logGateway: { warn: vi.fn() },
        chatAbortControllers,
        chatQueuedTurns: new Map(),
        terminalSessions,
      } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"];

      let suspensionId: string | undefined;
      try {
        const prepareHandler = suspendHandlers["gateway.suspend.prepare"];
        const statusHandler = suspendHandlers["gateway.suspend.status"];
        const resumeHandler = suspendHandlers["gateway.suspend.resume"];
        if (!prepareHandler || !statusHandler || !resumeHandler) {
          throw new Error("expected complete gateway suspension RPC handlers");
        }

        const prepared = dispatch({
          method: "gateway.suspend.prepare",
          scope: "operator.admin",
          handler: prepareHandler,
          requestParams: {
            requestId: "request-terminal-policy-drain",
            terminalPolicy,
            drain: true,
          },
          context,
        });
        await prepared.request;

        const result = prepared.respond.mock.calls[0]?.[1] as
          | { suspensionId: string; expiresAtMs: number }
          | undefined;
        suspensionId = result?.suspensionId;
        expect(prepared.respond).toHaveBeenCalledWith(true, {
          status: "draining",
          suspensionId: expect.any(String),
          expiresAtMs: expect.any(Number),
          retryAfterMs: 20_000,
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
        if (!result) {
          throw new Error("expected an owned draining suspension lease");
        }
        expect(cron.pauseScheduling).toHaveBeenCalledOnce();
        expect(cron.resumeScheduling).not.toHaveBeenCalled();

        const unrelatedHandler = vi.fn<GatewayRequestHandler>();
        const unrelated = dispatch({
          method: "suspend-proof.unrelated",
          scope: "operator.write",
          handler: unrelatedHandler,
          context,
        });
        await unrelated.request;
        expect(unrelatedHandler).not.toHaveBeenCalled();
        expect(unrelated.respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            code: "UNAVAILABLE",
            details: expect.objectContaining({ phase: "draining" }),
          }),
        );

        expect(terminalSessions.size).toBe(1);
        expect(pty.killed).toBe(false);
        finish.resolve();
        await active.request;
        if (preservingTerminals) {
          terminalSessions.disposeAll();
        }

        const pending = dispatch({
          method: "gateway.suspend.status",
          scope: "operator.read",
          handler: statusHandler,
          requestParams: { suspensionId: result.suspensionId },
          context,
        });
        await pending.request;
        expect(pending.respond).toHaveBeenCalledWith(true, {
          status: "draining",
          expiresAtMs: result.expiresAtMs,
          retryAfterMs: 20_000,
          activeCount: 1,
          blockers: [expect.objectContaining({ kind: "terminal-persistence", count: 1 })],
          writeCustody: [{ phase: "terminal-persistence", count: 1 }],
        });

        chatAbortControllers.clear();
        const ready = dispatch({
          method: "gateway.suspend.status",
          scope: "operator.read",
          handler: statusHandler,
          requestParams: { suspensionId: result.suspensionId },
          context,
        });
        await ready.request;
        expect(ready.respond).toHaveBeenCalledWith(true, {
          status: "ready",
          expiresAtMs: result.expiresAtMs,
          writeCustody: [],
        });
        expect(cron.resumeScheduling).not.toHaveBeenCalled();

        const resumed = dispatch({
          method: "gateway.suspend.resume",
          scope: "operator.admin",
          handler: resumeHandler,
          requestParams: { suspensionId: result.suspensionId },
          context,
        });
        await resumed.request;
        expect(resumed.respond).toHaveBeenCalledWith(true, {
          ok: true,
          status: "running",
          resumed: true,
        });
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

    const writeHandler = vi.fn<GatewayRequestHandler>();
    const blocked = dispatch({
      method: "suspend-proof.write",
      scope: "operator.write",
      handler: writeHandler,
    });
    await blocked.request;
    expect(writeHandler).not.toHaveBeenCalled();
    expect(blocked.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        retryable: true,
        details: expect.objectContaining({ reason: "gateway-suspending" }),
      }),
    );

    const readHandler = vi.fn<GatewayRequestHandler>(({ respond }) => {
      respond(true, { state: "visible" });
    });
    for (const method of ["suspend-proof.read", "agent.identity.get"]) {
      const blockedRead = dispatch({
        method,
        scope: "operator.read",
        handler: readHandler,
        core: method === "agent.identity.get",
      });
      await blockedRead.request;
      expect(readHandler).not.toHaveBeenCalled();
      expect(blockedRead.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "UNAVAILABLE",
          retryable: true,
          retryAfterMs: method === "agent.identity.get" ? 60_000 : 1_000,
          details: expect.objectContaining({ reason: "gateway-suspending" }),
        }),
      );
    }
    suspension?.release();
  });

  it.each([undefined, false])(
    "admits an exact targeted restart with safe=%s on an owned root",
    async (safe) => {
      const suspension = tryBeginGatewaySuspendAdmission(() => {});
      expect(suspension?.commit()).toBe(true);
      const handler = vi.fn<GatewayRequestHandler>(({ respond }) => {
        expect(getActiveGatewayRootWorkCount()).toBe(1);
        respond(true, { ok: true });
      });

      const restarted = dispatch({
        method: "gateway.restart.request",
        scope: "operator.admin",
        handler,
        requestParams: {
          ...(safe === undefined ? {} : { safe }),
          target: { pid: process.pid, ownerId: "gateway-owner", port: 18_789 },
          restartIntent: { waitMs: 5_000 },
        },
      });
      await restarted.request;

      expect(handler).toHaveBeenCalledOnce();
      expect(restarted.respond).toHaveBeenCalledWith(true, { ok: true });
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect(suspension?.release()).toBe(true);
    },
  );

  it.each([
    ["untargeted", { reason: "operator" }],
    [
      "safe targeted",
      {
        safe: true,
        target: { pid: process.pid, ownerId: "gateway-owner", port: 18_789 },
      },
    ],
    ["malformed target", { target: { pid: process.pid, ownerId: "", port: 18_789 } }],
    [
      "malformed intent",
      {
        target: { pid: process.pid, ownerId: "gateway-owner", port: 18_789 },
        restartIntent: { force: true, waitMs: 1 },
      },
    ],
  ])("rejects %s restart requests while suspension is prepared", async (_name, requestParams) => {
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);
    const handler = vi.fn<GatewayRequestHandler>();

    const blocked = dispatch({
      method: "gateway.restart.request",
      scope: "operator.admin",
      handler,
      requestParams,
    });
    await blocked.request;

    expect(handler).not.toHaveBeenCalled();
    expect(blocked.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        details: expect.objectContaining({
          method: "gateway.restart.request",
          reason: "gateway-suspending",
          phase: "prepared",
        }),
      }),
    );
    expect(getActiveGatewayRootWorkCount()).toBe(0);
    expect(suspension?.release()).toBe(true);
  });

  it("rejects suspension preparation nested inside another root request", async () => {
    const root = tryBeginGatewayRootWorkAdmission();
    expect(root?.ownsRoot).toBe(true);
    const handler = vi.fn<GatewayRequestHandler>();

    await root?.run(async () => {
      const nested = dispatch({
        method: "gateway.suspend.prepare",
        scope: "operator.admin",
        handler,
      });
      await nested.request;
      expect(nested.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "UNAVAILABLE",
          retryable: true,
          details: expect.objectContaining({ reason: "nested-gateway-request" }),
        }),
      );
    });

    root?.release();
    expect(handler).not.toHaveBeenCalled();
  });
});
