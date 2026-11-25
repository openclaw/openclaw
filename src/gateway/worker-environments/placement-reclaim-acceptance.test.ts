import { beforeEach, expect, vi } from "vitest";
import { createCommandTest } from "../../../test/helpers/command-fixture.js";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../config/io.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { useStateDatabaseTempDirs } from "../../test-utils/state-database-temp-dirs.js";
import { type PlacementStore, REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";

const tempDirs = useStateDatabaseTempDirs();
const it = createCommandTest();
let root: string;
let database: OpenClawStateDatabase;
let placementStore: PlacementStore;

beforeEach(() => {
  setRuntimeConfigSnapshot({});
  root = tempDirs.make("openclaw-reclaim-acceptance-");
  database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
  placementStore = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
});

it("completes the placement while accepted provider cleanup is still pending", async ({
  signal,
}) => {
  const harness = await createHarness(database, placementStore, {
    workspacePath: root,
    reconcileChanged: false,
    reconcileCommitsManifest: false,
  });
  await harness.service.dispatch(REQUEST);
  const releaseFinished = createDeferred();
  const waitingForRelease = createDeferred();
  vi.spyOn(harness.environments, "reclaim").mockImplementation(async (environmentId) => {
    const attached = harness.environments.get(environmentId);
    if (!attached || attached.state !== "attached") {
      throw new Error("Expected the active environment before reclaim acceptance");
    }
    const destroying = {
      ...attached,
      state: "destroying" as const,
      destroyRequestedAtMs: 1_000,
      attachedSessionIds: [],
      tunnelStatus: "stopped" as const,
    };
    vi.mocked(harness.environments.get).mockReturnValue(destroying);
    return destroying;
  });
  vi.mocked(harness.environments.stopTunnel).mockImplementation(async () => {
    waitingForRelease.resolve();
    await releaseFinished.promise;
  });
  const reclaim = harness.service.reclaim(REQUEST);
  try {
    await expect(
      withinTest(
        Promise.race([
          reclaim.then(() => "reclaimed"),
          waitingForRelease.promise.then(() => "waited-for-release"),
        ]),
        signal,
      ),
    ).resolves.toBe("reclaimed");
    expect(await reclaim).toMatchObject({ state: "reclaimed", turnClaim: null });
    expect(harness.environments.get(harness.ready.environmentId)?.state).toBe("destroying");
    expect(await placementStore.listPendingWorkspaceResultsAsync()).toEqual([]);
  } finally {
    releaseFinished.resolve();
    await reclaim;
  }
});
