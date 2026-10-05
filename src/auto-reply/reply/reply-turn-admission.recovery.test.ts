import { setImmediate } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER } from "../../agents/main-session-recovery/main-session-recovery-admission.js";
import * as recoveryLifecycle from "../../agents/main-session-recovery/main-session-recovery-lifecycle.js";
import * as recoveryOwnerRelease from "../../agents/main-session-recovery/main-session-recovery-owner-release.js";
import * as recoveryStore from "../../agents/main-session-recovery/main-session-recovery-store.js";
import * as restartRecovery from "../../agents/main-session-recovery/main-session-restart-recovery.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import {
  listSessionPendingInputs,
  stageSessionPendingInput,
} from "../../config/sessions/session-accessor.pending-inputs.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import {
  beginSessionWorkAdmission,
  consumeSessionWorkAdmissionHandoff,
  getSessionWorkAdmissionOwnerRelease,
  getSessionWorkAdmissionRelease,
  isCompetingSessionWorkAdmissionActive,
  runExclusiveSessionLifecycleMutation,
  type SessionWorkAdmissionLease,
} from "../../sessions/session-lifecycle-admission.js";
import { createReplyOperation, replyRunRegistry } from "./reply-run-registry.js";
import { testing } from "./reply-run-registry.test-support.js";
import { admitTestReplyTurn, createSessionStore } from "./reply-turn-admission.test-support.js";
import * as recoveryWait from "./reply-turn-recovery-wait.js";

type Admission = Awaited<ReturnType<typeof admitTestReplyTurn>>;
const sessionKey = "agent:main:main";
const sessionId = "interrupted-session";
const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) {
    await dispose();
  }
  testing.resetReplyRunRegistry();
  vi.restoreAllMocks();
});
function createRecoveryGatewayContext() {
  const recoveryRuntime: GatewayRecoveryRuntime = {
    dispatchSessionMethod: vi.fn(),
    dispatchAgent: vi.fn(),
    waitForAgent: vi.fn(),
    sendRecoveryNotice: vi.fn(),
  };
  // The recovery boundary supplies execution; admission consumes these capabilities.
  return { getRuntimeConfig: () => ({}), recoveryRuntime } as GatewayRequestContext;
}
function complete(result: Admission | undefined) {
  if (result?.status === "owned") {
    result.operation.complete();
  }
}
function owned(result: Admission) {
  expect(result.status).toBe("owned");
  if (result.status !== "owned") {
    throw new Error("Fixture requires an admitted reply operation");
  }
  return result;
}
function observe(pending: Promise<Admission>) {
  const outcome: { result?: Admission; failure?: unknown } = {};
  const settled = pending.then(
    (result) => {
      outcome.result = result;
    },
    (failure: unknown) => {
      outcome.failure = failure;
    },
  );
  return Object.assign(outcome, { settled });
}
function recoveryFixture(overrides: Partial<SessionEntry> = {}) {
  const entry: SessionEntry = {
    sessionId,
    updatedAt: 100,
    status: "interrupted",
    abortedLastRun: true,
    ...overrides,
  };
  const storePath = createSessionStore({ [sessionKey]: entry });
  const scope = { scope: storePath, identities: [sessionKey, sessionId] };
  const abort = new AbortController();
  const pending: Promise<Admission>[] = [];
  const results: Admission[] = [];
  const cleanup: (() => void | Promise<void>)[] = [];
  disposals.push(async () => {
    abort.abort();
    for (const release of cleanup) {
      await release();
    }
    results.forEach(complete);
    for (const admission of pending) {
      complete(await admission.catch(() => undefined));
    }
  });
  const admit = (request: Partial<Parameters<typeof admitTestReplyTurn>[0]> = {}) => {
    const admission = admitTestReplyTurn({
      sessionKey,
      sessionId,
      expectedSessionId: sessionId,
      storePath,
      ...request,
    });
    pending.push(admission);
    void admission.then(
      (result) => results.push(result),
      () => {},
    );
    return admission;
  };
  const begin = async (request: Partial<Parameters<typeof beginSessionWorkAdmission>[0]> = {}) => {
    const lease = await beginSessionWorkAdmission({
      ...scope,
      assertAllowed: () => {},
      ...request,
    });
    cleanup.push(async () => {
      lease.release();
      await lease.released;
    });
    return lease;
  };
  return {
    entry,
    storePath,
    scope,
    abort,
    cleanup,
    admit,
    begin,
    wait: (request: Parameters<typeof admit>[0]) =>
      observe(admit({ upstreamAbortSignal: abort.signal, ...request })),
    read: () => loadSessionEntry({ storePath, sessionKey }),
    write: (value: SessionEntry) => replaceSessionEntry({ storePath, sessionKey }, value),
  };
}

