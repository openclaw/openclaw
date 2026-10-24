import fs from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { useStateDatabaseTempDirs } from "../../test-utils/state-database-temp-dirs.js";
import { DEVICE_FOLDER_MANIFEST_REF } from "../../worker/device-folder.js";
import { createDispatchEnvironmentFixtures, REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { forceAbandonWorkerEnvironment } from "./placement-force-abandon.js";
import { createWorkerPlacementReclaim } from "./placement-reclaim.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { placementClaim, sessionIdentity } from "./placement-suite.test-support.js";
import { advancePlacementFixtureToActive } from "./placement-test-fixtures.js";
import type { WorkerTunnelHandle } from "./tunnel-contract.js";
import { createWorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";
import {
  recoverWorkspaceBeforeTurn,
  reconcileWorkspaceAfterTurn,
} from "./workspace-result-finalize.js";

const dirs = useStateDatabaseTempDirs();

async function fixture(folderPlacement = false) {
  const root = dirs.make("device-folder-lifecycle-");
  const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
  const placements = createWorkerSessionPlacementStore({ database, now: () => 1000 });
  const harness = await createHarness(database, placements, { workspacePath: root });
  const { environmentId } = createDispatchEnvironmentFixtures();
  const placement = await advancePlacementFixtureToActive(placements, database, REQUEST, {
    environmentId,
    ownerEpoch: 1,
    workspaceBaseManifestRef: folderPlacement ? DEVICE_FOLDER_MANIFEST_REF : undefined,
    remoteWorkspaceDir: folderPlacement ? "/user-folder" : "/worker/workspace",
    seedEnvironment: "before-dispatch",
  });
  harness.markEnvironmentOwnerEpoch(1);
  const folder = path.join(root, "user-folder");
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, "keep.txt"), "user data");
  const workspace = { kind: "device-folder" as const, deviceId: "paired-node", path: folder };
  return { root, placements, placement, harness, folder, workspace };
}

test("device-folder results release the turn without capture, transfer, reconciliation, or quiescence", async () => {
  const f = await fixture();
  const { placement } = f;
  const claim = await f.placements.claimTurn(placementClaim(placement, "folder-turn"));
  await f.placements.markWorkspaceResultPending(claim);
  const unexpected = vi.fn(async () => {
    throw new Error("folder must not be synchronized");
  });
  const tunnel: WorkerTunnelHandle = {
    environmentId: placement.environmentId,
    ownerEpoch: placement.activeOwnerEpoch,
    runWorkspaceCommand: unexpected,
    syncWorkspace: unexpected,
    reconcileWorkspace: unexpected,
    quiesceWorkspace: unexpected,
    stop: unexpected,
  };
  const result = {
    placement,
    placements: f.placements,
    turnClaim: claim,
    workspaceOperations: createWorkerWorkspaceOperationCoordinator(),
    workspace: f.workspace,
  };
  await recoverWorkspaceBeforeTurn(result);
  await reconcileWorkspaceAfterTurn({
    ...result,
    tunnel,
    transcriptTarget: {
      ...sessionIdentity(REQUEST.sessionId),
      storePath: path.join(f.root, "sessions.json"),
    },
  });
  expect(unexpected).not.toHaveBeenCalled();
  expect(f.placements.get(REQUEST.sessionId)?.turnClaim).toBeNull();
  expect(await f.placements.listPendingWorkspaceResultsAsync()).toEqual([]);
  expect(await fs.readdir(f.folder)).toEqual(["keep.txt"]);
});

test("device-folder reclaim stops its environment without touching user data", async () => {
  const f = await fixture();
  const reclaimPlacement = createWorkerPlacementReclaim({
    placements: f.placements,
    environments: f.harness.environments,
    workspaceOperations: createWorkerWorkspaceOperationCoordinator(),
    withPreparedRecovery: async () => {
      throw new Error("folder has no Gateway recovery");
    },
    runReclaimBarrier: async ({ begin, reclaim }) => reclaim(f.workspace, await begin(), () => {}),
  });
  expect(await reclaimPlacement(REQUEST)).toMatchObject({ state: "reclaimed" });
  expect(f.harness.environments.destroy).toHaveBeenCalledOnce();
  expect(f.harness.log).not.toContain("workspace:reconcile");
  expect(await fs.readFile(path.join(f.folder, "keep.txt"), "utf8")).toBe("user data");
  expect(await fs.readdir(f.folder)).toEqual(["keep.txt"]);
});

test("forced abandonment refuses a device-folder placement before mutation", async () => {
  const f = await fixture(true);
  await expect(
    forceAbandonWorkerEnvironment({
      placements: f.placements,
      environmentId: f.placement.environmentId,
      resolveWorkspace: async () => f.workspace,
    }),
  ).rejects.toThrow("cannot be abandoned");
  expect(f.placements.get(REQUEST.sessionId)).toMatchObject({ state: "active", turnClaim: null });
});
