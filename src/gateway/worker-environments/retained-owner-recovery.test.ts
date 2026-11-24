import { expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import {
  bindSessionRepositoryWorkspaceBaseInDatabase,
  bindSessionRepositoryWorkspaceDiskInDatabase,
  createSessionRepositoryWorkspaceInDatabase,
  readSessionRepositoryWorkspaceInDatabase,
} from "../../state/session-repository-workspaces.kernel.js";
import { useStateDatabaseTempDirs } from "../../test-utils/state-database-temp-dirs.js";
import { requireCurrentWorkerTurnEnvironment } from "./admission.js";
import { find as findPlacement } from "./placement-row-codec.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import {
  advancePlacementFixtureToActive,
  createPlacementTurnClaimFixtureOps,
} from "./placement-test-fixtures.js";
import {
  restoreRetainedWorkerOwnerInDatabase,
  type RetainedWorkerOwnerRecoveryInput,
  type RetainedWorkerOwnerRecoverySource,
} from "./retained-owner-recovery.js";
import { findCredential, findWorkerEnvironment } from "./store-row-codec.js";
import { createWorkerEnvironmentStore } from "./store.js";
import { createWorkerEnvironmentStoreKernel } from "./store.kernel.js";
import { workerCredential, workerReadyPatch } from "./store.test-support.js";

const directories = useStateDatabaseTempDirs();
const identity = {
  sessionId: "retained-session",
  agentId: "main",
  sessionKey: "agent:main:retained",
};
const environmentId = "retained-environment";
const receipt = {
  version: 1 as const,
  leaseId: "retained-lease",
  identity: { diskId: "original-disk" },
};

async function fixture() {
  const options = { env: { OPENCLAW_STATE_DIR: directories.make("retained-owner-recovery-") } };
  let database = openOpenClawStateDatabase(options);
  const write = <T>(run: () => T) => runOpenClawStateWriteTransaction(run, { database });
  const environment = write(() => {
    const kernel = createWorkerEnvironmentStoreKernel(database, () => 1_000);
    kernel.createIntent({
      environmentId,
      providerId: "synthetic",
      profileId: "retained",
      profileSnapshot: { install: "bundle", settings: {} },
      provisionOperationId: "original-provision",
      retention: {
        version: 1,
        ownerBinding: "original-workspace-owner",
        computeWindowSeconds: 600,
      },
    });
    kernel.ensureNodeEnrollment(environmentId);
    kernel.transition({ environmentId, from: "requested", to: "provisioning" });
    kernel.recordResourceReceipt({
      environmentId,
      provisionOperationId: "original-provision",
      receipt,
    });
    kernel.transition({
      environmentId,
      from: "provisioning",
      to: "ready",
      patch: workerReadyPatch(receipt.leaseId, "original-node"),
    });
    const attached = kernel.transition({
      environmentId,
      from: "ready",
      to: "attached",
      patch: {
        attachedSessionIds: [identity.sessionId],
        credential: workerCredential("c".repeat(43), identity.sessionId),
      },
    });
    kernel.recordRetentionObservation({
      environmentId,
      expectedOwnerEpoch: attached.ownerEpoch,
      observation: {
        claimRevision: "original-revision",
        state: "running",
        computeExpiresAtMs: Number.MAX_SAFE_INTEGER,
      },
    });
    return kernel.setRetentionRuntimeAdmission({
      environmentId,
      expectedOwnerEpoch: attached.ownerEpoch,
      expectedClaimRevision: "original-revision",
      ready: true,
    });
  });
  const placements = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
  const placement = await advancePlacementFixtureToActive(placements, database, identity, {
    environmentId,
    ownerEpoch: environment.ownerEpoch,
    seedEnvironment: false,
  });
  const workspace = write(() => {
    const created = createSessionRepositoryWorkspaceInDatabase(
      database.db,
      { ...identity, url: "https://example.invalid/project.git" },
      1_000,
    ).workspace!;
    const based = bindSessionRepositoryWorkspaceBaseInDatabase(
      database.db,
      {
        workspaceId: created.workspaceId,
        expectedRevision: created.revision,
        baseCommit: "a".repeat(40),
        baseManifestHash: "sha256:" + "b".repeat(64),
      },
      1_000,
    ).workspace!;
    return bindSessionRepositoryWorkspaceDiskInDatabase(
      database.db,
      {
        workspaceId: based.workspaceId,
        expectedRevision: based.revision,
        diskAuthority: { environmentId, resourceReceipt: receipt },
      },
      1_000,
    ).workspace!;
  });
  const source: RetainedWorkerOwnerRecoverySource = {
    environment: findWorkerEnvironment(database.db, environmentId)!,
    placement,
    workspace,
    hasPendingWorkspaceResult:
      database.db
        .prepare("SELECT 1 FROM worker_workspace_pending_results WHERE session_id = ?")
        .get(identity.sessionId) !== undefined,
    hasPlacementMove:
      database.db
        .prepare("SELECT 1 FROM worker_session_placement_moves WHERE session_id = ?")
        .get(identity.sessionId) !== undefined,
    hasRunningToolOperation:
      database.db
        .prepare(
          "SELECT 1 FROM worker_session_tool_operations WHERE source_session_id = ? AND status = 'running'",
        )
        .get(identity.sessionId) !== undefined,
  };
  await closeOpenClawStateDatabaseAsync();
  database = openOpenClawStateDatabase(options);
  const current = () => ({
    environment: findWorkerEnvironment(database.db, environmentId) ?? null,
    placement: findPlacement(database.db, identity.sessionId) ?? null,
    workspace: readSessionRepositoryWorkspaceInDatabase(database.db, workspace.workspaceId) ?? null,
  });
  const restore = (input: Partial<RetainedWorkerOwnerRecoveryInput> = {}) =>
    write(() =>
      restoreRetainedWorkerOwnerInDatabase(
        database,
        { source, expected: current(), assertCurrent() {}, ...input },
        2_000,
      ),
    );
  return {
    get database() {
      return database;
    },
    source,
    current,
    restore,
    write,
    async reopen() {
      await closeOpenClawStateDatabaseAsync();
      database = openOpenClawStateDatabase(options);
    },
  };
}

