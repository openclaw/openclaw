import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import { captureSessionEntrySourceAssertion } from "../../config/sessions/session-entry-source-authority.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { runExclusiveSessionLifecycleMutation } from "../../sessions/session-lifecycle-admission.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { restoreArchivedDispatchSession } from "./dispatch-from-config.archive-recovery.js";
import { createReplyOperation, replyRunRegistry } from "./reply-run-registry.js";
import { buildTestCtx } from "./test-ctx.js";

const sourceKey = "agent:main:discord:slash:worker-user";
const targetKey = "agent:main:discord:channel:worker-room";
let state: OpenClawTestState | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  await state?.cleanup();
  state = undefined;
});

async function prepare(crossStore = false) {
  state = await createOpenClawTestState({ label: "native-archive-recovery" });
  const storePath = path.join(state.sessionsDir(), "sessions.json");
  const targetStorePath = crossStore
    ? path.join(state.sessionsDir("work"), "sessions.json")
    : storePath;
  const commandTargetKey = crossStore ? "agent:work:discord:channel:worker-room" : targetKey;
  const sourceScope = { agentId: "main", sessionKey: sourceKey, storePath };
  const targetScope = {
    agentId: crossStore ? "work" : "main",
    sessionKey: commandTargetKey,
    storePath: targetStorePath,
  };
  const source: SessionEntry = { sessionId: "hidden-history", updatedAt: 1, archivedAt: 2 };
  const target: SessionEntry = { sessionId: "conversation-history", updatedAt: 1 };
  replaceSessionEntrySync(sourceScope, source);
  replaceSessionEntrySync(targetScope, target);
  const targetGuard = captureSessionEntrySourceAssertion({
    scope: targetScope,
    expected: target,
    fields: ["sessionId", "archivedAt", "pluginOwnerId", "lifecycleRevision"],
    assertCurrent: () => {},
    refuse: () => {
      throw new Error("stale command target");
    },
  });
  const ctx = buildTestCtx({
    Provider: "discord",
    Surface: "discord",
    SessionKey: sourceKey,
    CommandTargetSessionKey: commandTargetKey,
    CommandAuthorized: true,
    CommandTurn: {
      kind: "native",
      source: "native",
      authorized: true,
      commandName: "compact",
      body: "/compact",
    },
    InboundAccessAuthorized: true,
    InboundEventKind: "user_request",
    InputProvenance: { kind: "external_user", sourceChannel: "discord" },
  });
  return { ctx, source, target, targetGuard, sourceScope, targetScope };
}

it("refuses a worker-committed source restore when a direct writer replaces the target", async () => {
  expect(isMainThread).toBe(true);
  const fixture = await prepare();
  let placementReads = 0;
  const placementContext = {
    workerSessionPlacementService: {
      getMany: () => new Map(),
      getManyAsync: async () => {
        placementReads += 1;
        replaceSessionEntrySync(fixture.targetScope, {
          ...fixture.target,
          sessionId: "replacement-conversation",
        });
        return new Map();
      },
    },
  };
  await expect(
    restoreArchivedDispatchSession({
      ctx: fixture.ctx,
      entry: fixture.source,
      hasPluginOwnedBinding: false,
      allowNativeCommandRestore: true,
      additionalCommitGuard: fixture.targetGuard,
      targetMutationScope: {
        sessionKey: targetKey,
        storePath: fixture.sourceScope.storePath,
        expected: fixture.target,
      },
      requireSnapshotMatch: true,
      placementContext,
      sessionKey: sourceKey,
      storePath: fixture.sourceScope.storePath,
    }),
  ).rejects.toThrow("stale command target");
  expect(placementReads).toBeGreaterThan(0);
  expect(loadSessionEntryReadOnly(fixture.targetScope)?.sessionId).toBe("replacement-conversation");
  expect(loadSessionEntryReadOnly(fixture.sourceScope)?.archivedAt).toBe(2);
});

it("keeps the durable source archived when command authority expires during placement", async () => {
  expect(isMainThread).toBe(true);
  const fixture = await prepare();
  let current = true;
  await expect(
    restoreArchivedDispatchSession({
      ctx: fixture.ctx,
      entry: fixture.source,
      hasPluginOwnedBinding: false,
      allowNativeCommandRestore: true,
      additionalCommitGuard: fixture.targetGuard,
      targetMutationScope: {
        sessionKey: fixture.targetScope.sessionKey,
        storePath: fixture.targetScope.storePath,
        expected: fixture.target,
      },
      assertCurrent: () => {
        if (!current) {
          throw new Error("command owner revoked");
        }
      },
      requireSnapshotMatch: true,
      placementContext: {
        workerSessionPlacementService: {
          getMany: () => new Map(),
          getManyAsync: async () => {
            current = false;
            return new Map();
          },
        },
      },
      sessionKey: sourceKey,
      storePath: fixture.sourceScope.storePath,
    }),
  ).rejects.toThrow("command owner revoked");
  expect(loadSessionEntryReadOnly(fixture.sourceScope)?.archivedAt).toBe(2);
});

