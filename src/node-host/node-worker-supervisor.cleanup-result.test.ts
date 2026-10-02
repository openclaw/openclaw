import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { NODE_WORKER_CAPACITY_EXHAUSTED_ERROR_CODE } from "../infra/node-commands.js";
import { useStateDatabaseTempDirs } from "../test-utils/state-database-temp-dirs.js";
import { NodeWorkerJournalWorker } from "./node-worker-journal-worker.js";
import { NodeWorkerLaunchStore } from "./node-worker-launch-store.js";
import {
  createNodeWorkerSupervisorFixture,
  observeNodeWorkerAdapters,
} from "./node-worker-supervisor.fixture.test-support.js";
import {
  TEST_WORKER_ENDPOINT,
  testNodeWorkerEnvironmentIdentity,
  testWorkerLaunchInput,
} from "./node-worker-supervisor.test-support.js";
import * as workerTreeControl from "./node-worker-tree-control.js";

const tempDirs = useStateDatabaseTempDirs();

it.skipIf(process.platform === "win32").for(["uncertain", "confirmed"] as const)(
  "settles durable capacity from the native cleanup certificate (%s)",
  { timeout: 20_000 },
  async (cleanupStatus, { signal }) => {
    const capacities: Array<{ total: number; available: number }> = [];
    const { env, supervisor, workspaceDir } = createNodeWorkerSupervisorFixture(
      tempDirs.make("node-worker-uncertain-cleanup-"),
      { capacity: 1, capacityWaitMs: 0, onCapacityChanged: (value) => capacities.push(value) },
    );
    const input = testWorkerLaunchInput(workspaceDir, "uncertain-owner");
    const store = new NodeWorkerLaunchStore(new NodeWorkerJournalWorker({ env }));
    const reported = createDeferred();
    vi.spyOn(workerTreeControl, "inspectOwnedNodeWorkerTree").mockReturnValue("unknown");
    let restoreConfirmation: (() => void) | undefined;
    const capture = observeNodeWorkerAdapters((adapter) => {
      const waitForExtinction = adapter.waitForExtinction;
      if (!waitForExtinction) {
        throw new Error("Expected the real relay's extinction boundary");
      }
      const confirmExtinction = adapter.confirmExtinction;
      adapter.confirmExtinction = undefined;
      restoreConfirmation = () => {
        adapter.confirmExtinction = confirmExtinction;
      };
      adapter.waitForExtinction = async () => {
        await waitForExtinction();
        reported.resolve();
        return cleanupStatus === "uncertain"
          ? { status: "uncertain", reason: "job-unavailable" }
          : { status: "confirmed" };
      };
    });
    try {
      await supervisor.launch(input, TEST_WORKER_ENDPOINT);
      await withinTest(reported.promise, signal);
      if (cleanupStatus === "confirmed") {
        await supervisor.stopEnvironment(testNodeWorkerEnvironmentIdentity(input));
        expect((await store.get(input.launchId))?.state).toBe("completed");
        expect(capacities.at(-1)).toEqual({ total: 1, available: 1 });
        expect(await supervisor.hasActiveWork()).toBe(false);
        return;
      }
      await expect(
        supervisor.stopEnvironment(testNodeWorkerEnvironmentIdentity(input)),
      ).rejects.toThrow("cleanup remains unconfirmed");
      expect((await store.get(input.launchId))?.state).toBe("running");
      expect(capacities.at(-1)).toEqual({ total: 1, available: 0 });
      expect(await supervisor.hasActiveWork()).toBe(true);

      const replacement = testWorkerLaunchInput(workspaceDir, "replacement-owner");
      replacement.descriptor.admission.environmentId = "replacement-environment";
      replacement.descriptor.admission.sessionId = "replacement-session";
      await expect(supervisor.launch(replacement, TEST_WORKER_ENDPOINT)).rejects.toMatchObject({
        code: NODE_WORKER_CAPACITY_EXHAUSTED_ERROR_CODE,
      });
    } finally {
      capture.mockRestore();
      restoreConfirmation?.();
      await supervisor.close();
    }
  },
);
