import { afterEach, describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  createManagedTaskFlow,
  getTaskFlowById,
  resetTaskFlowRegistryForTests,
} from "./task-flow-registry.js";
import {
  previewTaskFlowRegistryMaintenance,
  runTaskFlowRegistryMaintenance,
} from "./task-flow-registry.maintenance.js";
import {
  resetTaskRegistryDeliveryRuntimeForTests,
  resetTaskRegistryForTests,
} from "./task-registry.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;

async function withTaskFlowMaintenanceStateDir(
  run: (root: string) => Promise<void>,
): Promise<void> {
  await withTempDir({ prefix: "openclaw-task-flow-maintenance-" }, async (root) => {
    process.env.OPENCLAW_STATE_DIR = root;
    resetTaskRegistryDeliveryRuntimeForTests();
    resetTaskRegistryForTests();
    resetTaskFlowRegistryForTests();
    try {
      await run(root);
    } finally {
      resetTaskRegistryDeliveryRuntimeForTests();
      resetTaskRegistryForTests();
      resetTaskFlowRegistryForTests();
    }
  });
}

describe("task-flow-registry maintenance", () => {
  afterEach(() => {
    if (ORIGINAL_STATE_DIR === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
    }
    resetTaskRegistryDeliveryRuntimeForTests();
    resetTaskRegistryForTests();
    resetTaskFlowRegistryForTests();
  });

  it("finalizes cancel-requested managed flows once no child tasks remain active", async () => {
    await withTaskFlowMaintenanceStateDir(async () => {
      const flow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/task-flow-maintenance",
        goal: "Cancel work",
        status: "running",
        cancelRequestedAt: 100,
        createdAt: 1,
        updatedAt: 100,
      });

      expect(previewTaskFlowRegistryMaintenance()).toEqual({
        reconciled: 1,
        pruned: 0,
      });

      expect(await runTaskFlowRegistryMaintenance()).toEqual({
        reconciled: 1,
        pruned: 0,
      });
      expect(getTaskFlowById(flow.flowId)).toMatchObject({
        flowId: flow.flowId,
        status: "cancelled",
        cancelRequestedAt: 100,
      });
    });
  });

  it("prunes old terminal flows", async () => {
    await withTaskFlowMaintenanceStateDir(async () => {
      const now = Date.now();
      const oldFlow = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/task-flow-maintenance",
        goal: "Old terminal flow",
        status: "succeeded",
        createdAt: now - 8 * 24 * 60 * 60_000,
        updatedAt: now - 8 * 24 * 60 * 60_000,
        endedAt: now - 8 * 24 * 60 * 60_000,
      });

      expect(previewTaskFlowRegistryMaintenance()).toEqual({
        reconciled: 0,
        pruned: 1,
      });

      expect(await runTaskFlowRegistryMaintenance()).toEqual({
        reconciled: 0,
        pruned: 1,
      });
      expect(getTaskFlowById(oldFlow.flowId)).toBeUndefined();
    });
  });
});
