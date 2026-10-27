import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { deleteRegistryWorktree, insertRegistryWorktree } from "../agents/worktrees/registry.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { getRuntimeConfig } from "../config/io.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { readSessionActorStorageResult } from "../config/sessions/session-actor-storage-result.js";
import { onSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { GitHubPublicationRow } from "../state/github-publication-read.types.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import * as publicationSource from "./github-publication-source.js";
import { readGitHubPublicationRequestAsync } from "./github-publication-store-async.js";
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
  publicationRequest,
  publicationWorktree,
  registryPublicationWorktree,
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

function observeSql() {
  const sql = observeHostDataSql();
  return { ...sql, [Symbol.dispose]: sql.restore };
}

function observeEvents() {
  const observer = vi.fn();
  return Object.assign(observer, { [Symbol.dispose]: onSessionLifecycleEvent(observer) });
}

function insertRepositoryReceipt(
  workspace: Parameters<typeof repositoryReceipt>[0],
  overrides?: Parameters<typeof repositoryReceipt>[1],
) {
  return insertRepositoryGitHubPublicationFixture(
    repositoryReceipt(workspace, overrides),
    () => {},
  );
}

function holdObservation(onRead: (count: number) => void = () => {}) {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const execute = stateReads.executeExistingOpenClawStateRead;
  const held = vi
    .spyOn(stateReads, "executeExistingOpenClawStateRead")
    .mockImplementation(async (...args) => {
      const result = await execute(...args);
      if (args[1].type === "githubPublications.sharedObservation") {
        entered.resolve();
        onRead(held.mock.calls.length);
        await release.promise;
      }
      return result;
    });
  return { entered, release, held };
}

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

function expectNoPublicationWork() {
  for (const mock of [mocks.prepareIdentity, mocks.refreshIdentity, mocks.runCommand]) {
    expect(mock).not.toHaveBeenCalled();
  }
}

async function expectSessionIsolation(
  coordinator: ReturnType<typeof sharedPublicationCoordinator>,
  requestId: string,
) {
  const location = { agentId: "main", sessionKey: "agent:main:dashboard:other" };
  replaceSessionEntrySync(location, { ...mocks.loadSession(SESSION_KEY).entry });
  expect(await coordinator.sharedStatus({ ...session, ...location }, requestId)).toBeUndefined();
  await expect(
    coordinator.sharedStatus({ ...session, agentId: "other" }, requestId),
  ).rejects.toThrow("GitHub publication session lifecycle changed.");
}

async function createPrivatePublicationSession(sessionKey: string) {
  const location = {
    agentId: "main",
    path: resolveIncognitoOpenClawAgentSqlitePath({
      agentId: "main",
      env: { OPENCLAW_STATE_DIR: root },
    }),
  };
  const owner = memorySessionActorOwners.get(location);
  const actor = await owner.acquire(
    { database: owner.identity, sessionKey },
    { assertCurrent() {}, assertReadable() {} },
  );
  try {
    readSessionActorStorageResult(
      await actor.storage!.mutate(
        {
          type: "session.entry.create",
          input: { entry: { ...mocks.loadSession(SESSION_KEY).entry, updatedAt: Date.now() } },
        },
        { assertCurrent() {}, authorize() {} },
      ),
    );
  } finally {
    await actor.release();
  }
  return { owner, location };
}

describe("shared worktree receipt observation", () => {
  it.each(["memory", "closed-memory", "draft"] as const)(
    "publishes private %s without host session reads; closed admission rejects",
    async (mode) => {
      const privateKey = `agent:main:dashboard:${mode === "draft" ? "private" : "incognito"}-publication-execute`;
      const key = mode === "draft" ? "private-publication" : "memory-publication";
      const memory =
        mode === "draft" ? undefined : await createPrivatePublicationSession(privateKey);
      if (mode === "draft") {
        const loadSession = mocks.loadSession.getMockImplementation()!;
        mocks.loadSession.mockImplementation((sessionKey: string) => {
          const loaded = loadSession(sessionKey);
          return sessionKey === privateKey
            ? { ...loaded, entry: { ...loaded.entry, visibility: "draft" } }
            : loaded;
        });
        await persistPublicationTestSession(privateKey);
      }
      if (mode === "closed-memory" && memory) {
        const bind = publicationSource.bindGitHubPublicationSource;
        vi.spyOn(publicationSource, "bindGitHubPublicationSource").mockImplementation(
          (capability) => {
            const binding = bind(capability);
            return {
              ...binding,
              createAdmission(operation) {
                const admission = binding.createAdmission(operation);
                admission.admission.observeRequests((request) => {
                  if (request.stage === "prepare") {
                    memory.owner.closeSession(privateKey);
                  }
                });
                return admission;
              },
            };
          },
        );
      }
      try {
        if (memory) {
          await deleteRegistryWorktree(process.env, "worktree-1");
          await insertRegistryWorktree(process.env, {
            ...registryPublicationWorktree(publicationWorktree(privateKey)),
            createdAt: 1,
            lastActiveAt: 1,
          });
        }
        const coordinator = mode === "draft" ? sharedPublicationCoordinator() : undefined;
        using sql = observeSql();
        const publication = (coordinator ?? sharedPublicationCoordinator()).requestForSessionV2(
          publicationRequest(key, { sessionKey: privateKey }),
        );
        if (mode === "closed-memory") {
          await expect(publication).rejects.toThrow(/session|source|requester/i);
          expect(
            await readGitHubPublicationRequestAsync({
              sessionId: session.sessionId,
              idempotencyKey: key,
            }),
          ).toBeUndefined();
        } else {
          expect(await publication).toMatchObject({ status: "published", headCommit: NEW_HEAD });
        }
        expect(sql.queries.filter((query) => /\bsession_nodes\b/.test(query))).toEqual([]);
      } finally {
        if (memory) {
          memorySessionActorOwners.closeDatabase(memory.location);
        }
      }
    },
  );
  it("observes memory-only private receipts and refuses disclosure after session close", async () => {
    const privateSession = {
      ...session,
      sessionKey: "agent:main:dashboard:incognito-publication-receipt",
    };
    const { owner, location } = await createPrivatePublicationSession(privateSession.sessionKey);
    try {
      const row = insertSharedWorktreeReceipt("private-receipt", { session: privateSession });
      publishWorktree(row);
      const coordinator = sharedPublicationCoordinator();
      const observe = () => coordinator.sharedStatus(privateSession, row.request_id);
      {
        using sql = observeSql();
        expect((await observe())?.result).toMatchObject({
          requestId: row.request_id,
          status: "published",
        });
        expect(sql.queries).toEqual([]);
      }
      const { entered, release, held } = holdObservation();
      const pending = observe();
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
        owner.closeSession(privateSession.sessionKey);
        release.resolve();
        await expect(pending).rejects.toThrow(/session.*changed/i);
      } finally {
        release.resolve();
        await pending.catch(() => {});
        held.mockRestore();
      }
    } finally {
      memorySessionActorOwners.closeDatabase(location);
    }
  });

  it("borrows prepared session custody for receipt reads and rejects its release", async () => {
    const { prepareGitHubPublicationSession } =
      await import("./github-publication-availability.js");
    await persistPublicationTestSession();
    using selected = await prepareGitHubPublicationSession(SESSION_KEY, { agentId: "main" });
    const entry = selected.readCurrent().entry!;
    const identity = { ...session, lifecycleRevision: entry.lifecycleRevision ?? null };
    const coordinator = sharedPublicationCoordinator();
    expect(
      await coordinator.latestShared(identity, undefined, undefined, () => selected.readCurrent()),
    ).toBeNull();
    selected.release();
    await expect(
      coordinator.latestShared(identity, undefined, undefined, () => selected.readCurrent()),
    ).rejects.toThrow("session lifecycle changed");
  });

  it("shares a reconnect burst's pending observation and invalidates it on publication", async () => {
    const { prepareGitHubPublicationSession } =
      await import("./github-publication-availability.js");
    await persistPublicationTestSession();
    using selected = await prepareGitHubPublicationSession(SESSION_KEY, { agentId: "main" });
    const identity = {
      ...session,
      lifecycleRevision: selected.readCurrent().entry!.lifecycleRevision ?? null,
    };
    const coordinator = sharedPublicationCoordinator();
    const freshEntered = createDeferredCore();
    const { entered, release, held } = holdObservation((count) => {
      if (count === 2) {
        freshEntered.resolve();
      }
    });
    const observe = () =>
      coordinator.latestShared(identity, undefined, undefined, () => selected.readCurrent());
    const burst = Promise.allSettled(Array.from({ length: 150 }, observe));
    let fresh: ReturnType<typeof observe> | undefined;
    let retired: ReturnType<typeof observe> | undefined;
    try {
      await entered.promise;
      expect(held).toHaveBeenCalledTimes(1);
      insertSharedWorktreeReceipt("new-publication", { session: identity });
      fresh = observe();
      await freshEntered.promise;
      expect(held).toHaveBeenCalledTimes(2);
      await deleteRegistryWorktree(process.env, "worktree-1");
      retired = observe();
      expect(held).toHaveBeenCalledTimes(3);
      release.resolve();
      expect(await burst).toEqual(
        Array.from({ length: 150 }, () => ({ status: "fulfilled", value: null })),
      );
      expect((await fresh)?.result.requestId).toBe("new-publication");
      expect(await retired).toBeNull();
      await observe();
      expect(held).toHaveBeenCalledTimes(4);
    } finally {
      release.resolve();
      await burst;
      await fresh?.catch(() => {});
      await retired?.catch(() => {});
    }
  });

  it("rehydrates a real publication from immutable receipts without Git, credentials, replay, or events", async () => {
    const coordinator = sharedPublicationCoordinator();
    const published = await coordinator.requestForSessionV2(publicationRequest("accepted"));
    expect(published.status).toBe("published");
    prohibitPublicationWork();
    using observer = observeEvents();
    using sql = observeSql();
    const reads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
    const expected = { result: published, confirmation: null };
    expect(await coordinator.sharedStatus(session, published.requestId)).toEqual(expected);
    expect(await coordinator.latestShared(session)).toEqual(expected);
    expect(await coordinator.latestShared(session, "accepted")).toEqual(expected);
    expect(
      reads.mock.calls.filter(
        ([, command]) => command.type === "githubPublications.sharedObservation",
      ),
    ).toHaveLength(3);
    expect(observer).not.toHaveBeenCalled();
    expectNoPublicationWork();
    expect(
      sql.queries.filter((query) =>
        /\b(?:github_publication_requests|github_repository_publication_requests|github_publication_session_lifecycles|session_repository_workspaces|worktrees)\b/.test(
          query,
        ),
      ),
    ).toEqual([]);
  });

  it.each(["latest", "pending", "terminal"] as const)(
    "revalidates workspace selection after the worker read for %s",
    async (mode) => {
      mocks.persistedSessionKeys.add(SESSION_KEY);
      const coordinator = sharedPublicationCoordinator();
      const row = insertSharedWorktreeReceipt("held-selection");
      if (mode !== "pending") {
        publishWorktree(row);
      }
      const { entered, release, held } = holdObservation();
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
      {
        using observer = observeEvents();
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
    await expectSessionIsolation(coordinator, "private-to-session");
    changeSession({ sessionId: "rotated-before-read" });
    await expect(coordinator.latestShared(session)).rejects.toThrow(/session.*changed/i);
  });

  it.each(["binding", "table", "digest", "publisher"])(
    "surfaces unavailable or corrupt %s evidence, not discovery null",
    async (corruption) => {
      const coordinator = sharedPublicationCoordinator();
      insertSharedWorktreeReceipt("corrupt");
      const db = openOpenClawStateDatabase().db;
      if (corruption === "table") {
        db.exec("DROP TABLE github_publication_session_lifecycles");
      } else if (corruption === "binding") {
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
      const error = corruption === "table" ? /binding.*unavailable/ : /unavailable|corrupt/;
      await expect(coordinator.latestShared(session)).rejects.toThrow(error);
      await expect(coordinator.sharedStatus(session, "corrupt")).rejects.toThrow(error);
      if (corruption === "table") {
        expect(
          db
            .prepare("SELECT name FROM sqlite_schema WHERE name = ?")
            .get("github_publication_session_lifecycles"),
        ).toBeUndefined();
      }
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
    const { loadGatewaySessionEntryReadOnlyInWorker } = await vi.importActual<
      typeof import("./session-utils-store-worker.js")
    >("./session-utils-store-worker.js");
    const cfg = getRuntimeConfig();
    const loaded = await loadGatewaySessionEntryReadOnlyInWorker({
      cfg,
      key: SESSION_KEY,
      agentId: "main",
      readOnly: true,
    });
    setRuntimeConfigSnapshot({
      ...cfg,
      session: {
        ...cfg.session,
        store: loaded.storePath,
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

  it("does not turn an unreadable existing database into discovery null", async () => {
    const coordinator = sharedPublicationCoordinator();
    const databasePath = openOpenClawStateDatabase().path;
    const unavailableRoot = path.join(root, "unreadable");
    await fs.mkdir(path.join(unavailableRoot, path.relative(root, databasePath)), {
      recursive: true,
    });
    vi.stubEnv("OPENCLAW_STATE_DIR", unavailableRoot);
    await expect(coordinator.latestShared(session)).rejects.toThrow();
  });
});

describe("shared repository receipt observation", () => {
  it("reads durable effect facts after a new coordinator starts without confirmation, replay, or credential work", async () => {
    const workspace = await sharedRepositoryWorkspace();
    const row = insertRepositoryReceipt(workspace);
    const execution = claimRepositoryGitHubPublicationFixture(row, "old-instance", {
      assertCustody: () => {},
      assertCurrent: () => {},
    });
    execution.recordEffect("push", { headCommit: OLD_HEAD });
    const coordinator = sharedPublicationCoordinator();
    const before = readRepositoryGitHubPublicationFixture(row.request_id);
    prohibitPublicationWork();
    using observer = observeEvents();
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
    expectNoPublicationWork();
  });

  it("discovers terminal outcomes by creation order and recovers exact older invocations", async () => {
    const workspace = await sharedRepositoryWorkspace();
    const coordinator = sharedPublicationCoordinator();
    const older = insertRepositoryReceipt(workspace, {
      request_id: "older",
      idempotency_key: "older-key",
      created_at_ms: 1,
    });
    for (const requestId of ["new-a", "new-z"]) {
      insertRepositoryReceipt(workspace, {
        request_id: requestId,
        idempotency_key: requestId,
        created_at_ms: 2,
        status: "failed",
        error_code: "push_rejected",
        next_action: "Inspect the existing GitHub branch.",
      });
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
    const row = insertRepositoryReceipt(workspace, scope);
    expect(await coordinator.latestShared(session)).toBeNull();
    expect(await coordinator.latestShared(session, row.idempotency_key)).toBeNull();
    expect(await coordinator.sharedStatus(session, row.request_id)).toBeUndefined();
  });

  it("keeps repository history precedence while discovering the current worktree after a workspace-kind change", async () => {
    publishWorktree(insertSharedWorktreeReceipt("repository-request"));
    const workspace = await sharedRepositoryWorkspace();
    const coordinator = sharedPublicationCoordinator();
    const row = insertRepositoryReceipt(workspace, {
      status: "published",
      head_commit: OLD_HEAD,
      pull_request_url: url,
    });
    expect((await coordinator.latestShared(session))?.result).toMatchObject({
      status: "published",
      headCommit: OLD_HEAD,
    });
    changeSession({
      repositoryWorkspaceId: undefined,
      worktree: { id: "worktree-1", branch: BRANCH, repoRoot: "/repo" },
    });
    expect((await coordinator.latestShared(session))?.result).toMatchObject({
      status: "published",
      headCommit: NEW_HEAD,
    });
    expect((await coordinator.sharedStatus(session, row.request_id))?.result).toMatchObject({
      status: "published",
      headCommit: OLD_HEAD,
      url,
    });
    await expectSessionIsolation(coordinator, row.request_id);
  });

  it("qualifies the workspace only for shared receipts and excludes corrupt personal rows", async () => {
    const workspace = await sharedRepositoryWorkspace();
    const coordinator = sharedPublicationCoordinator();
    const row = insertRepositoryReceipt(workspace, {
      owner_profile_id: "private-person",
      connection_generation: "private-generation",
      identity_source: "personal",
    });
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
    expect(await coordinator.latestShared(session, "absent")).toBeNull();
    insertRepositoryReceipt(workspace, { request_id: "shared", idempotency_key: "shared" });
    await expect(coordinator.latestShared(session)).rejects.toThrow(/owner.*unavailable/);
  });

  it("surfaces shared receipt corruption before filtering by branch", async () => {
    const workspace = await sharedRepositoryWorkspace();
    const coordinator = sharedPublicationCoordinator();
    const row = insertRepositoryReceipt(workspace);
    openOpenClawStateDatabase()
      .db.prepare(
        "UPDATE github_repository_publication_requests SET branch = 'changed outside owner' WHERE request_id = ?",
      )
      .run(row.request_id);
    await expect(coordinator.latestShared(session)).rejects.toThrow(/corrupt/);
    await expect(coordinator.sharedStatus(session, row.request_id)).rejects.toThrow(/corrupt/);
  });
  it("searches past retired repository history to select the current lifecycle", async () => {
    const workspace = await sharedRepositoryWorkspace();
    const coordinator = sharedPublicationCoordinator();
    insertRepositoryReceipt(workspace, {
      request_id: "current",
      idempotency_key: "current",
      created_at_ms: 0,
    });
    runOpenClawStateWriteTransaction(() => {
      for (let index = 0; index < 70; index += 1) {
        const id = "old-" + index.toString().padStart(3, "0");
        insertRepositoryReceipt(workspace, {
          request_id: id,
          idempotency_key: id,
          created_at_ms: 1,
          session_lifecycle_revision: "retired",
        });
      }
    });
    expect((await coordinator.latestShared(session))?.result.requestId).toBe("current");
  });
});
