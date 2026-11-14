import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import * as operationAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { useStateDatabaseTempDirs } from "../../test-utils/state-database-temp-dirs.js";
import {
  identifiedClient,
  listSessions,
  requestContext,
  seedSessions,
} from "../server-methods/sessions-read-cache.test-support.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import {
  advancePlacementFixtureToActive,
  createEnvironmentStoreFixture,
} from "./placement-test-fixtures.js";
import { createWorkerEnvironmentStore } from "./store.js";

const SESSION = {
  sessionId: "session-placement",
  agentId: "main",
  sessionKey: "agent:main:placement",
};
const subscribe = (listener: Parameters<typeof sessionChanges.subscribe>[0]) =>
  onTestFinished(sessionChanges.subscribe(listener));

it.each(["reopen", "reconcile", "revoke"] as const)(
  "keeps session lists resident after a no-op %s",
  async (operation) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
      onTestFinished(() => clock.mockRestore());
      const database = openOpenClawStateDatabase();
      const store = await createWorkerEnvironmentStore({ database, now: () => 1_000 });
      const environmentId = "worker-unchanged";
      const { seedBootstrapping } = createEnvironmentStoreFixture({
        getStore: () => store,
        getDatabase: () => database,
        now: () => 1_000,
      });
      await seedBootstrapping(environmentId, "lease-unchanged");
      const host = {
        environmentId,
        state: "bootstrapping" as const,
        leaseId: "lease-unchanged",
        sharedHost: false,
      };
      await store.reconcileSharedHost(host);
      const context = requestContext(await seedSessions());
      const client = identifiedClient("owner@example.com");
      const request = { limit: 1, archived: "all" as const };
      const initial = await listSessions({ context, client, request });
      const projection = getSessionRowProjection(context)!;
      await projection.ensureMaterialized();
      const before = projection.materializedCount;
      const environment = store.get(environmentId);
      if (operation === "reopen") {
        await createWorkerEnvironmentStore({ database, now: () => 1_000 });
      } else if (operation === "reconcile") {
        await store.reconcileSharedHost(host);
      } else {
        await store.revokeEnvironmentCredential(environmentId);
      }
      expect(store.get(environmentId)).toEqual(environment);
      expect(projection.dirtyRowCount).toBe(0);
      const current = await listSessions({ context, client, request });
      expect(current.sessions).toEqual(initial.sessions);
      expect(current.totalCount).toBe(initial.totalCount);
      expect(projection.materializedCount).toBe(before);
    });
  },
);

