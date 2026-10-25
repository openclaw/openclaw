import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { insertRegistryWorktree, updateRegistryWorktree } from "../agents/worktrees/registry.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import {
  getRuntimeConfig,
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
} from "../config/config.js";
import { resolveSessionStorePathCore } from "../config/sessions.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import {
  WorkerDispatchTargetChangedError,
  resolveWorkerPlacementSessionTarget,
  type WorkerPlacementSessionRuntime,
} from "./server-worker-placement-session-target.js";
import { resolveGatewaySessionStoreTargetInWorker } from "./session-utils-store-worker.js";
import { resolveCanonicalSessionEntryFromStoreKeys } from "./session-utils-store.js";
import { WorkerPlacementWorkspaceUnavailableError } from "./worker-environments/placement-workspace-unavailable.js";

afterEach(() => resetConfigRuntimeState());

const sessionRuntime = (
  findLiveByOwner: WorkerPlacementSessionRuntime["managedWorktrees"]["findLiveByOwner"],
): WorkerPlacementSessionRuntime => ({
  resolveGatewaySessionStoreTargetInWorker,
  resolveCanonicalSessionEntryFromStoreKeys,
  managedWorktrees: { findLiveByOwner },
});

const createWorktree = (name: string, ownerId: string) =>
  managedWorktrees.createEmpty({
    name,
    ownerKind: "session",
    ownerId,
    runSetupScript: false,
    provisionIgnoredFiles: false,
  });

const worktreeEntry = ({
  id,
  branch,
  repoRoot,
}: NonNullable<InternalSessionEntry["worktree"]>) => ({ id, branch, repoRoot });

function targetFixture(sessionKey: string) {
  const identity = { agentId: "main", sessionKey, sessionId: sessionKey };
  return {
    identity,
    write: (entry: Partial<InternalSessionEntry>) =>
      replaceSessionEntry(
        {
          ...identity,
          storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
        },
        { sessionId: identity.sessionId, updatedAt: 1, ...entry },
      ),
    select: (runtime: WorkerPlacementSessionRuntime) =>
      resolveWorkerPlacementSessionTarget({
        ...identity,
        config: getRuntimeConfig(),
        errorMessage: "placement source changed",
        sessionRuntime: runtime,
      }),
  };
}

function withEmptyTargetState(name: string, run: () => Promise<void>) {
  return withStateDirEnv(name, () => {
    setRuntimeConfigSnapshot({});
    return run();
  });
}

test("skips registry reads without a worktree binding and observes a newly attached worktree", () =>
  withEmptyTargetState("unbound-placement-", async () => {
    const fixture = targetFixture("agent:main:unbound-placement");
    await targetFixture("agent:main:unrelated").write({});
    const findLiveByOwner = vi.fn((...args: Parameters<typeof managedWorktrees.findLiveByOwner>) =>
      managedWorktrees.findLiveByOwner(...args),
    );
    const runtime = sessionRuntime(findLiveByOwner);
    const target = {
      agentId: fixture.identity.agentId,
      sessionKey: fixture.identity.sessionKey,
      storePath: resolveOpenClawAgentSqlitePath({ agentId: "main" }),
    };
    for (const entry of [undefined, {}]) {
      if (entry) {
        await fixture.write(entry);
      }
      const unavailable = fixture.select(runtime);
      await expect(unavailable).rejects.toBeInstanceOf(WorkerPlacementWorkspaceUnavailableError);
      await expect(unavailable).rejects.toMatchObject({ target });
    }
    const expectedTarget = await resolveGatewaySessionStoreTargetInWorker({
      cfg: getRuntimeConfig(),
      key: target.sessionKey,
      agentId: target.agentId,
      projection: "full",
    });
    await expect(
      resolveWorkerPlacementSessionTarget({
        ...fixture.identity,
        config: getRuntimeConfig(),
        errorMessage: "placement source changed",
        sessionRuntime: runtime,
        expectedTarget,
      }),
    ).rejects.toBeInstanceOf(WorkerDispatchTargetChangedError);
    expect(findLiveByOwner).not.toHaveBeenCalled();

    const worktree = await createWorktree("newly-attached", fixture.identity.sessionKey);
    await fixture.write({ worktree: worktreeEntry(worktree) });
    using resolved = await fixture.select(runtime);
    expect(resolved.workspace).toEqual({ kind: "local", path: worktree.path });
    expect(() => resolved.assertCurrent()).not.toThrow();
  }));

test("captures the physical owner of an unavailable session in a shared store", () =>
  withStateDirEnv("shared-unavailable-placement-", async ({ stateDir }) => {
    const storePath = path.join(stateDir, "shared.sqlite");
    const config = { agents: { entries: { main: {}, ops: {} } }, session: { store: storePath } };
    setRuntimeConfigSnapshot(config);
    await replaceSessionEntry(
      { agentId: "main", storePath, sessionKey: "agent:main:shared" },
      { sessionId: "main-shared", updatedAt: 1 },
    );
    const identity = { agentId: "ops", sessionKey: "agent:ops:shared", sessionId: "ops-shared" };
    await replaceSessionEntry(
      { ...identity, storePath },
      { sessionId: identity.sessionId, updatedAt: 1 },
    );
    const unavailable = resolveWorkerPlacementSessionTarget({
      ...identity,
      config,
      errorMessage: "placement source changed",
      sessionRuntime: sessionRuntime((...args) => managedWorktrees.findLiveByOwner(...args)),
    });
    await expect(unavailable).rejects.toBeInstanceOf(WorkerPlacementWorkspaceUnavailableError);
    await expect(unavailable).rejects.toMatchObject({
      target: { agentId: "main", storePath, sessionKey: identity.sessionKey },
    });
  }));

