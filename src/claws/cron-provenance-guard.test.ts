import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { projectClawsStatus } from "./gateway-status-projection.js";
import { readClawInventory } from "./inventory-read.js";
import { quiescentClawMonitorGateway } from "./lifecycle-remove.test-support.js";
import { applyClawRemovePlan, buildClawRemovePlan, readClawStatus } from "./lifecycle-state.js";
import { createClawRemoveTestFixtures } from "./lifecycle-state.test-helpers.js";

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ prefix: "claw-cron-provenance-" });
  await state.writeConfig({});
});
afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await state.cleanup();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const { addFixture } = createClawRemoveTestFixtures(tempDirs, () => state);

function setUnsupportedCronVersion(env: NodeJS.ProcessEnv): void {
  openOpenClawStateDatabase({ env })
    .db.prepare("UPDATE claw_cron_refs SET schema_version = ? WHERE agent_id = ?")
    .run("openclaw.clawCronRef.v2", "worker");
}

it("preserves unsupported cron provenance through the inventory worker", async () => {
  const current = await addFixture({ withCron: true });
  setUnsupportedCronVersion(current.env);

  const inventory = await readClawInventory({ env: current.env });

  expect(inventory.cronJobs).toMatchObject([
    { agentId: "worker", manifestId: "daily-report", schemaVersion: "openclaw.clawCronRef.v2" },
  ]);
});

it("reports and blocks removal of unsupported cron provenance", async () => {
  const current = await addFixture({ withCron: true });
  setUnsupportedCronVersion(current.env);

  const status = await readClawStatus("worker", {
    env: current.env,
    config: current.getConfig(),
  });
  const projected = projectClawsStatus(status.records, []);
  const plan = await buildClawRemovePlan("worker", {
    env: current.env,
    config: current.getConfig(),
  });

  expect(status.summary.unresolvedCronRefs).toBe(1);
  expect(projected.records[0]?.resources).toContainEqual(
    expect.objectContaining({ kind: "cron-job", state: "unresolved" }),
  );
  expect(plan.blockers).toContainEqual(expect.objectContaining({ code: "cron_cleanup_uncertain" }));
  expect(plan.actions).toContainEqual(
    expect.objectContaining({ kind: "cronJob", action: "retain", blocked: true }),
  );
});

it("rejects removal when cron provenance changes after review", async () => {
  const current = await addFixture({ withCron: true });
  const config = current.getConfig();
  const plan = await buildClawRemovePlan("worker", { env: current.env, config });
  setUnsupportedCronVersion(current.env);
  const get = vi.fn();
  const remove = vi.fn();

  await expect(
    applyClawRemovePlan(plan, {
      monitorGateway: quiescentClawMonitorGateway,
      trashPath: async () => true,
      consentPlanIntegrity: plan.planIntegrity,
      env: current.env,
      config,
      cronGateway: { get, remove },
    }),
  ).rejects.toMatchObject({ code: "remove_changed" });
  expect(get).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
  expect(current.getConfig().agents?.entries?.worker).toBeDefined();
});
