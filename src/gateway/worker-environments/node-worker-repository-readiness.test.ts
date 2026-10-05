import { expect, it, vi } from "vitest";
import type { NodeWorkerWorkspaceExecResult } from "../../worker/node-workspace-protocol.js";
import { createNodeRepositoryReadiness } from "./node-worker-repository-readiness.js";

it.each(["publication", "revocation"] as const)(
  "settles dependent waiters after %s fails",
  async (failure) => {
    let current = true;
    const run = vi.fn(async (): Promise<NodeWorkerWorkspaceExecResult> => ({
      workspaceDir: "/worker/workspace",
      code: 0,
      stdout: "pending\n",
      stderr: "",
      killed: false,
      signal: null,
      termination: "exit",
    }));
    const owner = createNodeRepositoryReadiness({
      signal: new AbortController().signal,
      assertCurrent: () => {
        if (!current) {
          throw new Error("fixture owner revoked");
        }
      },
      run,
    });
    await owner.prepare({
      sessionKey: "agent:main:fixture",
      assertCurrent: () => {},
      repository: {
        workspaceId: "fixture",
        agentId: "main",
        sessionKey: "agent:main:fixture",
        url: "https://github.com/fixture/repo.git",
        requestedRef: "topic",
        branch: "fixture/topic",
        baseCommit: null,
        baseManifestHash: null,
        checkpointRef: null,
        manifestHash: null,
        revision: 1,
        runSetupScript: false,
        createdAtMs: 1,
        updatedAtMs: 1,
      },
    });
    const waiting = owner.wait();
    void waiting.catch(() => undefined);
    if (failure === "publication") {
      run.mockRejectedValueOnce(new Error("fixture publication failed"));
    } else {
      current = false;
    }
    await expect(
      owner.settle(failure === "publication" ? "ready" : "failed", "a".repeat(40)),
    ).rejects.toThrow();
    await expect(waiting).rejects.toThrow();
    await expect(owner.wait()).rejects.toThrow();
  },
);
