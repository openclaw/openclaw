import { afterAll, beforeAll, expect, it } from "vitest";
import { observeMainThreadFs } from "../test-utils/main-thread-fs-spies.test-support.js";
import { installDatabaseEngineSelection } from "./database-engine/context.js";
import { resetDatabaseEngineSelectionForTest } from "./database-engine/context.test-support.js";
import { resolveDatabaseFamilyEngines } from "./database-engine/registry.js";
// Register the synthetic coordinator before importing the real handoff owner.
import { useManagedServiceHandoffLifecycleFixture } from "./update-managed-service-handoff-fixture.test-support.js";
import { startManagedServiceUpdateHandoff } from "./update-managed-service-handoff.js";

const { spawnMock, tempDirs } = useManagedServiceHandoffLifecycleFixture(false, true);
beforeAll(() => {
  installDatabaseEngineSelection({ effectiveEngines: resolveDatabaseFamilyEngines({}) });
});
afterAll(resetDatabaseEngineSelectionForTest);

it("prepares the real handoff lease before spawn without synchronous host filesystem calls", async () => {
  const root = tempDirs.make("handoff-main-thread-fs-");
  const refusedSpawn = new Error("synthetic spawn boundary");
  spawnMock.mockImplementationOnce(() => {
    throw refusedSpawn;
  });
  using observed = observeMainThreadFs();
  await expect(
    startManagedServiceUpdateHandoff({
      root,
      restartDrainTimeoutMs: 300_000,
      parentPid: process.pid,
      execPath: process.execPath,
      argv1: root + "/openclaw.mjs",
      meta: {},
    }),
  ).rejects.toThrow("synthetic spawn boundary");
  expect(spawnMock).toHaveBeenCalledOnce();
  expect(
    observed
      .stacks()
      .filter(({ stack }) =>
        /update-managed-service-handoff-(?:database|lease|legacy-store|temp-root|runtime|native)/.test(
          stack,
        ),
      ),
  ).toEqual([]);
});
