// Archive lifecycle keeps session metadata and recoverable worktree contents in sync.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { StatementSync } from "node:sqlite";
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
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../agents/embedded-agent-runner/runs.test-support.js";
import { WORKTREE_MUTATION_LEASE_SCOPE } from "../agents/worktrees/capacity-contract.js";
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
import * as sessionLifecycle from "../sessions/session-lifecycle-admission.js";
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

test("sessions.patchMany releases unrelated writes while restoration waits for allocation", async ({
  signal,
}) => {
  const { key, sessionId, storePath, worktree, cleanupWorktrees } =
    await createArchiveWorktreeFixture();
  const peer = await directSessionReq<{ key: string; sessionId: string }>("sessions.create", {
    agentId: "main",
  });
  const batchPeer = await directSessionReq<{ key: string; sessionId: string }>("sessions.create", {
    agentId: "main",
  });
  expect(peer.ok).toBe(true);
  expect(batchPeer.ok).toBe(true);
  await fs.writeFile(path.join(worktree.path, "draft.txt"), "preserved work\n");
  expect(
    await directSessionReq("sessions.patch", { key, expectedSessionId: sessionId, archived: true }),
  ).toMatchObject({ ok: true });
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
  const restore = vi
    .spyOn(ManagedWorktreeService.prototype, "restore")
    .mockImplementation(function (this: ManagedWorktreeService, params) {
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
    mutation = directSessionReq("sessions.patchMany", {
      targets: [
        { key, expectedSessionId: sessionId },
        { key: batchPeer.payload!.key, expectedSessionId: batchPeer.payload!.sessionId },
      ],
      patch: { archived: false },
    });
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
      key: peer.payload!.key,
      label: "Independent session",
    });
    expect(await withinTest(independent, signal)).toMatchObject({ ok: true });
    expect(successorDone).toBe(false);
    expect(loadSessionEntry({ storePath, sessionKey: key })?.archivedAt).toEqual(
      expect.any(Number),
    );
  } finally {
    release.resolve();
    await Promise.allSettled([allocation, mutation, independent, successor]);
    restore.mockRestore();
  }
  expect(await mutation).toMatchObject({
    ok: true,
    payload: { outcomes: [{ ok: true }, { ok: true }] },
  });
  expect(await successor).toMatchObject({ ok: true });
  expect(loadSessionEntry({ storePath, sessionKey: key })).toMatchObject({ label: "Same session" });
  expect(loadSessionEntry({ storePath, sessionKey: key })?.archivedAt).toBeUndefined();
  await expect(fs.readFile(path.join(worktree.path, "draft.txt"), "utf8")).resolves.toBe(
    "preserved work\n",
  );
});

test("unarchive before the cleanup tick preserves the live checkout", async () => {
  const { key, sessionId, storePath, worktree, cleanupWorktrees } =
    await createArchiveWorktreeFixture();
  await fs.writeFile(path.join(worktree.path, "draft.txt"), "never removed\n");
  const remove = vi.spyOn(managedWorktrees, "remove");
  try {
    for (const archived of [true, false]) {
      expect(
        await directSessionReq("sessions.patch", { key, expectedSessionId: sessionId, archived }),
      ).toMatchObject({ ok: true });
    }
    await cleanupWorktrees();
    expect(remove).not.toHaveBeenCalled();
    expect(loadSessionEntry({ storePath, sessionKey: key })?.archivedAt).toBeUndefined();
    expect(getRegistryWorktree(process.env, worktree.id)?.removedAt).toBeUndefined();
    await expect(fs.readFile(path.join(worktree.path, "draft.txt"), "utf8")).resolves.toBe(
      "never removed\n",
    );
  } finally {
    remove.mockRestore();
  }
});