function createPredecessor() {
  return {
    runId: "orphaned-predecessor",
    inputId: "missing-predecessor-input",
    idempotencyKey: "predecessor-request",
    sessionId,
    sessionKey,
    lifecycleRevision: "original-revision",
    lifecycleGeneration: "old-process",
    repositoryWorkspaceId: "existing-repository",
    issuer: {
      version: 1 as const,
      profileId: "original-profile",
      factoryActor: { host: "microsoft.ghe.com" as const, accountId: 101 },
      assignedRole: "administrator",
      rolePolicyGeneration: "original-role-policy",
      aliasBindingIds: ["original-alias"],
      scopes: ["operator.read", "operator.write"],
      modelCeilings: ["*"],
      device: { deviceId: "original-device", identity: "original-device-key" },
      authPrincipal: { role: "operator", authMethod: "trusted-proxy" as const },
      authPolicyGeneration: "original-auth-policy",
      sharedAuthGeneration: null,
      grant: null,
    },
  };
}

it.each(["none", "effect", "provider"] as const)(
  "preserves a paused Goal and predecessor custody during visible admission (hold: %s)",
  async (hold) => {
    const goal = {
      schemaVersion: 1 as const,
      id: "paused-goal",
      objective: "Keep the existing branch",
      status: "paused" as const,
      createdAt: 10,
      updatedAt: 20,
      pausedAt: 20,
      tokenStart: 0,
      tokensUsed: 0,
      continuationTurns: 0,
    };
    const predecessor = createPredecessor();
    const f = recoveryFixture({
      goal,
      goalPauseOrigin: "manual",
      lifecycleRevision: "original-revision",
      repositoryWorkspaceId: "existing-repository",
      mainRestartRecovery: {
        cycleId: "original-cycle",
        revision: 1,
        chargedAttempts: 0,
        turnIntent: predecessor,
        queuedInputsPending: true,
        ...(hold === "effect"
          ? {
              pause: {
                reason: "unverifiable-external-effect" as const,
                toolName: "github_publish",
                pausedAtMs: 30,
              },
            }
          : {}),
        ...(hold === "provider"
          ? {
              capacityWait: {
                runId: predecessor.runId,
                lifecycleGeneration: predecessor.lifecycleGeneration,
                sinceMs: 30,
                provider: {
                  kind: "settled-shortage-v1" as const,
                  environmentId: "",
                  ownerEpoch: 1,
                  placementGeneration: 1,
                  providerId: "crabbox",
                  profileId: "original-profile",
                  operationId: "original-operation",
                  leaseId: "original-lease",
                  attemptName: "original-attempt",
                  attemptNonce: "original-nonce",
                  providerCode: "SkuNotAvailable",
                  attempt: 1,
                },
              },
            }
          : {}),
      },
    });
    const context = createRecoveryGatewayContext();
    const retryEntered = createDeferred();
    const retryActual = restartRecovery.retryRestartAbortedMainSessionRecovery;
    const retry = vi
      .spyOn(restartRecovery, "retryRestartAbortedMainSessionRecovery")
      .mockImplementation(async (request) => {
        const result = await retryActual(request);
        retryEntered.resolve();
        return result;
      });
    const admission = f.admit({
      resolveGatewayContext: () => context,
      upstreamAbortSignal: f.abort.signal,
    });
    if (hold !== "none") {
      await expect(admission).rejects.toThrow(/paused|unresolved|capacity/i);
      expect(f.read()).toMatchObject(f.entry);
    } else {
      const result = await Promise.race([
        admission,
        retryEntered.promise.then(() => {
          throw new Error("Visible input was deferred to ineligible paused-Goal recovery");
        }),
      ]);
      owned(result);
      expect(f.read()).toMatchObject({
        goal,
        goalPauseOrigin: "manual",
        repositoryWorkspaceId: "existing-repository",
        mainRestartRecovery: {
          cycleId: "original-cycle",
          chargedAttempts: 0,
          queuedInputsPending: true,
          turnIntent: predecessor,
          foregroundClaims: { tokens: [expect.any(String)] },
        },
      });
    }
    expect(f.read()?.lastRunId).toBeUndefined();
    expect(retry).not.toHaveBeenCalled();
  },
);

