import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
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
  const restore = (overrides: Partial<Parameters<typeof restoreArchivedDispatchSession>[0]> = {}) =>
    restoreArchivedDispatchSession({
      ctx,
      entry: source,
      hasPluginOwnedBinding: false,
      allowNativeCommandRestore: true,
      additionalCommitGuard: targetGuard,
      targetMutationScope: {
        sessionKey: targetScope.sessionKey,
        storePath: targetScope.storePath,
        expected: target,
      },
      requireSnapshotMatch: true,
      placementContext: { workerSessionPlacementService: { getMany: () => new Map() } },
      sessionKey: sourceKey,
      storePath: sourceScope.storePath,
      ...overrides,
    });
  return { source, target, sourceScope, targetScope, restore };
}

it("reads the durable archived source through the worker on the host thread", async () => {
  expect(isMainThread).toBe(true);
  const fixture = await prepare();
  vi.spyOn(sessionAccessor, "loadSessionEntryReadOnly").mockImplementation(() => {
    throw new Error("Gateway-thread source read");
  });
  const restored = await fixture.restore({
    additionalCommitGuard: undefined,
    targetMutationScope: undefined,
  });
  expect(restored?.archivedAt).toBeUndefined();
  vi.restoreAllMocks();
  expect(loadSessionEntryReadOnly(fixture.sourceScope)?.archivedAt).toBeUndefined();
});

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
  await expect(fixture.restore({ placementContext })).rejects.toThrow("stale command target");
  expect(placementReads).toBeGreaterThan(0);
  expect(loadSessionEntryReadOnly(fixture.targetScope)?.sessionId).toBe("replacement-conversation");
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
    const restoring = fixture.restore({
      entry: worktreeEntry,
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
    const restoring = fixture.restore({
      entry: worktreeEntry,
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