test.each(["missing", "replacement"] as const)(
  "classifies a %s local worktree without losing restoration to the captured session",
  (change) =>
    withEmptyTargetState("unavailable-local-placement-", async () => {
      const fixture = targetFixture("agent:main:unavailable-local");
      const original = await createWorktree("unavailable-local", fixture.identity.sessionKey);
      await fixture.write({ worktree: worktreeEntry(original) });
      if (change === "missing") {
        await updateRegistryWorktree(process.env, original.id, { removedAt: 1 });
      } else {
        await insertRegistryWorktree(process.env, {
          ...original,
          id: "replacement-local",
          createdAt: original.createdAt + 1,
        });
      }
      const runtime = sessionRuntime((...args) => managedWorktrees.findLiveByOwner(...args));
      const unavailable = fixture.select(runtime);
      await expect(unavailable).rejects.toBeInstanceOf(WorkerPlacementWorkspaceUnavailableError);
      await expect(unavailable).rejects.toMatchObject({
        target: {
          agentId: fixture.identity.agentId,
          sessionKey: fixture.identity.sessionKey,
          storePath: resolveOpenClawAgentSqlitePath({ agentId: "main" }),
          worktreeId: original.id,
        },
      });
      await updateRegistryWorktree(
        process.env,
        change === "missing" ? original.id : "replacement-local",
        { removedAt: change === "missing" ? undefined : 1 },
      );
      using resolved = await fixture.select(runtime);
      expect(resolved.workspace).toEqual({ kind: "local", path: original.path });
      resolved.assertCurrent();
    }),
);

test("keeps repository absence transient instead of requiring a session or worktree publication", () =>
  withEmptyTargetState("unavailable-repository-placement-", async () => {
    const fixture = targetFixture("agent:main:unavailable-repository");
    await fixture.write({ repositoryWorkspaceId: "absent-repository" });
    const unavailable = fixture.select(
      sessionRuntime((...args) => managedWorktrees.findLiveByOwner(...args)),
    );
    await expect(unavailable).rejects.toThrow("placement source changed");
    await expect(unavailable).rejects.not.toBeInstanceOf(WorkerPlacementWorkspaceUnavailableError);
  }));

test("prepares concurrent empty workspaces while another session registers its checkout", () =>
  withEmptyTargetState("concurrent-empty-placement-", async () => {
    const first = targetFixture("agent:main:first-empty");
    const second = targetFixture("agent:main:second-empty");
    const firstWorktree = await createWorktree("first-empty", first.identity.sessionKey);
    await first.write({ worktree: worktreeEntry(firstWorktree) });
    const read = createDeferred();
    const release = createDeferred();
    const pending = first.select(
      sessionRuntime(async (...args) => {
        const worktree = await managedWorktrees.findLiveByOwner(...args);
        read.resolve();
        await release.promise;
        return worktree;
      }),
    );
    void pending.catch(() => {});
    try {
      await awaitGateBeforeSettlement(read.promise, pending, "Workspace read never started");
      const secondWorktree = await createWorktree("second-empty", second.identity.sessionKey);
      await second.write({ worktree: worktreeEntry(secondWorktree) });
      using secondTarget = await second.select(
        sessionRuntime((...args) => managedWorktrees.findLiveByOwner(...args)),
      );
      release.resolve();
      using firstTarget = await pending;
      expect(firstTarget.workspace).toEqual({ kind: "local", path: firstWorktree.path });
      expect(secondTarget.workspace).toEqual({ kind: "local", path: secondWorktree.path });
      expect(() => firstTarget.assertCurrent()).not.toThrow();
      expect(() => secondTarget.assertCurrent()).not.toThrow();
    } finally {
      release.resolve();
      (await pending.catch(() => undefined))?.[Symbol.dispose]();
    }
  }));

test.each(["removal", "repository", "replacement"] as const)(
  "refuses an empty workspace whose own %s changes during preparation",
  (change) =>
    withEmptyTargetState("changed-empty-placement-", async () => {
      const fixture = targetFixture("agent:main:changed-empty");
      const original = await createWorktree("changed-empty", fixture.identity.sessionKey);
      await fixture.write({ worktree: worktreeEntry(original) });
      const pending = fixture.select(
        sessionRuntime(async (...args) => {
          const worktree = await managedWorktrees.findLiveByOwner(...args);
          if (change === "replacement") {
            await insertRegistryWorktree(process.env, {
              ...original,
              id: "replacement-empty",
              createdAt: original.createdAt + 1,
            });
          } else {
            await updateRegistryWorktree(
              process.env,
              original.id,
              change === "removal"
                ? { removedAt: 1 }
                : {
                    repositoryIdentity: {
                      repoRoot: `${original.repoRoot}-changed`,
                      repoFingerprint: original.repoFingerprint,
                    },
                  },
            );
          }
          return worktree;
        }),
      );
      await expect(pending).rejects.toThrow(
        "Spawn parent managed worktree changed; retry from its current session",
      );
      await expect(pending).rejects.not.toBeInstanceOf(WorkerPlacementWorkspaceUnavailableError);
    }),
);