it("keeps deferred owner release retries from retaining a successor", async () => {
  const deferredReleases: Promise<void>[] = [];
  const schedule = recoveryLifecycle.scheduleMainSessionRecoveryMutation;
  const scheduled = vi
    .spyOn(recoveryLifecycle, "scheduleMainSessionRecoveryMutation")
    .mockImplementation((params) => {
      const settled = createDeferred();
      deferredReleases.push(settled.promise);
      schedule({
        ...params,
        onSuccess: async (result) => {
          await params.onSuccess(result);
          settled.resolve();
        },
      });
    });
  const pendingTarget = vi
    .spyOn(recoveryOwnerRelease, "scheduleMainSessionRecoveryPendingTarget")
    .mockImplementation(() => {});
  let restoreAccessor: (() => void) | undefined;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const f = recoveryFixture({
      mainRestartRecovery: { cycleId: "cycle-1", revision: 1, chargedAttempts: 0 },
    });
    const owner = owned(await f.admit());
    const apply = sessionAccessor.applySessionEntryReplacements;
    const failedWrites = Array.from({ length: 3 }, () => createDeferred());
    let failures = 0;
    const accessorSpy = vi
      .spyOn(sessionAccessor, "applySessionEntryReplacements")
      .mockImplementation(async (params) => {
        const failedWrite = failedWrites[failures];
        if (failedWrite) {
          failures += 1;
          failedWrite.resolve();
          throw new Error("SQLite session entry changed before replacement");
        }
        return await apply(params);
      });
    restoreAccessor = () => accessorSpy.mockRestore();
    owner.operation.complete();
    const successor = f.admit();
    for (const [index, failedWrite] of failedWrites.entries()) {
      await failedWrite.promise;
      if (index < failedWrites.length - 1) {
        await vi.advanceTimersByTimeAsync(25 * 2 ** index);
      }
    }
    // Join real worker I/O without advancing later retry timers.
    const admitted = await successor;
    expect(deferredReleases).toHaveLength(1);
    accessorSpy.mockRestore();
    owned(admitted);
    const released = getSessionWorkAdmissionRelease(f.scope);
    expect(released).toBeDefined();
    complete(admitted);
    await released;
  } finally {
    try {
      restoreAccessor?.();
      // Start deferred repair without firing unrelated database lease deadlines.
      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.all(deferredReleases);
    } finally {
      scheduled.mockRestore();
      pendingTarget.mockRestore();
      vi.useRealTimers();
    }
  }
});

it("settles a committed recovery claim without replay when preparation changes", async () => {
  const f = recoveryFixture({
    mainRestartRecovery: { cycleId: "cycle-1", revision: 1, chargedAttempts: 0 },
  });
  const predecessor = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
  const claimed = createDeferred();
  const release = createDeferred();
  f.cleanup.push(() => {
    release.resolve();
    predecessor.complete();
  });
  const claim = recoveryStore.claimMainSessionRecoveryOwner;
  const claimSpy = vi
    .spyOn(recoveryStore, "claimMainSessionRecoveryOwner")
    .mockImplementation(async (params) => {
      const result = await claim(params);
      claimed.resolve();
      await release.promise;
      return result;
    });
  const pending = f.admit({ expectedSessionId: undefined });
  await Promise.race([
    claimed.promise,
    pending.then(() => {
      throw new Error("Admission completed before recovery claimed ownership");
    }),
  ]);
  expect(f.read()?.mainRestartRecovery).toMatchObject({
    foregroundClaims: { tokens: [expect.any(String)] },
  });
  predecessor.complete();
  release.resolve();
  await expect(pending).rejects.toMatchObject({ code: "SESSION_WORK_START_CHANGED" });
  expect(claimSpy).toHaveBeenCalledOnce();
  expect(f.read()?.mainRestartRecovery?.foregroundClaims).toBeUndefined();
  expect(replyRunRegistry.get(sessionKey)).toBeUndefined();
});

