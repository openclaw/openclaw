import fs from "node:fs/promises";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, test, vi } from "vitest";
import type { SessionPlacementAdmissionProvider } from "../agents/session-placement-admission.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import {
  creationIntent,
  expectEmptyCreation,
  operationFixture,
  operationRequest,
  successfulCreation,
} from "./server.sessions.create.operations.test-support.js";
import { setupSessionCreateHandlerTestHarness } from "./server.sessions.create.test-support.js";
import type { WorkerPlacementDispatchContract } from "./worker-environments/service-contract.js";

const { createSessionStoreDir } = setupSessionCreateHandlerTestHarness();
const requiredWorkers = {
  requiredProfile: "durable-device",
  profiles: {
    "durable-device": {
      provider: "device",
      settings: { device: "synthetic-node", inference: "worker" },
    },
  },
};
const repository = { url: "https://github.com/openclaw/openclaw.git", ref: "main" };

test("worker purposes require configured placement and exactly their workspace source", async () => {
  const f = await operationFixture(createSessionStoreDir);
  const params = creationIntent();
  for (const purpose of ["investigation", "coding"] as const) {
    const input = { ...params, purpose, ...(purpose === "coding" ? { repository } : {}) };
    expect(await operationRequest(f.context, f.client, "sessions.create", input)).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: expect.stringMatching(/required worker profile/i),
      },
    });
  }
  const config = f.getConfig();
  f.setConfig({ ...config, cloudWorkers: { requiredProfile: "missing-profile" } });
  expect(
    await operationRequest(f.context, f.client, "sessions.create", {
      ...params,
      purpose: "investigation",
    }),
  ).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
  f.setConfig({ ...config, cloudWorkers: requiredWorkers });
  for (const selection of [
    { purpose: "coding" },
    { purpose: "investigation", repository },
    { purpose: "investigation", cwd: "/not-an-authorized-source" },
  ]) {
    expect(
      await operationRequest(f.context, f.client, "sessions.create", { ...params, ...selection }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
  }
  expect(
    loadSessionEntry({
      sessionKey: "agent:main:dashboard:" + params.sessionId,
      storePath: f.storePath,
    }),
  ).toBeUndefined();
});

// Real creation, repository registry and managed-worktree owners. Only the
// external worker-preparation boundary is fixed; no provider credentials/turns.
test.each(["investigation", "coding"] as const)(
  "%s replay preserves its owned workspace and never restarts failed placement",
  async (purpose) => {
    const f = await operationFixture(createSessionStoreDir, requiredWorkers);
    const params = {
      ...creationIntent(),
      purpose,
      ...(purpose === "coding" ? { repository } : {}),
      idempotencyKey: "worker-lost-reply",
    };
    const key = "agent:main:dashboard:" + params.sessionId;
    const withRequiredSession = vi.fn(
      async (
        ...[identity, _task, assertCurrent]: Parameters<
          NonNullable<SessionPlacementAdmissionProvider["withRequiredSession"]>
        >
      ): Promise<never> => {
        assertCurrent?.();
        expect(identity).toEqual({ agentId: "main", sessionKey: key, sessionId: params.sessionId });
        const entry = expectDefined(
          loadSessionEntry({ agentId: "main", sessionKey: key, storePath: f.storePath }),
          "committed before placement",
        );
        if (purpose === "investigation") {
          const workspace = expectDefined(
            await managedWorktrees.findLiveByOwner("session", key),
            "managed empty workspace",
          );
          expect(entry).toMatchObject({
            worktree: { id: workspace.id },
            sessionRoot: workspace.path,
          });
          expect(await fs.readdir(workspace.path)).toEqual([".git"]);
        } else {
          const workspace = expectDefined(
            await getSessionRepositoryWorkspaceStore().find({ agentId: "main", sessionKey: key }),
            "repository workspace owner",
          );
          expect(workspace).toMatchObject({ url: repository.url, requestedRef: "main" });
          expect(entry.repositoryWorkspaceId).toBe(workspace.workspaceId);
          expect(entry.worktree).toBeUndefined();
          expect(entry.sessionRoot).toBeUndefined();
        }
        throw new Error("Synthetic worker offline; explicit dispatch is required.");
      },
    );
    const dispatch = vi.fn<WorkerPlacementDispatchContract["dispatch"]>(async () => {
      throw new Error("Creation must use required placement admission, not manual dispatch.");
    });
    const overrides = { workerPlacementDispatchService: { withRequiredSession, dispatch } };
    try {
      const context = await f.makeContext(overrides);
      const created = successfulCreation(
        await operationRequest(context, f.client, "sessions.create", params),
      );
      expect(created).toMatchObject({
        key,
        sessionId: params.sessionId,
        creationReplayed: false,
        runStarted: false,
        runError: { message: expect.stringContaining("Synthetic worker offline") },
      });
      expect(withRequiredSession).toHaveBeenCalledOnce();
      const target = { agentId: "main", sessionKey: key, storePath: f.storePath };
      const before = expectDefined(loadSessionEntry(target), "accepted worker session");
      if (purpose === "investigation") {
        await fs.writeFile(
          expectDefined(before.sessionRoot, "empty workspace root") + "/retained.txt",
          "accepted work",
        );
      }
      // A fresh context cannot benefit from the first connection's transport cache.
      const replayed = successfulCreation(
        await operationRequest(await f.makeContext(overrides), f.client, "sessions.create", params),
      );
      expect(replayed).toMatchObject({
        key,
        sessionId: params.sessionId,
        creationReplayed: true,
        runStarted: false,
      });
      expect(withRequiredSession).toHaveBeenCalledOnce();
      expect(dispatch).not.toHaveBeenCalled();
      const after = expectDefined(loadSessionEntry(target), "reconciled worker session");
      expect(after.worktree).toEqual(before.worktree);
      expect(after.repositoryWorkspaceId).toBe(before.repositoryWorkspaceId);
      expect(after.sessionRoot).toBe(before.sessionRoot);
      if (purpose === "investigation") {
        expect(
          await fs.readFile(
            expectDefined(after.sessionRoot, "retained workspace") + "/retained.txt",
            "utf8",
          ),
        ).toBe("accepted work");
      } else {
        expect((await getSessionRepositoryWorkspaceStore().find(target))?.workspaceId).toBe(
          before.repositoryWorkspaceId,
        );
      }
      await expectEmptyCreation(f.storePath, key, params.sessionId);
    } finally {
      // Cleanup only the fixture-owned workspace, including a failed assertion.
      const owned = await managedWorktrees.findLiveByOwner("session", key);
      if (owned) {
        await managedWorktrees.remove({
          id: owned.id,
          reason: "test-cleanup",
          allowSnapshotLoss: true,
        });
      }
    }
  },
);
