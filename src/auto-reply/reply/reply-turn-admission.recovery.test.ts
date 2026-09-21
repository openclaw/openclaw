import { afterEach, describe, expect, it, vi } from "vitest";
import { MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER } from "../../agents/main-session-recovery/main-session-recovery-admission.js";
import * as restartRecovery from "../../agents/main-session-recovery/main-session-restart-recovery.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import * as sessionEntryAccessor from "../../config/sessions/session-accessor.sqlite-entry.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import {
  beginSessionWorkAdmission,
  consumeSessionWorkAdmissionHandoff,
  getSessionWorkAdmissionOwnerRelease,
  isCompetingSessionWorkAdmissionActive,
  runExclusiveSessionLifecycleMutation,
  type SessionWorkAdmissionLease,
} from "../../sessions/session-lifecycle-admission.js";
import { replyRunRegistry } from "./reply-run-registry.js";
import { testing } from "./reply-run-registry.test-support.js";
import {
  admitTestReplyTurn,
  createSessionStore,
  createSessionStoreFor,
} from "./reply-turn-admission.test-support.js";

function createRecoveryGatewayContext() {
  const recoveryRuntime: GatewayRecoveryRuntime = {
    dispatchSessionMethod: vi.fn(),
    dispatchAgent: vi.fn(),
    waitForAgent: vi.fn(),
    sendRecoveryNotice: vi.fn(),
  };
  // Admission consumes only these Gateway-owned capabilities; execution is
  // represented by the recovery boundary and its real session handoff below.
  return {
    getRuntimeConfig: () => ({}),
    recoveryRuntime,
  } as GatewayRequestContext;
}

