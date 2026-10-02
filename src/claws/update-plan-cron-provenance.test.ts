import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { buildClawUpdatePlan } from "./update-plan.js";
import { createUpdatePlanFixture, packagePreflight } from "./update-plan.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

it("blocks updates against unsupported cron provenance", async () => {
  const current = await createUpdatePlanFixture(tempDirs.make("openclaw-claw-cron-update-"));
  openOpenClawStateDatabase({ env: current.env })
    .db.prepare("UPDATE claw_cron_refs SET schema_version = ? WHERE agent_id = ?")
    .run("openclaw.clawCronRef.v2", "worker");

  const plan = await buildClawUpdatePlan({
    agentId: "worker",
    targetManifest: current.manifest,
    targetSource: current.source,
    config: current.config,
    sourceMcpServers: current.config.mcp?.servers ?? {},
    stateOptions: { env: current.env },
    packagePreflight,
  });

  expect(plan.actions).toContainEqual(
    expect.objectContaining({ kind: "cronJob", id: "daily", action: "manual", blocked: true }),
  );
});
