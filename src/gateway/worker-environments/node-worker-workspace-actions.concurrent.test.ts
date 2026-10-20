import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { workspaceCommandResult, workspaceTransfer } from "./node-worker-tunnel.test-support.js";
import { createNodeWorkerWorkspaceActions } from "./node-worker-workspace-actions.js";

function trackedDeferred<T = void>() {
  const deferred = createDeferred<T>();
  const tracked = { ...deferred, settled: false };
  tracked.promise = deferred.promise.finally(() => {
    tracked.settled = true;
  });
  return tracked;
}

it.for(["journal", "upload", "both", "authority"] as const)(
  "joins local recovery and remote upload before releasing a failed %s preparation",
  async (failedSide, { signal }) => {
    const journal = trackedDeferred<undefined>();
    const upload = trackedDeferred();
    const uploadStarted = createDeferred();
    let current = true;
    const failure = new Error(`${failedSide} failed`);
    const takeUpload = vi.fn((): never => {
      throw new Error("failed preparation must not consume staging");
    });
    const revoke = vi.fn(async () => {
      expect([journal.settled, upload.settled]).toEqual([true, true]);
    });
    const manifestRef = "sha256:" + "a".repeat(64);
    const source = { kind: "local" as const, path: "/gateway/workspace" };
    const remoteWorkspaceDir = "/worker/workspace";
    const actions = createNodeWorkerWorkspaceActions({
      environmentId: "environment-1",
      ownerEpoch: 1,
      sessionId: "session-1",
      ownerSignal: new AbortController().signal,
      isOwnerCurrent: () => true,
      restoredWorkspace: {
        source,
        remoteWorkspaceDir,
        manifestRef,
      },
      workspaceTransfer: workspaceTransfer({
        prepareUpload: () => "upload-token",
        takeUpload,
        revoke,
      }),
      runWorkspaceCommand: async () => {
        uploadStarted.resolve();
        await upload.promise;
        return workspaceCommandResult(remoteWorkspaceDir);
      },
    });
    const operation = actions.reconcileWorkspace({
      remoteWorkspaceDir,
      baseManifestRef: manifestRef,
      source: {
        ...source,
        assertCurrent: () => {
          if (!current) {
            throw failure;
          }
        },
        journal: {
          load: () => journal.promise,
          begin: async () => {},
          commit: async () => {},
          abort: async () => {},
        },
        stagedResult: { ref: "refs/openclaw/worker-results/overlap", record: () => {} },
      },
    });
    const outcome = operation.catch((error: unknown) => error);
    try {
      if (failedSide === "journal") {
        journal.reject(failure);
      } else if (failedSide === "authority") {
        journal.resolve(undefined);
      }
      await withinTest(
        awaitGateBeforeSettlement(uploadStarted.promise, operation, "upload never started"),
        signal,
      );
      expect(takeUpload).not.toHaveBeenCalled();
      expect(revoke).not.toHaveBeenCalled();
      if (failedSide === "authority") {
        current = false;
      }
      if (failedSide === "upload" || failedSide === "both") {
        upload.reject(failedSide === "both" ? new Error("upload failed first") : failure);
        if (failedSide === "both") {
          journal.reject(failure);
        } else {
          journal.resolve(undefined);
        }
      } else {
        upload.resolve();
      }
      expect(await outcome).toBe(failure);
      expect(takeUpload).not.toHaveBeenCalled();
      expect(revoke).toHaveBeenCalledExactlyOnceWith("environment-1", "upload-token");
    } finally {
      journal.resolve(undefined);
      upload.resolve();
      await operation.catch(() => {});
    }
  },
);
