import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { withClawAgentMutationLease } from "./add-apply-lease.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

it("runs one add operation under its agent lease", async () => {
  const root = tempDirs.make("openclaw-claw-add-lease-unit-");
  const env = { OPENCLAW_STATE_DIR: join(root, "state") };

  await expect(
    withClawAgentMutationLease("WORKER", { env }, async (lease) => {
      lease.assertOwned();
      return "owned";
    }),
  ).resolves.toBe("owned");
});
