import childProcess from "node:child_process";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { NODE_WORKER_CAPACITY_MAX } from "../infra/node-runner-inventory.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { NodeWorkerJournalWorker } from "./node-worker-journal-worker.js";
import { NodeWorkerLaunchStore } from "./node-worker-launch-store.js";
import * as workerProcessIdentity from "./node-worker-process-identity.js";
import { createNodeWorkerSupervisorFixture } from "./node-worker-supervisor.fixture.test-support.js";
import { createNodeWorkerSupervisor } from "./node-worker-supervisor.js";
import {
  testNodeWorkerLaunchIdentity,
  testWorkerLaunchInput,
  writeNodeWorkerFixture,
} from "./node-worker-supervisor.test-support.js";
import * as workerTreeControl from "./node-worker-tree-control.js";
import { NodeWorkerTurnStore } from "./node-worker-turn-store.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

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

  it("uses explicit worker capacity without resolving the CPU default", async () => {
    const availableParallelism = vi.spyOn(os, "availableParallelism");
    const capacitySnapshots: Array<{ total: number; available: number }> = [];
    const { supervisor } = fixture({
      capacity: 3,
      onCapacityChanged: (capacity) => capacitySnapshots.push(capacity),
    });

    try {
      await supervisor.initialize();
      expect(capacitySnapshots.at(-1)).toEqual({ total: 3, available: 3 });
      expect(availableParallelism).not.toHaveBeenCalled();
    } finally {
      await supervisor.close();
    }
  });

  it("keeps construction and close inert without resolving process identity", async () => {
    const root = tempDirs.make("node-worker-inert-");
    const { bundleRoot, env } = writeNodeWorkerFixture(root);
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    const spawnSync = vi.spyOn(childProcess, "spawnSync");
    const execFileSync = vi.spyOn(childProcess, "execFileSync");
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    try {
      const supervisor = createNodeWorkerSupervisor({ bundleRoot, env });
      await supervisor.close();
      expect(spawnSync).not.toHaveBeenCalled();
      expect(execFileSync).not.toHaveBeenCalled();
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, "platform", originalPlatform);
      }
    }
  });

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

  it("keeps pending and running launches owned by a live supervisor unchanged", async () => {
    const { bundleRoot, env, supervisor, workspaceDir } = fixture();
    await supervisor.status("schema-probe");
    const supervisorIdentity = workerProcessIdentity.requireNodeWorkerProcessIdentity(process.pid);
    const journal = new NodeWorkerJournalWorker({ env });
    const store = new NodeWorkerLaunchStore(journal);
    const turns = new NodeWorkerTurnStore(journal);
    for (const launchId of ["pending-launch", "running-launch"]) {
      const input = launchInput(workspaceDir, launchId, "wait");
      const claim = {
        ...testNodeWorkerLaunchIdentity(input),
        gatewayNamespace: input.gatewayNamespace,
      };
      await store.claim(claim, supervisorIdentity, 2);
      await turns.claim({ claim, ownerLaunchId: launchId, supervisor: supervisorIdentity });
      if (launchId === "running-launch") {
        await store.markRunning({
          ...claim,
          supervisor: supervisorIdentity,
          worker: supervisorIdentity,
          cleanupMode: "process-group",
        });
      }
    }

    const capacitySnapshots: Array<{ total: number; available: number }> = [];
    const sameHandle = createNodeWorkerSupervisor({
      bundleRoot,
      env,
      capacity: 2,
      onCapacityChanged: (capacity) => capacitySnapshots.push(capacity),
    });
    expect(await sameHandle.status("pending-launch")).toMatchObject({
      state: "pending",
      worker: null,
    });
    expect(await sameHandle.status("running-launch")).toMatchObject({
      state: "running",
      worker: supervisorIdentity,
    });
    expect(capacitySnapshots).toEqual([
      { total: 2, available: 0 },
      { total: 2, available: 0 },
    ]);
    expect(await sameHandle.hasActiveWork()).toBe(true);
    await supervisor.close();
    await sameHandle.close();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();

    openOpenClawStateDatabase({ env });
    const recovered = createNodeWorkerSupervisor({ bundleRoot, env });
    expect(await recovered.status("pending-launch")).toMatchObject({
      state: "pending",
      worker: null,
    });
    expect(await recovered.status("running-launch")).toMatchObject({
      state: "running",
      worker: supervisorIdentity,
    });
    await recovered.close();
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
