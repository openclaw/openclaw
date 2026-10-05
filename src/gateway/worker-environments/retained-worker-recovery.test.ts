import { createHash } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  appendSessionTranscriptReport,
  loadTranscriptEvents,
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { createSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { chatHistoryHandlers } from "../server-methods/chat-history-handler.js";
import { createHistoryReadContext } from "../server-methods/chat-history.test-helpers.js";
import { identifiedClient } from "../server-methods/sessions-read-cache.test-support.js";
import type { RespondFn } from "../server-methods/types.js";
import { createWorkerWorkspaceConflictTranscriptHandlers } from "../worker-workspace-conflict-transcript.js";
import { REQUEST, MANIFEST_REF, seedActivePlacement } from "./placement-dispatch-test-fixtures.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { createRetainedRecoveryFixture as fixture } from "./retained-worker-recovery.test-support.js";
import * as support from "./service.test-support.js";
import { createWorkerEnvironmentStore } from "./store.js";

describe("retained failed-worker recovery", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("post-RCA cleanup preserves the visible accepted checkpoint and logical hold through automatic reconciliation and reopen", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const f = await fixture();
      const target = {
        agentId: REQUEST.agentId,
        sessionKey: REQUEST.sessionKey,
        sessionId: REQUEST.sessionId,
        storePath: resolveOpenClawAgentSqlitePath({ agentId: REQUEST.agentId, env: state.env }),
        env: state.env,
      };
      await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
      await appendSessionTranscriptReport(target, {
        kind: "custom",
        customTypes: ["cloud-worker-retained"],
        selectReport: () => ({
          customType: "cloud-worker-retained",
          content: "The previous worker is retained; checkpoint unknown.",
          display: true,
          details: { environmentId: f.failed.environmentId, unacceptedChanges: "unknown" },
        }),
      });
      const handlers = createWorkerWorkspaceConflictTranscriptHandlers(target, () => {});
      f.reportRetention.mockImplementation(handlers.reportRetention);
      const result = await f.recovery.recover(f.failed, { assertCurrent: () => {} });
      expect(result).toMatchObject({
        state: "reclaimed",
        sessionId: REQUEST.sessionId,
        environmentId: f.failed.environmentId,
        generation: f.failed.generation + 1,
      });
      expect(f.environments.get(f.failed.environmentId!)).toMatchObject({
        state: "orphaned",
        leaseId: "lease:worker-retained-source",
        recoveryHold: {
          phase: "reconciled",
          previousCheckpointRef: "refs/openclaw/worker-results/accepted-old",
          remoteHeadCommit: "d".repeat(40),
        },
      });
      expect(support.testState.store.getCredential(f.failed.environmentId!)).toBeUndefined();
      expect((await f.repositories.get(f.repository.workspaceId))?.checkpointRef).toBe(
        "refs/openclaw/worker-results/reconciled-new",
      );
      const projectKey = "e".repeat(64);
      for (let index = 0; index < 4; index++) {
        const reserve = await support.testState.store.ensurePreparedIntent({
          intent: {
            environmentId: `fresh-reserve-${index}`,
            providerId: "test-provider",
            profileId: "development",
            provisionOperationId: `fresh-provision-${index}`,
            profileSnapshot: {
              settings: {},
              executionMode: "remote-exec",
              project: { key: projectKey, root: "/project", baseCommit: "a".repeat(40) },
            },
            preparation: {
              purpose: "reserve",
              key: "f".repeat(64),
              demandAtMs: support.testState.nowMs,
              expiresAtMs: support.testState.nowMs + 10_000,
            },
          },
          projectKey,
          target: 3,
          maxTotal: 3,
          assertCurrent: () => {},
        });
        if (index < 3) {
          expect(reserve?.state).toBe("requested");
        } else {
          expect(reserve).toBeUndefined();
        }
      }
      expect(f.environments.readRecoveryHold(REQUEST.sessionId)?.phase).toBe("reconciled");
      expect(f.destroy).not.toHaveBeenCalled();
      expect(f.reportRetention).toHaveBeenCalledOnce();
      await handlers.reportRetention(f.reportRetention.mock.calls[0]![0]);
      await closeOpenClawAgentDatabasesAsync();
      const retainedReports = (await loadTranscriptEvents(target)).filter(
        (event) =>
          isRecord(event) &&
          event.type === "custom_message" &&
          event.customType === "cloud-worker-retained",
      );
      expect(retainedReports).toHaveLength(2);
      expect(retainedReports.at(-1)).toMatchObject({
        display: true,
        content: expect.stringContaining("refs/openclaw/worker-results/reconciled-new"),
        details: {
          environmentId: f.failed.environmentId,
          previousCheckpointRef: "refs/openclaw/worker-results/accepted-old",
          checkpointRef: "refs/openclaw/worker-results/reconciled-new",
          manifestHash: `sha256:${"c".repeat(64)}`,
          unacceptedChanges: "unknown",
        },
      });
      expect(retainedReports.at(-1)).toMatchObject({
        content: expect.stringContaining("refs/openclaw/worker-results/accepted-old"),
      });
      const context = await createHistoryReadContext();
      const client = identifiedClient("checkpoint-reader");
      client.connect.scopes = ["operator.admin"];
      const respond = vi.fn<RespondFn>();
      await expectDefined(
        chatHistoryHandlers["chat.history"],
        "history handler",
      )({
        params: { agentId: target.agentId, sessionKey: target.sessionKey },
        req: { type: "req", id: "retained-checkpoint-history", method: "chat.history" },
        context,
        client,
        respond,
        isWebchatConnect: () => true,
      });
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          sessionId: target.sessionId,
          messages: expect.arrayContaining([
            expect.objectContaining({
              role: "custom",
              customType: "cloud-worker-retained",
              content: expect.stringContaining("refs/openclaw/worker-results/reconciled-new"),
            }),
          ]),
        }),
      );
      expect(f.reportConflict).toHaveBeenCalledWith({
        paths: ["conflicting-accepted-edit.txt"],
        totalCount: 1,
        stagedResultRef: "refs/openclaw/worker-results/accepted-old",
      });
      await upsertSessionEntryCore(target, {
        sessionId: target.sessionId,
        updatedAt: 2,
        goalPauseOrigin: "recovery-hold",
        mainRestartRecovery: {
          cycleId: "paused-cycle",
          revision: 1,
          chargedAttempts: 0,
          pause: { reason: "unverifiable-external-effect", pausedAtMs: 2 },
        },
      });
      const logicalHold = loadSessionEntry(target);
      await f.environments.reconcileOnce();
      expect(f.destroy).toHaveBeenCalledOnce();
      expect(f.retireNodeEnrollment).toHaveBeenCalledOnce();
      expect(f.destroy).toHaveBeenCalledWith(
        expect.objectContaining({ leaseId: "lease:worker-retained-source" }),
      );
      expect(f.environments.get(f.failed.environmentId!)).toMatchObject({
        state: "destroyed",
        recoveryHold: {
          diagnostic: {
            origin: "failed-placement",
            cause: "unverified",
            failureHash: createHash("sha256")
              .update("worker node disconnected; VM absent")
              .digest("hex"),
          },
          cleanup: { requestedAtMs: expect.any(Number), settledAtMs: expect.any(Number) },
        },
      });
      expect(f.environments.readRecoveryHold(REQUEST.sessionId)).toBeUndefined();
      expect(loadSessionEntry(target)).toEqual(logicalHold);
      expect((await f.repositories.get(f.repository.workspaceId))?.checkpointRef).toBe(
        "refs/openclaw/worker-results/reconciled-new",
      );
      await f.environments.stop();
      const reopened = await createWorkerEnvironmentStore({ database: support.testState.stateDb });
      try {
        expect(reopened.get(f.failed.environmentId!)?.recoveryHold?.phase).toBe("reconciled");
        expect(
          reopened.get(f.failed.environmentId!)?.recoveryHold?.cleanup?.settledAtMs,
        ).toBeDefined();
      } finally {
        await reopened.close();
      }
      const durable = createWorkerSessionPlacementStore({
        database: support.testState.stateDb,
      }).get(REQUEST.sessionId);
      expect(durable?.state).toBe("reclaimed");
    });
  });

  it("post-RCA cleanup keeps uncertain exact custody through restart and settles only through the same canonical owner", async () => {
    const f = await fixture();
    await f.recovery.recover(f.failed, { assertCurrent: () => {} });
    const before = f.environments.get(f.failed.environmentId!)!.recoveryHold!;
    f.destroy.mockRejectedValueOnce(new Error("provider cleanup reply lost"));
    await f.environments.reconcileOnce();
    expect(f.destroy).toHaveBeenCalledOnce();
    expect(f.environments.get(f.failed.environmentId!)).toMatchObject({
      state: "destroying",
      recoveryHold: {
        receipt: before.receipt,
        diagnostic: before.diagnostic,
        cleanup: { requestedAtMs: expect.any(Number) },
      },
    });
    expect(
      f.environments.get(f.failed.environmentId!)?.recoveryHold?.cleanup?.settledAtMs,
    ).toBeUndefined();
    expect(f.environments.readRecoveryHold(REQUEST.sessionId)?.environmentId).toBe(
      f.failed.environmentId,
    );
    await support.reopenWorkerEnvironmentStore();
    const service = support.createService(support.createProvider({ destroy: f.destroy }));
    await service.reconcileOnce();
    expect(f.destroy).toHaveBeenCalledTimes(2);
    expect(service.get(f.failed.environmentId!)).toMatchObject({
      state: "destroyed",
      recoveryHold: {
        receipt: before.receipt,
        diagnostic: before.diagnostic,
        cleanup: { settledAtMs: expect.any(Number) },
      },
    });
    await service.reconcileOnce();
    expect(f.destroy).toHaveBeenCalledTimes(2);
    expect(service.readRecoveryHold(REQUEST.sessionId)).toBeUndefined();
  });

  it.each([
    "missing RCA",
    "compute retained",
    "shared owner",
    "changed epoch",
    "active old claim",
    "unaccepted checkpoint",
    "changed SID",
    "changed checkpoint",
    "unresolved result",
    "malformed settlement",
  ])("post-RCA cleanup denies %s before any provider effect", async (change) => {
    const f = await fixture();
    await f.recovery.recover(f.failed, { assertCurrent: () => {} });
    await f.environments.stop();
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        const capturedHold = f.environments.get(f.failed.environmentId!)?.recoveryHold;
        const hold = capturedHold ? structuredClone(capturedHold) : undefined;
        if (!hold || hold.kind === "prepared") {
          throw new Error("missing session custody fixture");
        }
        if (change === "missing RCA") {
          delete hold.diagnostic;
        }
        if (change === "compute retained") {
          const vm = hold.receipt!.resources[0]!;
          vm.state = "retained";
          vm.immutableId = "original-vm";
        }
        if (change === "changed SID") {
          hold.sessionId = "changed-session";
        }
        if (change === "changed checkpoint") {
          hold.checkpointRef = "refs/openclaw/worker-results/unaccepted";
        }
        if (change === "unaccepted checkpoint") {
          hold.phase = "held";
        }
        if (change === "malformed settlement") {
          Object.defineProperty(hold, "cleanup", {
            value: { requestedAtMs: support.testState.nowMs, settledAtMs: "unverified" },
            enumerable: true,
          });
        }
        db.prepare(
          "UPDATE worker_environment_recovery_holds SET hold_json = ? WHERE environment_id = ?",
        ).run(JSON.stringify(hold), f.failed.environmentId!);
        if (change === "shared owner") {
          db.prepare("UPDATE worker_environments SET shared_host = 1 WHERE environment_id = ?").run(
            f.failed.environmentId!,
          );
        }
        if (change === "changed epoch") {
          db.prepare(
            "UPDATE worker_environments SET owner_epoch = owner_epoch + 1 WHERE environment_id = ?",
          ).run(f.failed.environmentId!);
        }
        if (change === "active old claim") {
          db.prepare(
            "UPDATE worker_session_placements SET state = 'active', turn_claim_id = ?, turn_claim_owner = 'local', turn_claim_run_id = 'old-run', turn_claim_generation = transition_generation, turn_claim_owner_epoch = NULL WHERE session_id = ?",
          ).run("late-old-claim", REQUEST.sessionId);
        }
        if (change === "unresolved result") {
          db.prepare(
            "INSERT INTO worker_workspace_pending_results (session_id, environment_id, owner_epoch, placement_generation, claim_id, run_id, gateway_instance_id, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          ).run(
            REQUEST.sessionId,
            f.failed.environmentId!,
            hold.ownerEpoch,
            hold.placementGeneration,
            "old-claim",
            "old-run",
            "old-gateway",
            1,
          );
        }
      },
      { database: support.testState.stateDb },
    );
    await support.reopenWorkerEnvironmentStore();
    const service = support.createService(support.createProvider({ destroy: f.destroy }));
    if (change === "malformed settlement") {
      expect(service.readRecoveryHold(REQUEST.sessionId)).toMatchObject({
        environmentId: f.failed.environmentId,
        sessionId: REQUEST.sessionId,
        cleanup: { requestedAtMs: support.testState.nowMs, settledAtMs: "unverified" },
      });
    }
    await service.reconcileOnce();
    expect(f.destroy).not.toHaveBeenCalled();
    expect(service.get(f.failed.environmentId!)).toMatchObject({
      state: "orphaned",
      recoveryHold: { receipt: expect.any(Object) },
    });
    if (change !== "malformed settlement") {
      expect(service.get(f.failed.environmentId!)?.recoveryHold?.cleanup).toBeUndefined();
    }
    expect(
      (
        await createSessionRepositoryWorkspaceStore({ path: support.testState.stateDb.path }).get(
          f.repository.workspaceId,
        )
      )?.checkpointRef,
    ).toBe("refs/openclaw/worker-results/reconciled-new");
  });

  it("post-RCA cleanup does not replay settled provider disposal while enrollment retirement remains uncertain", async () => {
    const f = await fixture();
    await f.recovery.recover(f.failed, { assertCurrent: () => {} });
    f.retireNodeEnrollment.mockRejectedValueOnce(new Error("node retirement reply lost"));
    await f.environments.reconcileOnce();
    expect(f.destroy).toHaveBeenCalledOnce();
    expect(f.retireNodeEnrollment).toHaveBeenCalledOnce();
    const held = f.environments.get(f.failed.environmentId!)!;
    expect(held).toMatchObject({
      state: "destroying",
      recoveryHold: { cleanup: { providerReleasedAtMs: expect.any(Number) } },
    });
    expect(held.recoveryHold?.cleanup?.settledAtMs).toBeUndefined();
    expect(f.environments.readRecoveryHold(REQUEST.sessionId)?.environmentId).toBe(
      f.failed.environmentId,
    );
    await support.reopenWorkerEnvironmentStore();
    const service = support.createService(support.createProvider({ destroy: f.destroy }), {
      retireNodeEnrollment: f.retireNodeEnrollment,
    });
    await service.reconcileOnce();
    expect(f.destroy).toHaveBeenCalledOnce();
    expect(f.retireNodeEnrollment).toHaveBeenCalledTimes(2);
    expect(service.get(f.failed.environmentId!)).toMatchObject({
      state: "destroyed",
      recoveryHold: {
        cleanup: {
          providerReleasedAtMs: held.recoveryHold!.cleanup!.providerReleasedAtMs,
          settledAtMs: expect.any(Number),
        },
      },
    });
    expect(service.readRecoveryHold(REQUEST.sessionId)).toBeUndefined();
  });

  it("present-compute recovery keeps its failed placement and accepted checkpoint until exact provider settlement", async () => {
    const f = await fixture(true);
    const entered = createDeferred();
    const release = createDeferred();
    f.destroy.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
    });
    const recovering = f.recovery.recover(f.failed, { assertCurrent: () => {} });
    try {
      await entered.promise;
      expect(f.placements.get(REQUEST.sessionId)).toMatchObject({
        state: "failed",
        generation: f.failed.generation,
      });
      expect((await f.repositories.get(f.repository.workspaceId))?.checkpointRef).toBe(
        "refs/openclaw/worker-results/accepted-old",
      );
      expect(f.environments.readRecoveryHold(REQUEST.sessionId)).toMatchObject({
        phase: "disposal-pending",
        disposalCheckpoint: {
          previousCheckpointRef: "refs/openclaw/worker-results/accepted-old",
          checkpointRef: "refs/openclaw/worker-results/reconciled-new",
        },
        diagnostic: { cause: "unverified" },
      });
      expect(f.environments.readRecoveryHold(REQUEST.sessionId)?.receipt).toBeUndefined();
      expect(f.retireNodeEnrollment).not.toHaveBeenCalled();
    } finally {
      release.resolve();
    }
    await expect(recovering).resolves.toMatchObject({
      state: "reclaimed",
      sessionId: REQUEST.sessionId,
      generation: f.failed.generation + 1,
    });
    expect(f.destroy).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ leaseId: "lease:worker-retained-source" }),
    );
    expect(f.retireNodeEnrollment).toHaveBeenCalledOnce();
    expect((await f.repositories.get(f.repository.workspaceId))?.checkpointRef).toBe(
      "refs/openclaw/worker-results/reconciled-new",
    );
  });

  it("present-compute recovery reconciles uncertain teardown after reopen without allocating or committing a premature checkpoint", async () => {
    const f = await fixture(true);
    f.destroy.mockRejectedValueOnce(new Error("provider teardown outcome unknown"));
    await expect(f.recovery.recover(f.failed, { assertCurrent: () => {} })).rejects.toThrow(
      "outcome unknown",
    );
    expect(f.placements.get(REQUEST.sessionId)?.state).toBe("failed");
    const pending = f.environments.readRecoveryHold(REQUEST.sessionId);
    expect(pending).toMatchObject({
      phase: "disposal-pending",
      diagnostic: { cause: "unverified" },
    });
    expect(pending?.cleanup?.settledAtMs).toBeUndefined();
    await support.reopenWorkerEnvironmentStore();
    const service = support.createService(support.createProvider({ destroy: f.destroy }), {
      retireNodeEnrollment: f.retireNodeEnrollment,
    });
    await service.reconcileOnce();
    const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
    const repositories = createSessionRepositoryWorkspaceStore({
      path: support.testState.stateDb.path,
    });
    expect(placements.get(REQUEST.sessionId)?.state).toBe("failed");
    expect((await repositories.get(f.repository.workspaceId))?.checkpointRef).toBe(
      "refs/openclaw/worker-results/accepted-old",
    );
    expect(service.get(f.failed.environmentId!)).toMatchObject({
      state: "destroyed",
      recoveryHold: {
        disposalCheckpoint: pending?.disposalCheckpoint,
        cleanup: { settledAtMs: expect.any(Number) },
      },
    });
    const checkpoint = expectDefined(pending?.disposalCheckpoint, "staged checkpoint");
    await expect(
      service.acceptRetainedRecovery({
        ...checkpoint,
        checkpointRef: "refs/openclaw/worker-results/substituted",
        environmentId: f.failed.environmentId!,
        sessionId: REQUEST.sessionId,
        placementGeneration: f.failed.generation,
        assertCurrent: () => {},
      }),
    ).rejects.toThrow("Staged worker checkpoint custody changed");
    expect(placements.get(REQUEST.sessionId)?.state).toBe("failed");
    await expect(
      service.acceptRetainedRecovery({
        ...checkpoint,
        environmentId: f.failed.environmentId!,
        sessionId: REQUEST.sessionId,
        placementGeneration: f.failed.generation,
        assertCurrent: () => {},
      }),
    ).resolves.toMatchObject({
      state: "reclaimed",
      sessionId: REQUEST.sessionId,
      generation: f.failed.generation + 1,
    });
    expect(f.destroy).toHaveBeenCalledTimes(2);
    await service.reconcileOnce();
    expect(f.destroy).toHaveBeenCalledTimes(2);
  });

  it("present-compute recovery checks original authority again after physical disposal before logical cutover", async () => {
    const f = await fixture(true);
    let current = true;
    f.destroy.mockImplementationOnce(async () => {
      current = false;
    });
    const assertCurrent = () => {
      if (!current) {
        throw new Error("original issuer revoked");
      }
    };
    await expect(f.recovery.recover(f.failed, { assertCurrent })).rejects.toThrow(
      "original issuer revoked",
    );
    expect(f.environments.get(f.failed.environmentId!)).toMatchObject({
      state: "destroyed",
      recoveryHold: { cleanup: { settledAtMs: expect.any(Number) } },
    });
    expect(f.placements.get(REQUEST.sessionId)?.state).toBe("failed");
    expect((await f.repositories.get(f.repository.workspaceId))?.checkpointRef).toBe(
      "refs/openclaw/worker-results/accepted-old",
    );
  });

  it("bounds another retained source for the same session before calling its provider", async () => {
    const f = await fixture();
    await f.recovery.recover(f.failed, { assertCurrent: () => {} });
    const environmentId = "worker-second-source";
    await support.seedReadyNodeDesktop(environmentId);
    const attached = await support.testState.store.transition({
      environmentId,
      from: "ready",
      to: "attached",
      patch: { ...support.attachedPatch(environmentId, REQUEST.sessionId), sharedHost: false },
    });
    const active = await seedActivePlacement(f.placements, {
      environmentId,
      ownerEpoch: attached.ownerEpoch,
      executionMode: "remote-exec",
    });
    const draining = await f.placements.startDrain({
      sessionId: REQUEST.sessionId,
      environmentId,
      ownerEpoch: attached.ownerEpoch,
      expectedGeneration: active.generation,
    });
    const reconciling = await f.placements.startReconcile({
      sessionId: REQUEST.sessionId,
      environmentId,
      ownerEpoch: attached.ownerEpoch,
      expectedGeneration: draining.generation,
    });
    const failed = await f.placements.fail({
      sessionId: REQUEST.sessionId,
      expectedGeneration: reconciling.generation,
      recoveryError: "second worker disconnected",
    });
    if (failed.state !== "failed") {
      throw new Error("Second source fixture did not fail");
    }
    await expect(f.recovery.recover(failed, { assertCurrent: () => {} })).rejects.toThrow(
      "already has an unresolved retained worker",
    );
    expect(f.holdFailedLease).toHaveBeenCalledOnce();
    expect(f.environments.readRecoveryHold(REQUEST.sessionId)?.environmentId).toBe(
      f.failed.environmentId,
    );
    expect(f.destroy).not.toHaveBeenCalled();
  });

  it("refuses full retained capacity without adding destructive intent or revoking the rejected source", async () => {
    const f = await fixture();
    await f.recovery.recover(f.failed, { assertCurrent: () => {} });
    support.testState.config.cloudWorkers!.preparedPool = { maxTotal: 1 };
    const identity = {
      sessionId: "another-session",
      sessionKey: "agent:main:another-session",
      agentId: "main",
      executionMode: "remote-exec" as const,
    };
    const environmentId = "another-failed-worker";
    await support.seedReadyNodeDesktop(environmentId);
    const attached = await support.testState.store.transition({
      environmentId,
      from: "ready",
      to: "attached",
      patch: { ...support.attachedPatch(environmentId, identity.sessionId), sharedHost: false },
    });
    let placement = await f.placements.startDispatch(identity);
    placement = await f.placements.transition({
      sessionId: identity.sessionId,
      from: "requested",
      to: "provisioning",
      expectedGeneration: placement.generation,
      patch: { environmentId },
    });
    placement = await f.placements.transition({
      sessionId: identity.sessionId,
      from: "provisioning",
      to: "syncing",
      expectedGeneration: placement.generation,
      patch: { workerBundleHash: support.BUNDLE_HASH },
    });
    placement = await f.placements.transition({
      sessionId: identity.sessionId,
      from: "syncing",
      to: "starting",
      expectedGeneration: placement.generation,
      patch: { workspaceBaseManifestRef: MANIFEST_REF, remoteWorkspaceDir: "/worker/workspace" },
    });
    placement = await f.placements.transition({
      sessionId: identity.sessionId,
      from: "starting",
      to: "active",
      expectedGeneration: placement.generation,
      patch: { activeOwnerEpoch: attached.ownerEpoch },
    });
    const draining = await f.placements.startDrain({
      sessionId: identity.sessionId,
      environmentId,
      ownerEpoch: attached.ownerEpoch,
      expectedGeneration: placement.generation,
    });
    const reconciling = await f.placements.startReconcile({
      sessionId: identity.sessionId,
      environmentId,
      ownerEpoch: attached.ownerEpoch,
      expectedGeneration: draining.generation,
    });
    const failed = await f.placements.fail({
      sessionId: identity.sessionId,
      expectedGeneration: reconciling.generation,
      recoveryError: "worker lost at full capacity",
    });
    const sourceBefore = support.testState.store.get(environmentId);
    const credential = support.testState.store.getCredential(environmentId);
    await expect(
      f.environments.holdFailedEnvironment!(
        {
          ...identity,
          environmentId,
          ownerEpoch: attached.ownerEpoch,
          placementGeneration: failed.generation,
        },
        () => {},
      ),
    ).rejects.toThrow("Retained worker capacity is full");
    expect(support.testState.store.get(environmentId)).toEqual(sourceBefore);
    expect(support.testState.store.getCredential(environmentId)).toEqual(credential);
    expect(f.holdFailedLease).toHaveBeenCalledOnce();
    expect(f.destroy).not.toHaveBeenCalled();
  });

  it("keeps checkpoint acceptance closed when authority is revoked during reconciliation", async () => {
    const f = await fixture();
    let authorized = true;
    const assertCurrent = () => {
      if (!authorized) {
        throw new Error("operator authority revoked");
      }
    };
    f.prepareCheckpoint.mockImplementationOnce(async () => {
      authorized = false;
      return {
        workspaceId: f.repository.workspaceId,
        expectedWorkspaceRevision: f.repository.revision,
        previousCheckpointRef: f.repository.checkpointRef!,
        checkpointRef: "refs/openclaw/worker-results/reconciled-new",
        manifestHash: `sha256:${"c".repeat(64)}`,
        remoteHeadCommit: "d".repeat(40),
      };
    });
    await expect(f.recovery.recover(f.failed, { assertCurrent })).rejects.toThrow(
      "authority revoked",
    );
    expect(f.placements.get(REQUEST.sessionId)?.state).toBe("failed");
    expect((await f.repositories.get(f.repository.workspaceId))?.checkpointRef).toBe(
      "refs/openclaw/worker-results/accepted-old",
    );
    expect(f.environments.readRecoveryHold(REQUEST.sessionId)?.phase).toBe("held");
    expect(f.destroy).not.toHaveBeenCalled();
  });
});
