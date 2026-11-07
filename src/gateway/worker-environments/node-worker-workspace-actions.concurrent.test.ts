import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { observeSettlement } from "../../infra/sqlite-readonly.test-support.js";
import { workspaceCommandResult, workspaceTransfer } from "./node-worker-tunnel.test-support.js";
import { createNodeWorkerWorkspaceActions } from "./node-worker-workspace-actions.js";
import { emptyJournal } from "./workspace-manifest-fixtures.test-support.js";

it.for(["journal", "upload", "both", "authority"] as const)(
  "joins local recovery and remote upload before releasing a failed %s preparation",
  async (failedSide, { signal }) => {
    const journal = createDeferred<undefined>();
    const upload = createDeferred();
    const settlements = [journal, upload].map(({ promise }) => observeSettlement(promise));
    const uploadStarted = createDeferred();
    const authority = new AbortController();
    const failure = new Error(`${failedSide} failed`);
    const takeUpload = vi.fn((): never => {
      throw new Error("failed preparation must not consume staging");
    });
    const revoke = vi.fn(async () => {
      expect(settlements.map(({ settled }) => settled)).toEqual([true, true]);
    });
    const binding = {
      manifestRef: "sha256:" + "a".repeat(64),
      source: { kind: "local" as const, path: "/gateway/workspace" },
      remoteWorkspaceDir: "/worker/workspace",
    };
    const actions = createNodeWorkerWorkspaceActions({
      environmentId: "environment-1",
      ownerEpoch: 1,
      sessionId: "session-1",
      ownerSignal: new AbortController().signal,
      isOwnerCurrent: () => true,
      restoredWorkspace: binding,
      workspaceTransfer: workspaceTransfer({
        prepareUpload: () => "upload-token",
        takeUpload,
        revoke,
      }),
      runWorkspaceCommand: async () => {
        uploadStarted.resolve();
        await upload.promise;
        return workspaceCommandResult(binding.remoteWorkspaceDir);
      },
    });
    const operation = actions.reconcileWorkspace({
      remoteWorkspaceDir: binding.remoteWorkspaceDir,
      baseManifestRef: binding.manifestRef,
      source: {
        ...binding.source,
        assertCurrent: () => authority.signal.throwIfAborted(),
        journal: emptyJournal({ load: () => journal.promise }),
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
      if (failedSide === "authority") {
        authority.abort(failure);
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
