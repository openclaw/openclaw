import fs from "node:fs/promises";
import path from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import type { SessionsDeleteResult } from "../../packages/gateway-protocol/src/index.js";
import type { SessionsCreateParams } from "../../packages/gateway-protocol/src/schema/sessions-create.js";
import { captureMethodCall } from "../../test/helpers/capture-method-call.js";
import { requireGit } from "../agents/worktrees/git.js";
import { WorktreeRemovalContentionError } from "../agents/worktrees/registry.js";
import { getRegistryWorktree } from "../agents/worktrees/registry.test-support.js";
import { acquireWorktreeRunLease, resolveWorktreeForPath } from "../agents/worktrees/run-lease.js";
import {
  managedWorktrees,
  ManagedWorktreeService,
  WorktreeSnapshotError,
} from "../agents/worktrees/service.js";
import { loadSessionEntry, patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import {
  resolveSqliteScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { isSessionMutationActive } from "../sessions/session-controller.lifecycle.js";
import { listSessionStateEventsSince } from "../sessions/session-state-events.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { SQLITE_SESSION_WRITER_QUEUES } from "../state/openclaw-agent-write-admission-state.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  attachGatewayLocalUserIngress,
  prepareGatewayLocalUserIngress,
} from "./local-user-ingress.js";
import { disposeSessionReadContexts } from "./server-methods/sessions-read-cache.test-support.js";
import { createStartupGate } from "./server-startup-state.test-support.js";
import { gatewayProfile } from "./server/client-fixtures.test-support.js";
import { testState, writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  loadSeededTranscriptEvents,
  sessionStoreEntry,
  threadBindingMocks,
} from "./test/server-sessions.test-helpers.js";
import { setupGatewaySessionsWorktreeTestHarness } from "./test/server-sessions.worktree-fixture.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

const { createSessionStoreDir, createArchiveWorktreeFixture, initializeRemoteBackedGitWorkspace } =
  setupGatewaySessionsWorktreeTestHarness();
type Worktree = { id: string; path: string; branch: string };
const defaultAdminClient = { connect: { scopes: ["operator.admin"] } } as never;
const createWorktree = (params: Partial<SessionsCreateParams>, client = defaultAdminClient) =>
  directSessionReq<{ key: string; sessionId: string; worktree: Worktree }>(
    "sessions.create",
    { ...params, worktree: true },
    { client },
  );

function worktreeEntry({ id, path: cwd, branch, repoRoot }: Worktree & { repoRoot: string }) {
  return { spawnedCwd: cwd, worktree: { id, branch, repoRoot } };
}

async function createDeletionFixture(agentsConfig?: typeof testState.agentsConfig) {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-delete-worktree-",
  });
  const workspace = await initializeRemoteBackedGitWorkspace(state.root);
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = { workspace };
  if (agentsConfig) {
    testState.agentsConfig = agentsConfig;
  }
  const { storePath } = await createSessionStoreDir();
  const worktrees = new Set<string>();
  return {
    workspace,
    storePath,
    track(id: string | undefined) {
      if (id) {
        worktrees.add(id);
      }
    },
    async [Symbol.asyncDispose]() {
      for (const id of worktrees) {
        if (getRegistryWorktree(process.env, id)?.removedAt === undefined) {
          await managedWorktrees.remove({ id, reason: "test-cleanup", allowSnapshotLoss: true });
        }
      }
      await disposeSessionReadContexts();
      testState.agentConfig = undefined;
      if (agentsConfig) {
        testState.agentsConfig = undefined;
      }
      await state.cleanup();
    },
  };
}

async function createSessionWorktree(key: string) {
  const created = await createWorktree({ key, agentId: "main" });
  expect(created.ok).toBe(true);
  return created.payload!.worktree;
}

async function expectWorktreePresent(worktree: Worktree, present = true) {
  const record = getRegistryWorktree(process.env, worktree.id);
  expect(record?.id).toBe(worktree.id);
  expect(record?.removedAt).toEqual(present ? undefined : expect.any(Number));
  if (present) {
    await fs.access(worktree.path);
  } else {
    await expect(fs.access(worktree.path)).rejects.toThrow();
  }
}

