import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { createExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import {
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { applyAssistantDeliveryDirectives } from "../../config/sessions/transcript-assistant-delivery.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  rotateAgentRunRegistryLifecycleGeneration,
} from "../../infra/agent-run-registry.js";
import { tryBeginGatewayRootWorkAdmission } from "../../process/gateway-work-admission.js";
import { onSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { projectSessionMessagePayload } from "../session-transcript-message.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import { readWorkerSessionPlacementProjectionInDatabase } from "./placement-read-projection.js";
import { placementTurnOwner, type WorkerSessionPlacementIdentity } from "./placement-record.js";
import {
  createWorkerSessionPlacementStore,
  type WorkerSessionPlacementStore,
} from "./placement-store.js";
import { advancePlacementFixtureToActive } from "./placement-test-fixtures.js";
import {
  bindWorkerTurnOwner,
  captureWorkerTurnFinishing,
  acknowledgeWorkerTurnFinishing,
  getWorkerTurnExecutionIdentityCapability,
  runWorkerTurnAdmissionContinuation,
} from "./placement-turn-claim-events.js";
import { createWorkerTranscriptCommitStore } from "./transcript-commit-store.js";
import { createWorkerTranscriptCommitter } from "./transcript-commit.js";

const SESSION: WorkerSessionPlacementIdentity = {
  sessionId: "session-placement-claim-close",
  agentId: "main",
  sessionKey: "agent:main:placement-claim-close",
};

let root: string;
let database: OpenClawStateDatabase;
let store: WorkerSessionPlacementStore;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-placement-claim-"));
  database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
  store = createWorkerSessionPlacementStore({ database });
});

afterEach(async () => {
  await closeStateDatabaseForTest();
  await fs.rm(root, { recursive: true, force: true });
});

function advanceToActive(executionMode: "worker-turn" | "remote-exec" = "worker-turn") {
  return advancePlacementFixtureToActive(store, database, SESSION, executionMode);
}

it("rejects an unbounded claim wait when its signal is already aborted", async () => {
  const active = await advanceToActive();
  const claim = await store.claimTurn({
    ...SESSION,
    owner: placementTurnOwner(active),
    claimId: "claim-aborted-wait",
    runId: "run-aborted-wait",
  });
  const controller = new AbortController();
  controller.abort();

  await expect(
    store.waitForTurnClaimRelease(SESSION.sessionId, { signal: controller.signal }),
  ).rejects.toThrow(`Turn claim wait aborted for session ${SESSION.sessionId}`);
  expect(store.validateTurnClaim(claim)).toBe(true);
});

it.each([
  { executionMode: "worker-turn", visibleBeforeStaging: true },
  { executionMode: "remote-exec", visibleBeforeStaging: false },
] as const)(
  "projects $executionMode workspace reconciliation at its owned boundary",
  async (scenario) => {
    const active = await advanceToActive(scenario.executionMode);
    const claim = await store.claimTurn({
      ...SESSION,
      owner: placementTurnOwner(active),
      claimId: `workspace-result-${scenario.executionMode}`,
      runId: `run-${scenario.executionMode}`,
    });
    store.markWorkspaceResultPending(claim);

    const readReconciling = () => store.getWorkspaceResultReconcilingSessionIds([active.sessionId]);
    expect(readReconciling().has(active.sessionId)).toBe(scenario.visibleBeforeStaging);
    expect(
      (await store.readProjection([active.sessionId])).workspaceResultReconcilingSessionIds.has(
        active.sessionId,
      ),
    ).toBe(scenario.visibleBeforeStaging);
    const stagedResultRef = `refs/openclaw/worker-results/${claim.claimId}`;
    store.recordStagedWorkspaceResult(claim, stagedResultRef);
    expect(readReconciling()).toEqual(new Set([active.sessionId]));
    store.recordWorkspaceResultConflict(claim, { paths: ["conflict.txt"], stagedResultRef });
    const conflicted = await store.readProjection([active.sessionId]);
    expect(conflicted.placements.get(active.sessionId)).toMatchObject({
      workspaceResultConflict: { paths: ["conflict.txt"], stagedResultRef, totalCount: 1 },
    });
    expect(conflicted.workspaceResultReconcilingSessionIds.has(active.sessionId)).toBe(true);
    store.recordWorkspaceResultConflict(claim, undefined);
    expect(
      (await store.readProjection([active.sessionId])).placements.get(active.sessionId),
    ).not.toHaveProperty("workspaceResultConflict");
    store.acceptWorkspaceResult(claim);
    store.completeWorkspaceResultAndReleaseTurn(claim);
    expect(
      (await store.readProjection([active.sessionId])).workspaceResultReconcilingSessionIds.has(
        active.sessionId,
      ),
    ).toBe(false);
  },
);

