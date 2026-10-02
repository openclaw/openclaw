import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readAgentDeletionJournal } from "../state/agent-deletion-journal.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { planClawRemoveForGateway } from "./gateway-lifecycle-plan.js";
import { applyClawRemoveForGateway } from "./gateway-remove-apply.js";
import { quiescentClawMonitorGateway } from "./lifecycle-remove.test-support.js";
import { applyClawRemovePlan, buildClawRemovePlan, readClawStatus } from "./lifecycle-state.js";
import { createClawRemoveTestFixtures } from "./lifecycle-state.test-helpers.js";

const runClawRemoveCli = vi.hoisted(() => vi.fn());
vi.mock("./gateway-remove-cli.js", () => ({ runClawRemoveCli }));

let state: OpenClawTestState;
beforeEach(async () => {
  runClawRemoveCli.mockReset();
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
  it("does not remove config when Gateway authority retires during monitor quiesce", async () => {
    const current = await addFixture({ withFile: true });
    const config = current.getConfig();
    const monitorGateway = {
      ...quiescentClawMonitorGateway,
      quiesce: async () => {
        gatewayAuthorityCurrent = false;
      },
    };
    let gatewayAuthorityCurrent = true;
    const preview = await planClawRemoveForGateway({
      agentId: "worker",
      config,
      monitorGateway,
    });
    const canonical = await buildClawRemovePlan("worker", {
      env: current.env,
      config,
      exactAgentId: true,
      monitorGateway,
    });
    runClawRemoveCli.mockResolvedValueOnce({ code: 0, payload: canonical });
    runClawRemoveCli.mockImplementationOnce(
      async (input: { planIntegrity: string; gatewayBridge?: { assertCurrent: () => void } }) => {
        const result = await applyClawRemovePlan(canonical, {
          consentPlanIntegrity: input.planIntegrity,
          env: current.env,
          config,
          exactAgentId: true,
          assertForwardCurrent: () => {
            input.gatewayBridge?.assertCurrent();
          },
          monitorGateway,
          packageGateway: async () => ({ packages: [] }),
          cronGateway: { get: async () => null, remove: async () => undefined },
        });
        return { code: result.status === "complete" ? 0 : 1, payload: result };
      },
    );

    const result = await applyClawRemoveForGateway({
      agentId: "worker",
      planIntegrity: preview.planIntegrity,
      getRuntimeConfig: current.getConfig,
      assertCurrent: () => {
        if (!gatewayAuthorityCurrent) {
          throw new Error("Gateway authority retired");
        }
      },
      monitorGateway,
      createApplyCallbacks: () => ({
        monitorGateway,
        packageGateway: async () => ({ packages: [] }),
        cronGateway: { get: async () => null, remove: async () => undefined },
      }),
    });

    expect(gatewayAuthorityCurrent).toBe(false);
    expect(result).toMatchObject({ status: "partial", agentRemoved: false });
    expect(current.getConfig().agents?.entries?.worker).toBeDefined();
    expect(runClawRemoveCli).toHaveBeenCalledTimes(2);
  });

  it("completes the unchanged Gateway-owned lifecycle path", async () => {
    const current = await addFixture({ withFile: true });
    const config = current.getConfig();
    const preview = await planClawRemoveForGateway({
      agentId: "worker",
      config,
      monitorGateway: quiescentClawMonitorGateway,
    });
    const canonical = await buildClawRemovePlan("worker", {
      env: current.env,
      config,
      exactAgentId: true,
      monitorGateway: quiescentClawMonitorGateway,
    });
    runClawRemoveCli.mockResolvedValueOnce({ code: 0, payload: canonical });
    runClawRemoveCli.mockImplementationOnce(
      async (input: { planIntegrity: string; gatewayBridge?: { assertCurrent: () => void } }) => {
        const result = await applyClawRemovePlan(canonical, {
          consentPlanIntegrity: input.planIntegrity,
          env: current.env,
          config: current.getConfig(),
          exactAgentId: true,
          assertForwardCurrent: () => input.gatewayBridge?.assertCurrent(),
          monitorGateway: quiescentClawMonitorGateway,
          packageGateway: async () => ({ packages: [] }),
          cronGateway: { get: async () => null, remove: async () => undefined },
        });
        return { code: result.status === "complete" ? 0 : 1, payload: result };
      },
    );

    const result = await applyClawRemoveForGateway({
      agentId: "worker",
      planIntegrity: preview.planIntegrity,
      getRuntimeConfig: current.getConfig,
      assertCurrent: () => {},
      monitorGateway: quiescentClawMonitorGateway,
      createApplyCallbacks: () => ({
        monitorGateway: quiescentClawMonitorGateway,
        packageGateway: async () => ({ packages: [] }),
        cronGateway: { get: async () => null, remove: async () => undefined },
      }),
    });

    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({ status: "complete", agentRemoved: true });
    expect(current.getConfig().agents?.entries?.worker).toBeUndefined();
  });

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
