import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { onSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  claimGitHubPublicationExecution,
  createGitHubPublicationExecutionStore,
  type GitHubPublicationRow,
} from "./github-publication-store.js";
import {
  BRANCH,
  NEW_HEAD,
  OLD_HEAD,
  SESSION_KEY,
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
  root,
} from "./github-publication.test-support.js";
import {
  claimRepositoryGitHubPublication,
  insertRepositoryGitHubPublication,
  readRepositoryGitHubPublication,
} from "./github-repository-publication-store.js";
import {
  insertSharedWorktreeReceipt,
  repositoryReceipt,
  sharedPublicationCoordinator,
  sharedPublicationSession as session,
  sharedRepositoryWorkspace,
} from "./github-shared-publication.test-support.js";

installGitHubPublicationTestHarness();
afterEach(() => vi.restoreAllMocks());
const mocks = githubPublicationTestMocks();
const url = "https://github.com/owner/repository/pull/12";

function publishWorktree(row: GitHubPublicationRow) {
  const claimed = claimGitHubPublicationExecution(row.request_id, "fixture-instance");
  return createGitHubPublicationExecutionStore("fixture-instance").complete(claimed, {
    requestId: row.request_id,
    status: "published",
    repository: "owner/repository",
    url,
    branch: row.branch,
    headCommit: NEW_HEAD,
  });
}
function changeSession(patch: Record<string, unknown>) {
  const original = mocks.loadSession.getMockImplementation()!;
  mocks.loadSession.mockImplementation((key: string, options: unknown) => {
    const loaded = original(key, options);
    return key === SESSION_KEY ? { ...loaded, entry: { ...loaded.entry, ...patch } } : loaded;
  });
}
function prohibitPublicationWork() {
  for (const mock of [mocks.prepareIdentity, mocks.refreshIdentity, mocks.runCommand]) {
    mock.mockClear().mockImplementation(() => {
      throw new Error("A status read must not publish or inspect credentials");
    });
  }
}