it("restores missing retained dependencies, stays dormant across reopen and keeps exact disk custody", async () => {
  const f = await fixture();
  f.write(() => {
    f.database.db
      .prepare("DELETE FROM worker_session_placements WHERE session_id = ?")
      .run(identity.sessionId);
    f.database.db
      .prepare("DELETE FROM session_repository_workspaces WHERE workspace_id = ?")
      .run(f.source.workspace.workspaceId);
    f.database.db
      .prepare("DELETE FROM worker_environments WHERE environment_id = ?")
      .run(environmentId);
  });
  expect(f.current()).toEqual({ environment: null, placement: null, workspace: null });
  for (const field of [
    "hasPendingWorkspaceResult",
    "hasPlacementMove",
    "hasRunningToolOperation",
  ] as const) {
    expect(() => f.restore({ source: { ...f.source, [field]: true } })).toThrow(
      "quiescent retained repository owner",
    );
    expect(f.current()).toEqual({ environment: null, placement: null, workspace: null });
  }
  const restored = f.restore();
  await f.reopen();
  const current = f.current();
  expect(restored).toMatchObject({
    environmentId,
    ownerEpoch: f.source.environment.ownerEpoch,
    placementGeneration: f.source.placement.generation + 1,
  });
  expect(current.environment).toMatchObject({
    state: "attached",
    leaseId: receipt.leaseId,
    resourceReceipt: receipt,
    retention: { runtimeReady: false, policy: f.source.environment.retention!.policy },
    nodeSetupId: null,
    sshEndpoint: null,
    desktop: null,
    destroyRequestedAtMs: null,
  });
  expect(current.placement).toMatchObject({
    state: "active",
    turnClaim: null,
    generation: restored.placementGeneration,
  });
  expect(current.workspace?.diskAuthority).toEqual(f.source.workspace.diskAuthority);
  expect(() =>
    requireCurrentWorkerTurnEnvironment({
      environments: { get: () => current.environment ?? undefined },
      placement: f.source.placement,
    }),
  ).toThrow("does not match its attached environment");
  expect(findCredential(f.database.db, environmentId)).toBeUndefined();
  // The normal lifecycle still owns this row: terminal pruning cannot discard the retained disk.
  const store = await createWorkerEnvironmentStore({ database: f.database, now: () => 2_000 });
  expect(await store.pruneTerminalEnvironments({ nowMs: 100 * 86400_000 })).toBe(0);
  expect(store.get(environmentId)?.resourceReceipt).toEqual(receipt);
});

it("repairs only the selected stranded binding and rolls back stale authority or conflicting receipts", async () => {
  const f = await fixture();
  f.write(() =>
    f.database.db
      .prepare(
        "UPDATE session_repository_workspaces SET disk_authority_json = NULL WHERE workspace_id = ?",
      )
      .run(f.source.workspace.workspaceId),
  );
  const selected = f.current();
  let assertions = 0;
  expect(() =>
    f.restore({
      assertCurrent() {
        if (++assertions === 3) {
          throw new Error("offline custody revoked");
        }
      },
    }),
  ).toThrow("offline custody revoked");
  expect(f.current()).toEqual(selected);
  expect(findCredential(f.database.db, environmentId)).toBeDefined();
  expect(() =>
    f.restore({
      expected: {
        ...selected,
        environment: { ...selected.environment!, ownerEpoch: selected.environment!.ownerEpoch + 1 },
      },
    }),
  ).toThrow("selection changed");
  const conflictingReceipt = { ...receipt, identity: { diskId: "replacement-disk" } };
  const conflictingSource = {
    ...f.source,
    environment: { ...f.source.environment, resourceReceipt: conflictingReceipt },
    workspace: {
      ...f.source.workspace,
      diskAuthority: { environmentId, resourceReceipt: conflictingReceipt },
    },
  };
  expect(() => f.restore({ source: conflictingSource })).toThrow("different resource owner");
  expect(f.current()).toEqual(selected);
  expect(() =>
    f.restore({
      expected: {
        ...selected,
        workspace: { ...selected.workspace!, revision: selected.workspace!.revision + 1 },
      },
    }),
  ).toThrow("selection changed");
  expect(f.current()).toEqual(selected);
  const claims = createPlacementTurnClaimFixtureOps(f.database);
  const claim = claims.claimTurn({
    ...identity,
    claimId: "unfinished-claim",
    runId: "unfinished-run",
    owner: { kind: "worker", environmentId, ownerEpoch: f.source.environment.ownerEpoch },
  });
  const claimed = f.current();
  expect(() => f.restore()).toThrow("unfinished turn");
  expect(f.current()).toEqual(claimed);
  claims.releaseTurn(claim);
  f.restore();
  expect(f.current().workspace?.diskAuthority).toEqual(f.source.workspace.diskAuthority);
  expect(f.current().workspace?.revision).toBe(selected.workspace!.revision + 1);
  expect(findCredential(f.database.db, environmentId)).toBeUndefined();
  expect(f.current().environment?.retention?.runtimeReady).toBe(false);
  const repaired = f.current();
  expect(() => f.restore({ expected: selected })).toThrow("selection changed");
  expect(f.current()).toEqual(repaired);
});