it("keeps placement and result facts in one snapshot across a peer commit", async () => {
  const active = await advanceToActive();
  const claim = await store.claimTurn({
    ...SESSION,
    owner: placementTurnOwner(active),
    claimId: "projection-peer-claim",
    runId: "projection-peer-run",
  });
  store.markWorkspaceResultPending(claim);

  database.db.exec("PRAGMA journal_mode = WAL");
  const peer = new DatabaseSync(database.path);
  const reader = new DatabaseSync(database.path, { readOnly: true });
  const prepare = reader.prepare.bind(reader);
  const recoveryError = "Peer placement failure";
  let peerCommits = 0;
  let changedRows: number | bigint = 0;
  const statement = vi.spyOn(reader, "prepare").mockImplementation((sql) => {
    // The fresh reader has consumed placements before preparing the result query on every Node version.
    if (peerCommits === 0 && /\bfrom\s+"?worker_workspace_pending_results\b/i.test(sql)) {
      peerCommits++;
      const updatedAtMs = Date.now();
      peer.exec("BEGIN IMMEDIATE");
      changedRows = peer
        .prepare(
          `UPDATE worker_session_placements
           SET state = 'failed', transition_generation = ?, recovery_error = ?,
               terminal_reason = ?, terminal_at_ms = ?, turn_claim_owner = NULL,
               turn_claim_id = NULL, turn_claim_run_id = NULL, turn_claim_generation = NULL,
               turn_claim_owner_epoch = NULL, updated_at_ms = ?, state_changed_at_ms = ?
           WHERE session_id = ? AND state = 'active' AND transition_generation = ?
             AND turn_claim_owner = 'worker' AND turn_claim_id = ? AND turn_claim_run_id = ?`,
        )
        .run(
          active.generation + 1,
          recoveryError,
          recoveryError,
          updatedAtMs,
          updatedAtMs,
          updatedAtMs,
          active.sessionId,
          active.generation,
          claim.claimId,
          claim.runId,
        ).changes;
      peer
        .prepare("DELETE FROM worker_workspace_pending_results WHERE session_id = ?")
        .run(active.sessionId);
      peer.exec("COMMIT");
    }
    return prepare(sql);
  });
  try {
    expect(
      (await store.readProjection([active.sessionId])).workspaceResultReconcilingSessionIds.has(
        active.sessionId,
      ),
    ).toBe(true);
    const facts = readWorkerSessionPlacementProjectionInDatabase(
      reader,
      [active.sessionId],
      [],
    ).projection;
    expect(peerCommits).toBe(1);
    expect(changedRows).toBe(1);
    expect(facts.placements.get(active.sessionId)).toMatchObject({
      state: "active",
      generation: active.generation,
    });
    expect(facts.workspaceResultReconcilingSessionIds.has(active.sessionId)).toBe(true);
    const current = await store.readProjection([active.sessionId]);
    expect(current.placements.get(active.sessionId)).toMatchObject({
      state: "failed",
      generation: active.generation + 1,
      recoveryError,
      turnClaim: null,
    });
    expect(current.workspaceResultReconcilingSessionIds.has(active.sessionId)).toBe(false);
  } finally {
    statement.mockRestore();
    reader.close();
    peer.close();
  }
});