describe("shared worktree receipt observation", () => {
  it("rehydrates a real publication from immutable receipts without Git, credentials, replay, or events", async () => {
    const coordinator = sharedPublicationCoordinator();
    const published = await coordinator.requestForSession({
      sessionKey: SESSION_KEY,
      agentId: "main",
      idempotencyKey: "accepted",
    });
    expect(published.status).toBe("published");
    prohibitPublicationWork();
    const observer = vi.fn();
    const stop = onSessionLifecycleEvent(observer);
    try {
      expect(coordinator.sharedStatus(session, published.requestId)).toEqual({
        result: published,
        confirmation: null,
      });
      expect(coordinator.latestShared(session)).toEqual({ result: published, confirmation: null });
      expect(coordinator.latestShared(session, "accepted")).toEqual({
        result: published,
        confirmation: null,
      });
      expect(observer).not.toHaveBeenCalled();
      expect(mocks.prepareIdentity).not.toHaveBeenCalled();
      expect(mocks.refreshIdentity).not.toHaveBeenCalled();
      expect(mocks.runCommand).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it.each([
    { missing: "table", status: "published" },
    { missing: "row", status: "published" },
    { missing: "table", status: "failed" },
    { missing: "row", status: "failed" },
  ] as const)(
    "keeps legacy $status receipts as history with no lifecycle $missing",
    async ({ missing, status }) => {
      const coordinator = sharedPublicationCoordinator();
      const row = insertSharedWorktreeReceipt("legacy", { createdAtMs: 2_000 });
      if (status === "published") {
        publishWorktree(row);
      } else {
        const claimed = claimGitHubPublicationExecution(row.request_id, "fixture-instance");
        createGitHubPublicationExecutionStore("fixture-instance").complete(claimed, {
          requestId: row.request_id,
          status: "failed",
          code: "github_rejected",
          message: "GitHub rejected the publication.",
          nextAction: "Inspect GitHub before starting a new publication.",
        });
      }
      const database = openOpenClawStateDatabase();
      // v2026.9.1 persisted these receipt fields without any lifecycle companion.
      if (missing === "table") {
        database.db.exec("DROP TABLE github_publication_session_lifecycles");
      } else {
        database.db
          .prepare("DELETE FROM github_publication_session_lifecycles WHERE request_id = ?")
          .run(row.request_id);
      }
      const databasePath = database.path;
      closeOpenClawStateDatabaseForTest();
      const bytes = await fs.readFile(databasePath);
      const files = await fs.readdir(path.dirname(databasePath));
      prohibitPublicationWork();
      const observer = vi.fn();
      const stop = onSessionLifecycleEvent(observer);
      try {
        expect(coordinator.latestShared(session)).toBeNull();
        expect(coordinator.latestShared(session, row.idempotency_key)).toBeNull();
        expect(coordinator.sharedStatus(session, row.request_id)?.result).toMatchObject({
          requestId: row.request_id,
          status,
        });
        expect(await fs.readFile(databasePath)).toEqual(bytes);
        expect(await fs.readdir(path.dirname(databasePath))).toEqual(files);
        expect(observer).not.toHaveBeenCalled();
        expect(mocks.prepareIdentity).not.toHaveBeenCalled();
        expect(mocks.runCommand).not.toHaveBeenCalled();
      } finally {
        stop();
      }
      const db = openOpenClawStateDatabase().db;
      db.prepare("UPDATE worktrees SET owner_id = ? WHERE id = ?").run(
        "retired-owner",
        "worktree-1",
      );
      expect(coordinator.latestShared(session)).toBeNull();
      db.prepare("UPDATE worktrees SET owner_id = ? WHERE id = ?").run(SESSION_KEY, "worktree-1");
      insertSharedWorktreeReceipt("current", { createdAtMs: 1_000 });
      expect(coordinator.latestShared(session)?.result.requestId).toBe("current");
      expect(
        db
          .prepare(
            "SELECT request_id FROM github_publication_session_lifecycles WHERE request_id = ?",
          )
          .get(row.request_id),
      ).toBeUndefined();
    },
  );
  it("orders by creation and request ID even when an older receipt is reported later, and recovers only the exact key", () => {
    const coordinator = sharedPublicationCoordinator();
    publishWorktree(insertSharedWorktreeReceipt("old", { createdAtMs: 1 }));
    insertSharedWorktreeReceipt("new-a", { createdAtMs: 2 });
    insertSharedWorktreeReceipt("new-z", { createdAtMs: 2 });
    coordinator.markReported("old");
    expect(coordinator.latestShared(session)?.result).toMatchObject({
      requestId: "new-z",
      status: "requested",
    });
    expect(coordinator.latestShared(session, "old")?.result).toMatchObject({
      requestId: "old",
      status: "published",
      headCommit: NEW_HEAD,
    });
    expect(coordinator.latestShared(session, "not-accepted")).toBeNull();
  });

  it.each([
    { worktreeId: "previous-workspace" },
    { branch: "previous-branch" },
    { repositoryFingerprint: "previous-repository" },
  ])("never discovers an old workspace as current: %j", (scope) => {
    const coordinator = sharedPublicationCoordinator();
    const old = publishWorktree(insertSharedWorktreeReceipt("old", scope));
    expect(coordinator.latestShared(session)).toBeNull();
    expect(coordinator.latestShared(session, "old")).toBeNull();
    expect(coordinator.sharedStatus(session, old.request_id)?.result).toMatchObject({
      status: "published",
      headCommit: NEW_HEAD,
    });
  });

  it("separates current lifecycle discovery from explicit terminal history and never returns a stale pending receipt", () => {
    const coordinator = sharedPublicationCoordinator();
    publishWorktree(insertSharedWorktreeReceipt("terminal"));
    insertSharedWorktreeReceipt("pending");
    changeSession({ lifecycleRevision: "after-reset" });
    const current = { ...session, lifecycleRevision: "after-reset" };
    expect(coordinator.latestShared(current)).toBeNull();
    expect(coordinator.sharedStatus(current, "pending")).toBeUndefined();
    expect(coordinator.sharedStatus(current, "terminal")?.result).toMatchObject({
      status: "published",
      headCommit: NEW_HEAD,
    });
    changeSession({ sessionId: "new-incarnation" });
    const next = { ...current, sessionId: "new-incarnation" };
    expect(coordinator.latestShared(next)).toBeNull();
    expect(coordinator.sharedStatus(next, "terminal")?.result.status).toBe("published");
    changeSession({ archivedAt: 123 });
    expect(coordinator.latestShared(next)).toBeNull();
    expect(coordinator.sharedStatus(next, "terminal")?.result.status).toBe("published");
  });

  it("finds a current receipt behind a newer stale-lifecycle attempt", () => {
    const coordinator = sharedPublicationCoordinator();
    insertSharedWorktreeReceipt("current", { createdAtMs: 1 });
    insertSharedWorktreeReceipt("stale", {
      createdAtMs: 2,
      session: { ...session, lifecycleRevision: "old-lifecycle" },
    });
    expect(coordinator.latestShared(session)?.result.requestId).toBe("current");
    expect(coordinator.latestShared(session, "stale")).toBeNull();
  });

  it("does not reveal receipts to other logical sessions or agents", () => {
    const coordinator = sharedPublicationCoordinator();
    publishWorktree(insertSharedWorktreeReceipt("private-to-session"));
    expect(
      coordinator.sharedStatus(
        { ...session, sessionKey: "agent:main:dashboard:other" },
        "private-to-session",
      ),
    ).toBeUndefined();
    expect(() =>
      coordinator.sharedStatus({ ...session, agentId: "other" }, "private-to-session"),
    ).toThrow(/session.*changed/i);
    changeSession({ sessionId: "rotated-before-read" });
    expect(() => coordinator.latestShared(session)).toThrow(/session.*changed/i);
  });

  it.each(["binding", "digest", "publisher"])(
    "surfaces unavailable or corrupt %s evidence, not discovery null",
    (corruption) => {
      const coordinator = sharedPublicationCoordinator();
      insertSharedWorktreeReceipt("corrupt");
      const db = openOpenClawStateDatabase().db;
      if (corruption === "binding") {
        db.prepare("DELETE FROM github_publication_session_lifecycles WHERE request_id = ?").run(
          "corrupt",
        );
      } else if (corruption === "digest") {
        db.prepare(
          "UPDATE github_publication_requests SET request_digest = 'bad' WHERE request_id = ?",
        ).run("corrupt");
      } else {
        db.prepare(
          "UPDATE github_publication_requests SET identity_login = '' WHERE request_id = ?",
        ).run("corrupt");
      }
      expect(() => coordinator.latestShared(session)).toThrow(/unavailable|corrupt/);
      expect(() => coordinator.sharedStatus(session, "corrupt")).toThrow(/unavailable|corrupt/);
    },
  );

  it("does not initialize missing receipt or lifecycle tables, or a missing state database", async () => {
    const coordinator = sharedPublicationCoordinator();
    const database = openOpenClawStateDatabase();
    const schema = () =>
      database.db.prepare("SELECT name, sql FROM sqlite_schema ORDER BY name").all();
    const before = schema();
    expect(coordinator.latestShared(session)).toBeNull();
    expect(coordinator.sharedStatus(session, "absent")).toBeUndefined();
    expect(schema()).toEqual(before);
    const missingRoot = path.join(root, "never-opened");
    vi.stubEnv("OPENCLAW_STATE_DIR", missingRoot);
    expect(coordinator.latestShared(session)).toBeNull();
    expect(coordinator.sharedStatus(session, "absent")).toBeUndefined();
    await expect(fs.stat(missingRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reads a cold database without changing source bytes, schemas, or SQLite sidecars", async () => {
    const coordinator = sharedPublicationCoordinator();
    publishWorktree(insertSharedWorktreeReceipt("cold"));
    const database = openOpenClawStateDatabase();
    const databasePath = database.path;
    closeOpenClawStateDatabaseForTest();
    const before = await fs.readFile(databasePath);
    const files = await fs.readdir(path.dirname(databasePath));
    prohibitPublicationWork();
    expect(coordinator.latestShared(session)?.result).toMatchObject({
      requestId: "cold",
      headCommit: NEW_HEAD,
    });
    expect(coordinator.sharedStatus(session, "cold")?.result.status).toBe("published");
    expect(await fs.readFile(databasePath)).toEqual(before);
    expect(await fs.readdir(path.dirname(databasePath))).toEqual(files);
  });

  it("does not qualify an unavailable workspace until this session has a shared receipt", () => {
    const coordinator = sharedPublicationCoordinator();
    const db = openOpenClawStateDatabase().db;
    db.prepare("UPDATE worktrees SET owner_id = ? WHERE id = ?").run("other-session", "worktree-1");
    expect(coordinator.latestShared(session)).toBeNull();
    expect(coordinator.latestShared(session, "absent")).toBeNull();
    insertSharedWorktreeReceipt("accepted");
    expect(() => coordinator.latestShared(session)).toThrow(/owner.*unavailable/);
  });

  it("surfaces an unavailable current workspace rather than claiming no attempt", () => {
    const coordinator = sharedPublicationCoordinator();
    insertSharedWorktreeReceipt("current");
    openOpenClawStateDatabase()
      .db.prepare("UPDATE worktrees SET owner_id = ? WHERE id = ?")
      .run("other-session", "worktree-1");
    expect(() => coordinator.latestShared(session)).toThrow(/owner.*unavailable/);
  });
  it("searches past a full page of valid stale receipts without choosing one as current", () => {
    const coordinator = sharedPublicationCoordinator();
    insertSharedWorktreeReceipt("current", { createdAtMs: 0 });
    runOpenClawStateWriteTransaction(() => {
      for (let index = 0; index < 70; index += 1) {
        insertSharedWorktreeReceipt("old-" + index.toString().padStart(3, "0"), {
          createdAtMs: 1,
          session: { ...session, lifecycleRevision: "retired" },
        });
      }
    });
    expect(coordinator.latestShared(session)?.result.requestId).toBe("current");
  });

  it("does not recreate a missing lifecycle table while reporting unavailable evidence", () => {
    const coordinator = sharedPublicationCoordinator();
    insertSharedWorktreeReceipt("unbound");
    const db = openOpenClawStateDatabase().db;
    db.exec("DROP TABLE github_publication_session_lifecycles");
    expect(() => coordinator.latestShared(session)).toThrow(/binding.*unavailable/);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE name = 'github_publication_session_lifecycles'",
        )
        .get(),
    ).toBeUndefined();
  });

  it("does not turn an unreadable existing database into discovery null", async () => {
    const coordinator = sharedPublicationCoordinator();
    const databasePath = openOpenClawStateDatabase().path;
    const unavailableRoot = path.join(root, "unreadable");
    await fs.mkdir(path.join(unavailableRoot, path.relative(root, databasePath)), {
      recursive: true,
    });
    vi.stubEnv("OPENCLAW_STATE_DIR", unavailableRoot);
    expect(() => coordinator.latestShared(session)).toThrow();
  });
});

describe("shared repository receipt observation", () => {
  it("reads durable effect facts after a new coordinator starts without confirmation, replay, or credential work", () => {
    const workspace = sharedRepositoryWorkspace();
    const row = insertRepositoryGitHubPublication(
      repositoryReceipt(workspace.workspaceId),
      () => {},
    );
    const execution = claimRepositoryGitHubPublication(row, "old-instance", () => {});
    execution.recordEffect("push", { headCommit: OLD_HEAD });
    const coordinator = sharedPublicationCoordinator();
    const before = readRepositoryGitHubPublication(row.request_id);
    prohibitPublicationWork();
    const observer = vi.fn();
    const stop = onSessionLifecycleEvent(observer);
    try {
      expect(coordinator.latestShared(session)).toMatchObject({
        confirmation: null,
        result: {
          requestId: row.request_id,
          status: "publishing",
          effect: { kind: "push", status: "observed", headCommit: OLD_HEAD },
        },
      });
      expect(coordinator.sharedStatus(session, row.request_id)).toEqual(
        coordinator.latestShared(session, row.idempotency_key),
      );
      expect(readRepositoryGitHubPublication(row.request_id)).toEqual(before);
      expect(observer).not.toHaveBeenCalled();
      expect(mocks.prepareIdentity).not.toHaveBeenCalled();
      expect(mocks.runCommand).not.toHaveBeenCalled();
      expect(mocks.refreshIdentity).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it("discovers terminal outcomes by creation order and recovers exact older invocations", () => {
    const workspace = sharedRepositoryWorkspace();
    const coordinator = sharedPublicationCoordinator();
    const older = insertRepositoryGitHubPublication(
      repositoryReceipt(workspace.workspaceId, {
        request_id: "older",
        idempotency_key: "older-key",
        created_at_ms: 1,
      }),
      () => {},
    );
    for (const requestId of ["new-a", "new-z"]) {
      insertRepositoryGitHubPublication(
        repositoryReceipt(workspace.workspaceId, {
          request_id: requestId,
          idempotency_key: requestId,
          created_at_ms: 2,
          status: "failed",
          error_code: "push_rejected",
          next_action: "Inspect the existing GitHub branch.",
        }),
        () => {},
      );
    }
    const execution = claimRepositoryGitHubPublication(older, "instance", () => {});
    execution.complete({
      requestId: older.request_id,
      status: "published",
      url,
      repository: "owner/repository",
      branch: older.branch,
      headCommit: OLD_HEAD,
    });
    coordinator.markReported(older.request_id);
    expect(coordinator.latestShared(session)?.result).toMatchObject({
      requestId: "new-z",
      status: "failed",
    });
    expect(coordinator.latestShared(session, older.idempotency_key)?.result).toMatchObject({
      requestId: "older",
      status: "published",
      headCommit: OLD_HEAD,
    });
    expect(coordinator.latestShared(session, "absent")).toBeNull();
  });

  it.each([
    { session_id: "old-incarnation" },
    { session_lifecycle_revision: "old-lifecycle" },
    { workspace_id: "old-workspace" },
    { branch: "old-branch" },
  ])("does not discover stale repository scope: %j", (scope) => {
    const workspace = sharedRepositoryWorkspace();
    const coordinator = sharedPublicationCoordinator();
    const row = insertRepositoryGitHubPublication(
      repositoryReceipt(workspace.workspaceId, scope),
      () => {},
    );
    expect(coordinator.latestShared(session)).toBeNull();
    expect(coordinator.latestShared(session, row.idempotency_key)).toBeNull();
    expect(coordinator.sharedStatus(session, row.request_id)).toBeUndefined();
  });

  it("keeps terminal repository history explicit while refusing discovery after a workspace-kind change", () => {
    const workspace = sharedRepositoryWorkspace();
    const coordinator = sharedPublicationCoordinator();
    const row = insertRepositoryGitHubPublication(
      repositoryReceipt(workspace.workspaceId, {
        status: "published",
        head_commit: OLD_HEAD,
        pull_request_url: url,
      }),
      () => {},
    );
    changeSession({
      repositoryWorkspaceId: undefined,
      worktree: { id: "worktree-1", branch: BRANCH, repoRoot: "/repo" },
    });
    expect(coordinator.latestShared(session)).toBeNull();
    expect(coordinator.sharedStatus(session, row.request_id)?.result).toMatchObject({
      status: "published",
      headCommit: OLD_HEAD,
      url,
    });
    expect(
      coordinator.sharedStatus({ ...session, sessionKey: "other-session" }, row.request_id),
    ).toBeUndefined();
    expect(() =>
      coordinator.sharedStatus({ ...session, agentId: "other" }, row.request_id),
    ).toThrow(/session.*changed/i);
  });

  it("excludes personal rows before decoding even when their stored digest is corrupt", () => {
    const workspace = sharedRepositoryWorkspace();
    const coordinator = sharedPublicationCoordinator();
    const row = insertRepositoryGitHubPublication(
      repositoryReceipt(workspace.workspaceId, {
        owner_profile_id: "private-person",
        connection_generation: "private-generation",
        identity_source: "personal",
      }),
      () => {},
    );
    openOpenClawStateDatabase()
      .db.prepare(
        "UPDATE github_repository_publication_requests SET request_digest = 'corrupt-private-digest' WHERE request_id = ?",
      )
      .run(row.request_id);
    openOpenClawStateDatabase()
      .db.prepare("UPDATE session_repository_workspaces SET session_key = ? WHERE workspace_id = ?")
      .run("other-session", workspace.workspaceId);
    expect(coordinator.sharedStatus(session, row.request_id)).toBeUndefined();
    expect(coordinator.latestShared(session)).toBeNull();
    expect(coordinator.latestShared(session, row.idempotency_key)).toBeNull();
  });

  it.each(["title", "branch", "session_lifecycle_revision"])(
    "surfaces shared receipt corruption in %s instead of returning an empty discovery",
    (field) => {
      const workspace = sharedRepositoryWorkspace();
      const coordinator = sharedPublicationCoordinator();
      const row = insertRepositoryGitHubPublication(
        repositoryReceipt(workspace.workspaceId),
        () => {},
      );
      openOpenClawStateDatabase()
        .db.prepare(
          `UPDATE github_repository_publication_requests SET ${field} = 'changed outside owner' WHERE request_id = ?`,
        )
        .run(row.request_id);
      expect(() => coordinator.latestShared(session)).toThrow(/corrupt/);
      expect(() => coordinator.sharedStatus(session, row.request_id)).toThrow(/corrupt/);
    },
  );
  it("searches repository history in bounded pages before selecting the current lifecycle", () => {
    const workspace = sharedRepositoryWorkspace();
    const coordinator = sharedPublicationCoordinator();
    insertRepositoryGitHubPublication(
      repositoryReceipt(workspace.workspaceId, {
        request_id: "current",
        idempotency_key: "current",
        created_at_ms: 0,
      }),
      () => {},
    );
    runOpenClawStateWriteTransaction(() => {
      for (let index = 0; index < 70; index += 1) {
        const id = "old-" + index.toString().padStart(3, "0");
        insertRepositoryGitHubPublication(
          repositoryReceipt(workspace.workspaceId, {
            request_id: id,
            idempotency_key: id,
            created_at_ms: 1,
            session_lifecycle_revision: "retired",
          }),
          () => {},
        );
      }
    });
    expect(coordinator.latestShared(session)?.result.requestId).toBe("current");
  });

  it("reads cold repository receipts without recreating source sidecars or changing bytes", async () => {
    const workspace = sharedRepositoryWorkspace();
    const coordinator = sharedPublicationCoordinator();
    const row = insertRepositoryGitHubPublication(
      repositoryReceipt(workspace.workspaceId),
      () => {},
    );
    const databasePath = openOpenClawStateDatabase().path;
    closeOpenClawStateDatabaseForTest();
    const before = await fs.readFile(databasePath);
    const files = await fs.readdir(path.dirname(databasePath));
    prohibitPublicationWork();
    expect(coordinator.latestShared(session)?.result.requestId).toBe(row.request_id);
    expect(coordinator.sharedStatus(session, row.request_id)?.confirmation).toBeNull();
    expect(await fs.readFile(databasePath)).toEqual(before);
    expect(await fs.readdir(path.dirname(databasePath))).toEqual(files);
  });
});
