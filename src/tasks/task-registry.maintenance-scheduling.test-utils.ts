import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi, type MockInstance } from "vitest";
import type { AcpSessionStoreEntry } from "../acp/runtime/session-meta.js";
import * as gatewayWorkAdmission from "../process/gateway-work-admission.js";
import { createManagedTaskFlow, getTaskFlowById } from "./task-flow-registry.js";
import { resetTaskFlowRegistryForTests } from "./task-flow-registry.test-support.js";
import {
  startTaskRegistryMaintenance,
  stopTaskRegistryMaintenance,
} from "./task-registry.maintenance.js";
import { configureTaskRegistryMaintenanceRuntimeForTest } from "./task-registry.maintenance.test-support.js";
import {
  resetTaskRegistryForTests,
  withTaskRegistryTempDir,
} from "./task-registry.test-support.js";

async function waitForScheduledMaintenance(
  admissions: MockInstance<typeof gatewayWorkAdmission.runWithGatewayIndependentRootWorkAdmission>,
) {
  const index = admissions.mock.calls.findIndex(([, origin]) => origin === "tasks:maintenance");
  const operation = expectDefined(admissions.mock.results[index], "expected scheduled maintenance");
  if (operation.type !== "return") {
    throw new Error("scheduled maintenance did not return its work promise");
  }
  await operation.value;
}

export function registerTaskRegistryScheduledMaintenanceTests() {
  it("prunes expired ended TaskFlows during scheduled maintenance", async () => {
    await withTaskRegistryTempDir(
      async () => {
        vi.useFakeTimers();
        const endedAt = Date.now() - 8 * 24 * 60 * 60_000;
        const flow = expectDefined(
          createManagedTaskFlow({
            ownerKey: "agent:main:main",
            controllerId: "tests/scheduled-task-flow-maintenance",
            goal: "Completed without a usable result",
            status: "blocked",
            createdAt: endedAt,
            updatedAt: endedAt,
            endedAt,
          }),
          "expected managed TaskFlow creation to succeed",
        );
        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests({ persist: false });
        using admissions = vi.spyOn(
          gatewayWorkAdmission,
          "runWithGatewayIndependentRootWorkAdmission",
        );
        try {
          startTaskRegistryMaintenance();
          await vi.advanceTimersByTimeAsync(5_000);
          await waitForScheduledMaintenance(admissions);
          expect(getTaskFlowById(flow.flowId)).toBeUndefined();
        } finally {
          await stopTaskRegistryMaintenance();
        }
      },
      { durableStore: true },
    );
  });

  it("keeps scheduled maintenance root-admitted until session cleanup inspection settles", async () => {
    await withTaskRegistryTempDir(async () => {
      vi.useFakeTimers();
      let releaseInspection = (_entries: AcpSessionStoreEntry[]) => {};
      const inspection = new Promise<AcpSessionStoreEntry[]>((resolve) => {
        releaseInspection = resolve;
      });
      configureTaskRegistryMaintenanceRuntimeForTest({
        currentTasks: new Map(),
        snapshotTasks: [],
        listAcpSessionEntries: async () => await inspection,
      });
      using admissions = vi.spyOn(
        gatewayWorkAdmission,
        "runWithGatewayIndependentRootWorkAdmission",
      );
      try {
        startTaskRegistryMaintenance();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(gatewayWorkAdmission.getActiveGatewayRootWorkCount()).toBe(1);

        releaseInspection([]);
        await waitForScheduledMaintenance(admissions);
        expect(gatewayWorkAdmission.getActiveGatewayRootWorkCount()).toBe(0);
      } finally {
        releaseInspection([]);
        await stopTaskRegistryMaintenance();
      }
    });
  });
}
