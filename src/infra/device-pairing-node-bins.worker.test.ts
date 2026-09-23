import { afterEach, expect, test, vi } from "vitest";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { updatePairedNodeBins } from "./device-pairing-node-facts.js";
import { setupPairedNode } from "./device-pairing-node.test-support.js";
import { getPairedDevice } from "./device-pairing.js";
import * as workerAdmission from "./sqlite-worker-operation-admission.js";

const tempDirs = createTrackedTempDirs();
afterEach(async () => {
  vi.restoreAllMocks();
  await closeStateDatabaseForTest();
  await tempDirs.cleanup();
});

test("rejects a replaced probe at precommit and persists the current connection's bins", async () => {
  const baseDir = await tempDirs.make("node-bins-worker-admission-");
  const generation = await setupPairedNode(baseDir);
  await updatePairedNodeBins("node-1", ["original"], generation, baseDir);
  let connection = "connection-a";
  let precommitObserved = false;
  const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
  const admission = vi
    .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
    .mockImplementation((admit) =>
      createAdmission((request, grant) => {
        if (request.stage === "commit") {
          precommitObserved = true;
          connection = "connection-b";
        }
        admit(request, grant);
      }),
    );

  await expect(
    updatePairedNodeBins(
      "node-1",
      ["stale-probe"],
      generation,
      baseDir,
      () => connection === "connection-a",
    ),
  ).resolves.toBe(false);
  expect(precommitObserved).toBe(true);
  expect((await getPairedDevice("node-1", baseDir))?.nodeSurface?.bins).toEqual(["original"]);
  admission.mockRestore();

  await expect(
    updatePairedNodeBins(
      "node-1",
      ["current-probe"],
      generation,
      baseDir,
      () => connection === "connection-b",
    ),
  ).resolves.toBe(true);
  expect((await getPairedDevice("node-1", baseDir))?.nodeSurface?.bins).toEqual(["current-probe"]);
});