it("rejects invalid placement fields when reading projection facts", async () => {
  const active = await advanceToActive();
  database.db
    .prepare("UPDATE worker_session_placements SET worker_bundle_hash = ' ' WHERE session_id = ?")
    .run(active.sessionId);

  await expect(store.readProjection([active.sessionId])).rejects.toThrow(
    "Worker session placement worker bundle hash must be a non-empty string",
  );
});

async function bindFinishingOwner() {
  const active = await advanceToActive();
  const claim = await store.claimTurn({
    ...SESSION,
    owner: placementTurnOwner(active),
    claimId: "claim-finishing",
    runId: "run-finishing",
  });
  const instance = createOperationalRunInstanceRef(claim.runId);
  const authority = claimAgentRunDelegatedAuthority(instance);
  const abort = new AbortController();
  const bind = () =>
    bindWorkerTurnOwner(
      store,
      claim,
      undefined,
      instance,
      { ...SESSION, storePath: path.join(root, "sessions.json") },
      () => abort.signal.throwIfAborted(),
    );
  const { takeFinishingOutcome: take } = await bind();
  const identity: WorkerConnectionIdentity = {
    environmentId: active.environmentId,
    credentialHash: "finishing-credential-hash",
    bundleHash: "a".repeat(64),
    sessionId: claim.sessionId,
    runId: claim.runId,
    turnClaim: claim,
    ownerEpoch: active.activeOwnerEpoch,
    rpcSetVersion: 1,
    protocolFeatures: [],
    credentialExpiresAtMs: Date.now() + 60_000,
  };
  const request = {
    runEpoch: identity.ownerEpoch,
    lastAckedSeq: 0,
    seq: 2,
    runId: claim.runId,
    event: {
      kind: "lifecycle" as const,
      payload: {
        phase: "finishing" as const,
        endedAt: 2,
        stopReason: "error",
        error: "native close failed",
        replayInvalid: true as const,
      },
    },
  };
  const close = async () => {
    if (store.validateTurnClaim(claim)) {
      await store.releaseTurn(claim);
    }
    releaseAgentRunDelegatedAuthority(authority);
  };
  return { claim, authority, abort, bind, take, identity, request, close };
}

it.each([false, true])(
  "consumes finishing only under its current ACK (credential replaced: %s)",
  async (replaced) => {
    const h = await bindFinishingOwner();
    try {
      const record = captureWorkerTurnFinishing(h.identity, h.request);
      expect(record).toBeTypeOf("function");
      record?.();
      expect(h.take(h.identity.credentialHash)).toBeUndefined();
      acknowledgeWorkerTurnFinishing(h.identity, 1, () => true);
      expect(h.take(h.identity.credentialHash)).toBeUndefined();
      acknowledgeWorkerTurnFinishing(
        { ...h.identity, credentialHash: "other-process" },
        2,
        () => true,
      );
      expect(h.take(h.identity.credentialHash)).toBeUndefined();
      let credentialCurrent = true;
      acknowledgeWorkerTurnFinishing(h.identity, 2, () => credentialCurrent);
      expect(h.take("other-process")).toBeUndefined();
      credentialCurrent = !replaced;
      expect(h.take(h.identity.credentialHash)).toEqual(
        replaced ? undefined : { error: "native close failed", replayInvalid: true },
      );
      expect(h.take(h.identity.credentialHash)).toBeUndefined();
    } finally {
      await h.close();
    }
  },
);

