import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readAgentDeletionJournal } from "../state/agent-deletion-journal.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { quiescentClawMonitorGateway } from "./lifecycle-remove.test-support.js";
import { applyClawRemovePlan, buildClawRemovePlan, readClawStatus } from "./lifecycle-state.js";
import { createClawRemoveTestFixtures } from "./lifecycle-state.test-helpers.js";

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ prefix: "claw-remove-cancel-" });
  await state.writeConfig({});
});
afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await state.cleanup();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const { addFixture } = createClawRemoveTestFixtures(tempDirs, () => state);

describe("Claw removal cancellation", () => {
  it("stops before config removal when cancellation arrives during monitor quiesce", async () => {
    const current = await addFixture({ withFile: true });
    const config = current.getConfig();
    const plan = await buildClawRemovePlan("worker", { env: current.env, config });
    const controller = new AbortController();

    const result = await applyClawRemovePlan(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      env: current.env,
      config,
      assertForwardCurrent: () => controller.signal.throwIfAborted(),
      monitorGateway: {
        ...quiescentClawMonitorGateway,
        quiesce: async () => controller.abort(new Error("removal canceled")),
      },
    });

    expect(result).toMatchObject({ status: "partial", agentRemoved: false });
    expect(current.getConfig().agents?.entries?.worker).toBeDefined();
    expect(readAgentDeletionJournal("worker", { env: current.env })).toMatchObject({
      cleanupCompleted: false,
    });
    await expect(readFile(join(current.plan.agent.workspace, "SOUL.md"), "utf8")).resolves.toBe(
      "managed\n",
    );
  });

  it("retains a retryable partial install when cancellation follows config removal", async () => {
    const current = await addFixture({ withFile: true });
    const config = current.getConfig();
    const plan = await buildClawRemovePlan("worker", { env: current.env, config });
    const controller = new AbortController();

    const result = await applyClawRemovePlan(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      env: current.env,
      config,
      assertForwardCurrent: () => controller.signal.throwIfAborted(),
      monitorGateway: {
        ...quiescentClawMonitorGateway,
        drain: async () => controller.abort(new Error("removal canceled")),
      },
    });

    expect(result).toMatchObject({ status: "partial", agentRemoved: true });
    expect(current.getConfig().agents?.entries?.worker).toBeUndefined();
    expect(readAgentDeletionJournal("worker", { env: current.env })).toMatchObject({
      cleanupCompleted: false,
    });
    await expect(
      readClawStatus("worker", { env: current.env, config: current.getConfig() }),
    ).resolves.toMatchObject({ records: [{ install: { status: "partial" } }] });
    await expect(readFile(join(current.plan.agent.workspace, "SOUL.md"), "utf8")).resolves.toBe(
      "managed\n",
    );
  });
});