it("keeps new input and followups behind a concurrent recovery winner", async () => {
  const delivery = {
    restartRecoveryDeliveryRunId: "old-channel-claim",
    restartRecoveryDeliverySourceRunId: "old-channel-source",
  };
  const f = recoveryFixture({
    ...delivery,
    restartRecoveryDeliveryContext: { channel: "discord", to: "synthetic-channel" },
    restartRecoverySourceIngress: "channel",
  });
  const context = createRecoveryGatewayContext();
  const resolveGatewayContext = () => ({ ...context });
  const root = await f.begin({ resolveGatewayContext });
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
      const owner = await f.begin({
        owner: MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER,
        resolveGatewayContext,
      });
      recoveryLease = consumeSessionWorkAdmissionHandoff({
        handoffId: owner.createHandoff(),
        ...f.scope,
      });
      expect(recoveryLease).toBe(owner);
      await owner.run(() => {
        expect(isCompetingSessionWorkAdmissionActive(f.storePath, [sessionKey, sessionId])).toBe(
          false,
        );
        return runExclusiveSessionLifecycleMutation("recover", {
          ...f.scope,
          run: () =>
            f.write({
              ...f.entry,
              abortedLastRun: false,
              restartRecoveryRuns: [
                {
                  runId: "old-channel-claim",
                  lifecycleGeneration: getAgentEventLifecycleGeneration(),
                },
              ],
            }),
        });
      });
      return { started: 0, settled: 0, failed: 0, skipped: 1 };
    });
  const visible = await root.run(() => f.admit({ resolveGatewayContext, waitForActive: false }));
  expect(visible.status).toBe("owned");
  expect(retry).toHaveBeenCalledOnce();
  expect(f.read()).toMatchObject(delivery);
  expect(f.read()?.mainRestartRecovery?.foregroundClaims).toBeUndefined();
  expect(
    getSessionWorkAdmissionOwnerRelease({
      ...f.scope,
      owner: MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER,
    }),
  ).toBeDefined();
  complete(visible);
  root.release();
  let followupSettled = false;
  const followup = f.admit({
    resolveGatewayContext,
    kind: "queued_followup",
    upstreamAbortSignal: f.abort.signal,
  });
  void followup.then(() => {
    followupSettled = true;
  });
  await setImmediate();
  expect(followupSettled).toBe(false);
  await f.write({ sessionId, updatedAt: Date.now(), status: "done" });
  recoveryLease?.release();
  expect((await followup).status).toBe("owned");
  expect(retry).toHaveBeenCalledOnce();
});

it.each([
  { kind: "queued_followup", failed: false },
  { kind: "visible", failed: true },
] as const)(
  "settles or defers $kind input according to recovery failure: $failed",
  async ({ kind, failed }) => {
    const f = recoveryFixture({
      restartRecoveryDeliveryRunId: "interrupted-claim",
      restartRecoveryDeliverySourceRunId: "interrupted-source",
    });
    const context = createRecoveryGatewayContext();
    const retryEntered = createDeferred();
    const retry = vi
      .spyOn(restartRecovery, "retryRestartAbortedMainSessionRecovery")
      .mockImplementation(async () => {
        retryEntered.resolve();
        return { started: 0, settled: 0, failed: failed ? 1 : 0, skipped: failed ? 0 : 1 };
      });
    const outcome = f.wait({ resolveGatewayContext: () => context, kind });
    await Promise.race([
      retryEntered.promise,
      outcome.settled.then(() => {
        throw new Error("Admission settled before recovery dispatch");
      }),
    ]);
    expect(retry).toHaveBeenCalledOnce();
    await setImmediate();
    expect(f.read()).toMatchObject(f.entry);
    expect(replyRunRegistry.get(sessionKey)).toBeUndefined();
    if (failed) {
      await outcome.settled;
      expect(outcome.failure).toMatchObject({
        message: expect.stringMatching(/restart recovery failed/i),
      });
      expect(outcome.result).toBeUndefined();
    } else {
      expect(outcome.failure).toBeUndefined();
      await outcome.settled;
      expect(outcome.result).toEqual({ status: "skipped", reason: "active-run" });
    }
    expect(retry).toHaveBeenCalledOnce();
  },
);

