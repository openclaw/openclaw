import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { useStateDatabaseTempDirs } from "../../test-utils/state-database-temp-dirs.js";
import { MANIFEST_REF, type PlacementStore, REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createHarness as createPlacementHarness } from "./placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import type { WorkspaceResultConflictLookup } from "./workspace-conflicts.js";

const { workerPlacementWarn } = vi.hoisted(() => ({ workerPlacementWarn: vi.fn() }));

vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "gateway/worker-placement"
        ? { ...logger, warn: workerPlacementWarn }
        : logger;
    },
  };
});

const tempDirs = useStateDatabaseTempDirs();

describe("worker placement dispatch conflict lookup", () => {
  let root: string;
  let database: OpenClawStateDatabase;
  let placementStore: PlacementStore;
  const createTestHarness = async (
    options: Parameters<typeof createPlacementHarness>[2] = {},
    store: PlacementStore = placementStore,
  ) =>
    await createPlacementHarness(database, store, {
      workspacePath: path.join(root, "workspace"),
      ...options,
    });

  beforeEach(async () => {
    workerPlacementWarn.mockClear();
    root = tempDirs.make("openclaw-dispatch-");
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    placementStore = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
  });

  it("reclaims an unchanged worker with unknown conflict state without silently clearing its report", async () => {
    const harness = await createTestHarness({
      priorWorkspaceResultConflictLookup: { kind: "unknown", reason: "malformed-report" },
      reconcileChanged: false,
      reconcileCommitsManifest: false,
    });
    await harness.service.dispatch(REQUEST);

    await expect(harness.service.reclaim(REQUEST)).resolves.toMatchObject({
      state: "reclaimed",
      workspaceBaseManifestRef: MANIFEST_REF,
      turnClaim: null,
    });

    expect(harness.reportWorkspaceResultConflict).not.toHaveBeenCalled();
    expect(await placementStore.listPendingWorkspaceResultsAsync()).toEqual([]);
    expect(harness.environments.destroy).toHaveBeenCalledOnce();
    expect(workerPlacementWarn).toHaveBeenCalledExactlyOnceWith(
      `Cloud workspace conflict state unknown sessionId=${REQUEST.sessionId} reason=malformed-report; preserving prior conflict state`,
    );
  });

  it.each<WorkspaceResultConflictLookup>([
    { kind: "absent" },
    { kind: "unknown", reason: "malformed-report" },
  ])(
    "reclaims a previous-instance pending result with $kind conflict state without clearing unseen reports",
    async (lookup) => {
      const originalHarness = await createTestHarness();
      const active = await originalHarness.placements.seedActive(2);
      if (active.state !== "active") {
        throw new Error("active placement fixture was not active");
      }
      const claim = await placementStore.claimTurn({
        ...REQUEST,
        claimId: "restarted-turn-claim",
        runId: "restarted-turn-run",
        owner: {
          kind: "worker",
          environmentId: active.environmentId,
          ownerEpoch: active.activeOwnerEpoch,
        },
      });
      await placementStore.markWorkspaceResultPending(claim);

      const restartedStore = createWorkerSessionPlacementStore({ database, now: () => 2_000 });
      const restartedHarness = await createTestHarness(
        { priorWorkspaceResultConflictLookup: lookup },
        restartedStore,
      );
      restartedHarness.markEnvironmentOwnerEpoch(2);
      await restartedHarness.service.reconcile();

      expect(restartedHarness.placements.current()).toMatchObject({
        state: "reclaimed",
        turnClaim: null,
        workspaceBaseManifestRef: restartedHarness.reconciledManifestRef,
      });
      expect(await restartedStore.listPendingWorkspaceResultsAsync()).toEqual([]);
      expect(restartedHarness.environments.destroy).toHaveBeenCalledOnce();
      expect(restartedHarness.log).not.toContain("workspace:resume");
      expect(restartedHarness.reportWorkspaceResultConflict).not.toHaveBeenCalled();
      if (lookup.kind === "unknown") {
        expect(workerPlacementWarn).toHaveBeenCalledExactlyOnceWith(
          `Cloud workspace conflict state unknown sessionId=${REQUEST.sessionId} reason=malformed-report; preserving prior conflict state`,
        );
      } else {
        expect(workerPlacementWarn).not.toHaveBeenCalled();
      }
    },
  );
});
