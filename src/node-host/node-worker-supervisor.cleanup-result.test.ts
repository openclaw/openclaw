import { afterEach, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { NODE_WORKER_CAPACITY_EXHAUSTED_ERROR_CODE } from "../infra/node-commands.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
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

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
});

it.skipIf(process.platform === "win32").each(["uncertain", "confirmed"] as const)(
  "settles durable capacity from the native cleanup certificate (%s)",
  async (cleanupStatus) => {
    const capacities: Array<{ total: number; available: number }> = [];
    const { env, supervisor, workspaceDir } = createNodeWorkerSupervisorFixture(
      tempDirs.make("node-worker-uncertain-cleanup-"),
      { capacity: 1, capacityWaitMs: 0, onCapacityChanged: (value) => capacities.push(value) },
    );
    const input = testWorkerLaunchInput(workspaceDir, "uncertain-owner");
    const store = new NodeWorkerLaunchStore({ env });
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
      await withTestTimeout(reported.promise, 5_000, "Worker cleanup did not report its outcome");
      if (cleanupStatus === "confirmed") {
        await supervisor.stopEnvironment(testNodeWorkerEnvironmentIdentity(input));
        expect(store.get(input.launchId)?.state).toBe("completed");
        expect(capacities.at(-1)).toEqual({ total: 1, available: 1 });
        expect(supervisor.hasActiveWork()).toBe(false);
        return;
      }
      await expect(
        supervisor.stopEnvironment(testNodeWorkerEnvironmentIdentity(input)),
      ).rejects.toThrow("cleanup remains unconfirmed");
      expect(store.get(input.launchId)?.state).toBe("running");
      expect(capacities.at(-1)).toEqual({ total: 1, available: 0 });
      expect(supervisor.hasActiveWork()).toBe(true);

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
  20_000,
);
