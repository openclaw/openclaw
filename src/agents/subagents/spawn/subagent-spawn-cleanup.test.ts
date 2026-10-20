import { describe, expect, it, vi } from "vitest";
import { registerChatAbortController } from "../../../gateway/chat-abort.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import { withPluginRuntimeGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import { captureSessionTarget } from "../../../sessions/session-controller.lifecycle.js";
import { getRpcSource } from "../../../sessions/session-controller.rpc-sources.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  bindSubagentSpawnCleanup,
  cleanupProvisionalSession,
  terminateAcceptedCollectorRun,
} from "./subagent-spawn-cleanup.js";

function sessionChangedError(): Error {
  return Object.assign(new Error("session changed"), {
    name: "GatewayClientRequestError",
    gatewayCode: "INVALID_REQUEST",
    details: { reason: "session-changed" },
  });
}

describe("subagent spawn cleanup identity", () => {
  it("retains its physical RPC source across cleanup and refuses a same-ID successor", async () => {
    const childSessionKey = "agent:main:subagent:cleanup-child";
    const runId = "cleanup-run";
    const response = createDeferredCore<{ aborted: boolean; runIds: string[] }>();
    const dispatchSessionMethod = vi.fn(() => response.promise);
    const context = Object.assign({} as GatewayRequestContext, {
      recoveryRuntime: { dispatchSessionMethod },
    });
    const target = captureSessionTarget({
      storeScope: "/synthetic/spawn-cleanup.db",
      sessionKey: childSessionKey,
      incarnation: "child-session",
    });
    const resolveGatewayContext = () => context;
    const register = () =>
      withPluginRuntimeGatewayContextResolver(resolveGatewayContext, () =>
        registerChatAbortController({
          target,
          runId,
          sessionId: "child-session",
          sessionKey: childSessionKey,
          timeoutMs: 60_000,
        }),
      );
    const original = register();
    const foreign = withPluginRuntimeGatewayContextResolver(undefined, () =>
      registerChatAbortController({
        target: captureSessionTarget({ ...target, storeScope: "/synthetic/foreign-cleanup.db" }),
        runId,
        sessionId: "child-session",
        sessionKey: childSessionKey,
        timeoutMs: 60_000,
      }),
    );
    const cleanup = bindSubagentSpawnCleanup({
      childSessionKey,
      target,
      resolveGatewayContext,
      isCurrent: () => true,
      canAbortAcceptedRun: () => true,
      getSessionIdentity: () => ({
        expectedSessionId: "child-session",
        expectedLifecycleRevision: "revision",
      }),
    });
    cleanup.bindAcceptedRun(runId);
    expect(cleanup.isCurrent()).toBe(true);
    const request = cleanup.callGateway({
      method: "chat.abort",
      params: { sessionKey: childSessionKey, runId },
    });
    original.cleanup();
    const successor = register();
    try {
      expect(original.registered).toBe(true);
      expect(foreign.registered).toBe(true);
      expect(successor.registered).toBe(true);
      expect(cleanup.isCurrent()).toBe(false);
      response.resolve({ aborted: true, runIds: [runId] });
      await expect(request).rejects.toThrow("Subagent spawn no longer owns this cleanup");
      expect(dispatchSessionMethod).toHaveBeenCalledOnce();
      expect(successor.controller.signal.aborted).toBe(false);
      expect(foreign.controller.signal.aborted).toBe(false);
      await expect(
        cleanup.callGateway({
          method: "chat.abort",
          params: { sessionKey: childSessionKey, runId },
        }),
      ).rejects.toThrow("Subagent spawn no longer owns this cleanup");
      expect(dispatchSessionMethod).toHaveBeenCalledOnce();
    } finally {
      response.resolve({ aborted: false, runIds: [] });
      await request.catch(() => {});
      original.cleanup();
      successor.cleanup();
      foreign.cleanup();
    }
  });

  it("requires both frozen session identities before deletion", async () => {
    const callGateway = vi.fn();

    await expect(
      cleanupProvisionalSession("agent:main:subagent:child", {
        expectedSessionId: "session-id",
        callGateway,
      }),
    ).resolves.toBe(false);

    expect(callGateway).not.toHaveBeenCalled();
  });

  it("reports uncertain termination while retaining the accepted child", async () => {
    const childSessionKey = "agent:main:subagent:cancelled-cleanup";
    const runId = "cancelled-cleanup-run";
    const failure = new Error("gateway unavailable");
    const dispatchSessionMethod = vi.fn(async () => {
      throw failure;
    });
    const context = Object.assign({} as GatewayRequestContext, {
      recoveryRuntime: { dispatchSessionMethod },
    });
    const target = captureSessionTarget({
      storeScope: "/synthetic/cancelled-cleanup.db",
      sessionKey: childSessionKey,
      incarnation: "cancelled-cleanup-session",
    });
    const resolveGatewayContext = () => context;
    const source = withPluginRuntimeGatewayContextResolver(resolveGatewayContext, () =>
      registerChatAbortController({
        target,
        runId,
        sessionId: "cancelled-cleanup-session",
        sessionKey: childSessionKey,
        timeoutMs: 60_000,
      }),
    );
    if (!source.registered) {
      throw new Error("Cancelled cleanup proof requires a registered controller source");
    }
    let inputSettled = false;
    void source.entry.input.settlement.promise.then(() => {
      inputSettled = true;
    });
    const cleanup = bindSubagentSpawnCleanup({
      childSessionKey,
      target,
      resolveGatewayContext,
      isCurrent: () => true,
      canAbortAcceptedRun: () => true,
      getSessionIdentity: () => ({
        expectedSessionId: "cancelled-cleanup-session",
        expectedLifecycleRevision: "revision",
      }),
    });
    cleanup.bindAcceptedRun(runId);
    try {
      await expect(cleanup.terminateAcceptedRun?.()).resolves.toEqual({
        status: "failed",
        error: failure,
      });
      expect(dispatchSessionMethod).toHaveBeenCalledOnce();
      expect(getRpcSource(runId)).toBe(source.entry);
      expect(source.controller.signal.aborted).toBe(false);
      expect(inputSettled).toBe(false);
    } finally {
      source.cleanup();
    }
  });

  it("accepts chat.abort only when it confirms the exact run", async () => {
    const callGateway = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, aborted: false, runIds: [] })
      .mockResolvedValueOnce({ deleted: true });

    await terminateAcceptedCollectorRun({
      childSessionKey: "agent:main:subagent:child",
      gatewayRunId: "gateway-run",
      expectedSessionId: "session-id",
      expectedLifecycleRevision: "session-revision",
      callGateway,
    });

    expect(callGateway).toHaveBeenNthCalledWith(2, {
      method: "sessions.delete",
      params: {
        key: "agent:main:subagent:child",
        agentId: "main",
        emitLifecycleHooks: false,
        deleteTranscript: true,
        expectedSessionId: "session-id",
        expectedLifecycleRevision: "session-revision",
      },
      timeoutMs: 60_000,
    });
  });

  it("does not delete after chat.abort confirms the matching run", async () => {
    const callGateway = vi.fn(async () => ({
      ok: true,
      aborted: true,
      runIds: ["gateway-run"],
    }));

    await terminateAcceptedCollectorRun({
      childSessionKey: "agent:main:subagent:child",
      gatewayRunId: "gateway-run",
      expectedSessionId: "session-id",
      expectedLifecycleRevision: "session-revision",
      callGateway,
    });

    expect(callGateway).toHaveBeenCalledOnce();
  });

  it("stops without deleting a durable session when the accepted run already ended", async () => {
    const callGateway = vi.fn(async () => ({
      ok: true,
      aborted: false,
      runIds: [],
    }));

    await terminateAcceptedCollectorRun({
      childSessionKey: "agent:main:subagent:child",
      gatewayRunId: "gateway-run",
      sessionCleanup: "preserve",
      callGateway,
    });

    expect(callGateway).toHaveBeenCalledOnce();
  });

  it("reports an abort failure without deleting or retrying a durable session", async () => {
    const failure = new Error("gateway unavailable");
    const callGateway = vi.fn().mockRejectedValue(failure);
    await expect(
      terminateAcceptedCollectorRun({
        childSessionKey: "agent:main:subagent:child",
        gatewayRunId: "gateway-run",
        sessionCleanup: "preserve",
        callGateway,
      }),
    ).rejects.toBe(failure);
    expect(callGateway).toHaveBeenCalledOnce();
  });

  it("stops cleanup when guarded deletion observes a successor lifecycle", async () => {
    const callGateway = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, aborted: true, runIds: ["different-run"] })
      .mockRejectedValueOnce(sessionChangedError());

    await expect(
      terminateAcceptedCollectorRun({
        childSessionKey: "agent:main:subagent:child",
        gatewayRunId: "gateway-run",
        expectedSessionId: "session-id",
        expectedLifecycleRevision: "session-revision",
        callGateway,
      }),
    ).resolves.toBeUndefined();

    expect(callGateway).toHaveBeenCalledTimes(2);
  });
});