test("unarchive waits for its in-flight cleanup and restores the finalized snapshot", async ({
  signal,
}) => {
  const { key, sessionId, storePath, worktree, cleanupWorktrees } =
    await createArchiveWorktreeFixture();
  await fs.writeFile(path.join(worktree.path, "draft.txt"), "preserved across in-flight cleanup\n");
  expect(
    await directSessionReq("sessions.patch", { key, expectedSessionId: sessionId, archived: true }),
  ).toMatchObject({ ok: true });
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const submitted = createDeferredCore();
  const originalRemove = managedWorktrees.remove.bind(managedWorktrees);
  const remove = vi.spyOn(managedWorktrees, "remove").mockImplementationOnce(async (params) => {
    entered.resolve();
    await release.promise;
    return await originalRemove(params);
  });
  const originalMutation = sessionLifecycle.runExclusiveSessionLifecycleMutation;
  const mutation = vi
    .spyOn(sessionLifecycle, "runExclusiveSessionLifecycleMutation")
    .mockImplementation((operation, params) => {
      const pending = originalMutation(operation, params);
      if (operation === "restore") {
        submitted.resolve();
      }
      return pending;
    });
  const cleanup = cleanupWorktrees();
  let unarchive: ReturnType<typeof directSessionReq> | undefined;
  try {
    await withinTest(
      awaitGateBeforeSettlement(entered.promise, cleanup, "cleanup did not enter removal"),
      signal,
    );
    unarchive = directSessionReq("sessions.patch", {
      key,
      expectedSessionId: sessionId,
      archived: false,
    });
    await withinTest(
      awaitGateBeforeSettlement(
        submitted.promise,
        unarchive,
        "unarchive did not enter lifecycle admission",
      ),
      signal,
    );
    expect(loadSessionEntry({ storePath, sessionKey: key })?.archivedAt).toEqual(
      expect.any(Number),
    );
    release.resolve();
    await cleanup;
    expect(await unarchive).toMatchObject({ ok: true });
    expect(loadSessionEntry({ storePath, sessionKey: key })?.archivedAt).toBeUndefined();
    expect(getRegistryWorktree(process.env, worktree.id)?.removedAt).toBeUndefined();
    await expect(fs.readFile(path.join(worktree.path, "draft.txt"), "utf8")).resolves.toBe(
      "preserved across in-flight cleanup\n",
    );
  } finally {
    release.resolve();
    await Promise.allSettled([cleanup, unarchive]);
    remove.mockRestore();
    mutation.mockRestore();
  }
});

test("sessions.patchMany leaves a failed restore's label available to a later target", async () => {
  const { key, sessionId, storePath, worktree, cleanupWorktrees } =
    await createArchiveWorktreeFixture();
  const peer = await directSessionReq<{ key: string; sessionId: string }>("sessions.create", {
    agentId: "main",
  });
  expect(peer.ok).toBe(true);
  expect(
    await directSessionReq("sessions.patch", { key, expectedSessionId: sessionId, archived: true }),
  ).toMatchObject({
    ok: true,
  });
  await cleanupWorktrees();
  const restore = vi
    .spyOn(ManagedWorktreeService.prototype, "restore")
    .mockRejectedValueOnce(new Error("checkout unavailable"));
  try {
    const result = await directSessionReq<SessionsPatchManyResult>("sessions.patchMany", {
      targets: [
        { key, expectedSessionId: sessionId },
        { key: peer.payload!.key, expectedSessionId: peer.payload!.sessionId },
      ],
      patch: { archived: false, label: "Available label" },
    });
    expect(result).toMatchObject({
      ok: true,
      payload: { outcomes: [{ ok: false, error: { code: "UNAVAILABLE" } }, { ok: true }] },
    });
    expect(loadSessionEntry({ storePath, sessionKey: key })?.archivedAt).toEqual(
      expect.any(Number),
    );
    expect(loadSessionEntry({ storePath, sessionKey: key })?.label).not.toBe("Available label");
    expect(loadSessionEntry({ storePath, sessionKey: peer.payload!.key })?.label).toBe(
      "Available label",
    );
    await expect(fs.access(worktree.path)).rejects.toThrow();
  } finally {
    restore.mockRestore();
  }
});