describe("reply turn recovery admission", () => {
  afterEach(() => {
    testing.resetReplyRunRegistry();
  });

  it.each(["started", "concurrent winner"] as const)(
    "resumes interrupted work before new input and keeps followups behind its owner: %s",
    async (outcome) => {
      const sessionKey = "agent:main:main";
      const sessionId = "interrupted-channel-session";
      const entry: SessionEntry = {
        sessionId,
        updatedAt: Date.now(),
        status: "running",
        abortedLastRun: true,
        restartRecoveryDeliveryRunId: "old-channel-claim",
        restartRecoveryDeliverySourceRunId: "old-channel-source",
        restartRecoveryDeliveryContext: { channel: "discord", to: "synthetic-channel" },
        restartRecoverySourceIngress: "channel",
      };
      const storePath = createSessionStore({ [sessionKey]: entry });
      const context = createRecoveryGatewayContext();
      const resolveGatewayContext = () => ({ ...context });
      const root = await beginSessionWorkAdmission({
        scope: storePath,
        identities: [sessionKey, sessionId],
        resolveGatewayContext,
        assertAllowed: () => {},
      });
      let recoveryLease: SessionWorkAdmissionLease | undefined;
      const retry = vi
        .spyOn(restartRecovery, "retryRestartAbortedMainSessionRecovery")
        .mockImplementationOnce(async (request) => {
          expect(request).toMatchObject({
            expectedSessionId: sessionId,
            expectedRecoveryRunId: "old-channel-claim",
            expectedRecoverySourceRunId: "old-channel-source",
            gatewayRuntime: context.recoveryRuntime,
          });
          expect(replyRunRegistry.get(sessionKey)).toBeUndefined();
          expect(root.isActive()).toBe(true);
          const owner = await beginSessionWorkAdmission({
            scope: storePath,
            identities: [sessionKey, sessionId],
            owner: MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER,
            resolveGatewayContext,
            assertAllowed: () => {},
          });
          recoveryLease = consumeSessionWorkAdmissionHandoff({
            handoffId: owner.createHandoff(),
            scope: storePath,
            identities: [sessionKey, sessionId],
          });
          expect(recoveryLease).toBe(owner);
          await owner.run(() => {
            expect(isCompetingSessionWorkAdmissionActive(storePath, [sessionKey, sessionId])).toBe(
              false,
            );
            return runExclusiveSessionLifecycleMutation({
              scope: storePath,
              identities: [sessionKey, sessionId],
              run: () =>
                replaceSessionEntry(
                  { storePath, sessionKey },
                  {
                    ...entry,
                    abortedLastRun: false,
                    restartRecoveryRuns: [
                      {
                        runId: "old-channel-claim",
                        lifecycleGeneration: getAgentEventLifecycleGeneration(),
                      },
                    ],
                  },
                ),
            });
          });
          return {
            started: outcome === "started" ? 1 : 0,
            settled: 0,
            failed: 0,
            skipped: outcome === "started" ? 0 : 1,
          };
        });
      let visible: Awaited<ReturnType<typeof admitTestReplyTurn>> | undefined;
      let followup: Awaited<ReturnType<typeof admitTestReplyTurn>> | undefined;
      let followupPromise: ReturnType<typeof admitTestReplyTurn> | undefined;
      const abort = new AbortController();
      try {
        visible = await root.run(() =>
          admitTestReplyTurn({
            sessionKey,
            sessionId,
            storePath,
            expectedSessionId: sessionId,
            resolveGatewayContext,
            waitForActive: false,
          }),
        );
        expect(visible.status).toBe("owned");
        expect(retry).toHaveBeenCalledOnce();
        expect(loadSessionEntry({ storePath, sessionKey })).toMatchObject({
          restartRecoveryDeliveryRunId: "old-channel-claim",
          restartRecoveryDeliverySourceRunId: "old-channel-source",
        });
        expect(
          loadSessionEntry({ storePath, sessionKey })?.mainRestartRecovery?.foregroundClaims,
        ).toBeUndefined();
        expect(
          getSessionWorkAdmissionOwnerRelease({
            scope: storePath,
            identities: [sessionKey, sessionId],
            owner: MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER,
          }),
        ).toBeDefined();
        if (visible.status === "owned") {
          visible.operation.complete();
        }
        root.release();
        let followupSettled = false;
        followupPromise = admitTestReplyTurn({
          sessionKey,
          sessionId,
          storePath,
          expectedSessionId: sessionId,
          resolveGatewayContext,
          kind: "queued_followup",
          upstreamAbortSignal: abort.signal,
        });
        void followupPromise.then(() => {
          followupSettled = true;
        });
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(followupSettled).toBe(false);
        await replaceSessionEntry(
          { storePath, sessionKey },
          { sessionId, updatedAt: Date.now(), status: "done" },
        );
        recoveryLease?.release();
        followup = await followupPromise;
        expect(followup.status).toBe("owned");
        expect(retry).toHaveBeenCalledOnce();
      } finally {
        abort.abort();
        recoveryLease?.release();
        root.release();
        if (visible?.status === "owned") {
          visible.operation.complete();
        }
        followup ??= await followupPromise;
        if (followup?.status === "owned") {
          followup.operation.complete();
        }
        retry.mockRestore();
      }
    },
  );

  it.each([
    { kind: "visible", failed: false },
    { kind: "queued_followup", failed: false },
    { kind: "visible", failed: true },
  ] as const)(
    "settles or defers $kind input according to recovery failure: $failed",
    async ({ kind, failed }) => {
      const sessionKey = "agent:main:main";
      const sessionId = "pending-recovery-session";
      const entry: SessionEntry = {
        sessionId,
        updatedAt: Date.now(),
        status: "running",
        abortedLastRun: true,
        restartRecoveryDeliveryRunId: "interrupted-claim",
        restartRecoveryDeliverySourceRunId: "interrupted-source",
      };
      const storePath = createSessionStore({ [sessionKey]: entry });
      const context = createRecoveryGatewayContext();
      const retry = vi
        .spyOn(restartRecovery, "retryRestartAbortedMainSessionRecovery")
        .mockResolvedValue({
          started: 0,
          settled: 0,
          failed: failed ? 1 : 0,
          skipped: failed ? 0 : 1,
        });
      const abort = new AbortController();
      let outcome: Awaited<ReturnType<typeof admitTestReplyTurn>> | undefined;
      let failure: unknown;
      const admission = admitTestReplyTurn({
        sessionKey,
        sessionId,
        storePath,
        expectedSessionId: sessionId,
        resolveGatewayContext: () => context,
        kind,
        upstreamAbortSignal: abort.signal,
      }).then(
        (result) => {
          outcome = result;
        },
        (error: unknown) => {
          failure = error;
        },
      );
      try {
        await vi.waitFor(() => expect(retry).toHaveBeenCalledOnce());
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(loadSessionEntry({ storePath, sessionKey })).toMatchObject(entry);
        expect(replyRunRegistry.get(sessionKey)).toBeUndefined();
        if (failed) {
          expect(failure).toMatchObject({
            message: expect.stringMatching(/restart recovery failed/i),
          });
          expect(outcome).toBeUndefined();
        } else if (kind === "queued_followup") {
          expect(failure).toBeUndefined();
          await admission;
          expect(outcome).toEqual({ status: "skipped", reason: "active-run" });
        } else {
          expect(failure).toBeUndefined();
          expect(outcome).toBeUndefined();
          await replaceSessionEntry(
            { storePath, sessionKey },
            { sessionId, updatedAt: Date.now(), status: "done" },
          );
          await admission;
          expect(outcome).toMatchObject({ status: "owned" });
        }
        expect(retry).toHaveBeenCalledOnce();
      } finally {
        abort.abort();
        await admission;
        if (outcome?.status === "owned") {
          outcome.operation.complete();
        }
        retry.mockRestore();
      }
    },
  );

  it.each(["started", "cancelled", "replaced"] as const)(
    "waits for reserved startup recovery before admitting visible input: %s",
    async (outcome) => {
      const sessionKey = "agent:main:startup-recovery";
      const sessionId = "startup-recovery-session";
      const entry: SessionEntry = {
        sessionId,
        updatedAt: Date.now(),
        status: "running",
        abortedLastRun: true,
      };
      const storePath = createSessionStore({ [sessionKey]: entry });
      const owner = await beginSessionWorkAdmission({
        scope: storePath,
        identities: [sessionKey, sessionId],
        owner: MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER,
        assertAllowed: () => {},
      });
      const controller = new AbortController();
      let result: Awaited<ReturnType<typeof admitTestReplyTurn>> | undefined;
      let failure: unknown;
      const admission = admitTestReplyTurn({
        sessionKey,
        sessionId,
        expectedSessionId: sessionId,
        storePath,
        waitForActive: false,
        upstreamAbortSignal: controller.signal,
      }).then(
        (value) => {
          result = value;
        },
        (error: unknown) => {
          failure = error;
        },
      );
      try {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(failure).toBeUndefined();
        expect(result).toBeUndefined();
        expect(replyRunRegistry.get(sessionKey)).toBeUndefined();
        if (outcome === "cancelled") {
          controller.abort();
        } else {
          await replaceSessionEntry(
            { storePath, sessionKey },
            {
              ...entry,
              sessionId: outcome === "replaced" ? "replacement-session" : sessionId,
              abortedLastRun: false,
            },
          );
        }
        await admission;
        if (outcome === "replaced") {
          expect(failure).toBeInstanceOf(Error);
          expect(failure).toMatchObject({
            message: expect.stringContaining("changed while starting work"),
          });
        } else {
          expect(failure).toBeUndefined();
          expect(result).toMatchObject(
            outcome === "started" ? { status: "owned" } : { status: "skipped", reason: "aborted" },
          );
        }
        // Starting recovery wakes visible input before the recovered turn completes.
        expect(owner.isActive()).toBe(true);
      } finally {
        controller.abort();
        owner.release();
        await admission;
        if (result?.status === "owned") {
          result.operation.complete();
        }
      }
    },
  );

  it("waits for the named recovery owner before admitting a queued followup", async () => {
    const sessionKey = "agent:main:queued-recovery-owner";
    const sessionId = "queued-recovery-owner";
    const storePath = createSessionStoreFor(sessionKey, sessionId);
    const owner = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [sessionKey, sessionId],
      owner: MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER,
      assertAllowed: () => {},
    });
    const loadSpy = vi.spyOn(sessionEntryAccessor, "loadSessionEntryForAdmission");
    const controller = new AbortController();
    const admission = admitTestReplyTurn({
      sessionKey,
      sessionId,
      expectedSessionId: sessionId,
      storePath,
      kind: "queued_followup",
      upstreamAbortSignal: controller.signal,
    });
    let settled = false;
    void admission.then(() => {
      settled = true;
    });
    let result: Awaited<typeof admission> | undefined;
    let completed = false;
    try {
      await vi.waitFor(() => expect(loadSpy.mock.calls.length).toBeGreaterThanOrEqual(2));
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(settled).toBe(false);
      owner.release();
      result = await admission;
      expect(result.status).toBe("owned");
      if (result.status === "owned") {
        result.operation.complete();
        completed = true;
      }
    } finally {
      controller.abort();
      owner.release();
      result ??= await admission;
      if (!completed && result.status === "owned") {
        result.operation.complete();
      }
      loadSpy.mockRestore();
    }
  });
});