it.each(["started", "cancelled", "replaced"] as const)(
  "waits for reserved startup recovery before visible input: %s",
  async (outcome) => {
    const f = recoveryFixture({
      mainRestartRecovery: { cycleId: "cycle-1", revision: 1, chargedAttempts: 0 },
    });
    const owner = await f.begin({ owner: MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER });
    const admission = f.wait({ waitForActive: false });
    await setImmediate();
    expect(admission.failure).toBeUndefined();
    expect(admission.result).toBeUndefined();
    expect(replyRunRegistry.get(sessionKey)).toBeUndefined();
    if (outcome === "cancelled") {
      f.abort.abort();
    } else {
      await f.write({
        ...f.entry,
        sessionId: outcome === "replaced" ? "replacement-session" : sessionId,
        abortedLastRun: false,
      });
    }
    await admission.settled;
    if (outcome === "replaced") {
      expect(admission.failure).toMatchObject({ code: "SESSION_WORK_START_CHANGED" });
      expect(admission.result).toBeUndefined();
    } else {
      expect(admission.failure).toBeUndefined();
      expect(admission.result).toMatchObject(
        outcome === "started" ? { status: "owned" } : { status: "skipped", reason: "aborted" },
      );
    }
    // Starting recovery wakes visible input before the recovered turn completes.
    expect(owner.isActive()).toBe(true);
  },
);

it("preserves live recovery authority while monitoring", async () => {
  const f = recoveryFixture({ status: undefined, abortedLastRun: undefined });
  const owner = await f.begin({ owner: MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER });
  let released = false;
  void owner.released.then(() => {
    released = true;
  });
  const result = await f.admit({ kind: "heartbeat" });
  expect(result).toMatchObject({ status: "skipped", reason: "active-run" });
  expect(released).toBe(false);
  expect(f.read()?.sessionId).toBe(sessionId);
  owner.release();
  await owner.released;
});