it.each(["claim", "run", "abort", "lifecycle", "same-claim replacement"] as const)(
  "rejects retained finishing readers and delayed events after %s closure",
  async (closure) => {
    const h = await bindFinishingOwner();
    try {
      const record = captureWorkerTurnFinishing(h.identity, h.request);
      expect(record).toBeTypeOf("function");
      record?.();
      acknowledgeWorkerTurnFinishing(h.identity, 2, () => true);
      let replacement: typeof h.take | undefined;
      if (closure === "claim") {
        await store.releaseTurn(h.claim);
      } else if (closure === "run") {
        releaseAgentRunDelegatedAuthority(h.authority);
      } else if (closure === "abort") {
        h.abort.abort(new Error("turn cancelled"));
      } else if (closure === "lifecycle") {
        rotateAgentRunRegistryLifecycleGeneration();
      } else {
        replacement = (await h.bind()).takeFinishingOutcome;
      }
      record?.();
      acknowledgeWorkerTurnFinishing(h.identity, 2, () => true);
      expect(() => h.take(h.identity.credentialHash)).toThrow();
      if (replacement) {
        expect(replacement(h.identity.credentialHash)).toBeUndefined();
        captureWorkerTurnFinishing(h.identity, h.request)?.();
        acknowledgeWorkerTurnFinishing(h.identity, 2, () => true);
        expect(replacement(h.identity.credentialHash)).toEqual({
          error: "native close failed",
          replayInvalid: true,
        });
      }
    } finally {
      await h.close();
    }
  },
);

it.each([
  "session",
  "run",
  "environment",
  "epoch",
  "claim",
  "generation",
  "request run",
  "request epoch",
] as const)("does not retain finishing from a mismatched %s binding", async (field) => {
  const h = await bindFinishingOwner();
  try {
    const identity = { ...h.identity };
    const request = { ...h.request };
    if (field === "session") {
      identity.sessionId = "other-session";
    } else if (field === "run") {
      identity.runId = "other-run";
    } else if (field === "environment") {
      identity.environmentId = "other-environment";
    } else if (field === "epoch") {
      identity.ownerEpoch += 1;
    } else if (field === "claim") {
      identity.turnClaim = { ...h.claim, claimId: "other-claim" };
    } else if (field === "generation") {
      identity.turnClaim = { ...h.claim, placementGeneration: h.claim.placementGeneration + 1 };
    } else if (field === "request run") {
      request.runId = "other-run";
    } else {
      request.runEpoch += 1;
    }
    expect(captureWorkerTurnFinishing(identity, request)).toBeUndefined();
    acknowledgeWorkerTurnFinishing(identity, 2, () => true);
    expect(h.take(h.identity.credentialHash)).toBeUndefined();
  } finally {
    await h.close();
  }
});

it("emits exact worker claim closure after release", async () => {
  const closed = vi.fn();
  const unregister = store.registerTurnClaimClosedHandler(closed);
  const active = await advanceToActive();
  const owner = {
    kind: "worker" as const,
    environmentId: active.environmentId,
    ownerEpoch: active.activeOwnerEpoch,
  };
  const first = await store.claimTurn({
    ...SESSION,
    owner,
    claimId: "claim-release",
    runId: "run-release",
  });
  await store.releaseTurn(first);
  expect(closed).toHaveBeenLastCalledWith(first);

  expect(closed).toHaveBeenCalledOnce();
  unregister();
});

