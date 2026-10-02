import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NODE_WORKER_CAPACITY_MAX } from "../../packages/gateway-protocol/src/worker-capacity.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { useStateDatabaseTempDirs } from "../test-utils/state-database-temp-dirs.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { NodeWorkerJournalWorker } from "./node-worker-journal-worker.js";
import { NodeWorkerLaunchStore } from "./node-worker-launch-store.js";
import * as workerProcessIdentity from "./node-worker-process-identity.js";
import { createNodeWorkerSupervisorFixture } from "./node-worker-supervisor.fixture.test-support.js";
import { createNodeWorkerSupervisor } from "./node-worker-supervisor.js";
import {
  testNodeWorkerLaunchIdentity,
  testWorkerLaunchInput,
} from "./node-worker-supervisor.test-support.js";
import * as workerTreeControl from "./node-worker-tree-control.js";

const tempDirs = useStateDatabaseTempDirs();

afterEach(() => {
  vi.restoreAllMocks();
  resetSecretRedactionRegistryForTest();
});

function fixture(options: Parameters<typeof createNodeWorkerSupervisor>[0] = {}) {
  return createNodeWorkerSupervisorFixture(tempDirs.make("node-worker-supervisor-"), options);
}

function launchInput(workspaceDir: string, launchId: string, prompt = "success") {
  const input = testWorkerLaunchInput(workspaceDir, launchId, prompt);
  input.descriptor.admission.environmentId = `environment-${launchId}`;
  input.descriptor.admission.sessionId = `session-${launchId}`;
  return input;
}

describe("node worker supervisor initialization", () => {
  it.each([
    { availableParallelism: 0, expected: 1 },
    { availableParallelism: 7, expected: 7 },
    { availableParallelism: NODE_WORKER_CAPACITY_MAX + 1, expected: NODE_WORKER_CAPACITY_MAX },
  ])(
    "publishes $expected default worker slots for $availableParallelism available CPUs",
    async ({ availableParallelism, expected }) => {
      vi.spyOn(os, "availableParallelism").mockReturnValue(availableParallelism);
      const capacitySnapshots: Array<{ total: number; available: number }> = [];
      const { supervisor } = fixture({
        onCapacityChanged: (capacity) => capacitySnapshots.push(capacity),
      });

      try {
        expect(await supervisor.hasActiveWork()).toBe(true);
        await supervisor.initialize();
        expect(capacitySnapshots.at(-1)).toEqual({ total: expected, available: expected });
        expect(await supervisor.hasActiveWork()).toBe(false);
      } finally {
        await supervisor.close();
      }
    },
  );

  it("keeps the additive table absent until the first stateful operation", async () => {
    const { bundleRoot, env, supervisor } = fixture();
    const database = openOpenClawStateDatabase({ env });
    const findTable = () =>
      database.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("node_worker_launches");

    expect(findTable()).toBeUndefined();
    await supervisor.close();
    expect(findTable()).toBeUndefined();

    const active = createNodeWorkerSupervisor({ bundleRoot, env });
    expect(await active.status("missing-launch")).toBeUndefined();
    expect(
      database.db
        .prepare("SELECT strict FROM pragma_table_list WHERE name = ?")
        .get("node_worker_launches"),
    ).toEqual({ strict: 1 });
    await active.close();
  });

  it.each(["dead", "reused"] as const)(
    "retains Windows restart capacity when the recorded worker root is %s",
    async (rootState) => {
      const { bundleRoot, env, supervisor, workspaceDir } = fixture();
      const store = new NodeWorkerLaunchStore(new NodeWorkerJournalWorker({ env }));
      const input = launchInput(workspaceDir, `windows-${rootState}`, "wait");
      const claim = {
        ...testNodeWorkerLaunchIdentity(input),
        gatewayNamespace: input.gatewayNamespace,
      };
      const previousSupervisor = { pid: 2_000_000_001, startTime: 1 };
      const worker = { pid: 2_000_000_002, startTime: 2 };
      await store.claim(claim, previousSupervisor, 1);
      await store.markRunning({
        ...claim,
        supervisor: previousSupervisor,
        worker,
        cleanupMode: "process-group",
      });

      const inspectIdentity = workerProcessIdentity.inspectNodeWorkerProcessIdentity;
      vi.spyOn(workerProcessIdentity, "inspectNodeWorkerProcessIdentity").mockImplementation(
        (identity) => {
          if (identity.pid === previousSupervisor.pid) {
            return "dead";
          }
          return identity.pid === worker.pid ? rootState : inspectIdentity(identity);
        },
      );
      const inspectTree = workerTreeControl.inspectOwnedNodeWorkerTree;
      vi.spyOn(workerTreeControl, "inspectOwnedNodeWorkerTree").mockImplementation((identity) => {
        // Scope the Windows observation to its owner; the real database remains host-native.
        const platform = mockProcessPlatform("win32");
        try {
          return inspectTree(identity);
        } finally {
          platform.mockRestore();
        }
      });
      const signal = vi.spyOn(workerTreeControl, "signalOwnedNodeWorkerTree").mockResolvedValue();
      const capacities: Array<{ total: number; available: number }> = [];
      const recovered = createNodeWorkerSupervisor({
        bundleRoot,
        env,
        capacity: 1,
        onCapacityChanged: (value) => capacities.push(value),
      });
      try {
        await recovered.initialize();
        expect(await store.get(input.launchId)).toMatchObject({ state: "running", worker });
        expect(capacities.at(-1)).toEqual({ total: 1, available: 0 });
        expect(await recovered.hasActiveWork()).toBe(true);
        expect(signal).not.toHaveBeenCalled();
      } finally {
        await recovered.close();
        await supervisor.close();
      }
    },
  );
});