describe("worker store session change publications", () => {
  let database: ReturnType<typeof openOpenClawStateDatabase>;
  const tempDirs = useStateDatabaseTempDirs();

  beforeEach(() => {
    const root = tempDirs.make("openclaw-worker-store-changes-");
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
  });

  it("publishes committed environment changes and discards rolled-back writes", async () => {
    const store = await createWorkerEnvironmentStore({ database, now: () => 1_000 });
    const publications: unknown[] = [];
    const committedState = database.db.prepare(
      "SELECT state FROM worker_environments WHERE environment_id = ?",
    );
    subscribe((change) => {
      if ("all" in change && change.scope === "worker-environments") {
        publications.push([database.db.isTransaction, committedState.get("worker-1")]);
      }
    });
    const intent = {
      ...SESSION,
      environmentId: "worker-1",
      providerId: "fake-provider",
      profileId: "test-profile",
      profileSnapshot: { settings: { region: "test" }, lifetime: { idleMinutes: 10 } },
      provisionOperationId: "provision:worker-1",
    };
    await store.createSessionAttachmentIntent(intent, () => {});
    const requested = [false, { state: "requested" }];
    expect(publications).toEqual([requested]);
    database.db.exec(`CREATE TRIGGER reject_environment_error
        AFTER UPDATE OF last_error ON worker_environments
        BEGIN SELECT RAISE(ABORT, 'rollback environment'); END`);
    await expect(
      store.recordError({ environmentId: "worker-1", state: "requested", error: "rollback" }),
    ).rejects.toThrow("rollback environment");
    database.db.exec("DROP TRIGGER reject_environment_error");
    expect(publications).toEqual([requested]);
    expect(store.get("worker-1")?.lastError).toBeNull();
    await store.closeSessionAttachment(SESSION.sessionId);
    expect(publications).toEqual([requested, requested]);
    await store.closeSessionAttachment(SESSION.sessionId);
    expect(publications).toEqual([requested, requested]);
    await store.transition({ environmentId: "worker-1", from: "requested", to: "failed" });
    expect(await store.pruneTerminalEnvironments({ nowMs: 8 * 24 * 60 * 60 * 1_000 })).toBe(1);
    expect(publications).toEqual([
      requested,
      requested,
      [false, { state: "failed" }],
      [false, undefined],
    ]);
  });

  it("publishes pending-only and conflict changes after their owner commits", async () => {
    const store = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
    const dispatch = { ...SESSION, executionMode: "remote-exec" as const };
    const active = await advancePlacementFixtureToActive(store, database, dispatch, {
      seedEnvironment: "before-dispatch",
    });
    const { environmentId, activeOwnerEpoch: ownerEpoch } = active;
    const claim = await store.claimWorkspaceMutationResult({
      ...SESSION,
      owner: { kind: "local", environmentId, ownerEpoch },
      claimId: "pending-row-change",
    });
    const authority = await store.prepareTurnClaimAuthority(claim);
    const previousObservation = await store.prepareRuntimeRefresh(claim.sessionId);
    previousObservation.release();
    const observation = await store.prepareRuntimeRefresh(claim.sessionId);
    onTestFinished(authority.release);
    onTestFinished(observation.release);
    const observed: Array<[reconciling: boolean, conflict: boolean, transaction: boolean]> = [];
    subscribe((change) => {
      if (
        "sessionKey" in change &&
        change.sessionKey === SESSION.sessionKey &&
        change.agentId === SESSION.agentId
      ) {
        observed.push([
          Boolean(store.preparedWorkspaceResult(claim)?.stagedResultRef),
          Boolean(store.get(SESSION.sessionId)?.workspaceResultConflict),
          database.db.isTransaction,
        ]);
      }
    });
    const ref = "refs/openclaw/worker-results/pending-row-change";
    let current = true;
    const assertCurrent = () => {
      if (!current) {
        throw new Error("rollback pending row");
      }
    };
    const isClaimCommit = (request: operationAdmission.SqliteWorkerAdmissionRequest) =>
      request.stage === "commit" &&
      isRecord(request.facts) &&
      isRecord(request.facts.placement) &&
      request.facts.placement.sessionId === claim.sessionId;
    const admission = probe.admission(operationAdmission, (request, grant, admit) => {
      if (isClaimCommit(request)) {
        expect(observed).toEqual([]);
        current = false;
      }
      admit(request, grant);
    });
    await expect(
      store.recordStagedWorkspaceResult(claim, ref, undefined, assertCurrent),
    ).rejects.toThrow("rollback pending row");
    admission.mockRestore();
    expect(observed).toEqual([]);
    expect(await store.listPendingWorkspaceResultsAsync()).toMatchObject([
      { stagedResultRef: null },
    ]);
    expect(authority.isCurrent()).toBe(true);
    expect(() => observation.assertCurrent()).not.toThrow();
    let checkedCommit = false;
    const successfulAdmission = probe.admission(operationAdmission, (request, grant, admit) => {
      admit(request, () => {
        if (isClaimCommit(request)) {
          checkedCommit = true;
          expect(authority.isCurrent()).toBe(true);
          expect(() => observation.assertCurrent()).toThrow("placement authority changed");
          expect(observed).toEqual([]);
        }
        return grant();
      });
    });
    await store.recordStagedWorkspaceResult(claim, ref);
    successfulAdmission.mockRestore();
    expect(checkedCommit).toBe(true);
    expect(authority.isCurrent()).toBe(true);
    expect(() => observation.assertCurrent()).toThrow("placement authority changed");
    expect(observed.at(-1)).toEqual([true, false, false]);
    store.recordWorkspaceResultConflict(claim, { paths: ["conflict.txt"], stagedResultRef: ref });
    expect(observed.at(-1)).toEqual([true, true, false]);
    store.recordWorkspaceResultConflict(claim, undefined);
    expect(observed.at(-1)).toEqual([true, false, false]);
    await store.acceptWorkspaceResult(claim);
    await store.completeWorkspaceResultAndReleaseTurn(claim);
    expect(observed.at(-1)).toEqual([false, false, false]);
  });
});
