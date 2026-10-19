import assert from "node:assert/strict";
import { describe, expect, it, vi } from "vitest";
import type { DecisionReceiptV1 } from "../../../packages/gateway-protocol/src/index.js";
import { createExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import { configureRuntimeActionDecisionSink } from "../../audit/runtime-action-decision.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import { hashWorkerCredential } from "./credential.js";
import { getWorkerInferenceSessionControl } from "./inference-control-internal.js";
import type { WorkerSessionTurnClaim } from "./placement-record.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { publishWorkerEnvironmentFixture } from "./placement-test-fixtures.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import * as support from "./service.test-support.js";
import {
  bindClaimOwner,
  claimAdmission,
  claimService,
  replaceClaim,
  seedClaim,
  turnRequests,
} from "./worker-turn-rpc-fixtures.test-support.js";
import { registerWorkerNativeInferenceRpcTests } from "./worker-turn-rpc.native-inference.test-support.js";

type WorkerEnvironmentServiceOptions = support.WorkerEnvironmentServiceOptions;
const fenced = { ok: false, closeReason: "placement-mismatch" };
const invalidCredential = { ok: false, reason: "invalid-credential" };
const inferenceSink = (connectionId: string) => ({ connectionId, send: vi.fn() });

function captureReceipts() {
  const receipts: DecisionReceiptV1[] = [];
  const clear = configureRuntimeActionDecisionSink((receipt) => {
    receipts.push(receipt);
    return true;
  });
  return { receipts, clear };
}

function admissionToken(runId: string, name: string, now = 100) {
  return createExecutionIdentityAdmissionToken(runId, {
    contextId: `context-${name}`,
    executionId: `execution-${name}`,
    now,
  });
}

function renewCredential(identity: WorkerConnectionIdentity, credentialHash: string) {
  return support.testState.store.renewCredential({
    environmentId: identity.environmentId,
    expectedOwnerEpoch: identity.ownerEpoch,
    sessionId: identity.sessionId,
    rpcSetVersion: identity.rpcSetVersion,
    expiresAtMs: identity.credentialExpiresAtMs,
    credentialHash,
  });
}

const providerFailure = {
  type: "error",
  reason: "provider-error",
  message: "Provider request failed",
} as const;
function abortingInference(onSignal: (signal: AbortSignal) => void) {
  return vi.fn<WorkerEnvironmentServiceOptions["executeInference"]>(async ({ signal }) => {
    onSignal(signal);
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return { type: "error", reason: "cancelled", message: "Inference cancelled" };
  });
}

describe("worker environment service", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("admits only a gateway-preclaimed worker placement and fences later requests", async () => {
    const environmentId = "worker-placement-fence";
    const sessionId = "session-placement-fence";
    const { identity, placementStore, workerService } = await support.placementHarness(
      environmentId,
      sessionId,
    );
    const rpc = turnRequests(identity, workerService);
    const admission = claimAdmission(
      identity.turnClaim!,
      [support.CREDENTIAL, environmentId, sessionId].join("-"),
    );

    await expect(workerService.admitWorker(admission)).resolves.toMatchObject({ ok: true });
    expect(workerService.validateWorkerConnection(identity)).toBeNull();

    const warmEnvironmentId = "worker-placement-warm";
    await support.seedReady(warmEnvironmentId);
    const warmAdmission = await workerService.admitWorker(support.admissionFor(warmEnvironmentId));
    assert(warmAdmission.ok, "warm worker admission failed");
    expect(workerService.validateWorkerConnection(warmAdmission.identity)).toBeNull();

    placementStore.validateWorkerTurn.mockReturnValue(false);
    await expect(
      workerService.admitWorker({ ...admission, runId: "run-conflict" }),
    ).resolves.toEqual({ ok: false, reason: "placement-mismatch" });

    placementStore.validateWorkerTurn.mockReturnValue(true);
    support.testState.nowMs += 10_000;
    expect(workerService.validateWorkerConnection(identity)).toBeNull();
    expect(workerService.validateWorkerConnection(warmAdmission.identity)).toBe(
      "credential-expired",
    );
    await expect(workerService.admitWorker(admission)).resolves.toMatchObject({
      ok: true,
      identity: { sessionId, runId: "run-1" },
    });

    placementStore.validateWorkerTurn.mockReturnValue(false);
    expect(workerService.validateWorkerConnection(identity)).toBe("placement-mismatch");
    vi.mocked(support.testState.prepareInstallation).mockClear();
    await expect(workerService.admitWorker(admission)).resolves.toEqual({
      ok: false,
      reason: "credential-expired",
    });
    expect(support.testState.prepareInstallation).not.toHaveBeenCalled();
    await expect(rpc.transcript("fenced")).resolves.toEqual(fenced);
  });

  it("records credential, build, owner-epoch, and successful worker admission gates", async () => {
    const environmentId = "worker-sensitive-environment";
    const sessionId = "session-sensitive-worker";
    const { claim, store } = await seedClaim(environmentId, sessionId, "run-worker-receipts");
    const owner = await bindClaimOwner(store, claim, {
      token: admissionToken(claim.runId, "worker-receipts"),
    });
    const workerService = claimService(store);
    const credential = await workerService.acquireTurnCredential(claim);
    const admission = claimAdmission(claim, credential.credential);
    const { receipts, clear } = captureReceipts();
    try {
      await expect(
        workerService.admitWorker({ ...admission, credential: "credential-must-not-leak" }),
      ).resolves.toEqual(invalidCredential);
      await expect(
        workerService.admitWorker({
          ...admission,
          handshake: { ...admission.handshake, bundleHash: "b".repeat(64) },
        }),
      ).resolves.toEqual({ ok: false, reason: "bundle-mismatch" });
      await expect(
        workerService.admitWorker({ ...admission, ownerEpoch: admission.ownerEpoch + 1 }),
      ).resolves.toEqual(invalidCredential);
      await expect(workerService.admitWorker(admission)).resolves.toMatchObject({ ok: true });
    } finally {
      clear();
      owner.release();
    }
    expect(
      receipts.map(({ decision, enforcement }) => [decision.reasonCode, enforcement.coverageState]),
    ).toEqual([
      ["worker_admission_invalid_credential", "enforced"],
      ["worker_admission_bundle_mismatch", "enforced"],
      ["worker_admission_gate_allowed", "enforced"],
    ]);
    const serialized = JSON.stringify(receipts);
    for (const secret of ["credential-must-not-leak", "b".repeat(64), environmentId, sessionId]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("does not attribute a late admission result to a replacement using the same run id", async () => {
    const environmentId = "worker-admission-replacement";
    const sessionId = "session-admission-replacement";
    const { claim: first, store } = await seedClaim(
      environmentId,
      sessionId,
      "run-admission-replacement",
    );
    const firstOwner = await bindClaimOwner(store, first, {
      token: admissionToken(first.runId, "admission-first"),
    });
    const installation = createDeferredCore<typeof support.BUNDLE_ARTIFACT>();
    support.testState.prepareInstallation = vi.fn(() => installation.promise);
    const workerService = claimService(store);
    const firstCredential = await workerService.acquireTurnCredential(first);
    const { receipts, clear } = captureReceipts();
    const admission = claimAdmission(first, firstCredential.credential);
    let secondOwner: Awaited<ReturnType<typeof bindClaimOwner>> | undefined;
    const pendingAdmission = workerService.admitWorker(admission);
    try {
      await support.waitForFast(() =>
        expect(support.testState.prepareInstallation).toHaveBeenCalledOnce(),
      );

      await store.releaseTurn(first);
      firstOwner.release();
      const second = await replaceClaim(store, first, "claim-admission-replacement");
      secondOwner = await bindClaimOwner(store, second, {
        token: admissionToken(second.runId, "admission-second", 101),
      });
      installation.resolve(support.BUNDLE_ARTIFACT);

      await expect(pendingAdmission).resolves.toEqual(invalidCredential);
      expect(receipts).toEqual([]);
    } finally {
      installation.resolve(support.BUNDLE_ARTIFACT);
      await Promise.allSettled([pendingAdmission]);
      clear();
      firstOwner.release();
      secondOwner?.release();
    }
  });

  it.each(["inherited", "revoked"] as const)(
    "keeps %s claims recovery-only across every worker authority surface",
    async (source) => {
      const environmentId = "worker-inherited-claim";
      const sessionId = "session-inherited-claim";
      const { claim, store, environmentIdentity } = await seedClaim(environmentId, sessionId);
      await store.authorizeWorkerTurnTools(claim, ["sessions_send"]);
      await store.updateAckCursors({ claim, liveEvent: 1 });
      const preRestartService = claimService(store);
      const recoveryCredential = await preRestartService.acquireTurnCredential(claim);
      await preRestartService.stop();
      await store.handoffWorkspaceResultRecovery(claim);

      const restartedStore = createWorkerSessionPlacementStore({
        database: support.testState.stateDb,
      });
      const gate = createWorkerSessionPlacementGate(restartedStore, {
        recoveryPlacements: source === "inherited" ? await restartedStore.listAsync() : [],
      });
      if (source === "revoked") {
        gate.fenceWorkerTurnForRecovery(claim);
      }
      const executeInference = vi.fn<WorkerEnvironmentServiceOptions["executeInference"]>();
      const createGatewayTools =
        vi.fn<NonNullable<WorkerEnvironmentServiceOptions["createGatewayTools"]>>();
      const liveEvents = support.createLiveEvents();
      const workerService = support.createService(support.createProvider(), {
        executeInference,
        createGatewayTools,
        liveEvents,
        placementStore: gate,
      });
      const identity = {
        ...environmentIdentity,
        runId: claim.runId,
        turnClaim: claim,
      };
      const admission = claimAdmission(claim, recoveryCredential.credential);
      const rpc = turnRequests(identity, workerService);

      expect(restartedStore.validateTurnClaim(claim)).toBe(true);
      expect(await restartedStore.listPendingWorkspaceResultsAsync()).toHaveLength(1);
      await expect(workerService.admitWorker(admission)).resolves.toEqual({
        ok: false,
        reason: "placement-mismatch",
      });
      expect(await workerService.acknowledgeCredentialDelivery(recoveryCredential)).toBe(false);
      expect(workerService.validateWorkerConnection(identity)).toBe("placement-mismatch");
      for (const request of [
        () => rpc.transcript("stale"),
        () => rpc.assistant("stale"),
        () =>
          workerService.startInference(
            identity,
            support.inferenceRequest(identity),
            inferenceSink("inherited-claim"),
          ),
        () =>
          workerService.invokeGatewayTool(
            identity,
            {
              generation: "stale-surface",
              toolId: "send",
              toolCallId: "inherited-tool",
              arguments: { sessionKey: "agent:main:target", message: "stale" },
            },
            { send: vi.fn() },
          ),
        () => workerService.getToolSurface(identity),
        () =>
          workerService.cancelGatewayTool(identity, {
            generation: "stale-surface",
            toolCallId: "inherited-tool",
          }),
      ]) {
        await expect(request()).resolves.toEqual(fenced);
      }
      expect(executeInference).not.toHaveBeenCalled();
      expect(createGatewayTools).not.toHaveBeenCalled();
    },
  );

  it("binds credentials and reconnect identities to the exact replacement claim", async () => {
    const environmentId = "worker-claim-credential";
    const sessionId = "session-claim-credential";
    const { claim: first, store } = await seedClaim(environmentId, sessionId);
    const workerService = claimService(store);
    const firstCredential = await workerService.acquireTurnCredential(first);
    const admission = claimAdmission(first, firstCredential.credential);
    for (const attemptedSession of [sessionId, "session-unknown"]) {
      await expect(
        workerService.admitWorker({
          ...admission,
          credential: "invalid-worker-credential",
          sessionId: attemptedSession,
          runId: "run-unknown",
        }),
      ).resolves.toEqual(invalidCredential);
    }
    await expect(
      workerService.admitWorker({ ...admission, runId: "run-unknown" }),
    ).resolves.toEqual({ ok: false, reason: "placement-mismatch" });
    const firstAdmission = await workerService.admitWorker(admission);
    expect(firstAdmission).toMatchObject({ ok: true, identity: { turnClaim: first } });
    await store.releaseTurn(first);
    const second = await replaceClaim(store, first, "claim-replacement");

    expect(await workerService.acknowledgeCredentialDelivery(firstCredential)).toBe(false);
    await expect(workerService.admitWorker(admission)).resolves.toEqual(invalidCredential);
    assert(firstAdmission.ok, "first exact worker admission failed");
    expect(workerService.validateWorkerConnection(firstAdmission.identity)).toBe(
      "placement-mismatch",
    );

    const secondCredential = await workerService.acquireTurnCredential(second);
    expect(await workerService.acknowledgeCredentialDelivery(secondCredential)).toBe(true);
    const secondAdmission = { ...admission, credential: secondCredential.credential };
    await expect(workerService.admitWorker(secondAdmission)).resolves.toMatchObject({
      ok: true,
      identity: { turnClaim: second },
    });
    await expect(workerService.admitWorker(secondAdmission)).resolves.toMatchObject({ ok: true });
  });

  it("keeps exact-claim inference live past TTL and aborts promptly on claim closure", async () => {
    const environmentId = "worker-claim-inference";
    const sessionId = "session-claim-inference";
    const { claim: first, store } = await seedClaim(environmentId, sessionId);
    const signals: AbortSignal[] = [];
    const executeInference = abortingInference((signal) => signals.push(signal));
    const workerService = claimService(store, {
      executeInference,
      workerCredentialTtlMs: 20,
    });
    const admitClaim = async (claim: WorkerSessionTurnClaim) => {
      const owner = await bindClaimOwner(store, claim, {
        assertCurrent: () => {
          if (!store.validateTurnClaim(claim)) {
            throw new Error("inference fixture claim is no longer current");
          }
        },
      });
      support.testState.releaseTurnOwners.push(async () => {
        if (store.validateTurnClaim(claim)) {
          await store.releaseTurn(claim);
        }
        owner.release();
      });
      const credential = await workerService.acquireTurnCredential(claim);
      const admitted = await workerService.admitWorker(
        claimAdmission(claim, credential.credential),
      );
      assert(admitted.ok, "worker admission failed");
      expect(await workerService.acknowledgeCredentialDelivery(credential)).toBe(true);
      return admitted.identity;
    };
    const firstIdentity = await admitClaim(first);
    const started = await workerService.startInference(
      firstIdentity,
      support.inferenceRequest(firstIdentity),
      inferenceSink("claim-inference-a"),
    );
    assert(started.ok, "first inference failed to start");
    started.launch();
    await support.waitForFast(() => expect(signals).toHaveLength(1));
    support.testState.nowMs = firstIdentity.credentialExpiresAtMs + 1;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 30);
    });
    expect(signals[0]?.aborted).toBe(false);

    const originalCancellation = getWorkerInferenceSessionControl(
      workerService,
    )?.captureSessionCancellation(sessionId, first.runId);
    expect(originalCancellation?.runIds).toEqual([first.runId]);
    await store.releaseTurn(first);
    expect(signals[0]?.aborted).toBe(true);
    const second = await replaceClaim(store, first, "claim-inference-replacement");
    const secondIdentity = await admitClaim(second);
    const replacement = await workerService.startInference(
      secondIdentity,
      { ...support.inferenceRequest(secondIdentity), turnId: "turn-replacement" },
      inferenceSink("claim-inference-b"),
    );
    assert(replacement.ok, "replacement inference failed to start");
    replacement.launch();
    await support.waitForFast(() => expect(signals).toHaveLength(2));
    expect(await originalCancellation?.cancel()).toEqual([]);
    expect(signals[1]?.aborted).toBe(false);
    expect(
      getWorkerInferenceSessionControl(workerService)?.captureSessionCancellation(
        sessionId,
        first.runId,
      ).runIds,
    ).toEqual([first.runId]);
    await expect(store.releaseTurn(first)).rejects.toThrow("turn claim changed before release");
    expect(signals[1]?.aborted).toBe(false);
    await store.releaseTurn(second);
    expect(signals[1]?.aborted).toBe(true);
  });

  it("does not rotate an expired delivered credential while its durable turn is active", async () => {
    const environmentId = "worker-expired-active-turn";
    const sessionId = "session-expired-active-turn";
    const liveEvents = support.createLiveEvents();
    const { identity, workerService } = await support.placementHarness(environmentId, sessionId, {
      liveEvents,
    });
    await support.testState.store.markCredentialDelivered({
      environmentId,
      credentialHash: identity.credentialHash,
      ownerEpoch: identity.ownerEpoch,
      sessionId,
      deliveredAtMs: support.testState.nowMs,
    });
    support.testState.nowMs = identity.credentialExpiresAtMs;

    await workerService.reconcileOnce();

    expect(support.testState.store.getCredential(environmentId)?.credentialHash).toBe(
      identity.credentialHash,
    );
    expect(liveEvents.rotateCredential).not.toHaveBeenCalled();
  });

  it("fences post-terminal mutations while preserving sequenced replays", async () => {
    const applyTranscriptCommit = support.successfulTranscriptCommit("entry-terminal");
    const { apply: liveApply, liveEvents } = support.sequencedLiveEvents();
    const executeInference = vi.fn<WorkerEnvironmentServiceOptions["executeInference"]>(
      async () => ({ ...providerFailure }),
    );
    const { identity, workerService } = await support.placementHarness(
      "worker-terminal-fence",
      "session-terminal-fence",
      { applyTranscriptCommit, executeInference, liveEvents },
    );
    const transcript = support.transcriptRequest(identity, "terminal fence");
    const rpc = turnRequests(identity, workerService);

    await expect(workerService.commitTranscript(identity, transcript)).resolves.toMatchObject({
      ok: true,
    });
    const terminalAck = { ok: true, result: { ackedSeq: 1 } };
    await expect(rpc.terminal()).resolves.toEqual(terminalAck);

    await expect(workerService.commitTranscript(identity, transcript)).resolves.toMatchObject({
      ok: true,
    });
    await expect(
      workerService.commitTranscript(identity, { ...transcript, seq: 2 }),
    ).resolves.toEqual(fenced);
    expect(applyTranscriptCommit).toHaveBeenCalledTimes(2);

    await expect(rpc.terminal()).resolves.toEqual(terminalAck);
    await expect(rpc.assistant("late", { seq: 2 })).resolves.toEqual(fenced);
    expect(liveApply).toHaveBeenCalledTimes(2);

    expect(
      await workerService.startInference(
        identity,
        support.inferenceRequest(identity),
        inferenceSink("connection-terminal-fence"),
      ),
    ).toEqual(fenced);
    expect(
      await workerService.cancelInference(identity, support.inferenceRequest(identity)),
    ).toEqual(fenced);
    expect(executeInference).not.toHaveBeenCalled();

    const rotatedCredentialHash = hashWorkerCredential(
      ["rotated", identity.environmentId, identity.sessionId].join("-"),
    );
    await renewCredential(identity, rotatedCredentialHash);
    const rotatedIdentity = { ...identity, credentialHash: rotatedCredentialHash };
    await expect(
      workerService.commitTranscript(rotatedIdentity, { ...transcript, seq: 2 }),
    ).resolves.toMatchObject({ ok: true });
    expect(applyTranscriptCommit).toHaveBeenCalledTimes(3);
  });

  it("fences inference by epoch and the durable session credential", async () => {
    const executeInference = vi.fn<WorkerEnvironmentServiceOptions["executeInference"]>(
      async () => ({ ...providerFailure }),
    );
    const { identity, workerService } = await support.placementHarness(
      "worker-inference-fence",
      "session-inference-fence",
      { executeInference },
    );
    const request = support.inferenceRequest(identity);
    for (const [input, reason] of [
      [{ ...request, sessionId: "session-other" }, "session-not-attached"],
      [{ ...request, runId: "run-other" }, "session-not-attached"],
      [{ ...request, runEpoch: request.runEpoch + 1 }, "epoch-mismatch"],
    ] as const) {
      await expect(
        workerService.startInference(identity, input, inferenceSink("fenced")),
      ).resolves.toEqual({ ok: false, reason });
      await expect(workerService.cancelInference(identity, input)).resolves.toEqual({
        ok: false,
        reason,
      });
    }

    const send = vi.fn();
    const started = await workerService.startInference(identity, request, {
      connectionId: "connection-c",
      send,
    });
    assert(started.ok, "inference fixture failed to start");
    await renewCredential(
      identity,
      hashWorkerCredential(["replacement", identity.environmentId].join("-")),
    );
    started.launch();
    await support.waitForFast(() => expect(send).toHaveBeenCalledOnce());
    expect(executeInference).not.toHaveBeenCalled();
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      event: "worker.inference.terminal",
      payload: { outcome: { reason: "session-not-attached" } },
    });
  });

  registerWorkerNativeInferenceRpcTests();

  it("fences and rotates live credentials", async () => {
    const environmentId = "worker-live";
    const sessionId = "session-live";
    const liveEvents = support.createLiveEvents();
    let inferenceSignal: AbortSignal | undefined;
    const executeInference = abortingInference((signal) => {
      inferenceSignal = signal;
    });
    const { identity, workerService } = await support.placementHarness(environmentId, sessionId, {
      executeInference,
      liveEvents,
    });
    const request = { ...support.LIVE_EVENT, runEpoch: identity.ownerEpoch };
    const push = workerService.pushLiveEvent.bind(workerService, identity);
    await push(request);
    await expect(push({ ...request, runEpoch: identity.ownerEpoch + 1 })).resolves.toEqual({
      ok: false,
      details: { reason: "epoch-mismatch" },
    });
    const started = await workerService.startInference(
      identity,
      support.inferenceRequest(identity),
      inferenceSink("connection-rotation"),
    );
    assert(started.ok, "inference fixture failed to start");
    started.launch();
    await support.waitForFast(() => expect(executeInference).toHaveBeenCalledOnce());
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        db.prepare(
          "UPDATE worker_environment_credentials SET session_id = ? WHERE environment_id = ?",
        ).run("session-other", environmentId);
        publishWorkerEnvironmentFixture(db, environmentId);
      },
      { database: support.testState.stateDb },
    );
    await expect(push({ ...request, seq: 2 })).resolves.toEqual({
      ok: false,
      details: { reason: "session-not-attached" },
    });
    liveEvents.rotateCredential.mockClear();
    support.testState.nowMs += 10_000;
    await workerService.reconcileOnce();
    expect(inferenceSignal?.aborted).toBe(true);
    expect(liveEvents.rotateCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialHash: support.testState.store.getCredential(environmentId)?.credentialHash,
        previousCredentialHash: identity.credentialHash,
        runEpoch: identity.ownerEpoch,
      }),
    );
  });
});
