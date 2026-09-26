import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import type { NodeWorkerLaunchReceipt } from "./node-worker-launch-store.js";
import { launchWithNodeWorkerPreparedWorkspace } from "./node-worker-supervisor-ownership.js";

describe("prepared workspace launch custody", () => {
  it.each(["completed", "failed", "closed", "aborted"] as const)(
    "settles the acquired lease when launch is %s",
    async (outcome) => {
      const request = {
        workspaceDir: "/synthetic/workspace",
        environmentId: "environment",
        sessionId: "session",
        sessionKey: "agent:main:session",
        ownerEpoch: 1,
      };
      const receipt: NodeWorkerLaunchReceipt = {
        launchId: "launch",
        planHash: "plan",
        gatewayNamespace: "gateway",
        environmentId: request.environmentId,
        sessionId: request.sessionId,
        ownerEpoch: request.ownerEpoch,
        placementGeneration: 1,
        runId: "run",
        state: "running",
        supervisor: { pid: 1, startTime: 1 },
        worker: null,
        workerCleanupMode: null,
        workerLineageSettled: false,
        resultJson: null,
        errorText: null,
        completedAtMs: null,
        createdAtMs: 1,
        updatedAtMs: 1,
      };
      const release = vi.fn();
      const lease = { workspaceDir: request.workspaceDir, homeDir: "/synthetic/home", release };
      const acquired = createDeferredCore<typeof lease>();
      const workspace = { acquirePreparedWorkspace: vi.fn(() => acquired.promise) };
      const controller = new AbortController();
      const failure = new Error("synthetic launch failure");
      let current = true;
      const started = createDeferredCore();
      const launched = createDeferredCore<NodeWorkerLaunchReceipt>();
      const launch = vi.fn((homeDir?: string) => {
        expect(homeDir).toBe(lease.homeDir);
        expect(release).not.toHaveBeenCalled();
        started.resolve();
        return launched.promise;
      });
      const pending = launchWithNodeWorkerPreparedWorkspace({
        workspace,
        request,
        signal: controller.signal,
        isCurrent: () => current,
        launch,
      });
      expect(workspace.acquirePreparedWorkspace).toHaveBeenCalledExactlyOnceWith(request);
      expect(launch).not.toHaveBeenCalled();
      if (outcome === "closed") {
        current = false;
      } else if (outcome === "aborted") {
        controller.abort(failure);
      }
      acquired.resolve(lease);
      if (outcome === "completed" || outcome === "failed") {
        await started.promise;
        expect(release).not.toHaveBeenCalled();
        if (outcome === "failed") {
          launched.reject(failure);
        } else {
          launched.resolve(receipt);
        }
      }
      if (outcome === "completed") {
        await expect(pending).resolves.toBe(receipt);
      } else if (outcome === "closed") {
        await expect(pending).rejects.toThrow("node worker environment is stopping");
      } else {
        await expect(pending).rejects.toBe(failure);
      }
      expect(launch).toHaveBeenCalledTimes(outcome === "completed" || outcome === "failed" ? 1 : 0);
      expect(release).toHaveBeenCalledOnce();
    },
  );
});
