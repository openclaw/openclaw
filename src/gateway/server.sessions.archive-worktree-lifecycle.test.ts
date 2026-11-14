import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, onTestFinished, test, vi } from "vitest";
import {
  ErrorCodes,
  errorShape,
  type SessionsPatchManyResult,
} from "../../packages/gateway-protocol/src/index.js";
import { captureMethodCall } from "../../test/helpers/capture-method-call.js";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import {
  clearTestEmbeddedRun as clearActiveEmbeddedRun,
  registerTestEmbeddedRun as setActiveEmbeddedRun,
  createEmbeddedRunHandle,
} from "../agents/embedded-agent-runner/runs.test-support.js";
import { WORKTREE_MUTATION_LEASE_SCOPE } from "../agents/worktrees/capacity-contract.js";
import { updateRegistryWorktree } from "../agents/worktrees/registry.js";
import { getRegistryWorktree } from "../agents/worktrees/registry.test-support.js";
import { acquireWorktreeRunLease } from "../agents/worktrees/run-lease.js";
import {
  managedWorktrees,
  ManagedWorktreeService,
  WorktreeSnapshotError,
} from "../agents/worktrees/service.js";
import {
  applySessionEntryLifecycleMutation,
  loadSessionEntry,
  patchSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { recordSessionParticipant } from "../config/sessions/session-accessor.sqlite-participants.native.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import * as sessionLifecycle from "../sessions/session-controller.lifecycle.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawStateLease } from "../state/openclaw-state-lease.js";
import { observeMainThreadReads } from "../test-utils/main-thread-sql-spies.test-support.js";
import { flushPendingSessionsChangedEvents } from "./server-methods/session-change-event.js";
import { worktreesHandlers } from "./server-methods/worktrees.js";
import { isSessionPermissionChangePending } from "./session-permission-change.js";
import { SessionMutationAuthorizationChangedError } from "./session-sharing.js";
import { embeddedRunMock } from "./test-helpers.runtime-state.js";
import {
  directSessionReq,
  loadSeededTranscriptEvents,
  sessionHookMocks,
} from "./test/server-sessions.test-helpers.js";
import { setupGatewaySessionsWorktreeTestHarness } from "./test/server-sessions.worktree-fixture.js";

const { createArchiveWorktreeFixture } = setupGatewaySessionsWorktreeTestHarness();
const execFileAsync = promisify(execFile);