it("holds target lifecycle changes behind a busy target run until worktree restore settles", async ({
  signal,
}) => {
  expect(isMainThread).toBe(true);
  const fixture = await prepare(true);
  const worktreeEntry: SessionEntry = {
    ...fixture.source,
    worktree: { id: "held-worktree", branch: "test", repoRoot: state!.root },
  };
  replaceSessionEntrySync(fixture.sourceScope, worktreeEntry);
  const entered = createDeferred();
  const release = createDeferred();
  const worktree = await import("../../sessions/session-worktree-lifecycle.js");
  vi.spyOn(worktree, "restoreSessionWorktree").mockImplementation(async () => {
    entered.resolve();
    await release.promise;
    return () => {};
  });
  const targetOperation = createReplyOperation({
    sessionKey: fixture.targetScope.sessionKey,
    sessionId: fixture.target.sessionId,
    resetTriggered: false,
  });
  try {
    const restoring = restoreArchivedDispatchSession({
      ctx: fixture.ctx,
      entry: worktreeEntry,
      hasPluginOwnedBinding: false,
      allowNativeCommandRestore: true,
      additionalCommitGuard: fixture.targetGuard,
      targetMutationScope: {
        sessionKey: fixture.targetScope.sessionKey,
        storePath: fixture.targetScope.storePath,
        expected: fixture.target,
      },
      requireSnapshotMatch: true,
      placementContext: { workerSessionPlacementService: { getMany: () => new Map() } },
      sessionKey: sourceKey,
      storePath: fixture.sourceScope.storePath,
    });
    await withinTest(
      awaitGateBeforeSettlement(entered.promise, restoring, "worktree restore was not reached"),
      signal,
    );
    expect(replyRunRegistry.get(fixture.targetScope.sessionKey)).toBe(targetOperation);
    let targetMutationRan = false;
    const targetMutation = runExclusiveSessionLifecycleMutation("archive", {
      scope: fixture.targetScope.storePath,
      identities: [fixture.targetScope.sessionKey, fixture.target.sessionId],
      run: async () => {
        targetMutationRan = true;
        replaceSessionEntrySync(fixture.targetScope, {
          ...fixture.target,
          archivedAt: 3,
        });
      },
    });
    await Promise.resolve();
    expect(targetMutationRan).toBe(false);
    expect(loadSessionEntryReadOnly(fixture.targetScope)?.archivedAt).toBeUndefined();
    release.resolve();
    await withinTest(restoring, signal);
    await withinTest(targetMutation, signal);
    expect(targetMutationRan).toBe(true);
    expect(loadSessionEntryReadOnly(fixture.sourceScope)?.archivedAt).toBeUndefined();
    expect(loadSessionEntryReadOnly(fixture.targetScope)?.archivedAt).toBe(3);
  } finally {
    release.resolve();
    targetOperation.complete();
  }
});

it("refuses a target changed before fence acquisition without restoring the worktree", async ({
  signal,
}) => {
  expect(isMainThread).toBe(true);
  const fixture = await prepare();
  const worktreeEntry: SessionEntry = {
    ...fixture.source,
    worktree: { id: "unrestored-worktree", branch: "test", repoRoot: state!.root },
  };
  replaceSessionEntrySync(fixture.sourceScope, worktreeEntry);
  const worktree = await import("../../sessions/session-worktree-lifecycle.js");
  const worktreeRestore = vi
    .spyOn(worktree, "restoreSessionWorktree")
    .mockImplementation(async () => {
      throw new Error("worktree restore must not start for a changed target");
    });
  const entered = createDeferred();
  const release = createDeferred();
  const changingTarget = runExclusiveSessionLifecycleMutation("archive", {
    scope: fixture.targetScope.storePath,
    identities: [fixture.targetScope.sessionKey, fixture.target.sessionId],
    run: async () => {
      entered.resolve();
      await release.promise;
      replaceSessionEntrySync(fixture.targetScope, { ...fixture.target, archivedAt: 3 });
    },
  });
  try {
    await withinTest(
      awaitGateBeforeSettlement(
        entered.promise,
        changingTarget,
        "target mutation did not acquire the fence",
      ),
      signal,
    );
    const restoring = restoreArchivedDispatchSession({
      ctx: fixture.ctx,
      entry: worktreeEntry,
      hasPluginOwnedBinding: false,
      allowNativeCommandRestore: true,
      additionalCommitGuard: fixture.targetGuard,
      targetMutationScope: {
        sessionKey: fixture.targetScope.sessionKey,
        storePath: fixture.targetScope.storePath,
        expected: fixture.target,
      },
      requireSnapshotMatch: true,
      placementContext: { workerSessionPlacementService: { getMany: () => new Map() } },
      sessionKey: sourceKey,
      storePath: fixture.sourceScope.storePath,
    });
    release.resolve();
    await withinTest(changingTarget, signal);
    await expect(restoring).rejects.toThrow("Command target changed");
    expect(worktreeRestore).not.toHaveBeenCalled();
    expect(loadSessionEntryReadOnly(fixture.sourceScope)?.archivedAt).toBe(2);
    await withinTest(
      runExclusiveSessionLifecycleMutation("restore", {
        targets: [
          { scope: fixture.sourceScope.storePath, identities: [sourceKey] },
          { scope: fixture.targetScope.storePath, identities: [fixture.targetScope.sessionKey] },
        ],
        run: async () => {},
      }),
      signal,
    );
  } finally {
    release.resolve();
  }
});