test.each(["identity", "label-owner", "participants", "removed"] as const)(
  "sessions.patch preserves owner contracts after %s changes during restoration",
  async (change) => {
    const { key, sessionId, storePath, worktree, cleanupWorktrees } =
      await createArchiveWorktreeFixture();
    const scope = { storePath, sessionKey: key };
    const peer = await directSessionReq<{ key: string }>("sessions.create", { agentId: "main" });
    expect(peer.ok).toBe(true);
    expect(
      await directSessionReq("sessions.patch", {
        key,
        expectedSessionId: sessionId,
        archived: true,
      }),
    ).toMatchObject({ ok: true });
    await cleanupWorktrees();
    const originalRestore = captureMethodCall("restore")(ManagedWorktreeService.prototype);
    const restore = vi
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
            await directSessionReq("sessions.patch", {
              key: peer.payload!.key,
              label: "Requested label",
            }),
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
    try {
      const result = await directSessionReq("sessions.patch", {
        key,
        expectedSessionId: sessionId,
        archived: false,
        label: "Requested label",
      });
      const entry = loadSessionEntry(scope);
      if (change === "participants" || change === "removed") {
        expect(result.ok).toBe(true);
        expect(entry?.archivedAt).toBeUndefined();
        if (change === "participants") {
          expect(entry?.participantCount).toBe(1);
        }
      } else {
        expect(result.ok).toBe(false);
        expect(entry?.archivedAt).toEqual(expect.any(Number));
        expect(entry?.label).not.toBe("Requested label");
      }
      if (change === "identity") {
        expect(entry?.sessionId).toBe("replacement-session");
      }
      if (change === "label-owner") {
        expect(loadSessionEntry({ storePath, sessionKey: peer.payload!.key })?.label).toBe(
          "Requested label",
        );
      }
      if (change === "removed") {
        // Manual checkout removal deliberately leaves conversation metadata and binding intact.
        expect(entry?.worktree?.id).toBe(worktree.id);
        expect(getRegistryWorktree(process.env, worktree.id)).toMatchObject({
          removedAt: expect.any(Number),
          snapshotRef: expect.any(String),
        });
        await expect(fs.access(worktree.path)).rejects.toThrow();
      } else {
        await fs.access(worktree.path);
      }
    } finally {
      restore.mockRestore();
    }
  },
);

test.each(["accepted", "revoked", "replacement"] as const)(
  "sessions.patchMany retains the earlier permission owner across a later restore (%s)",
  async (scenario) => {
    const { key, sessionId, storePath, worktree, cleanupWorktrees } =
      await createArchiveWorktreeFixture();
    const created = await directSessionReq<{ key: string; sessionId: string }>("sessions.create", {
      agentId: "main",
    });
    expect(created.ok).toBe(true);
    const earlier = created.payload!;
    const earlierScope = { storePath, sessionKey: earlier.key };
    await patchSessionEntryCore(earlierScope, () => ({ permissionMode: "guarded" }), {
      skipMaintenance: true,
    });
    expect(
      await directSessionReq("sessions.patch", {
        key,
        expectedSessionId: sessionId,
        archived: true,
      }),
    ).toMatchObject({ ok: true });
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
    const restore = vi
      .spyOn(ManagedWorktreeService.prototype, "restore")
      .mockImplementationOnce(async function (this: ManagedWorktreeService, params) {
        const result = await originalRestore(this, params);
        reached.resolve();
        await release.promise;
        return result;
      });
    let revoked = false;
    const pending = directSessionReq<SessionsPatchManyResult>(
      "sessions.patchMany",
      {
        targets: [
          { key: earlier.key, expectedSessionId: earlier.sessionId },
          { key, expectedSessionId: sessionId },
        ],
        patch: { archived: false, permissionMode: "read-only" },
      },
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
      expect(loadSessionEntry({ storePath, sessionKey: key })?.archivedAt).toEqual(
        expect.any(Number),
      );
      if (scenario === "revoked") {
        revoked = true;
      }
      if (scenario === "replacement") {
        setActiveEmbeddedRun(earlier.sessionId, successor, earlier.key);
      }
      release.resolve();
      const result = await pending;
      if (scenario === "revoked") {
        expect(result).toMatchObject({
          ok: true,
          payload: {
            outcomes: [
              { ok: false, error: { code: "FORBIDDEN" } },
              { ok: false, error: { code: "FORBIDDEN" } },
            ],
          },
        });
        expect(loadSessionEntry(earlierScope)?.permissionMode).toBe("guarded");
        expect(loadSessionEntry({ storePath, sessionKey: key })?.archivedAt).toEqual(
          expect.any(Number),
        );
      } else {
        expect(result).toMatchObject({
          ok: true,
          payload: {
            outcomes: [
              scenario === "accepted"
                ? { ok: true }
                : {
                    ok: false,
                    error: {
                      code: "UNAVAILABLE",
                      message: expect.stringContaining("Permissions were saved"),
                    },
                  },
              { ok: true },
            ],
          },
        });
        expect(loadSessionEntry(earlierScope)?.permissionMode).toBe("read-only");
        expect(loadSessionEntry({ storePath, sessionKey: key })?.archivedAt).toBeUndefined();
      }
      expect(originalApply).toHaveBeenCalledTimes(scenario === "accepted" ? 1 : 0);
      expect(originalAbort).not.toHaveBeenCalled();
      expect(successorApply).not.toHaveBeenCalled();
      expect(successorAbort).not.toHaveBeenCalled();
      expect(isSessionPermissionChangePending(earlier.sessionId)).toBe(false);
      await fs.access(worktree.path);
    } finally {
      release.resolve();
      await Promise.allSettled([pending]);
      restore.mockRestore();
      clearActiveEmbeddedRun(earlier.sessionId, original, earlier.key);
      clearActiveEmbeddedRun(earlier.sessionId, successor, earlier.key);
      embeddedRunMock.activeIds.delete(earlier.sessionId);
    }
  },
);