it.each([
  { ownerKind: "worker", executionMode: "worker-turn" },
  { ownerKind: "local", executionMode: "remote-exec" },
] as const)("fences the exact $ownerKind claim when reconciliation starts", async (scenario) => {
  const closed = vi.fn();
  const unregister = store.registerTurnClaimClosedHandler(closed);
  const active = await advanceToActive(scenario.executionMode);
  const claim = await store.claimTurn({
    ...SESSION,
    owner: placementTurnOwner(active),
    claimId: `claim-reconcile-${scenario.ownerKind}`,
    runId: `run-reconcile-${scenario.ownerKind}`,
  });
  const draining = store.startDrain({
    sessionId: active.sessionId,
    environmentId: active.environmentId,
    ownerEpoch: active.activeOwnerEpoch,
    expectedGeneration: active.generation,
  });
  const reconcileInput = {
    sessionId: active.sessionId,
    environmentId: active.environmentId,
    ownerEpoch: active.activeOwnerEpoch,
    expectedGeneration: draining.generation,
  };

  expect(() =>
    store.startReconcile({ ...reconcileInput, ownerEpoch: active.activeOwnerEpoch + 1 }),
  ).toThrow("Cannot reconcile stale worker placement");
  expect(store.get(active.sessionId)).toMatchObject({
    state: "draining",
    turnClaim: { claimId: claim.claimId, owner: scenario.ownerKind },
  });
  expect(closed).not.toHaveBeenCalled();

  const authorizedReconcileInput =
    scenario.ownerKind === "local"
      ? { ...reconcileInput, forceLocalClaim: true as const }
      : reconcileInput;
  if (scenario.ownerKind === "local") {
    const preserved = store.get(active.sessionId);
    expect(() => store.startReconcile(reconcileInput)).toThrow("local turn is active");
    expect(store.get(active.sessionId)).toEqual(preserved);
    expect(store.validateTurnClaim(claim)).toBe(true);
    expect(closed).not.toHaveBeenCalled();
  }

  expect(store.startReconcile(authorizedReconcileInput)).toMatchObject({
    state: "reconciling",
    turnClaim: null,
  });
  expect(store.validateTurnClaim(claim)).toBe(false);
  expect(closed).toHaveBeenCalledExactlyOnceWith(claim);
  expect(() => store.startReconcile(authorizedReconcileInput)).toThrow(
    "Cannot reconcile stale worker placement",
  );
  await expect(store.releaseTurn(claim)).rejects.toThrow("turn claim changed before release");
  expect(closed).toHaveBeenCalledOnce();
  unregister();
});

it("rejects retained worker lineage capabilities after either owner closes", async () => {
  const active = await advanceToActive();
  const owner = {
    kind: "worker" as const,
    environmentId: active.environmentId,
    ownerEpoch: active.activeOwnerEpoch,
  };
  const placementClosedClaim = await store.claimTurn({
    ...SESSION,
    owner,
    claimId: "claim-placement-close",
    runId: "run-placement-close",
  });
  const placementClosedRun = createOperationalRunInstanceRef(placementClosedClaim.runId);
  const placementClosedAuthority = claimAgentRunDelegatedAuthority(placementClosedRun);
  await bindWorkerTurnOwner(
    store,
    placementClosedClaim,
    createExecutionIdentityAdmissionToken(placementClosedClaim.runId),
    placementClosedRun,
    { ...SESSION, storePath: path.join(root, "sessions.json") },
    () => {},
  );
  const placementCapability = getWorkerTurnExecutionIdentityCapability(store, placementClosedClaim);
  if (!placementCapability) {
    throw new Error("expected placement-bound lineage capability");
  }
  let placementReceiptAuthority: (() => void) | undefined;
  const sql = observeHostDataSql();
  try {
    const calibration = database.db.prepare("SELECT 1");
    database.db.exec("SELECT 1");
    calibration.get();
    calibration.all();
    calibration.run();
    expect([...calibration.iterate()]).toHaveLength(1);
    for (const call of sql.calls) {
      expect(call).toHaveBeenCalled();
      call.mockClear();
    }
    expect(getWorkerTurnExecutionIdentityCapability(store, placementClosedClaim)).toBe(
      placementCapability,
    );
    await placementCapability.run((identity) => {
      placementReceiptAuthority = identity.receiptAuthority;
      identity.receiptAuthority();
    });
    expect(sql.calls.map((call) => call.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]);
  } finally {
    sql.restore();
  }
  await store.releaseTurn(placementClosedClaim);
  expect(() => placementReceiptAuthority?.()).toThrow("worker turn authority changed");
  await expect(placementCapability.run(async () => "stale")).rejects.toThrow(
    "worker turn authority changed",
  );
  releaseAgentRunDelegatedAuthority(placementClosedAuthority);

  const runClosedClaim = await store.claimTurn({
    ...SESSION,
    owner,
    claimId: "claim-run-close",
    runId: "run-run-close",
  });
  const runClosedOperational = createOperationalRunInstanceRef(runClosedClaim.runId);
  const runClosedAuthority = claimAgentRunDelegatedAuthority(runClosedOperational);
  await bindWorkerTurnOwner(
    store,
    runClosedClaim,
    createExecutionIdentityAdmissionToken(runClosedClaim.runId),
    runClosedOperational,
    { ...SESSION, storePath: path.join(root, "sessions.json") },
    () => {},
  );
  const runCapability = getWorkerTurnExecutionIdentityCapability(store, runClosedClaim);
  if (!runCapability) {
    throw new Error("expected run-bound lineage capability");
  }
  await expect(
    runCapability.run(async () => {
      await Promise.resolve();
      releaseAgentRunDelegatedAuthority(runClosedAuthority);
      return "closed-after-await";
    }),
  ).rejects.toThrow("worker turn authority changed");
  await store.releaseTurn(runClosedClaim);
});

