import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { getRuntimeConfig } from "../config/io.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { withIncognitoSessionBinding } from "../config/sessions/session-incognito-binding.js";
import { onSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { GitHubPublicationRow } from "../state/github-publication-read.types.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { openIncognitoTestActor } from "../state/openclaw-agent-execution-incognito.test-support.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import {
  claimGitHubPublicationExecutionFixture,
  createGitHubPublicationExecutionStoreFixture,
  claimRepositoryGitHubPublicationFixture,
  insertRepositoryGitHubPublicationFixture,
  readRepositoryGitHubPublicationFixture,
} from "./github-publication-store.test-support.js";
import {
  BRANCH,
  NEW_HEAD,
  OLD_HEAD,
  SESSION_KEY,
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
  persistPublicationTestSession,
  root,
} from "./github-publication.test-support.js";
import {
  insertSharedWorktreeReceipt,
  repositoryReceipt,
  sharedPublicationCoordinator,
  sharedPublicationSession as session,
  sharedRepositoryWorkspace,
} from "./github-shared-publication.test-support.js";

installGitHubPublicationTestHarness();
afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  await closeStateDatabaseForTest();
});
const mocks = githubPublicationTestMocks();
const url = "https://github.com/owner/repository/pull/12";

function publishWorktree(row: GitHubPublicationRow) {
  const claimed = claimGitHubPublicationExecutionFixture(row.request_id, "fixture-instance");
  return createGitHubPublicationExecutionStoreFixture("fixture-instance").complete(claimed, {
    requestId: row.request_id,
    status: "published",
    repository: "owner/repository",
    url,
    branch: row.branch,
    headCommit: NEW_HEAD,
  });
}
function changeSession(patch: Record<string, unknown>) {
  replaceSessionEntrySync(
    { agentId: "main", sessionKey: SESSION_KEY },
    { ...mocks.loadSession(SESSION_KEY).entry, ...patch },
  );
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
  it("publishes a durable draft worktree through the coordinator without host session reads", async () => {
    const privateKey = "agent:main:dashboard:private-publication-execute";
    const loadSession = mocks.loadSession.getMockImplementation()!;
    mocks.loadSession.mockImplementation((key: string) => {
      const loaded = loadSession(key);
      return key === privateKey
        ? { ...loaded, entry: { ...loaded.entry, visibility: "draft" } }
        : loaded;
    });
    await persistPublicationTestSession(privateKey);
    const coordinator = sharedPublicationCoordinator();
    const sql = observeHostDataSql();
    try {
      const result = await coordinator.requestForSessionV2({
        sessionKey: privateKey,
        agentId: "main",
        idempotencyKey: "private-publication",
      });
      expect(result).toMatchObject({ status: "published", headCommit: NEW_HEAD });
      expect(sql.queries.filter((query) => /\bsession_nodes\b/.test(query))).toEqual([]);
    } finally {
      sql.restore();
    }
  });
  it("keeps ordinary private receipt reads on the native owner without allocating an actor", async () => {
    const native = { ...session, sessionKey: "agent:main:dashboard:incognito-native-publication" };
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: native.sessionKey },
      { ...mocks.loadSession(SESSION_KEY).entry, updatedAt: Date.now(), incognito: true },
    );
    const row = insertSharedWorktreeReceipt("native-private-receipt", { session: native });
    publishWorktree(row);
    const before = captureOpenClawAgentDatabaseExecution.listIncognito({
      OPENCLAW_STATE_DIR: root,
    });
    expect(
      (await sharedPublicationCoordinator().sharedStatus(native, row.request_id))?.result.status,
    ).toBe("published");
    expect(
      captureOpenClawAgentDatabaseExecution.listIncognito({ OPENCLAW_STATE_DIR: root }),
    ).toEqual(before);
    expect(before).toEqual([]);
  });
  it("observes bound private receipts without native session access and fences a retired actor", async () => {
    const authority = { assertCurrent() {} };
    const env = { OPENCLAW_STATE_DIR: root };
    const actor = await openIncognitoTestActor(env, authority);
    try {
      const privateSession = {
        ...session,
        sessionKey: "agent:main:dashboard:incognito-publication-receipt",
      };
      const entry = {
        ...mocks.loadSession(SESSION_KEY).entry,
        updatedAt: Date.now(),
        incognito: true as const,
      };
      await actor.sessions.create(authority, { sessionKey: privateSession.sessionKey, entry });
      const row = insertSharedWorktreeReceipt("private-receipt", { session: privateSession });
      publishWorktree(row);
      const coordinator = sharedPublicationCoordinator();
      const observe = () =>
        withIncognitoSessionBinding({ actor }, () =>
          coordinator.sharedStatus(privateSession, row.request_id),
        );
      const sql = observeHostDataSql();
      try {
        expect((await observe())?.result).toMatchObject({
          requestId: row.request_id,
          status: "published",
        });
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
      }
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const execute = stateReads.executeExistingOpenClawStateRead;
      const held = vi
        .spyOn(stateReads, "executeExistingOpenClawStateRead")
        .mockImplementation(async (...args) => {
          const result = await execute(...args);
          if (args[1].type === "githubPublication.sharedObservation") {
            entered.resolve();
            await release.promise;
          }
          return result;
        });
      const pending = observe();
      let closing: Promise<void> | undefined;
      try {
        await Promise.race([
          entered.promise,
          pending.then(
            () => {
              throw new Error("Private observation finished before receipt preparation was held");
            },
            (error: unknown) => {
              throw error;
            },
          ),
        ]);
        closing = actor.close();
        release.resolve();
        await expect(pending).rejects.toThrow(/ended|current|closed/i);
        await closing;
        const replacement = await openIncognitoTestActor(env, authority);
        try {
          await replacement.sessions.create(authority, {
            sessionKey: privateSession.sessionKey,
            entry,
          });
          expect(replacement.identity.incarnation).not.toBe(actor.identity.incarnation);
          await expect(observe()).rejects.toThrow(/ended|current|closed/i);
        } finally {
          await replacement.close();
          await replacement.release();
        }
      } finally {
        release.resolve();
        await pending.catch(() => {});
        await closing;
        held.mockRestore();
      }
    } finally {
      await actor.close();
      await actor.release();
    }
  });

  it("rehydrates a real publication from immutable receipts without Git, credentials, replay, or events", async () => {
    const coordinator = sharedPublicationCoordinator();
    const published = await coordinator.requestForSessionV2({
      sessionKey: SESSION_KEY,
      agentId: "main",
      idempotencyKey: "accepted",
    });
    expect(published.status).toBe("published");
    prohibitPublicationWork();
    const observer = vi.fn();
    const stop = onSessionLifecycleEvent(observer);
    const sql = observeHostDataSql();
    try {
      expect(await coordinator.sharedStatus(session, published.requestId)).toEqual({
        result: published,
        confirmation: null,
      });
      expect(await coordinator.latestShared(session)).toEqual({
        result: published,
        confirmation: null,
      });
      expect(await coordinator.latestShared(session, "accepted")).toEqual({
        result: published,
        confirmation: null,
      });
      expect(observer).not.toHaveBeenCalled();
      expect(mocks.prepareIdentity).not.toHaveBeenCalled();
      expect(mocks.refreshIdentity).not.toHaveBeenCalled();
      expect(mocks.runCommand).not.toHaveBeenCalled();
      expect(
        sql.queries.filter((query) =>
          /\b(?:github_publication_requests|github_repository_publication_requests|github_publication_session_lifecycles|session_repository_workspaces|worktrees)\b/.test(
            query,
          ),
        ),
      ).toEqual([]);
    } finally {
      sql.restore();
      stop();
    }
  });

  it.each(["latest", "pending", "terminal"] as const)(
    "revalidates workspace selection after the worker read for %s",
    async (mode) => {
      const coordinator = sharedPublicationCoordinator();
      const row = insertSharedWorktreeReceipt("held-selection");
      if (mode !== "pending") {
        publishWorktree(row);
      }
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const execute = stateReads.executeExistingOpenClawStateRead;
      const held = vi
        .spyOn(stateReads, "executeExistingOpenClawStateRead")
        .mockImplementation(async (...args) => {
          const result = await execute(...args);
          if (
            args[1].type === "githubPublication.sharedObservation" &&
            args[1].input.kind === "worktree"
          ) {
            entered.resolve();
            await release.promise;
          }
          return result;
        });
      const request =
        mode === "latest"
          ? coordinator.latestShared(session)
          : coordinator.sharedStatus(session, row.request_id);
      const settled = request.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        await Promise.race([
          entered.promise,
          settled.then(() => {
            throw new Error("Observation finished before the real worker read was held");
          }),
        ]);
        changeSession({
          worktree: {
            id: "replacement-worktree",
            branch: "replacement-branch",
            repoRoot: "/replacement",
          },
        });
        release.resolve();
        const outcome = await settled;
        if (mode === "terminal") {
          expect(outcome).toMatchObject({
            value: { result: { requestId: row.request_id, status: "published" } },
          });
        } else {
          expect(outcome).toMatchObject({
            error: expect.objectContaining({ message: expect.stringMatching(/session.*changed/i) }),
          });
        }
      } finally {
        release.resolve();
        await settled;
        held.mockRestore();
      }
    },
  );

  it.each([
    { missing: "table", status: "published" },
    { missing: "row", status: "failed" },
  ] as const)(
    "keeps legacy $status receipts as history with no lifecycle $missing",
    async ({ missing, status }) => {
      const coordinator = sharedPublicationCoordinator();
      const row = insertSharedWorktreeReceipt("legacy", { createdAtMs: 2_000 });
      if (status === "published") {
        publishWorktree(row);
      } else {
        const claimed = claimGitHubPublicationExecutionFixture(row.request_id, "fixture-instance");
        createGitHubPublicationExecutionStoreFixture("fixture-instance").complete(claimed, {
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
      await closeOpenClawStateDatabaseAsync();
      const bytes = await fs.readFile(databasePath);
      const files = await fs.readdir(path.dirname(databasePath));
      prohibitPublicationWork();
      const observer = vi.fn();
      const stop = onSessionLifecycleEvent(observer);
      try {
        expect(await coordinator.latestShared(session)).toBeNull();
        expect(await coordinator.latestShared(session, row.idempotency_key)).toBeNull();
        expect((await coordinator.sharedStatus(session, row.request_id))?.result).toMatchObject({
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
      expect(await coordinator.latestShared(session)).toBeNull();
      db.prepare("UPDATE worktrees SET owner_id = ? WHERE id = ?").run(SESSION_KEY, "worktree-1");
      insertSharedWorktreeReceipt("current", { createdAtMs: 1_000 });
      expect((await coordinator.latestShared(session))?.result.requestId).toBe("current");
      expect(
        db
          .prepare(
            "SELECT request_id FROM github_publication_session_lifecycles WHERE request_id = ?",
          )
          .get(row.request_id),
      ).toBeUndefined();
    },
  );

  it.each([
    { worktreeId: "previous-workspace" },
    { branch: "previous-branch" },
    { repositoryFingerprint: "previous-repository" },
  ])("never discovers an old workspace as current: %j", async (scope) => {
    const coordinator = sharedPublicationCoordinator();
    const old = publishWorktree(insertSharedWorktreeReceipt("old", scope));
    expect(await coordinator.latestShared(session)).toBeNull();
    expect(await coordinator.latestShared(session, "old")).toBeNull();
    expect((await coordinator.sharedStatus(session, old.request_id))?.result).toMatchObject({
      status: "published",
      headCommit: NEW_HEAD,
    });
  });

  it("separates current lifecycle discovery from explicit terminal history and never returns a stale pending receipt", async () => {
    const coordinator = sharedPublicationCoordinator();
    publishWorktree(insertSharedWorktreeReceipt("terminal"));
    insertSharedWorktreeReceipt("pending");
    changeSession({ lifecycleRevision: "after-reset" });
    const current = { ...session, lifecycleRevision: "after-reset" };
    expect(await coordinator.latestShared(current)).toBeNull();
    expect(await coordinator.sharedStatus(current, "pending")).toBeUndefined();
    expect((await coordinator.sharedStatus(current, "terminal"))?.result).toMatchObject({
      status: "published",
      headCommit: NEW_HEAD,
    });
    changeSession({ sessionId: "new-incarnation" });
    const next = { ...current, sessionId: "new-incarnation" };
    expect(await coordinator.latestShared(next)).toBeNull();
    expect((await coordinator.sharedStatus(next, "terminal"))?.result.status).toBe("published");
    changeSession({ archivedAt: 123 });
    expect(await coordinator.latestShared(next)).toBeNull();
    expect((await coordinator.sharedStatus(next, "terminal"))?.result.status).toBe("published");
  });

  it("does not reveal receipts to other logical sessions or agents", async () => {
    const coordinator = sharedPublicationCoordinator();
    publishWorktree(insertSharedWorktreeReceipt("private-to-session"));
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: "agent:main:dashboard:other" },
      { ...mocks.loadSession(SESSION_KEY).entry },
    );
    expect(
      await coordinator.sharedStatus(
        { ...session, sessionKey: "agent:main:dashboard:other" },
        "private-to-session",
      ),
    ).toBeUndefined();
    await expect(
      async () =>
        await coordinator.sharedStatus({ ...session, agentId: "other" }, "private-to-session"),
    ).rejects.toThrow('agent-scoped session key belongs to "main", not "other"');
    changeSession({ sessionId: "rotated-before-read" });
    await expect(async () => await coordinator.latestShared(session)).rejects.toThrow(
      /session.*changed/i,
    );
  });

  it.each(["binding", "digest", "publisher"])(
    "surfaces unavailable or corrupt %s evidence, not discovery null",
    async (corruption) => {
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
      await expect(async () => await coordinator.latestShared(session)).rejects.toThrow(
        /unavailable|corrupt/,
      );
      await expect(async () => await coordinator.sharedStatus(session, "corrupt")).rejects.toThrow(
        /unavailable|corrupt/,
      );
    },
  );

  it("does not initialize missing receipt or lifecycle tables, or a missing state database", async () => {
    const coordinator = sharedPublicationCoordinator();
    const database = openOpenClawStateDatabase();
    const schema = () =>
      database.db.prepare("SELECT name, sql FROM sqlite_schema ORDER BY name").all();
    const before = schema();
    expect(await coordinator.latestShared(session)).toBeNull();
    expect(await coordinator.sharedStatus(session, "absent")).toBeUndefined();
    expect(schema()).toEqual(before);
    const { loadGatewaySessionEntryReadOnly } =
      await vi.importActual<typeof import("./session-utils.js")>("./session-utils.js");
    const cfg = getRuntimeConfig();
    setRuntimeConfigSnapshot({
      ...cfg,
      session: {
        ...cfg.session,
        store: loadGatewaySessionEntryReadOnly(SESSION_KEY, { agentId: "main" }).storePath,
      },
    });
    const missingRoot = path.join(root, "never-opened");
    vi.stubEnv("OPENCLAW_STATE_DIR", missingRoot);
    expect(await coordinator.latestShared(session)).toBeNull();
    expect(await coordinator.sharedStatus(session, "absent")).toBeUndefined();
    await expect(fs.stat(missingRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("searches past a full page of valid stale receipts without choosing one as current", async () => {
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
    expect((await coordinator.latestShared(session))?.result.requestId).toBe("current");
    expect(await coordinator.latestShared(session, "old-000")).toBeNull();
  });

  it("does not recreate a missing lifecycle table while reporting unavailable evidence", async () => {
    const coordinator = sharedPublicationCoordinator();
    insertSharedWorktreeReceipt("unbound");
    const db = openOpenClawStateDatabase().db;
    db.exec("DROP TABLE github_publication_session_lifecycles");
    await expect(async () => await coordinator.latestShared(session)).rejects.toThrow(
      /binding.*unavailable/,
    );
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
    await expect(async () => await coordinator.latestShared(session)).rejects.toThrow();
  });
});

describe("shared repository receipt observation", () => {
  it("does not qualify an unavailable repository workspace until this session has a shared receipt", async () => {
    const workspace = await sharedRepositoryWorkspace();
    const coordinator = sharedPublicationCoordinator();
    openOpenClawStateDatabase()
      .db.prepare("UPDATE session_repository_workspaces SET session_key = ? WHERE workspace_id = ?")
      .run("other-session", workspace.workspaceId);
    expect(await coordinator.latestShared(session)).toBeNull();
    expect(await coordinator.latestShared(session, "absent")).toBeNull();
    insertRepositoryGitHubPublicationFixture(repositoryReceipt(workspace), () => {});
    await expect(async () => await coordinator.latestShared(session)).rejects.toThrow(
      /owner.*unavailable/,
    );
  });

  it("reads durable effect facts after a new coordinator starts without confirmation, replay, or credential work", async () => {
    const workspace = await sharedRepositoryWorkspace();
    const row = insertRepositoryGitHubPublicationFixture(repositoryReceipt(workspace), () => {});
    const execution = claimRepositoryGitHubPublicationFixture(row, "old-instance", {
      assertCustody: () => {},
      assertCurrent: () => {},
    });
    execution.recordEffect("push", { headCommit: OLD_HEAD });
    const coordinator = sharedPublicationCoordinator();
    const before = readRepositoryGitHubPublicationFixture(row.request_id);
    prohibitPublicationWork();
    const observer = vi.fn();
    const stop = onSessionLifecycleEvent(observer);
    try {
      expect(await coordinator.latestShared(session)).toMatchObject({
        confirmation: null,
        result: {
          requestId: row.request_id,
          status: "publishing",
          effect: { kind: "push", status: "observed", headCommit: OLD_HEAD },
        },
      });
      expect(await coordinator.sharedStatus(session, row.request_id)).toEqual(
        await coordinator.latestShared(session, row.idempotency_key),
      );
      expect(readRepositoryGitHubPublicationFixture(row.request_id)).toEqual(before);
      expect(observer).not.toHaveBeenCalled();
      expect(mocks.prepareIdentity).not.toHaveBeenCalled();
      expect(mocks.runCommand).not.toHaveBeenCalled();
      expect(mocks.refreshIdentity).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it("discovers terminal outcomes by creation order and recovers exact older invocations", async () => {
    const workspace = await sharedRepositoryWorkspace();
    const coordinator = sharedPublicationCoordinator();
    const older = insertRepositoryGitHubPublicationFixture(
      repositoryReceipt(workspace, {
        request_id: "older",
        idempotency_key: "older-key",
        created_at_ms: 1,
      }),
      () => {},
    );
    for (const requestId of ["new-a", "new-z"]) {
      insertRepositoryGitHubPublicationFixture(
        repositoryReceipt(workspace, {
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
    const execution = claimRepositoryGitHubPublicationFixture(older, "instance", {
      assertCustody: () => {},
      assertCurrent: () => {},
    });
    execution.complete({
      requestId: older.request_id,
      status: "published",
      url,
      repository: "owner/repository",
      branch: older.branch,
      headCommit: OLD_HEAD,
    });
    await coordinator.markReportedAsync(older.request_id);
    expect((await coordinator.latestShared(session))?.result).toMatchObject({
      requestId: "new-z",
      status: "failed",
    });
    expect((await coordinator.latestShared(session, older.idempotency_key))?.result).toMatchObject({
      requestId: "older",
      status: "published",
      headCommit: OLD_HEAD,
    });
    expect(await coordinator.latestShared(session, "absent")).toBeNull();
  });

  it.each([
    { session_id: "old-incarnation" },
    { session_lifecycle_revision: "old-lifecycle" },
    { workspace_id: "old-workspace" },
    { branch: "old-branch" },
  ])("does not discover stale repository scope: %j", async (scope) => {
    const workspace = await sharedRepositoryWorkspace();
    const coordinator = sharedPublicationCoordinator();
    const row = insertRepositoryGitHubPublicationFixture(
      repositoryReceipt(workspace, scope),
      () => {},
    );
    expect(await coordinator.latestShared(session)).toBeNull();
    expect(await coordinator.latestShared(session, row.idempotency_key)).toBeNull();
    expect(await coordinator.sharedStatus(session, row.request_id)).toBeUndefined();
  });

  it("keeps terminal repository history explicit while refusing discovery after a workspace-kind change", async () => {
    const workspace = await sharedRepositoryWorkspace();
    const coordinator = sharedPublicationCoordinator();
    const row = insertRepositoryGitHubPublicationFixture(
      repositoryReceipt(workspace, {
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
    expect(await coordinator.latestShared(session)).toBeNull();
    expect((await coordinator.sharedStatus(session, row.request_id))?.result).toMatchObject({
      status: "published",
      headCommit: OLD_HEAD,
      url,
    });
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: "agent:main:dashboard:other" },
      { ...mocks.loadSession(SESSION_KEY).entry },
    );
    expect(
      await coordinator.sharedStatus(
        { ...session, sessionKey: "agent:main:dashboard:other" },
        row.request_id,
      ),
    ).toBeUndefined();
    await expect(
      async () => await coordinator.sharedStatus({ ...session, agentId: "other" }, row.request_id),
    ).rejects.toThrow('agent-scoped session key belongs to "main", not "other"');
  });

  it("excludes personal rows before decoding even when their stored digest is corrupt", async () => {
    const workspace = await sharedRepositoryWorkspace();
    const coordinator = sharedPublicationCoordinator();
    const row = insertRepositoryGitHubPublicationFixture(
      repositoryReceipt(workspace, {
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
    expect(await coordinator.sharedStatus(session, row.request_id)).toBeUndefined();
    expect(await coordinator.latestShared(session)).toBeNull();
    expect(await coordinator.latestShared(session, row.idempotency_key)).toBeNull();
  });

  it("surfaces shared receipt corruption before filtering by branch", async () => {
    const workspace = await sharedRepositoryWorkspace();
    const coordinator = sharedPublicationCoordinator();
    const row = insertRepositoryGitHubPublicationFixture(repositoryReceipt(workspace), () => {});
    openOpenClawStateDatabase()
      .db.prepare(
        "UPDATE github_repository_publication_requests SET branch = 'changed outside owner' WHERE request_id = ?",
      )
      .run(row.request_id);
    await expect(async () => await coordinator.latestShared(session)).rejects.toThrow(/corrupt/);
    await expect(
      async () => await coordinator.sharedStatus(session, row.request_id),
    ).rejects.toThrow(/corrupt/);
  });
  it("searches past retired repository history to select the current lifecycle", async () => {
    const workspace = await sharedRepositoryWorkspace();
    const coordinator = sharedPublicationCoordinator();
    insertRepositoryGitHubPublicationFixture(
      repositoryReceipt(workspace, {
        request_id: "current",
        idempotency_key: "current",
        created_at_ms: 0,
      }),
      () => {},
    );
    runOpenClawStateWriteTransaction(() => {
      for (let index = 0; index < 70; index += 1) {
        const id = "old-" + index.toString().padStart(3, "0");
        insertRepositoryGitHubPublicationFixture(
          repositoryReceipt(workspace, {
            request_id: id,
            idempotency_key: id,
            created_at_ms: 1,
            session_lifecycle_revision: "retired",
          }),
          () => {},
        );
      }
    });
    expect((await coordinator.latestShared(session))?.result.requestId).toBe("current");
  });
});