test.each(["ready", "cleared-selection"] as const)(
  "sessions.patch restores dirty work only after catalog preparation (%s)",
  async (catalogMode) => {
    const fixture = await createArchiveWorktreeFixture();
    const { key, sessionId, storePath, worktree, workspace, cleanupWorktrees } = fixture;
    await fs.writeFile(path.join(worktree.path, "committed.txt"), "unpushed work\n");
    await execFileAsync("git", ["-C", worktree.path, "add", "committed.txt"]);
    await execFileAsync("git", ["-C", worktree.path, "commit", "-m", "session work"]);
    const originalHead = (await execFileAsync("git", ["-C", worktree.path, "rev-parse", "HEAD"]))
      .stdout;
    await fs.writeFile(path.join(worktree.path, "README.md"), "tracked changes\n");
    await fs.writeFile(path.join(worktree.path, "draft.txt"), "untracked changes\n");
    const transcript = await loadSeededTranscriptEvents(fixture.transcriptScope);
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
      directSessionReq(
        "sessions.patch",
        {
          key,
          expectedSessionId: sessionId,
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
    expect(loadSessionEntry({ storePath, sessionKey: key })).toMatchObject({
      sessionId,
      archivedAt: expect.any(Number),
      worktree: { id: worktree.id },
    });
    await expect(fs.access(worktree.path)).rejects.toThrow();
    expect(getRegistryWorktree(process.env, worktree.id)).toMatchObject({
      removedAt: expect.any(Number),
      snapshotRef: expect.stringMatching(/^refs\/openclaw\/snapshots\//),
    });
    expect(
      (await execFileAsync("git", ["-C", workspace, "worktree", "list", "--porcelain"])).stdout,
    ).not.toContain(worktree.path);
    await expect(loadSeededTranscriptEvents(fixture.transcriptScope)).resolves.toEqual(transcript);

    if (catalogMode === "cleared-selection") {
      await patchSessionEntryCore({ storePath, sessionKey: key }, () => ({ thinkingLevel: "off" }));
    }
    const restore = vi.spyOn(ManagedWorktreeService.prototype, "restore");
    const restored = patch(false);
    try {
      await Promise.race([catalogEntered.promise, restored]);
      expect(loadGatewayModelCatalog).toHaveBeenCalledOnce();
      expect(restore).not.toHaveBeenCalled();
      expect(loadSessionEntry({ storePath, sessionKey: key })?.archivedAt).toEqual(
        expect.any(Number),
      );
      await expect(fs.access(worktree.path)).rejects.toThrow();
      if (catalogMode === "cleared-selection") {
        await patchSessionEntryCore({ storePath, sessionKey: key }, () => ({
          thinkingLevel: undefined,
          contextWindow: undefined,
        }));
      }
      catalogRelease.resolve();
      expect(await restored).toMatchObject({ ok: true });
      expect(restore).toHaveBeenCalledOnce();
      expect(loadGatewayModelCatalog).toHaveBeenCalledOnce();
      expect(loadSessionEntry({ storePath, sessionKey: key })?.thinkingLevel).toBe(
        catalogMode === "cleared-selection" ? undefined : "off",
      );
    } finally {
      catalogRelease.resolve();
      await Promise.allSettled([restored]);
      restore.mockRestore();
    }
    expect(loadSessionEntry({ storePath, sessionKey: key })?.archivedAt).toBeUndefined();
    expect(getRegistryWorktree(process.env, worktree.id)?.removedAt).toBeUndefined();
    await expect(fs.readFile(path.join(worktree.path, "README.md"), "utf8")).resolves.toBe(
      "tracked changes\n",
    );
    await expect(fs.readFile(path.join(worktree.path, "draft.txt"), "utf8")).resolves.toBe(
      "untracked changes\n",
    );
    expect((await execFileAsync("git", ["-C", worktree.path, "rev-parse", "HEAD"])).stdout).toBe(
      originalHead,
    );
    await expect(loadSeededTranscriptEvents(fixture.transcriptScope)).resolves.toEqual(transcript);
    const lease = await acquireWorktreeRunLease(worktree.id);
    await lease.release();
  },
);

test("sessions.patchMany preserves the checkout when the archive commit is refused", async () => {
  const fixture = await createArchiveWorktreeFixture();
  const { key, sessionId, storePath, worktree, cleanupWorktrees } = fixture;
  const transcript = await loadSeededTranscriptEvents(fixture.transcriptScope);
  await fs.writeFile(path.join(worktree.path, "README.md"), "uncommitted edit\n");
  await fs.writeFile(path.join(worktree.path, "draft.txt"), "untracked draft\n");
  const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
  let rejectedCommit = false;
  const admission = vi
    .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
    .mockImplementation((admit, attachment) =>
      createAdmission((request, grant) => {
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
      }, attachment),
    );
  try {
    const outcome = (
      await directSessionReq<SessionsPatchManyResult>("sessions.patchMany", {
        targets: [{ key, expectedSessionId: sessionId }],
        patch: { archived: true },
      })
    ).payload?.outcomes[0];
    expect(outcome).toMatchObject({
      ok: false,
      error: { code: "UNAVAILABLE", retryable: true },
    });
    expect(rejectedCommit).toBe(true);
    await cleanupWorktrees();
    expect(loadSessionEntry({ storePath, sessionKey: key })?.archivedAt).toBeUndefined();
    expect(getRegistryWorktree(process.env, worktree.id)?.removedAt).toBeUndefined();
    await expect(fs.readFile(path.join(worktree.path, "README.md"), "utf8")).resolves.toBe(
      "uncommitted edit\n",
    );
    await expect(fs.readFile(path.join(worktree.path, "draft.txt"), "utf8")).resolves.toBe(
      "untracked draft\n",
    );
    await expect(loadSeededTranscriptEvents(fixture.transcriptScope)).resolves.toEqual(transcript);
  } finally {
    admission.mockRestore();
  }
});

test.each([
  ["sessions.patch", "busy"],
  ["sessions.patchMany", "snapshot-failed"],
] as const)(
  "%s commits archives and permits cleanup retry when cleanup is %s",
  async (method, failure) => {
    const fixture = await createArchiveWorktreeFixture();
    const { key, sessionId, storePath, worktree, cleanupWorktrees } = fixture;
    const transcript = await loadSeededTranscriptEvents(fixture.transcriptScope);
    const targets = [{ key, expectedSessionId: sessionId }];
    if (method === "sessions.patchMany") {
      const peer = await directSessionReq<{ key: string; sessionId: string }>("sessions.create", {
        agentId: "main",
      });
      expect(peer.ok).toBe(true);
      targets.push({ key: peer.payload!.key, expectedSessionId: peer.payload!.sessionId });
    }
    const broadcastToConnIds = vi.fn();
    const context = {
      broadcastToConnIds,
      getSessionEventSubscriberConnIds: () => new Set(["archive-observer"]),
    };
    onTestFinished(() => flushPendingSessionsChangedEvents());
    await fs.writeFile(path.join(worktree.path, "draft.txt"), "preserved for cleanup retry\n");
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
      expect(getRegistryWorktree(process.env, worktree.id)?.removedAt).toBeUndefined();
      await expect(fs.readFile(path.join(worktree.path, "draft.txt"), "utf8")).resolves.toBe(
        "preserved for cleanup retry\n",
      );
      await expect(loadSeededTranscriptEvents(fixture.transcriptScope)).resolves.toEqual(
        transcript,
      );
    } finally {
      remove?.mockRestore();
      await lease?.release();
    }
    await cleanupWorktrees();
    expect(loadSessionEntry({ storePath, sessionKey: key })?.archivedAt).toEqual(
      expect.any(Number),
    );
    expect(getRegistryWorktree(process.env, worktree.id)?.removedAt).toEqual(expect.any(Number));
    await expect(fs.access(worktree.path)).rejects.toThrow();
    await expect(loadSeededTranscriptEvents(fixture.transcriptScope)).resolves.toEqual(transcript);
  },
);

test("automatic dashboard archive snapshots the checkout and can restore its conversation", async () => {
  const fixture = await createArchiveWorktreeFixture();
  const { key, sessionId, storePath, worktree, cleanupWorktrees } = fixture;
  const old = Date.now() - 31 * 24 * 60 * 60 * 1000;
  await patchSessionEntryCore(
    { storePath, sessionKey: key },
    (entry) => ({
      ...entry!,
      updatedAt: old,
      lastInteractionAt: old,
      lastActivityAt: old,
      sessionStartedAt: old,
    }),
    { skipMaintenance: true, replaceEntry: true },
  );
  expect(loadSessionEntry({ storePath, sessionKey: key })?.updatedAt).toBe(old);
  const transcript = await loadSeededTranscriptEvents(fixture.transcriptScope);
  await fs.writeFile(path.join(worktree.path, "draft.txt"), "automatic archive keeps work\n");

  const reads = observeMainThreadReads();
  const worktreeReads: string[] = [];
  let grants = 0;
  const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
  const admission = vi
    .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
    .mockImplementation((handler, ...options) =>
      createAdmission(
        (request, grant) => {
          if (
            !isRecord(request.facts) ||
            request.facts.kind !== "state-leases" ||
            !Array.isArray(request.facts.leases) ||
            !request.facts.leases.some(
              (member: unknown) =>
                isRecord(member) &&
                isRecord(member.identity) &&
                member.identity.scope === WORKTREE_MUTATION_LEASE_SCOPE &&
                member.identity.key === worktree.id,
            )
          ) {
            return handler(request, grant);
          }
          grants += 1;
          reads.clear();
          try {
            return handler(request, grant);
          } finally {
            for (const call of reads.calls) {
              for (const statement of call.mock.contexts) {
                if (
                  statement instanceof StatementSync &&
                  /\bworktrees\b/u.test(statement.sourceSQL)
                ) {
                  worktreeReads.push(statement.sourceSQL);
                }
              }
            }
          }
        },
        ...options,
      ),
    );
  onTestFinished(() => {
    admission.mockRestore();
    reads.restore();
  });

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
  expect(loadSessionEntry({ storePath, sessionKey: key })).toMatchObject({
    sessionId,
    archivedAt: expect.any(Number),
    worktree: { id: worktree.id },
  });
  await expect(fs.access(worktree.path)).rejects.toThrow();
  expect(getRegistryWorktree(process.env, worktree.id)).toMatchObject({
    removedAt: expect.any(Number),
    snapshotRef: expect.stringMatching(/^refs\/openclaw\/snapshots\//),
  });
  await expect(loadSeededTranscriptEvents(fixture.transcriptScope)).resolves.toEqual(transcript);
  expect(
    await directSessionReq("sessions.patch", {
      key,
      expectedSessionId: sessionId,
      archived: false,
    }),
  ).toMatchObject({ ok: true });
  expect(loadSessionEntry({ storePath, sessionKey: key })?.archivedAt).toBeUndefined();
  await expect(fs.readFile(path.join(worktree.path, "draft.txt"), "utf8")).resolves.toBe(
    "automatic archive keeps work\n",
  );
  await expect(loadSeededTranscriptEvents(fixture.transcriptScope)).resolves.toEqual(transcript);
  const lease = await acquireWorktreeRunLease(worktree.id);
  await lease.release();
  expect(grants).toBeGreaterThan(cleanupGrants);
  expect(worktreeReads).toEqual([]);
});

test("automatic archive preserves a checkout rearchived while cleanup awaited", async () => {
  const fixture = await createArchiveWorktreeFixture();
  const { key, storePath, worktree, cleanupWorktrees } = fixture;
  const old = Date.now() - 31 * 24 * 60 * 60 * 1000;
  await patchSessionEntryCore(
    { storePath, sessionKey: key },
    (entry) => ({
      ...entry!,
      updatedAt: old,
      lastInteractionAt: old,
      lastActivityAt: old,
      sessionStartedAt: old,
    }),
    { skipMaintenance: true, replaceEntry: true },
  );
  expect(loadSessionEntry({ storePath, sessionKey: key })?.updatedAt).toBe(old);
  const transcript = await loadSeededTranscriptEvents(fixture.transcriptScope);
  const successorArchive = Date.now() + 1000;
  let archivedBeforeCleanup: number | undefined;
  const originalRemove = managedWorktrees.remove.bind(managedWorktrees);
  const remove = vi
    .spyOn(ManagedWorktreeService.prototype, "remove")
    .mockImplementationOnce(async (params) => {
      archivedBeforeCleanup = loadSessionEntry({ storePath, sessionKey: key })?.archivedAt;
      await patchSessionEntryCore(
        { storePath, sessionKey: key },
        () => ({ archivedAt: successorArchive }),
        { skipMaintenance: true },
      );
      return await originalRemove(params);
    });
  try {
    const result = await applySessionEntryLifecycleMutation({
      agentId: "main",
      storePath,
      removals: [],
      maintenanceOverride: { mode: "enforce", archiveDashboardAfterMs: 1 },
    });
    expect(result.archived).toBe(1);
    await cleanupWorktrees();
    expect(archivedBeforeCleanup).toEqual(expect.any(Number));
    expect(loadSessionEntry({ storePath, sessionKey: key })?.archivedAt).toBe(successorArchive);
    expect(getRegistryWorktree(process.env, worktree.id)?.removedAt).toBeUndefined();
    await fs.access(worktree.path);
    await expect(loadSeededTranscriptEvents(fixture.transcriptScope)).resolves.toEqual(transcript);
  } finally {
    remove.mockRestore();
  }
});

test.each(["checkout-failed", "expired", "source-missing"] as const)(
  "sessions.patch keeps an archived conversation when its worktree cannot be restored (%s)",
  async (failure) => {
    const fixture = await createArchiveWorktreeFixture();
    const { key, sessionId, storePath, worktree, workspace } = fixture;
    const transcript = await loadSeededTranscriptEvents(fixture.transcriptScope);
    await managedWorktrees.remove({ id: worktree.id, reason: "session-archive" });
    await patchSessionEntryCore(
      { storePath, sessionKey: key },
      (entry) => ({
        ...entry!,
        archivedAt: 1,
      }),
      { skipMaintenance: true },
    );
    if (failure === "expired") {
      await new ManagedWorktreeService({ now: () => Date.now() + 31 * 24 * 60 * 60 * 1000 }).gc();
    } else if (failure === "source-missing") {
      await fs.rename(workspace, `${workspace}-offline`);
    }
    const restore =
      failure === "checkout-failed"
        ? vi
            .spyOn(ManagedWorktreeService.prototype, "restore")
            .mockRejectedValueOnce(new Error("checkout unavailable"))
        : undefined;
    try {
      const restored = await directSessionReq("sessions.patch", {
        key,
        expectedSessionId: sessionId,
        archived: false,
      });
      expect(restored).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE", retryable: true },
      });
      expect(restored.error?.message).toContain("worktree");
      expect(restored.error?.message).not.toMatch(/worktree slot/i);
      expect(restored.error?.message).toContain(
        failure === "checkout-failed" ? "Free disk space" : "new worktree task",
      );
      if (failure === "expired") {
        expect(restored.error?.message).toContain("expired");
      }
      if (failure === "source-missing") {
        expect(restored.error?.message).toContain("source repository is missing");
      }
      await expect(loadSeededTranscriptEvents(fixture.transcriptScope)).resolves.toEqual(
        transcript,
      );
      expect(loadSessionEntry({ storePath, sessionKey: key })?.archivedAt).toBe(1);
      await expect(fs.access(worktree.path)).rejects.toThrow();
    } finally {
      restore?.mockRestore();
    }
  },
);