test.each(["restore-failed", "placement-changed"] as const)(
  "inbound admission restores the archived worktree before opening its session (failure=%s)",
  async (failure) => {
    const fixture = await createArchiveWorktreeFixture();
    const { key, sessionId, storePath, worktree, workspace } = fixture;
    await fs.writeFile(path.join(worktree.path, "draft.txt"), "inbound restore keeps work\n");
    await managedWorktrees.remove({ id: worktree.id, reason: "session-archive" });
    await patchSessionEntryCore(
      { storePath, sessionKey: key },
      (entry) => ({ ...entry!, archivedAt: 1 }),
      { skipMaintenance: true },
    );
    const [
      { createDispatchReplyOperationCoordinator },
      { createReplyDispatcher },
      { buildTestCtx },
    ] = await Promise.all([
      import("../auto-reply/reply/dispatch-from-config.lifecycle.js"),
      import("../auto-reply/reply/reply-dispatcher.js"),
      import("../auto-reply/reply/test-ctx.js"),
    ]);
    const placements =
      failure === "placement-changed" ? createWorkerSessionPlacementStore() : undefined;
    const transcript = await loadSeededTranscriptEvents(fixture.transcriptScope);
    const dispatcher = createReplyDispatcher({ deliver: async () => {} });
    onTestFinished(async () => {
      dispatcher.markComplete();
      await dispatcher.waitForIdle();
    });
    const coordinator = createDispatchReplyOperationCoordinator({
      agentId: "main",
      cfg: { agents: { defaults: { workspace } } },
      ctx: buildTestCtx({
        SessionKey: key,
        Body: "Continue this task",
        CommandSource: undefined,
        InboundAccessAuthorized: true,
        InboundEventKind: "user_request",
        InputProvenance: { kind: "external_user", sourceChannel: "discord" },
      }),
      dispatcher,
      dispatchOperationSessionKey: key,
      operationSessionStoreEntry: {
        storePath,
        entry: loadSessionEntry({ storePath, sessionKey: key }),
      },
      sessionWorkerPlacementContext: placements
        ? { workerSessionPlacementService: placements }
        : {},
      resolveOperationExpectedSessionId: () => sessionId,
    });
    const restore =
      failure === "restore-failed"
        ? vi
            .spyOn(ManagedWorktreeService.prototype, "restore")
            .mockRejectedValueOnce(new Error("worktree checkout unavailable"))
        : undefined;
    const worktreeLifecycle = await import("../sessions/session-worktree-lifecycle.js");
    const synchronize = worktreeLifecycle.restoreSessionWorktree;
    const sqliteScope = resolveSqliteScope({ storePath, sessionKey: key });
    const writerQueuePath = resolveOpenClawAgentSqlitePath(toDatabaseOptions(sqliteScope));
    const writer = createStartupGate();
    let heldWriter: Promise<void> | undefined;
    let admission: ReturnType<typeof coordinator.ensureDispatchReplyOperation> | undefined;
    const placementChange = placements
      ? vi
          .spyOn(worktreeLifecycle, "restoreSessionWorktree")
          .mockImplementationOnce(async (params) => {
            const assertCurrent = await synchronize(params);
            heldWriter = runExclusiveSqliteSessionWrite(
              sqliteScope,
              writer.run,
              "session.transcript.batch",
            );
            await writer.entered;
            return assertCurrent;
          })
      : undefined;
    try {
      admission = coordinator.ensureDispatchReplyOperation("pre_dispatch");
      void admission.catch(() => {});
      if (failure === "placement-changed") {
        // Advance placement only after the restored session waits behind a real SQLite writer.
        await Promise.race([writer.entered, admission]);
        expect(heldWriter).toBeDefined();
        await vi.waitFor(() => {
          expect(SQLITE_SESSION_WRITER_QUEUES.get(writerQueuePath)?.pending.length).toBe(1);
        });
        expect(isSessionMutationActive(storePath, [key, sessionId])).toBe(true);
        await placements!.startDispatch({ sessionId, sessionKey: key, agentId: "main" });
        // A stopped replacement is eligible, but cannot reuse preparation owned by the prior placement.
        await placements!.fail({
          sessionId,
          expectedGeneration: 1,
          recoveryError: "preparation failed",
        });
        writer.release();
        await heldWriter;
        await expect(admission).rejects.toThrow("changed before mutation");
        expect(placements?.get(sessionId)).toMatchObject({
          state: "failed",
          generation: 2,
          environmentId: null,
        });
        await expect(fs.readFile(path.join(worktree.path, "draft.txt"), "utf8")).resolves.toBe(
          "inbound restore keeps work\n",
        );
      } else {
        await expect(admission).rejects.toThrow(/worktree/i);
        await expect(fs.access(worktree.path)).rejects.toThrow();
      }
      expect(loadSessionEntry({ storePath, sessionKey: key })?.archivedAt).toBe(1);
      await expect(loadSeededTranscriptEvents(fixture.transcriptScope)).resolves.toEqual(
        transcript,
      );
    } finally {
      writer.release();
      await heldWriter;
      await admission?.catch(() => {});
      placementChange?.mockRestore();
      restore?.mockRestore();
      coordinator.completeDispatchReplyOperation();
      await coordinator.releasePreDispatchLifecycleAdmission();
      expect(isSessionMutationActive(storePath, [key, sessionId])).toBe(false);
    }
  },
);

