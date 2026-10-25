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
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import {
  resolveWorkerPlacementSessionTarget,
  type WorkerPlacementSessionRuntime,
} from "./server-worker-placement-session-target.js";
import { resolveGatewaySessionStoreTargetInWorker } from "./session-utils-store-worker.js";
import { resolveCanonicalSessionEntryFromStoreKeys } from "./session-utils-store.js";

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
    await fixture.write({});
    const findLiveByOwner = vi.fn((...args: Parameters<typeof managedWorktrees.findLiveByOwner>) =>
      managedWorktrees.findLiveByOwner(...args),
    );
    const runtime = sessionRuntime(findLiveByOwner);
    for (let sweep = 0; sweep < 3; sweep++) {
      await expect(fixture.select(runtime)).rejects.toThrow("placement source changed");
    }
    expect(findLiveByOwner).not.toHaveBeenCalled();

    const worktree = await createWorktree("newly-attached", fixture.identity.sessionKey);
    await fixture.write({ worktree: worktreeEntry(worktree) });
    using resolved = await fixture.select(runtime);
    expect(resolved.workspace).toEqual({ kind: "local", path: worktree.path });
    expect(() => resolved.assertCurrent()).not.toThrow();
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
      await expect(
        fixture.select(
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
        ),
      ).rejects.toThrow("Spawn parent managed worktree changed; retry from its current session");
    }),
);
