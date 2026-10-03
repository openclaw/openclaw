import { describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { workspaceTransfer } from "./node-worker-tunnel.test-support.js";
import { createNodeWorkerWorkspaceActions } from "./node-worker-workspace-actions.js";

describe("node workspace preparation", () => {
  it.for(["journal", "upload", "both", "authority"] as const)(
    "joins local recovery and remote upload before releasing a failed %s preparation",
    async (failedSide, { signal }) => {
      const journal = createDeferred<undefined>();
      const upload = createDeferred();
      const uploadStarted = createDeferred();
      let journalSettled = false;
      let uploadSettled = false;
      let current = true;
      const failure = new Error(`${failedSide} failed`);
      const takeUpload = vi.fn((): never => {
        throw new Error("failed preparation must not consume staging");
      });
      const revoke = vi.fn(async () => {
        expect(journalSettled).toBe(true);
        expect(uploadSettled).toBe(true);
      });
      const manifestRef = "sha256:" + "a".repeat(64);
      const actions = createNodeWorkerWorkspaceActions({
        environmentId: "environment-1",
        ownerEpoch: 1,
        sessionId: "session-1",
        ownerSignal: new AbortController().signal,
        isOwnerCurrent: () => true,
        restoredWorkspace: {
          source: { kind: "local", path: "/gateway/workspace" },
          remoteWorkspaceDir: "/worker/workspace",
          manifestRef,
        },
        workspaceTransfer: workspaceTransfer({
          prepareUpload: () => "upload-token",
          takeUpload,
          revoke,
        }),
        runWorkspaceCommand: async () => {
          uploadStarted.resolve();
          try {
            await upload.promise;
            return {
              workspaceDir: "/worker/workspace",
              code: 0,
              stdout: "",
              stderr: "",
              signal: null,
              killed: false,
              termination: "exit",
            };
          } finally {
            uploadSettled = true;
          }
        },
      });
      const operation = actions.reconcileWorkspace({
        remoteWorkspaceDir: "/worker/workspace",
        baseManifestRef: manifestRef,
        source: {
          kind: "local",
          path: "/gateway/workspace",
          assertCurrent: () => {
            if (!current) {
              throw failure;
            }
          },
          journal: {
            load: async () => {
              try {
                return await journal.promise;
              } finally {
                journalSettled = true;
              }
            },
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
          upload.resolve();
        } else if (failedSide !== "journal") {
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
});