test("sessions.create only allocates worktrees for lifecycle-manageable agent owners", async () => {
  await using fixture = await createDeletionFixture({ entries: { ops: {} } });
  const { storePath } = fixture;
  using allocation = vi.spyOn(ManagedWorktreeService.prototype, "createWithOutcome");
  for (const owner of [{ agentId: "main" }, { key: "agent:main:dashboard:unconfigured-owner" }]) {
    const created = await createWorktree(owner);
    fixture.track(created.payload?.worktree.id);

    expect(created).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: 'Unknown agent id "main"' },
    });
    if (owner.key) {
      expect(
        loadSessionEntry({ agentId: "main", sessionKey: owner.key, storePath }),
      ).toBeUndefined();
    }
    expect(allocation).not.toHaveBeenCalled();
  }

  for (const owner of [{ agentId: "ops" }, {}]) {
    const created = await createWorktree(owner);
    fixture.track(created.payload?.worktree.id);
    expect(created).toMatchObject({
      ok: true,
      payload: { key: expect.stringMatching(/^agent:ops:/) },
    });

    const worktree = created.payload!.worktree;
    await expect(
      directSessionReq("sessions.delete", { key: created.payload!.key, agentId: "ops" }),
    ).resolves.toMatchObject({ ok: true, payload: { deleted: true } });
    await expect(fs.access(worktree.path)).rejects.toThrow();
  }
});