it("lets an unaudited admitted worker complete the exact turn that closes its owners", async () => {
  const active = await advanceToActive();
  const claim = await store.claimTurn({
    ...SESSION,
    claimId: "claim-terminal-continuation",
    runId: "run-terminal-continuation",
    owner: {
      kind: "worker",
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
    },
  });
  const operationalRunInstance = createOperationalRunInstanceRef(claim.runId);
  const delegatedAuthority = claimAgentRunDelegatedAuthority(operationalRunInstance);
  const rootAdmission = tryBeginGatewayRootWorkAdmission();
  if (!rootAdmission) {
    throw new Error("expected parent worker turn root admission");
  }
  try {
    await rootAdmission.run(async () =>
      bindWorkerTurnOwner(
        store,
        claim,
        undefined,
        operationalRunInstance,
        { ...SESSION, storePath: path.join(root, "sessions.json") },
        () => {},
      ),
    );
    await getWorkerTurnExecutionIdentityCapability(store, claim)?.run((owner) => {
      expect(owner.executionIdentityToken).toBeUndefined();
    });
    const identity: WorkerConnectionIdentity = {
      environmentId: active.environmentId,
      credentialHash: "worker-terminal-continuation",
      bundleHash: "a".repeat(64),
      sessionId: claim.sessionId,
      runId: claim.runId,
      turnClaim: claim,
      ownerEpoch: active.activeOwnerEpoch,
      rpcSetVersion: 1,
      protocolFeatures: [],
      credentialExpiresAtMs: Date.now() + 60_000,
    };

    await expect(
      runWorkerTurnAdmissionContinuation(identity, async () => {
        await store.releaseTurn(claim);
        releaseAgentRunDelegatedAuthority(delegatedAuthority);
        return "completed";
      }),
    ).resolves.toBe("completed");
    expect(runWorkerTurnAdmissionContinuation(identity, async () => "stale")).toBeNull();
  } finally {
    releaseAgentRunDelegatedAuthority(delegatedAuthority);
    rootAdmission.release();
  }
});