async function archiveFixture() {
  const fixture = await createArchiveWorktreeFixture();
  const { key, sessionId, storePath, worktree } = fixture;
  const scope = { storePath, sessionKey: key };
  const target = { key, expectedSessionId: sessionId };
  const patch = (fields: Record<string, unknown>, opts?: Parameters<typeof directSessionReq>[2]) =>
    directSessionReq("sessions.patch", { ...target, ...fields }, opts);
  return {
    ...fixture,
    scope,
    target,
    patch,
    entry: (sessionKey = key) => loadSessionEntry({ storePath, sessionKey }),
    transcript: () => loadSeededTranscriptEvents(fixture.transcriptScope),
    patchMany: (
      fields: Record<string, unknown>,
      targets = [target],
      opts?: Parameters<typeof directSessionReq<SessionsPatchManyResult>>[2],
    ) =>
      directSessionReq<SessionsPatchManyResult>(
        "sessions.patchMany",
        { targets, patch: fields },
        opts,
      ),
    git: async (...args: string[]) =>
      (await execFileAsync("git", ["-C", worktree.path, ...args])).stdout,
    registry: () => getRegistryWorktree(process.env, worktree.id),
    write: (file: string, text: string) => fs.writeFile(path.join(worktree.path, file), text),
    async expectSnapshot() {
      expect(loadSessionEntry(scope)).toMatchObject({
        sessionId,
        archivedAt: expect.any(Number),
        worktree: { id: worktree.id },
      });
      await expect(fs.access(worktree.path)).rejects.toThrow();
      expect(getRegistryWorktree(process.env, worktree.id)).toMatchObject({
        removedAt: expect.any(Number),
        snapshotRef: expect.stringMatching(/^refs\/openclaw\/snapshots\//),
      });
    },
    async expectFile(file: string, text: string) {
      await expect(fs.readFile(path.join(worktree.path, file), "utf8")).resolves.toBe(text);
    },
    async archive(archived = true) {
      expect(await patch({ archived })).toMatchObject({ ok: true });
    },
    async age() {
      const old = Date.now() - 31 * 24 * 60 * 60 * 1000;
      await patchSessionEntryCore(
        scope,
        (entry) => ({
          ...entry!,
          updatedAt: old,
          lastInteractionAt: old,
          lastActivityAt: old,
          sessionStartedAt: old,
        }),
        { skipMaintenance: true, replaceEntry: true },
      );
      expect(loadSessionEntry(scope)?.updatedAt).toBe(old);
    },
  };
}

async function createPeer() {
  const result = await directSessionReq<{ key: string; sessionId: string }>("sessions.create", {
    agentId: "main",
  });
  expect(result.ok).toBe(true);
  const peer = result.payload!;
  return { ...peer, target: { key: peer.key, expectedSessionId: peer.sessionId } };
}

test("patchMany releases unrelated writes while restore waits for allocation", async ({
  signal,
}) => {
  const fixture = await archiveFixture();
  const { key, cleanupWorktrees } = fixture;
  const peer = await createPeer();
  const batchPeer = await createPeer();
  await fixture.write("draft.txt", "preserved work\n");
  await fixture.archive(true);
  await cleanupWorktrees();
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const operationEntered = createDeferredCore();
  const allocation = withOpenClawStateLease(
    {
      scope: "core:managed-worktrees:create",
      key: "capacity",
      database: { scope: "shared" },
      leaseMs: 60_000,
      waitMs: 5_000,
    },
    async () => {
      entered.resolve();
      await release.promise;
    },
  );
  const originalRestore = captureMethodCall("restore")(ManagedWorktreeService.prototype);
  using _ = vi.spyOn(ManagedWorktreeService.prototype, "restore").mockImplementation(function (
    this: ManagedWorktreeService,
    params,
  ) {
    operationEntered.resolve();
    return originalRestore(this, params);
  });
  let mutation: ReturnType<typeof directSessionReq> | undefined;
  let independent: ReturnType<typeof directSessionReq> | undefined;
  let successor: ReturnType<typeof directSessionReq> | undefined;
  let successorDone = false;
  try {
    await withinTest(
      awaitGateBeforeSettlement(entered.promise, allocation, "allocation lease was not acquired"),
      signal,
    );
    mutation = fixture.patchMany({ archived: false }, [fixture.target, batchPeer.target]);
    await withinTest(
      awaitGateBeforeSettlement(operationEntered.promise, mutation, "restore was not attempted"),
      signal,
    );
    successor = directSessionReq("sessions.patch", { key, label: "Same session" }).then(
      (result) => {
        successorDone = true;
        return result;
      },
    );
    independent = directSessionReq("sessions.patch", {
      key: peer.key,
      label: "Independent session",
    });
    expect(await withinTest(independent, signal)).toMatchObject({ ok: true });
    expect(successorDone).toBe(false);
    expect(fixture.entry()?.archivedAt).toEqual(expect.any(Number));
  } finally {
    release.resolve();
    await Promise.allSettled([allocation, mutation, independent, successor]);
  }
  expect(await mutation).toMatchObject({
    ok: true,
    payload: { outcomes: [{ ok: true }, { ok: true }] },
  });
  expect(await successor).toMatchObject({ ok: true });
  expect(fixture.entry()).toMatchObject({ label: "Same session" });
  expect(fixture.entry()?.archivedAt).toBeUndefined();
  await fixture.expectFile("draft.txt", "preserved work\n");
});

test("unarchive before cleanup preserves the live checkout", async () => {
  const fixture = await archiveFixture();
  const { cleanupWorktrees } = fixture;
  await fixture.write("draft.txt", "never removed\n");
  using remove = vi.spyOn(managedWorktrees, "remove");
  for (const archived of [true, false]) {
    await fixture.archive(archived);
  }
  await cleanupWorktrees();
  expect(remove).not.toHaveBeenCalled();
  expect(fixture.entry()?.archivedAt).toBeUndefined();
  expect(fixture.registry()?.removedAt).toBeUndefined();
  await fixture.expectFile("draft.txt", "never removed\n");
});

test("unarchive waits for cleanup and restores its finalized snapshot", async ({ signal }) => {
  const fixture = await archiveFixture();
  const { cleanupWorktrees } = fixture;
  await fixture.write("draft.txt", "preserved across in-flight cleanup\n");
  await fixture.archive(true);
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const submitted = createDeferredCore();
  const originalRemove = managedWorktrees.remove.bind(managedWorktrees);
  using _ = vi.spyOn(managedWorktrees, "remove").mockImplementationOnce(async (params) => {
    entered.resolve();
    await release.promise;
    return await originalRemove(params);
  });
  const cleanup = cleanupWorktrees();
  let restoreMutation = () => {};
  let unarchive: ReturnType<typeof directSessionReq> | undefined;
  try {
    await withinTest(
      awaitGateBeforeSettlement(entered.promise, cleanup, "cleanup did not enter removal"),
      signal,
    );
    const originalMutation = sessionLifecycle.runSessionMutation;
    const mutation = vi
      .spyOn(sessionLifecycle, "runSessionMutation")
      .mockImplementation((params) => {
        const pending = originalMutation(params);
        submitted.resolve();
        return pending;
      });
    restoreMutation = () => mutation.mockRestore();
    unarchive = fixture.patch({ archived: false });
    await withinTest(
      awaitGateBeforeSettlement(
        submitted.promise,
        unarchive,
        "unarchive did not enter lifecycle admission",
      ),
      signal,
    );
    expect(fixture.entry()?.archivedAt).toEqual(expect.any(Number));
    release.resolve();
    await cleanup;
    expect(await unarchive).toMatchObject({ ok: true });
    expect(fixture.entry()?.archivedAt).toBeUndefined();
    expect(fixture.registry()?.removedAt).toBeUndefined();
    await fixture.expectFile("draft.txt", "preserved across in-flight cleanup\n");
  } finally {
    release.resolve();
    await Promise.allSettled([cleanup, unarchive]);
    restoreMutation();
  }
});

test("patchMany leaves a failed restore's label available to a later target", async () => {
  const fixture = await archiveFixture();
  const { worktree, cleanupWorktrees } = fixture;
  const peer = await createPeer();
  await fixture.archive(true);
  await cleanupWorktrees();
  using _ = vi
    .spyOn(ManagedWorktreeService.prototype, "restore")
    .mockRejectedValueOnce(new Error("checkout unavailable"));
  const result = await fixture.patchMany({ archived: false, label: "Available label" }, [
    fixture.target,
    peer.target,
  ]);
  expect(result).toMatchObject({
    ok: true,
    payload: { outcomes: [{ ok: false, error: { code: "UNAVAILABLE" } }, { ok: true }] },
  });
  expect(result.payload?.outcomes[0]).toMatchObject({
    error: { retryable: true, message: expect.stringContaining("Free disk space") },
  });
  expect(result.payload?.outcomes[0]).not.toMatchObject({
    error: { message: expect.stringMatching(/worktree slot/i) },
  });
  expect(fixture.entry()?.archivedAt).toEqual(expect.any(Number));
  expect(fixture.entry()?.label).not.toBe("Available label");
  expect(fixture.entry(peer.key)?.label).toBe("Available label");
  await expect(fs.access(worktree.path)).rejects.toThrow();
});

test.each(["identity", "label-owner", "participants", "removed"] as const)(
  "patch preserves %s changes during restoration",
  async (change) => {
    const fixture = await archiveFixture();
    const { worktree, cleanupWorktrees, scope } = fixture;
    const peer = await createPeer();
    await fixture.archive(true);
    await cleanupWorktrees();
    const originalRestore = captureMethodCall("restore")(ManagedWorktreeService.prototype);
    using _ = vi
      .spyOn(ManagedWorktreeService.prototype, "restore")
      .mockImplementationOnce(async function (this: ManagedWorktreeService, params) {
        const restored = await originalRestore(this, params);
        // Another supported owner can act after allocation/Git completes, before metadata commits.
        if (change === "identity") {
          await patchSessionEntryCore(scope, () => ({ sessionId: "replacement-session" }), {
            skipMaintenance: true,
          });
        } else if (change === "label-owner") {
          expect(
            await directSessionReq("sessions.patch", { key: peer.key, label: "Requested label" }),
          ).toMatchObject({ ok: true });
        } else if (change === "participants") {
          expect(
            recordSessionParticipant(scope, {
              identity: { type: "agent", id: "participant-agent" },
              promptedAt: 100,
            }),
          ).toBe("inserted");
        } else {
          const respond = vi.fn();
          await worktreesHandlers["worktrees.remove"]!({
            params: { id: worktree.id },
            respond,
          } as never);
          expect(respond).toHaveBeenCalledWith(
            true,
            expect.objectContaining({ removed: true }),
            undefined,
          );
        }
        return restored;
      });
    const result = await fixture.patch({ archived: false, label: "Requested label" });
    const entry = loadSessionEntry(scope);
    const accepted = change === "participants" || change === "removed";
    expect(result.ok).toBe(accepted);
    expect(entry?.archivedAt).toEqual(accepted ? undefined : expect.any(Number));
    if (change === "participants") {
      expect(entry?.participantCount).toBe(1);
    }
    if (!accepted) {
      expect(entry?.label).not.toBe("Requested label");
    }
    if (change === "identity") {
      expect(entry?.sessionId).toBe("replacement-session");
    }
    if (change === "label-owner") {
      expect(fixture.entry(peer.key)?.label).toBe("Requested label");
    }
    if (change === "removed") {
      // Manual checkout removal deliberately leaves conversation metadata and binding intact.
      expect(entry?.worktree?.id).toBe(worktree.id);
      expect(fixture.registry()).toMatchObject({
        removedAt: expect.any(Number),
        snapshotRef: expect.any(String),
      });
      await expect(fs.access(worktree.path)).rejects.toThrow();
    } else {
      await fs.access(worktree.path);
    }
  },
);

test.each(["accepted", "revoked", "replacement"] as const)(
  "patchMany retains earlier permission authority across restore (%s)",
  async (scenario) => {
    const fixture = await archiveFixture();
    const { storePath, worktree, cleanupWorktrees } = fixture;
    const earlier = await createPeer();
    const earlierScope = { storePath, sessionKey: earlier.key };
    await patchSessionEntryCore(earlierScope, () => ({ permissionMode: "guarded" }), {
      skipMaintenance: true,
    });
    await fixture.archive(true);
    await cleanupWorktrees();
    const originalApply = vi.fn(async (_mode: string | null, revoke: () => void) => {
      revoke();
      return true;
    });
    const originalAbort = vi.fn();
    const original = {
      ...createEmbeddedRunHandle({ abort: originalAbort }),
      applyPermissionMode: originalApply,
    };
    const successorApply = vi.fn(async () => true);
    const successorAbort = vi.fn();
    const successor = {
      ...createEmbeddedRunHandle({ abort: successorAbort }),
      applyPermissionMode: successorApply,
    };
    setActiveEmbeddedRun(earlier.sessionId, original, earlier.key);
    embeddedRunMock.activeIds.add(earlier.sessionId);
    const reached = createDeferredCore();
    const release = createDeferredCore();
    const originalRestore = captureMethodCall("restore")(ManagedWorktreeService.prototype);
    using restore = vi
      .spyOn(ManagedWorktreeService.prototype, "restore")
      .mockImplementationOnce(async function (this: ManagedWorktreeService, params) {
        const result = await originalRestore(this, params);
        reached.resolve();
        await release.promise;
        return result;
      });
    let revoked = false;
    const pending = fixture.patchMany(
      { archived: false, permissionMode: "read-only" },
      [earlier.target, fixture.target],
      {
        // Exercise the handler's supplied live-authority contract independently of row equality.
        sessionMutationAuthorization: {
          assertCurrent() {},
          assertTargetCurrent({ sessionKey }) {
            if (revoked && sessionKey === earlier.key) {
              throw new SessionMutationAuthorizationChangedError(
                errorShape(ErrorCodes.FORBIDDEN, "Earlier target authority revoked"),
              );
            }
          },
        },
      },
    );
    try {
      await Promise.race([reached.promise, pending]);
      expect(restore).toHaveBeenCalledOnce();
      expect(isSessionPermissionChangePending(earlier.sessionId)).toBe(true);
      expect(originalApply).not.toHaveBeenCalled();
      expect(loadSessionEntry(earlierScope)?.permissionMode).toBe("guarded");
      expect(fixture.entry()?.archivedAt).toEqual(expect.any(Number));
      if (scenario === "revoked") {
        revoked = true;
      }
      if (scenario === "replacement") {
        setActiveEmbeddedRun(earlier.sessionId, successor, earlier.key);
      }
      release.resolve();
      const result = await pending;
      const forbidden = { ok: false, error: { code: "FORBIDDEN" } };
      const earlierOutcome =
        scenario === "revoked"
          ? forbidden
          : scenario === "accepted"
            ? { ok: true }
            : {
                ok: false,
                error: {
                  code: "UNAVAILABLE",
                  message: expect.stringContaining("Permissions were saved"),
                },
              };
      expect(result).toMatchObject({
        ok: true,
        payload: { outcomes: [earlierOutcome, scenario === "revoked" ? forbidden : { ok: true }] },
      });
      expect(loadSessionEntry(earlierScope)?.permissionMode).toBe(
        scenario === "revoked" ? "guarded" : "read-only",
      );
      expect(fixture.entry()?.archivedAt).toEqual(
        scenario === "revoked" ? expect.any(Number) : undefined,
      );
      expect(originalApply).toHaveBeenCalledTimes(scenario === "accepted" ? 1 : 0);
      expect(originalAbort).not.toHaveBeenCalled();
      expect(successorApply).not.toHaveBeenCalled();
      expect(successorAbort).not.toHaveBeenCalled();
      expect(isSessionPermissionChangePending(earlier.sessionId)).toBe(false);
      await fs.access(worktree.path);
    } finally {
      release.resolve();
      await Promise.allSettled([pending]);
      clearActiveEmbeddedRun(earlier.sessionId, original, earlier.key);
      clearActiveEmbeddedRun(earlier.sessionId, successor, earlier.key);
      embeddedRunMock.activeIds.delete(earlier.sessionId);
    }
  },
);

test.each(["ready", "cleared-selection"] as const)(
  "patch prepares the catalog before restoring dirty work (%s)",
  async (catalogMode) => {
    const fixture = await archiveFixture();
    const { key, worktree, workspace, cleanupWorktrees } = fixture;
    await fixture.write("committed.txt", "unpushed work\n");
    await fixture.git("add", "committed.txt");
    await fixture.git("commit", "-m", "session work");
    const originalHead = await fixture.git("rev-parse", "HEAD");
    await fixture.write("README.md", "tracked changes\n");
    await fixture.write("draft.txt", "untracked changes\n");
    const transcript = await fixture.transcript();
    const catalogEntered = createDeferredCore();
    const catalogRelease = createDeferredCore();
    const loadGatewayModelCatalog = vi.fn(async () => {
      catalogEntered.resolve();
      await catalogRelease.promise;
      if (catalogMode === "cleared-selection") {
        throw new Error("Synthetic catalog preparation failed");
      }
      return [];
    });
    const context = { loadGatewayModelCatalog };
    loadGatewayModelCatalog.mockResolvedValueOnce([]);
    expect(await directSessionReq("sessions.describe", { key }, { context })).toMatchObject({
      ok: true,
    });
    loadGatewayModelCatalog.mockClear();
    const patch = (archived: boolean) =>
      fixture.patch(
        {
          archived,
          ...(!archived
            ? catalogMode === "cleared-selection"
              ? { model: null }
              : { thinkingLevel: "off" }
            : {}),
        },
        { context },
      );

    expect(await patch(true)).toMatchObject({ ok: true });
    await cleanupWorktrees();
    await fixture.expectSnapshot();
    expect(
      (await execFileAsync("git", ["-C", workspace, "worktree", "list", "--porcelain"])).stdout,
    ).not.toContain(worktree.path);
    await expect(fixture.transcript()).resolves.toEqual(transcript);

    if (catalogMode === "cleared-selection") {
      // Model changes preserve thinking; a stored context window still needs catalog validation.
      await patchSessionEntryCore(fixture.scope, () => ({
        thinkingLevel: "off",
        contextWindow: "128k",
      }));
    }
    using restore = vi.spyOn(ManagedWorktreeService.prototype, "restore");
    const restored = patch(false);
    try {
      await Promise.race([catalogEntered.promise, restored]);
      expect(loadGatewayModelCatalog).toHaveBeenCalledOnce();
      expect(restore).not.toHaveBeenCalled();
      expect(fixture.entry()?.archivedAt).toEqual(expect.any(Number));
      await expect(fs.access(worktree.path)).rejects.toThrow();
      if (catalogMode === "cleared-selection") {
        await patchSessionEntryCore(fixture.scope, () => ({ contextWindow: undefined }));
      }
      catalogRelease.resolve();
      expect(await restored).toMatchObject({ ok: true });
      expect(restore).toHaveBeenCalledOnce();
      expect(loadGatewayModelCatalog).toHaveBeenCalledOnce();
      const restoredEntry = fixture.entry();
      expect(restoredEntry?.thinkingLevel).toBe("off");
      expect(restoredEntry?.contextWindow).toBeUndefined();
    } finally {
      catalogRelease.resolve();
      await Promise.allSettled([restored]);
    }
    expect(fixture.entry()?.archivedAt).toBeUndefined();
    expect(fixture.registry()?.removedAt).toBeUndefined();
    await fixture.expectFile("README.md", "tracked changes\n");
    await fixture.expectFile("draft.txt", "untracked changes\n");
    expect(await fixture.git("rev-parse", "HEAD")).toBe(originalHead);
    await expect(fixture.transcript()).resolves.toEqual(transcript);
    const lease = await acquireWorktreeRunLease(worktree.id);
    await lease.release();
  },
);

test("patchMany preserves the checkout on archive commit refusal", async () => {
  const fixture = await archiveFixture();
  const { key, cleanupWorktrees } = fixture;
  const transcript = await fixture.transcript();
  await fixture.write("README.md", "uncommitted edit\n");
  await fixture.write("draft.txt", "untracked draft\n");
  let rejectedCommit = false;
  using _ = probe.admission(workerAdmission, (request, grant, admit) => {
    if (
      request.stage === "commit" &&
      isRecord(request.facts) &&
      isRecord(request.facts.publication) &&
      request.facts.publication.kind === "session-entry-replacements" &&
      Array.isArray(request.facts.publication.changedKeys) &&
      request.facts.publication.changedKeys.includes(key)
    ) {
      rejectedCommit = true;
      throw new Error("injected archive commit failure");
    }
    admit(request, grant);
  });
  const outcome = (await fixture.patchMany({ archived: true })).payload?.outcomes[0];
  expect(outcome).toMatchObject({ ok: false, error: { code: "UNAVAILABLE", retryable: true } });
  expect(rejectedCommit).toBe(true);
  await cleanupWorktrees();
  expect(fixture.entry()?.archivedAt).toBeUndefined();
  expect(fixture.registry()?.removedAt).toBeUndefined();
  await fixture.expectFile("README.md", "uncommitted edit\n");
  await fixture.expectFile("draft.txt", "untracked draft\n");
  await expect(fixture.transcript()).resolves.toEqual(transcript);
});

test.each([
  ["sessions.patch", "busy"],
  ["sessions.patchMany", "snapshot-failed"],
] as const)(
  "%s commits archives and permits cleanup retry when cleanup is %s",
  async (method, failure) => {
    const fixture = await archiveFixture();
    const { key, sessionId, storePath, worktree, cleanupWorktrees } = fixture;
    const transcript = await fixture.transcript();
    const targets = [fixture.target];
    if (method === "sessions.patchMany") {
      const peer = await createPeer();
      targets.push(peer.target);
    }
    const broadcastToConnIds = vi.fn();
    const context = {
      broadcastToConnIds,
      getSessionEventSubscriberConnIds: () => new Set(["archive-observer"]),
    };
    onTestFinished(() => flushPendingSessionsChangedEvents());
    await fixture.write("draft.txt", "preserved for cleanup retry\n");
    const lease = failure === "busy" ? await acquireWorktreeRunLease(worktree.id) : undefined;
    const remove =
      failure === "snapshot-failed"
        ? vi
            .spyOn(managedWorktrees, "remove")
            .mockRejectedValueOnce(new WorktreeSnapshotError("snapshot unavailable"))
        : undefined;
    try {
      const archived = await directSessionReq<SessionsPatchManyResult>(
        method,
        method === "sessions.patch"
          ? { key, expectedSessionId: sessionId, archived: true }
          : { targets, patch: { archived: true } },
        { context },
      );
      const outcome = method === "sessions.patchMany" ? archived.payload?.outcomes[0] : archived;
      expect(outcome).toMatchObject({ ok: true });
      await cleanupWorktrees();
      if (method === "sessions.patchMany") {
        expect(archived.ok).toBe(true);
        expect(archived.payload?.outcomes.slice(1)).toEqual([{ key: targets[1]!.key, ok: true }]);
      }
      for (const target of targets) {
        expect(loadSessionEntry({ storePath, sessionKey: target.key })?.archivedAt).toEqual(
          expect.any(Number),
        );
        expect(broadcastToConnIds).toHaveBeenCalledWith(
          "sessions.changed",
          expect.objectContaining({ sessionKey: target.key, archived: true }),
          expect.any(Set),
          expect.any(Object),
        );
        expect(sessionHookMocks.triggerInternalHook).toHaveBeenCalledWith(
          expect.objectContaining({
            action: "patch",
            sessionKey: target.key,
            context: expect.objectContaining({
              sessionEntry: expect.objectContaining({ archivedAt: expect.any(Number) }),
            }),
          }),
        );
      }
      expect(fixture.registry()?.removedAt).toBeUndefined();
      await fixture.expectFile("draft.txt", "preserved for cleanup retry\n");
      await expect(fixture.transcript()).resolves.toEqual(transcript);
    } finally {
      remove?.mockRestore();
      await lease?.release();
    }
    await cleanupWorktrees();
    expect(fixture.entry()?.archivedAt).toEqual(expect.any(Number));
    expect(fixture.registry()?.removedAt).toEqual(expect.any(Number));
    await expect(fs.access(worktree.path)).rejects.toThrow();
    await expect(fixture.transcript()).resolves.toEqual(transcript);
  },
);

test("automatic archive snapshots the checkout and restores its conversation", async () => {
  const fixture = await archiveFixture();
  const { storePath, worktree, cleanupWorktrees } = fixture;
  await fixture.age();
  const transcript = await fixture.transcript();
  await fixture.write("draft.txt", "automatic archive keeps work\n");

  const readSql: string[] = [];
  const reads = observeMainThreadReads((sql) => readSql.push(sql));
  const worktreeReads: string[] = [];
  let grants = 0;
  using _ = probe.admission(workerAdmission, (request, grant, admit) => {
    const facts = request.facts;
    if (
      !isRecord(facts) ||
      facts.kind !== "state-leases" ||
      !Array.isArray(facts.leases) ||
      !facts.leases.some(
        (member: unknown) =>
          isRecord(member) &&
          isRecord(member.identity) &&
          member.identity.scope === WORKTREE_MUTATION_LEASE_SCOPE &&
          member.identity.key === worktree.id,
      )
    ) {
      return admit(request, grant);
    }
    grants += 1;
    reads.clear();
    readSql.length = 0;
    try {
      admit(request, grant);
    } finally {
      for (const sql of readSql) {
        if (/\bworktrees\b/u.test(sql)) {
          worktreeReads.push(sql);
        }
      }
    }
  });
  onTestFinished(() => reads.restore());

  const result = await applySessionEntryLifecycleMutation({
    agentId: "main",
    storePath,
    upserts: [
      {
        sessionKey: "agent:main:main",
        entry: { sessionId: "main-retention", updatedAt: Date.now() },
      },
    ],
    maintenanceOverride: {
      mode: "enforce",
      archiveDashboardAfterMs: 1,
      pruneAfterMs: Number.MAX_SAFE_INTEGER,
      maxEntries: 5000,
    },
  });

  expect(result.archived).toBe(1);
  await fs.access(worktree.path);
  await cleanupWorktrees();
  const cleanupGrants = grants;
  expect(cleanupGrants).toBeGreaterThan(0);
  await fixture.expectSnapshot();
  await expect(fixture.transcript()).resolves.toEqual(transcript);
  await fixture.archive(false);
  expect(fixture.entry()?.archivedAt).toBeUndefined();
  await fixture.expectFile("draft.txt", "automatic archive keeps work\n");
  await expect(fixture.transcript()).resolves.toEqual(transcript);
  const lease = await acquireWorktreeRunLease(worktree.id);
  await lease.release();
  expect(grants).toBeGreaterThan(cleanupGrants);
  expect(worktreeReads).toEqual([]);
});

test("automatic archive preserves a checkout rearchived during cleanup", async () => {
  const fixture = await archiveFixture();
  const { storePath, worktree, cleanupWorktrees } = fixture;
  await fixture.age();
  const transcript = await fixture.transcript();
  const successorArchive = Date.now() + 1000;
  let archivedBeforeCleanup: number | undefined;
  const originalRemove = managedWorktrees.remove.bind(managedWorktrees);
  using _ = vi
    .spyOn(ManagedWorktreeService.prototype, "remove")
    .mockImplementationOnce(async (params) => {
      archivedBeforeCleanup = fixture.entry()?.archivedAt;
      await patchSessionEntryCore(fixture.scope, () => ({ archivedAt: successorArchive }), {
        skipMaintenance: true,
      });
      return await originalRemove(params);
    });
  const result = await applySessionEntryLifecycleMutation({
    agentId: "main",
    storePath,
    removals: [],
    maintenanceOverride: { mode: "enforce", archiveDashboardAfterMs: 1 },
  });
  expect(result.archived).toBe(1);
  await cleanupWorktrees();
  expect(archivedBeforeCleanup).toEqual(expect.any(Number));
  expect(fixture.entry()?.archivedAt).toBe(successorArchive);
  expect(fixture.registry()?.removedAt).toBeUndefined();
  await fs.access(worktree.path);
  await expect(fixture.transcript()).resolves.toEqual(transcript);
});

test.each(["expired", "source-missing"] as const)(
  "patch preserves an archived conversation on %s restore failure",
  async (failure) => {
    const fixture = await archiveFixture();
    const { worktree, workspace } = fixture;
    const transcript = await fixture.transcript();
    await managedWorktrees.remove({ id: worktree.id, reason: "session-archive" });
    await patchSessionEntryCore(fixture.scope, (entry) => ({ ...entry!, archivedAt: 1 }), {
      skipMaintenance: true,
    });
    if (failure === "expired") {
      await updateRegistryWorktree(process.env, worktree.id, {
        removedAt: Date.now() - 31 * 24 * 60 * 60 * 1000 - 1,
      });
      await new ManagedWorktreeService().gc();
    } else if (failure === "source-missing") {
      await fs.rename(workspace, `${workspace}-offline`);
    }
    const restored = await fixture.patch({ archived: false });
    expect(restored).toMatchObject({ ok: false, error: { code: "UNAVAILABLE", retryable: true } });
    expect(restored.error?.message).toContain("worktree");
    expect(restored.error?.message).not.toMatch(/worktree slot/i);
    expect(restored.error?.message).toContain("new worktree task");
    expect(restored.error?.message).toContain(
      failure === "expired" ? "expired" : "source repository is missing",
    );
    await expect(fixture.transcript()).resolves.toEqual(transcript);
    expect(fixture.entry()?.archivedAt).toBe(1);
    await expect(fs.access(worktree.path)).rejects.toThrow();
  },
);