test("sessions.delete snapshots dirty work before admitting same-key successor worktree creation", async () => {
  await using fixture = await createDeletionFixture();
  const { workspace, storePath } = fixture;
  const key = "agent:main:dashboard:delete-worktree-successor";
  // Creation revalidates admitted profile authority before allocating the worktree.
  const creatorProfileId = ensureProfileForEmail("delete-worktree-successor@example.test").id;
  const adminClient = {
    connect: { scopes: ["operator.admin"] },
    authenticatedUserProfile: gatewayProfile(creatorProfileId, "Delete Worktree Test"),
  } as never;
  attachGatewayLocalUserIngress(
    adminClient,
    prepareGatewayLocalUserIngress({
      authenticatedUserExpected: true,
      profile: { profileId: creatorProfileId, displayName: "Delete Worktree Test" },
      isLocalClient: false,
    }),
  );
  const removal = createStartupGate();
  const originalRemove = captureMethodCall("remove")(ManagedWorktreeService.prototype);
  using removeSpy = vi.spyOn(ManagedWorktreeService.prototype, "remove");
  try {
    const create = () => createWorktree({ key, agentId: "main" }, adminClient);
    const predecessor = await create();
    expect(predecessor.ok, JSON.stringify(predecessor)).toBe(true);
    const predecessorSessionId = predecessor.payload!.sessionId;
    const predecessorWorktree = predecessor.payload!.worktree;
    await fs.writeFile(path.join(predecessorWorktree.path, "dirty.txt"), "keep me\n");

    removeSpy.mockImplementation(async function (this: ManagedWorktreeService, params) {
      if (params.id === predecessorWorktree.id && params.reason === "session-delete") {
        expect(isSessionMutationActive(storePath, [key, predecessorSessionId])).toBe(true);
        expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledWith({
          targetSessionKey: key,
          reason: "session-delete",
        });
        await removal.run();
      }
      return await originalRemove(this, params);
    });

    const deletion = directSessionReq<{ deleted: boolean }>("sessions.delete", {
      key,
      expectedSessionId: predecessorSessionId,
    });
    await removal.entered;
    let successorSettled = false;
    const successorPromise = create().then((result) => {
      successorSettled = true;
      return result;
    });
    await Promise.resolve();
    expect(successorSettled).toBe(false);

    removal.release();
    const [deleted, successor] = await Promise.all([deletion, successorPromise]);
    expect(deleted).toMatchObject({ ok: true, payload: { deleted: true } });
    const removedPredecessor = getRegistryWorktree(process.env, predecessorWorktree.id);
    expect(removedPredecessor).toMatchObject({
      removedAt: expect.any(Number),
      snapshotRef: expect.stringMatching(/^refs\/openclaw\/snapshots\//),
    });
    expect(
      await requireGit(workspace, ["show", `${removedPredecessor!.snapshotRef}:dirty.txt`]),
    ).toBe("keep me");
    expect(successor.ok).toBe(true);
    const successorSessionId = successor.payload!.sessionId;
    const successorWorktree = successor.payload!.worktree;
    fixture.track(successorWorktree.id);
    expect(successorSessionId).not.toBe(predecessorSessionId);
    expect(successorWorktree.id).not.toBe(predecessorWorktree.id);
    await expectWorktreePresent(successorWorktree);
    const persisted = loadSessionEntry({ sessionKey: key, storePath });
    expect(persisted).toMatchObject({
      sessionId: successorSessionId,
      spawnedCwd: successorWorktree.path,
      worktree: {
        id: successorWorktree.id,
        branch: successorWorktree.branch,
        repoRoot: workspace,
      },
    });
    expect(
      (await listSessionStateEventsSince(key, "main", 0, 20)).events.filter(
        (event) => event.kind === "created",
      ),
    ).toEqual([
      expect.objectContaining({
        sessionId: successorSessionId,
        actorType: "human",
        actorId: creatorProfileId,
      }),
    ]);
    const selected = await resolveWorktreeForPath({
      sessionEntry: persisted,
      candidatePaths: [persisted?.spawnedCwd],
    });
    expect(selected?.record.id).toBe(successorWorktree.id);
    const runLease = await acquireWorktreeRunLease(selected!.record.id, { source: selected });
    await runLease.release();
  } finally {
    removal.release();
  }
});

test.each([
  ["sessions.delete", "snapshot-failed"],
  ["sessions.delete", "finalized"],
  ["sessions.delete", "busy"],
  ["sessions.delete", "owner-mismatch"],
  ["sessions.reset", "removed"],
  ["sessions.reset", "busy"],
] as const)("%s reports worktree truth after %s", async (method, outcome) => {
  await using fixture = await createDeletionFixture();
  const { workspace, storePath } = fixture;
  const incognito = method === "sessions.reset";
  let key = "agent:main:dashboard:delete-worktree-preserved";
  const originalRemove = captureMethodCall("remove")(ManagedWorktreeService.prototype);
  let runLease: Awaited<ReturnType<typeof acquireWorktreeRunLease>> | undefined;
  using removeSpy = vi.spyOn(ManagedWorktreeService.prototype, "remove");
  try {
    const incognitoSession = incognito ? await createIncognitoSessionWithWorktree() : undefined;
    key = incognitoSession?.key ?? key;
    const worktree =
      incognitoSession?.worktree ??
      (outcome === "owner-mismatch"
        ? await managedWorktrees.create({
            repoRoot: workspace,
            ownerKind: "manual",
            ownerId: "foreign-owner",
            name: "foreign-owner",
          })
        : await createSessionWorktree(key));
    fixture.track(worktree.id);
    if (outcome === "owner-mismatch") {
      await writeSessionStore({
        entries: {
          [key]: sessionStoreEntry(
            "session-owner-mismatch",
            worktreeEntry({ ...worktree, repoRoot: workspace }),
          ),
        },
      });
      removeSpy.mockClear();
    } else if (outcome === "busy") {
      runLease = await acquireWorktreeRunLease(worktree.id);
    } else if (outcome === "snapshot-failed" || outcome === "finalized") {
      removeSpy.mockImplementation(async function (this: ManagedWorktreeService, params) {
        if (params.id === worktree.id && params.reason === "session-delete") {
          if (outcome === "finalized") {
            await originalRemove(this, params);
            throw new WorktreeRemovalContentionError("finalized", "removed concurrently");
          }
          throw new WorktreeSnapshotError("simulated snapshot failure");
        }
        return await originalRemove(this, params);
      });
    }

    const deleted = await directSessionReq<SessionsDeleteResult>(method, {
      key,
      ...(outcome === "owner-mismatch" ? { deleteTranscript: false } : {}),
    });

    const preserved = outcome !== "finalized" && outcome !== "removed";
    if (preserved) {
      const { id, path: worktreePath, branch } = worktree;
      expect(deleted).toMatchObject({
        ok: true,
        payload: {
          deleted: true,
          worktreePreserved: { id, path: worktreePath, branch, reason: outcome },
        },
      });
    } else {
      expect(deleted).toMatchObject({ ok: true, payload: { deleted: true } });
      expect(deleted.payload).not.toHaveProperty("worktreePreserved");
    }
    expect(
      loadSessionEntry({ sessionKey: key, ...(incognito ? { agentId: "main" } : { storePath }) }),
    ).toBeUndefined();
    await expectWorktreePresent(worktree, preserved);
    if (outcome === "owner-mismatch") {
      expect(removeSpy).not.toHaveBeenCalled();
      expect(getRegistryWorktree(process.env, worktree.id)).toMatchObject({
        ownerKind: "manual",
        ownerId: "foreign-owner",
      });
    }
  } finally {
    await runLease?.release();
  }
});

async function createIncognitoSessionWithWorktree() {
  const created = await createWorktree({ agentId: "main", incognito: true });
  expect(created.ok, JSON.stringify(created)).toBe(true);
  const { key, worktree } = created.payload!;
  expect(loadSessionEntry({ agentId: "main", sessionKey: key })?.worktree?.id).toBe(worktree.id);
  return { key, worktree };
}