it.each([
  { guard: "missing-intent", successor: "current" },
  { guard: "missing-restorer", successor: "current" },
  { guard: "source-mismatch", successor: "current" },
  { guard: "missing-goal-marker", successor: "current" },
  { guard: "missing-intent", successor: "queued" },
  { guard: "missing-intent", successor: "revoked" },
  { guard: "missing-intent", successor: "changed" },
  { guard: "missing-intent", successor: "intent-changed" },
] as const)(
  "settles fresh admission without replay for $guard with $successor authority/state",
  async ({ guard, successor }) => {
    vi.stubEnv("FACTORY_AUTH_MODE", "github");
    try {
      const predecessor = createPredecessor();
      const retainedIntents =
        guard === "missing-goal-marker"
          ? {
              goalIntent: {
                goalId: "paused-goal",
                sessionId,
                sessionKey,
                lifecycleRevision: predecessor.lifecycleRevision,
                issuer: predecessor.issuer,
              },
            }
          : guard === "missing-intent"
            ? {}
            : { turnIntent: predecessor };
      const f = recoveryFixture({
        lifecycleRevision: "original-revision",
        restartRecoveryDeliveryRunId: "old-recovery",
        restartRecoveryDeliverySourceRunId:
          guard === "source-mismatch" ? "different-source" : predecessor.runId,
        goalPauseOrigin: "terminal-error",
        goal: {
          schemaVersion: 1,
          id: "paused-goal",
          objective: "Keep the existing branch",
          status: "paused",
          createdAt: 10,
          updatedAt: 20,
          pausedAt: 20,
          tokenStart: 0,
          tokensUsed: 0,
          continuationTurns: 0,
        },
        mainRestartRecovery: {
          cycleId: "original-cycle",
          revision: 1,
          chargedAttempts: 0,
          ...retainedIntents,
        },
      });
      const scope = { agentId: "main", sessionKey, sessionId, storePath: f.storePath };
      const originalInput = await stageSessionPendingInput(scope, {
        message: {
          role: "user",
          content: "Original accepted work",
          timestamp: 10,
          idempotencyKey: predecessor.idempotencyKey,
        },
        runId: predecessor.runId,
        assertCurrent: () => {},
      });
      expect(originalInput).toBeDefined();
      predecessor.inputId = originalInput!.inputId;
      await f.write({
        ...f.entry,
        mainRestartRecovery: {
          ...f.entry.mainRestartRecovery!,
          ...retainedIntents,
        },
      });
      await appendTranscriptMessage(scope, {
        message: { role: "user", content: "Original accepted work", timestamp: 10 },
      });
      const input = await stageSessionPendingInput(scope, {
        message: {
          role: "user",
          content: "Fresh request",
          timestamp: 30,
          idempotencyKey: "fresh-input",
        },
        runId: "fresh-run",
        assertCurrent: () => {},
      });
      expect(input).toBeDefined();
      const pendingBefore = await listSessionPendingInputs(scope);
      const context = createRecoveryGatewayContext();
      const runtime = expectDefined(context.recoveryRuntime, "fixture recovery runtime");
      const prepare = vi.fn().mockRejectedValue(new Error("Original issuer must not be restored"));
      if (guard !== "missing-restorer") {
        runtime.prepareGoalRecoveryAuthority = prepare;
      }
      // A permanent issuer hold must settle admission, never enter the transient wait owner.
      const wait = vi
        .spyOn(recoveryWait, "waitForRestartRecoveryProgress")
        .mockRejectedValue(new Error("Non-executable recovery entered a transient wait"));
      let current = true;
      const revoked = new Error("Fresh request authority revoked");
      const retryActual = restartRecovery.retryRestartAbortedMainSessionRecovery;
      const retry = vi
        .spyOn(restartRecovery, "retryRestartAbortedMainSessionRecovery")
        .mockImplementation(async (request) => {
          const result = await retryActual(request);
          expect(result.authorityHold).toMatchObject({
            kind: "authority-hold",
            reason:
              successor === "intent-changed" && retry.mock.calls.length > 1
                ? "source-mismatch"
                : guard,
          });
          if (successor === "intent-changed" && retry.mock.calls.length === 1) {
            const entry = f.read()!;
            await f.write({
              ...entry,
              mainRestartRecovery: {
                ...entry.mainRestartRecovery!,
                turnIntent: { ...predecessor, runId: "new-accepted-source" },
              },
            });
          } else if (successor === "revoked") {
            current = false;
          } else if (successor === "changed") {
            const entry = f.read()!;
            await f.write({
              ...entry,
              goalPauseOrigin: "manual",
              mainRestartRecovery: {
                ...entry.mainRestartRecovery!,
                revision: entry.mainRestartRecovery!.revision + 1,
              },
            });
          }
          return result;
        });
      const admission = f.admit({
        resolveGatewayContext: () => context,
        kind: successor === "queued" ? "queued_followup" : "visible",
        assertRequestCurrent: () => {
          if (!current) {
            throw revoked;
          }
        },
      });
      if (successor === "queued") {
        await expect(admission).resolves.toEqual({
          status: "skipped",
          reason: "lifecycle-invalidated",
        });
      } else if (successor === "changed") {
        owned(await admission);
      } else if (successor === "revoked") {
        await expect(admission).rejects.toBe(revoked);
      } else {
        await expect(admission).rejects.toMatchObject({ code: "SESSION_WORK_START_INVALIDATED" });
      }
      expect(retry).toHaveBeenCalledTimes(successor === "intent-changed" ? 2 : 1);
      expect(wait).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
      expect(runtime.dispatchAgent).not.toHaveBeenCalled();
      expect(f.read()).toMatchObject({
        goal: f.entry.goal,
        goalPauseOrigin: successor === "changed" ? "manual" : "terminal-error",
        abortedLastRun: true,
        restartRecoveryDeliveryRunId: "old-recovery",
        restartRecoveryDeliverySourceRunId: f.entry.restartRecoveryDeliverySourceRunId,
        mainRestartRecovery: { chargedAttempts: 0 },
      });
      expect(f.read()?.mainRestartRecovery?.reservation).toBeUndefined();
      if (successor !== "changed") {
        expect(f.read()?.mainRestartRecovery?.foregroundClaims).toBeUndefined();
        expect(replyRunRegistry.get(sessionKey)).toBeUndefined();
      }
      expect(await listSessionPendingInputs(scope)).toEqual(pendingBefore);
      expect(originalInput!.state).toBe("queued");
      expect(input!.state).toBe("queued");
    } finally {
      vi.unstubAllEnvs();
    }
  },
);
