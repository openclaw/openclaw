import path from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { useStateDatabaseTempDirs } from "../../test-utils/state-database-temp-dirs.js";
import { MANIFEST_REF, REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createHarness as createPlacementHarness } from "./placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { placementClaim } from "./placement-suite.test-support.js";

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

afterAll(() => clearRuntimeConfigSnapshot());

it.each([
  { restarted: false, kind: "unknown" },
  { restarted: true, kind: "absent" },
  { restarted: true, kind: "unknown" },
] as const)(
  "reclaims without clearing unseen $kind conflict reports (restarted=$restarted)",
  async ({ restarted, kind }) => {
    setRuntimeConfigSnapshot({});
    workerPlacementWarn.mockClear();
    const root = tempDirs.make("openclaw-dispatch-");
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    let store = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
    const options: Parameters<typeof createPlacementHarness>[2] = {
      workspacePath: path.join(root, "workspace"),
      priorWorkspaceResultConflictLookup:
        kind === "unknown" ? { kind, reason: "malformed-report" } : { kind },
      reconcileChanged: restarted,
      reconcileCommitsManifest: restarted,
    };
    let harness = await createPlacementHarness(database, store, options);
    let reclaimed: ReturnType<typeof harness.placements.current>;
    if (restarted) {
      const active = await harness.placements.seedActive(2);
      if (active.state !== "active") {
        throw new Error("active placement fixture was not active");
      }
      const claim = await store.claimTurn(placementClaim(active, "restarted-turn"));
      await store.markWorkspaceResultPending(claim);
      store = createWorkerSessionPlacementStore({ database, now: () => 2_000 });
      harness = await createPlacementHarness(database, store, options);
      harness.markEnvironmentOwnerEpoch(2);
      await harness.service.reconcile();
      reclaimed = harness.placements.current();
      expect(harness.log).not.toContain("workspace:resume");
    } else {
      await harness.service.dispatch(REQUEST);
      reclaimed = await harness.service.reclaim(REQUEST);
    }
    expect(reclaimed).toMatchObject({
      state: "reclaimed",
      turnClaim: null,
      workspaceBaseManifestRef: restarted ? harness.reconciledManifestRef : MANIFEST_REF,
    });
    expect(await store.listPendingWorkspaceResultsAsync()).toEqual([]);
    expect(harness.environments.destroy).toHaveBeenCalledOnce();
    expect(harness.reportWorkspaceResultConflict).not.toHaveBeenCalled();
    if (kind === "unknown") {
      expect(workerPlacementWarn).toHaveBeenCalledExactlyOnceWith(
        `Cloud workspace conflict state unknown sessionId=${REQUEST.sessionId} reason=malformed-report; preserving prior conflict state`,
      );
    } else {
      expect(workerPlacementWarn).not.toHaveBeenCalled();
    }
  },
);
