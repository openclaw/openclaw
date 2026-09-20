import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  identifiedClient,
  listSessions,
  requestContext,
  seedSessions,
} from "../server-methods/sessions-read-cache.test-support.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { seedAttachedPlacementEnvironment } from "./placement-test-fixtures.js";
import { createWorkerEnvironmentStore } from "./store.js";

const SESSION = {
  sessionId: "session-placement",
  agentId: "main",
  sessionKey: "agent:main:placement",
};
const DAY_MS = 24 * 60 * 60 * 1_000;

it.each(["reopening the store", "reconciling an unchanged host"] as const)(
  "keeps session lists resident when %s changes no environment rows",
  async (operation) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
      onTestFinished(() => clock.mockRestore());
      const database = openOpenClawStateDatabase();
      const store = createWorkerEnvironmentStore({ database, now: () => 1_000 });
      const environmentId = "worker-unchanged";
      store.createIntent({
        environmentId,
        providerId: "fake-provider",
        profileId: "test-profile",
        profileSnapshot: { settings: {}, lifetime: { idleMinutes: 10 } },
        provisionOperationId: `provision:${environmentId}`,
      });
      store.transition({ environmentId, from: "requested", to: "provisioning" });
      store.transition({
        environmentId,
        from: "provisioning",
        to: "bootstrapping",
        patch: {
          leaseId: "lease-unchanged",
          sharedHost: false,
          sshEndpoint: {
            host: "worker.example.test",
            port: 22,
            user: "openclaw",
            hostKey: "ssh-ed25519 AAAA",
            keyRef: { source: "file", provider: "worker-keys", id: "/test-key" },
          },
        },
      });
      const context = requestContext(await seedSessions());
      const client = identifiedClient("owner@example.com");
      const request = { limit: 1, archived: "all" as const };
      const initial = await listSessions({ context, client, request });
      const projection = getSessionRowProjection(context)!;
      const before = projection.materializedCount;
      const environment = store.get(environmentId);
      if (operation === "reopening the store") {
        createWorkerEnvironmentStore({ database, now: () => 1_000 });
      } else {
        store.reconcileSharedHost({
          environmentId,
          state: "bootstrapping",
          leaseId: "lease-unchanged",
          sharedHost: false,
        });
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
  let database: OpenClawStateDatabase;
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(() => {
      closeOpenClawStateDatabaseForTest();
      cleanup();
    }),
  );

  beforeEach(() => {
    const root = tempDirs.make("openclaw-worker-store-changes-");
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
  });

  it("publishes committed environment changes and discards rolled-back writes", () => {
    const store = createWorkerEnvironmentStore({ database, now: () => 1_000 });
    const transactions: boolean[] = [];
    const unsubscribe = sessionChanges.subscribe((change) => {
      if ("all" in change && change.scope === "worker-environments") {
        transactions.push(database.db.isTransaction);
      }
    });
    try {
      runOpenClawStateWriteTransaction(
        () => {
          store.createIntent({
            environmentId: "worker-1",
            providerId: "fake-provider",
            profileId: "test-profile",
            profileSnapshot: { settings: { region: "test" }, lifetime: { idleMinutes: 10 } },
            provisionOperationId: "provision:worker-1",
          });
          expect(transactions).toEqual([]);
        },
        { database },
      );
      expect(transactions).toEqual([false]);
      expect(() =>
        runOpenClawStateWriteTransaction(
          () => {
            store.recordError({ environmentId: "worker-1", state: "requested", error: "rollback" });
            throw new Error("rollback environment");
          },
          { database },
        ),
      ).toThrow("rollback environment");
      expect(transactions).toEqual([false]);
      store.transition({ environmentId: "worker-1", from: "requested", to: "failed" });
      expect(store.pruneTerminalEnvironments({ nowMs: 8 * DAY_MS })).toBe(1);
      expect(transactions).toEqual([false, false, false]);
    } finally {
      unsubscribe();
    }
  });

  it("publishes pending-only and conflict changes after their owner commits", () => {
    const store = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
    seedAttachedPlacementEnvironment(database, {
      environmentId: `environment-${SESSION.sessionId}`,
      sessionId: SESSION.sessionId,
      ownerEpoch: 7,
    });
    let active = store.startDispatch({ ...SESSION, executionMode: "remote-exec" });
    for (const step of [
      { to: "provisioning", patch: { environmentId: `environment-${SESSION.sessionId}` } },
      { to: "syncing", patch: { workerBundleHash: "a".repeat(64) } },
      {
        to: "starting",
        patch: {
          workspaceBaseManifestRef: `sha256:${"b".repeat(64)}`,
          remoteWorkspaceDir: `/workspace/${SESSION.sessionId}`,
        },
      },
      { to: "active", patch: { activeOwnerEpoch: 7 } },
    ] as const) {
      active = store.transition({
        sessionId: SESSION.sessionId,
        from: active.state,
        expectedGeneration: active.generation,
        ...step,
      });
    }
    if (active.state !== "active") {
      throw new Error("expected active worker placement");
    }
    const claim = store.claimWorkspaceMutationResult({
      ...SESSION,
      owner: {
        kind: "local",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
      claimId: "pending-row-change",
    });
    const observed: Array<{ reconciling: boolean; conflict: boolean; transaction: boolean }> = [];
    onTestFinished(
      sessionChanges.subscribe((change) => {
        if (
          "sessionKey" in change &&
          change.sessionKey === SESSION.sessionKey &&
          change.agentId === SESSION.agentId
        ) {
          observed.push({
            reconciling: store
              .getWorkspaceResultReconcilingSessionIds([SESSION.sessionId])
              .has(SESSION.sessionId),
            conflict: Boolean(store.get(SESSION.sessionId)?.workspaceResultConflict),
            transaction: database.db.isTransaction,
          });
        }
      }),
    );
    const ref = "refs/openclaw/worker-results/pending-row-change";
    expect(() =>
      runOpenClawStateWriteTransaction(
        () => {
          store.recordStagedWorkspaceResult(claim, ref);
          expect(observed).toEqual([]);
          throw new Error("rollback pending row");
        },
        { database },
      ),
    ).toThrow("rollback pending row");
    expect(observed).toEqual([]);
    store.recordStagedWorkspaceResult(claim, ref);
    expect(observed.at(-1)).toEqual({ reconciling: true, conflict: false, transaction: false });
    store.recordWorkspaceResultConflict(claim, { paths: ["conflict.txt"], stagedResultRef: ref });
    expect(observed.at(-1)).toEqual({ reconciling: true, conflict: true, transaction: false });
    store.recordWorkspaceResultConflict(claim, undefined);
    expect(observed.at(-1)).toEqual({ reconciling: true, conflict: false, transaction: false });
    store.acceptWorkspaceResult(claim);
    store.completeWorkspaceResultAndReleaseTurn(claim);
    expect(observed.at(-1)).toEqual({ reconciling: false, conflict: false, transaction: false });
  });
});