it.each([
  "root admission",
  "no root admission",
  "released claim",
  "released run",
  "replaced claim",
  "wrong environment",
  "wrong generation",
] as const)(
  "prepares worker transcript publication only for its live owner: %s",
  async (scenario) => {
    const active = await advanceToActive();
    const claim = await store.claimTurn({
      ...SESSION,
      owner: placementTurnOwner(active),
      claimId: "claim-media-publication",
      runId: "run-media-publication",
    });
    const instance = createOperationalRunInstanceRef(claim.runId);
    const authority = claimAgentRunDelegatedAuthority(instance);
    const identity: WorkerConnectionIdentity = {
      environmentId: active.environmentId,
      credentialHash: "worker-media-publication",
      bundleHash: "a".repeat(64),
      sessionId: claim.sessionId,
      runId: claim.runId,
      turnClaim: claim,
      ownerEpoch: active.activeOwnerEpoch,
      rpcSetVersion: 1,
      protocolFeatures: [],
      credentialExpiresAtMs: Date.now() + 60_000,
    };
    const text = "Prepared\nMEDIA:./owned.png\nMEDIA:./unowned.png";
    const prepare = vi.fn(
      (message: ReturnType<typeof makeAgentAssistantMessage>, sourceText: string | undefined) => {
        expect(sourceText).toBe(text);
        return applyAssistantDeliveryDirectives(message, { managedMediaUrls: ["./owned.png"] });
      },
    );
    const admission =
      scenario === "root admission" ? tryBeginGatewayRootWorkAdmission() : undefined;
    const target = { ...SESSION, storePath: path.join(root, "sessions.json") };
    const published: unknown[] = [];
    const unsubscribe = onSessionTranscriptUpdate((update) => {
      if (update.sessionId === SESSION.sessionId) {
        published.push(
          projectSessionMessagePayload({
            ...update,
            message: update.message,
            sessionKey: SESSION.sessionKey,
          }).payload,
        );
      }
    });
    let replacement: typeof claim | undefined;
    try {
      const bind = () =>
        bindWorkerTurnOwner(store, claim, undefined, instance, target, () => {}, prepare);
      if (scenario === "root admission") {
        if (!admission) {
          throw new Error("expected root admission");
        }
        await admission.run(async () => bind());
      } else {
        await bind();
      }
      if (scenario === "released claim" || scenario === "replaced claim") {
        await store.releaseTurn(claim);
        if (scenario === "replaced claim") {
          replacement = await store.claimTurn({
            ...SESSION,
            owner: placementTurnOwner(active),
            claimId: "claim-replacement",
            runId: claim.runId,
          });
        }
      } else if (scenario === "released run") {
        releaseAgentRunDelegatedAuthority(authority);
      } else if (scenario === "wrong environment") {
        identity.environmentId = "different-environment";
      } else if (scenario === "wrong generation") {
        identity.turnClaim = { ...claim, placementGeneration: claim.placementGeneration + 1 };
      }
      await upsertSessionEntryCore(target, { sessionId: SESSION.sessionId, updatedAt: 1 });
      const committer = createWorkerTranscriptCommitter({
        getConfig: () => ({ session: { store: target.storePath } }),
        store: createWorkerTranscriptCommitStore({ database }),
      });
      const userText = "Keep this example\nMEDIA:./user.png";
      const result = await committer.commit({
        // This suite isolates projection from the RPC-owned persistence authority.
        assertCurrent: () => {},
        identity,
        sessionTarget: target,
        request: {
          runEpoch: identity.ownerEpoch,
          seq: 1,
          baseLeafId: null,
          messages: [
            { role: "user", content: [{ type: "text", text: userText }], timestamp: 1 },
            makeAgentAssistantMessage({ content: [{ type: "text", text }], timestamp: 2 }),
          ],
        },
      });
      expect(result.ok).toBe(true);
      expect(published).toHaveLength(2);
      expect(published[0]).toMatchObject({
        message: { content: [{ type: "text", text: userText }] },
      });
      const current = scenario === "root admission" || scenario === "no root admission";
      expect(published[1]).toMatchObject({
        message: {
          content: [{ type: "text", text: current ? "Prepared\nMEDIA:./unowned.png" : text }],
        },
      });
      expect(prepare).toHaveBeenCalledTimes(current ? 1 : 0);
      const rows = await loadTranscriptEvents(target);
      expect(rows.at(-1)).toMatchObject({
        message: {
          content: [{ type: "text", text }],
          ...(current ? { openclawDelivery: { mediaUrls: ["./owned.png"] } } : {}),
        },
      });
    } finally {
      unsubscribe();
      if (store.validateTurnClaim(replacement ?? claim)) {
        await store.releaseTurn(replacement ?? claim);
      }
      releaseAgentRunDelegatedAuthority(authority);
      admission?.release();
    }
  },
);
