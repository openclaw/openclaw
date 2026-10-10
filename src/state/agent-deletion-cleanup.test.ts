import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { prepareAgentDeleteDatabases } from "../agents/agent-delete-databases.js";
import {
  withAgentDeletion,
  type AgentDeletionOperation,
} from "../agents/agent-lifecycle-registry.js";
import {
  acquireAuthProfileReadDatabase,
  closeAuthProfileReadPool,
} from "../agents/auth-profiles/sqlite-read-pool.js";
import { readSessionArchiveContentSync } from "../config/sessions/archive-compression.js";
import { purgeAgentSessionStoreEntries } from "../config/sessions/cleanup-service.js";
import { resolveSessionArtifactDirectory } from "../config/sessions/paths.js";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import * as archiveWorker from "../config/sessions/session-accessor.sqlite-archive.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { appendTranscriptEventSync } from "../config/sessions/session-accessor.sqlite-transcript-write.js";
import { purgeDeletedAgentSessionEntries } from "../config/sessions/session-agent-purge.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { captureSqliteDatabaseAdmissions } from "../infra/sqlite-database-admission.js";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "../infra/sqlite-handle-lifecycle.js";
import * as integrityWorker from "../infra/sqlite-integrity-worker.js";
import * as admission from "../infra/sqlite-worker-operation-admission.js";
import { createWarnLogCapture } from "../logging/test-helpers/warn-log-capture.js";
import { onSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import {
  beginAgentDeletionJournal,
  removeAgentDeletionJournal,
} from "../test-utils/agent-deletion-journal.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { assertNoOpenClawAgentDatabaseLeases } from "./openclaw-agent-db-lease.js";
import { closeDeletedAgentDatabases, reviveAgentDatabases } from "./openclaw-agent-db-readers.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "./openclaw-agent-db-resources.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawAgentDatabasesAsync,
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  withOpenClawAgentDatabaseAsync,
} from "./openclaw-agent-db.js";
import { clearOpenClawAgentIntegrityVerification } from "./openclaw-quarantine-store.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  closeAuthProfileReadPool();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-delete-cleanup-")));
  roots.push(root);
  const options = { agentId: "worker", env: { OPENCLAW_STATE_DIR: root } };
  const database = openOpenClawAgentDatabase(options);
  const scope = { ...options, sessionKey: "agent:worker:main" };
  const write = (sessionId: string) => replaceSessionEntrySync(scope, { sessionId, updatedAt: 1 });
  write("before");
  closeOpenClawAgentDatabaseByPath(database.path);
  const entry = {
    agentId: options.agentId,
    agentDir: path.dirname(database.path),
    workspaceDir: path.join(root, "workspace"),
    sessionsDir: path.join(root, "agents", options.agentId, "sessions"),
  };
  return {
    root,
    options,
    target: { agentId: options.agentId, path: database.path },
    entry,
    write,
    read: () => loadSessionEntryReadOnly(scope)?.sessionId,
    withDeletion: <T>(run: (deletion: AgentDeletionOperation) => Promise<T>) =>
      withAgentDeletion(options.agentId, async (begin) => run(await begin(entry)), {
        env: options.env,
      }),
  };
}

function expectPublishedArchive(databasePath: string, sessionId: string, content: string): void {
  const reader = openNodeSqliteDatabase(databasePath, { readOnly: true });
  try {
    const archive = reader
      .prepare(
        "SELECT archive_name, published_at, last_publish_error FROM session_transcript_archives WHERE session_id = ?",
      )
      .get(sessionId);
    assert(archive && typeof archive.archive_name === "string");
    expect(archive).toMatchObject({ published_at: expect.any(Number), last_publish_error: null });
    expect(
      readSessionArchiveContentSync(
        path.join(resolveSessionArtifactDirectory(databasePath), archive.archive_name),
      ),
    ).toContain(content);
  } finally {
    reader.close();
  }
}

describe("agent deletion database cleanup authority", () => {
  it.each([false, true])(
    "purges through the live deletion owner without host SQLite (warm survivor: %s)",
    async (survivor) => {
      const f = fixture();
      const target = survivor
        ? { agentId: "kept", path: path.join(f.root, "shared.sqlite") }
        : f.target;
      const survivingDatabase = survivor
        ? openOpenClawAgentDatabase({ ...f.options, ...target })
        : undefined;
      const scope = { ...f.options, storePath: target.path, sessionKey: "agent:worker:main" };
      if (survivor) {
        replaceSessionEntrySync(scope, { sessionId: "before", updatedAt: 1 });
      }
      appendTranscriptEventSync(
        { ...scope, sessionId: "before" },
        { type: "proof", data: "retirement archive proof" },
      );
      if (!survivor) {
        await closeOpenClawAgentDatabaseByPathAsync(target.path, target.agentId);
      }
      const cfg = {
        agents: { entries: { worker: {}, kept: {} } },
        session: { store: target.path, maintenance: { mode: "warn" as const } },
      };
      await f.withDeletion(async (deletion) => {
        const sql = observeHostDataSql();
        try {
          await deletion.runDatabaseCleanup(target, () =>
            purgeDeletedAgentSessionEntries({
              cfg,
              agentId: "worker",
              storeAgentId: target.agentId,
              storePath: target.path,
              env: f.options.env,
            }),
          );
          expect(
            sql.queries.filter((query) =>
              /\b(?:agent_deletion_journal|state_leases|session_nodes|session_windows|transcript_events|session_transcript_archives)\b/i.test(
                query,
              ),
            ),
          ).toEqual([]);
        } finally {
          sql.restore();
        }
      });
      expect(loadSessionEntryReadOnly(scope)).toBeUndefined();
      expectPublishedArchive(target.path, "before", "retirement archive proof");
      if (survivingDatabase) {
        expect(survivingDatabase.db.isOpen).toBe(true);
      } else {
        expect(getOpenClawAgentDatabaseIfOpen(f.options)).toBeUndefined();
      }
    },
  );

  it("retains an accepted archive export when journal takeover refuses its publication receipt", async () => {
    const f = fixture();
    appendTranscriptEventSync(
      { ...f.options, sessionKey: "agent:worker:main", sessionId: "before" },
      { type: "proof", data: "accepted export proof" },
    );
    await closeOpenClawAgentDatabaseByPathAsync(f.target.path, "worker");
    let exported: string | undefined;
    const publish = archiveWorker.runSqliteTranscriptArchivePublishWorker;
    vi.spyOn(archiveWorker, "runSqliteTranscriptArchivePublishWorker").mockImplementationOnce(
      async (...args) => {
        const results = await publish(...args);
        exported = results.find((result) => result.sessionId === "before")?.archivedPath;
        beginAgentDeletionJournal(
          { ...f.entry, operationId: "replacement", deleteFiles: true },
          { env: f.options.env },
        );
        return results;
      },
    );
    await f.withDeletion(async (deletion) => {
      await expect(
        deletion.runDatabaseCleanup(f.target, () =>
          purgeDeletedAgentSessionEntries({
            cfg: {
              agents: { entries: { worker: {}, kept: {} } },
              session: { store: f.target.path, maintenance: { mode: "warn" } },
            },
            agentId: "worker",
            storeAgentId: "worker",
            storePath: f.target.path,
            env: f.options.env,
          }),
        ),
      ).rejects.toThrow(/no longer owns/);
    });
    assert(exported);
    expect(readSessionArchiveContentSync(exported)).toContain("accepted export proof");
    expect(f.read()).toBeUndefined();
    const reader = openNodeSqliteDatabase(f.target.path, { readOnly: true });
    try {
      expect(
        reader
          .prepare("SELECT published_at FROM session_transcript_archives WHERE session_id = ?")
          .get("before"),
      ).toMatchObject({ published_at: null });
    } finally {
      reader.close();
    }
  });

  it("settles maintenance archives and bulk planner refresh under the retained deletion owner", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = state.statePath("retirement.sqlite");
      const cfg = {
        agents: { ownership: "explicit" as const, entries: { worker: {}, kept: {} } },
        session: { store: storePath, maintenance: { mode: "warn" as const } },
      };
      await state.writeConfig(cfg);
      const options = { agentId: "worker", path: storePath, env: state.env };
      const target = openOpenClawAgentDatabase(options);
      const removed = {
        agentId: "worker",
        storePath,
        sessionKey: "agent:worker:main",
        env: state.env,
      };
      const aged = { ...removed, agentId: "kept", sessionKey: "agent:kept:aged" };
      const disposable = { ...aged, sessionKey: "agent:kept:hook:maintenance" };
      runOpenClawAgentWriteTransaction(() => {
        for (let index = 0; index < 64; index++) {
          replaceSessionEntrySync(
            { ...removed, sessionKey: index ? `agent:worker:extra-${index}` : removed.sessionKey },
            { sessionId: `retired-${index}`, updatedAt: Date.now() },
          );
        }
        replaceSessionEntrySync(aged, {
          sessionId: "aged-survivor",
          updatedAt: Date.now() - 3 * 86_400_000,
        });
        replaceSessionEntrySync(disposable, {
          sessionId: "maintenance-hook",
          updatedAt: Date.now() - 3 * 86_400_000,
        });
        appendTranscriptEventSync(
          { ...removed, sessionId: "retired-0" },
          { type: "proof", data: "primary archive proof" },
        );
        appendTranscriptEventSync(
          { ...disposable, sessionId: "maintenance-hook" },
          { type: "proof", data: "maintenance archive proof" },
        );
      }, options);
      await closeOpenClawAgentDatabaseByPathAsync(storePath, "worker");
      await state.writeConfig({
        ...cfg,
        session: {
          ...cfg.session,
          maintenance: {
            mode: "enforce",
            pruneAfter: "1d",
            maxEntries: 1000,
            preserveRecent: false,
          },
        },
      });
      const warnings = createWarnLogCapture("retirement-maintenance");
      try {
        await withAgentDeletion(
          "worker",
          async (begin) => {
            const deletion = await begin({
              agentId: "worker",
              agentDir: state.agentDir("worker"),
              sessionsDir: state.sessionsDir("worker"),
              workspaceDir: state.workspaceDir,
            });
            await deletion.runDatabaseCleanup({ agentId: "worker", path: target.path }, () =>
              purgeDeletedAgentSessionEntries({
                cfg,
                agentId: "worker",
                storeAgentId: "worker",
                storePath,
                env: state.env,
              }),
            );
          },
          { env: state.env },
        );
        expect(loadSessionEntryReadOnly(removed)).toBeUndefined();
        expect(loadSessionEntryReadOnly(aged)).toMatchObject({
          sessionId: "aged-survivor",
          archiveReason: "age-retention",
          archivedAt: expect.any(Number),
        });
        expect(loadSessionEntryReadOnly(disposable)).toBeUndefined();
        expectPublishedArchive(storePath, "retired-0", "primary archive proof");
        expectPublishedArchive(storePath, "maintenance-hook", "maintenance archive proof");
        expect(
          await warnings.findText("SQLite session maintenance cleanup failed"),
        ).toBeUndefined();
        expect(
          await warnings.findText("SQLite session planner-statistics refresh failed"),
        ).toBeUndefined();
      } finally {
        warnings.cleanup();
      }
    });
  });

  it.each(["held", "journal replaced", "lease expired"] as const)(
    "retains the shared retirement guard through agent COMMIT (%s)",
    async (change) => {
      const f = fixture();
      const sessionKey = "agent:worker:main";
      const cfg = {
        agents: { entries: { worker: {}, kept: {} } },
        session: { store: f.target.path, maintenance: { mode: "warn" as const } },
      };
      const foreign = openNodeSqliteDatabase(resolveOpenClawStateSqlitePath(f.options.env));
      foreign.exec("PRAGMA busy_timeout = 0");
      let candidate = false;
      let changed = false;
      let held = false;
      const create = admission.createSqliteWorkerOperationAdmission;
      vi.spyOn(admission, "createSqliteWorkerOperationAdmission").mockImplementation(
        (callback, attachment) =>
          create((request, grant) => {
            const facts = isRecord(request.facts) ? request.facts : undefined;
            const publication = isRecord(facts?.publication) ? facts.publication : undefined;
            if (
              request.stage === "commit" &&
              publication?.kind === "session-entry-patch-committed"
            ) {
              candidate = true;
              if (change === "journal replaced") {
                foreign
                  .prepare("UPDATE agent_deletion_journal SET operation_id = ? WHERE agent_id = ?")
                  .run("replacement", "worker");
                changed = true;
              } else if (change === "lease expired") {
                foreign
                  .prepare(
                    "UPDATE state_leases SET expires_at = 0 WHERE scope = ? AND lease_key = ?",
                  )
                  .run("core:agent-deletion", "worker");
                changed = true;
              }
            }
            if (
              candidate &&
              !changed &&
              !held &&
              request.stage === "commit" &&
              facts?.kind === "state-lease"
            ) {
              expect(() => foreign.exec("BEGIN IMMEDIATE")).toThrow(/locked|busy/i);
              const reader = openNodeSqliteDatabase(f.target.path, { readOnly: true });
              try {
                expect(
                  reader
                    .prepare("SELECT current_session_id FROM session_nodes WHERE session_key = ?")
                    .get(sessionKey),
                ).toMatchObject({ current_session_id: "before" });
              } finally {
                reader.close();
              }
              held = true;
            }
            callback(request, grant);
          }, attachment),
      );
      try {
        const retiring = f.withDeletion(async (deletion) => {
          await deletion.runDatabaseCleanup(f.target, () =>
            purgeDeletedAgentSessionEntries({
              cfg,
              agentId: "worker",
              storeAgentId: "worker",
              storePath: f.target.path,
              env: f.options.env,
            }),
          );
        });
        if (change === "held") {
          await retiring;
          expect(held).toBe(true);
          expect(f.read()).toBeUndefined();
        } else {
          await expect(retiring).rejects.toThrow();
          expect(changed).toBe(true);
          expect(f.read()).toBe("before");
        }
        expect(candidate).toBe(true);
      } finally {
        foreign.close();
      }
    },
  );

  it("closes pooled auth readers before releasing the deleted agent's files", async () => {
    const f = fixture();
    const reader = acquireAuthProfileReadDatabase(f.target.path);
    expect(reader.status).toBe("readable");
    const retainedAdmission = captureSqliteDatabaseAdmissions().find(
      (record) => record.location === f.target.path,
    )!;
    await f.withDeletion(async (deletion) => {
      await prepareAgentDeleteDatabases({}, "worker", f.entry.agentDir, { env: f.options.env });
      expect(reader.status === "readable" && reader.db.isOpen).toBe(false);
      expect(
        await purgeAgentSessionStoreEntries({}, "worker", {
          env: f.options.env,
          runDatabaseCleanup: deletion.runDatabaseCleanup,
        }),
      ).toBe(false);
      expect(() => fs.fstatSync(retainedAdmission.descriptor)).not.toThrow();
      try {
        await closeDeletedAgentDatabases("worker", [f.target.path], deletion);
        expect(() => fs.fstatSync(retainedAdmission.descriptor)).toThrow();
      } finally {
        await reviveAgentDatabases(["worker"]);
      }
    });
  });

  it.each([false, true])(
    "joins resources admitted by purge publication before reporting completion (close fails: %s)",
    async (failClose) => {
      const f = fixture();
      const cfg = { agents: { entries: { worker: {}, kept: {} } } };
      await f.withDeletion(async (deletion) => {
        await prepareAgentDeleteDatabases(cfg, "worker", f.entry.agentDir, { env: f.options.env });
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const closeEntered = createDeferred();
        const inspectLateWrite = createDeferred();
        const releaseClose = createDeferred();
        const closeError = new Error("purge reader close failed");
        let failNextClose = failClose;
        let closeCalls = 0;
        let lateWrite: Promise<void> | undefined;
        const stop = onSessionIdentityMutation((mutation) => {
          if (mutation.agentId !== "worker" || mutation.kind !== "delete") {
            return;
          }
          const unregister = registerOpenClawAgentDatabaseAsyncResource({
            ...f.target,
            revoke: () => {},
            close: async () => {
              closeCalls++;
              closeEntered.resolve();
              await releaseClose.promise;
              unregister();
              if (failNextClose) {
                failNextClose = false;
                throw closeError;
              }
            },
          });
          lateWrite = (async () => {
            await inspectLateWrite.promise;
            expect(() => f.write("late")).toThrow(/no longer active|resources are closing/);
          })();
        });
        let settled = false;
        const running = purgeAgentSessionStoreEntries(cfg, "worker", {
          env: f.options.env,
          runDatabaseCleanup: deletion.runDatabaseCleanup,
        }).then((failed) => {
          settled = true;
          return failed;
        });
        try {
          await Promise.race([
            closeEntered.promise,
            running.then(() => {
              throw new Error("Purge settled before its resource close was entered");
            }),
          ]);
          inspectLateWrite.resolve();
          await lateWrite;
          // Cross one event-loop turn so every completion continuation can run.
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          expect(settled).toBe(false);
          if (!failClose) {
            vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS);
          }
          expect(() =>
            assertNoOpenClawAgentDatabaseLeases("worker", { env: f.options.env }),
          ).toThrow("database is still open");
          releaseClose.resolve();
          expect(await running).toBe(failClose);
          expect(closeCalls).toBe(1);
          if (failClose) {
            vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS);
            expect(() =>
              assertNoOpenClawAgentDatabaseLeases("worker", { env: f.options.env }),
            ).toThrow("database is still open");
            expect(() =>
              registerOpenClawAgentDatabaseAsyncResource({
                ...f.target,
                revoke: () => {},
                close: async () => {},
              }),
            ).toThrow("Agent database resources are closing");
            await deletion.runDatabaseCleanup(f.target, async () => {});
            expect(closeCalls).toBe(2);
          }
          expect(f.read()).toBeUndefined();
          expect(() =>
            assertNoOpenClawAgentDatabaseLeases("worker", { env: f.options.env }),
          ).not.toThrow();
          const unregister = registerOpenClawAgentDatabaseAsyncResource({
            ...f.target,
            revoke: () => {},
            close: async () => {},
          });
          unregister();
        } finally {
          stop();
          inspectLateWrite.resolve();
          failNextClose = false;
          releaseClose.resolve();
          try {
            await Promise.all([running, lateWrite]);
          } finally {
            try {
              await closeOpenClawAgentDatabaseByPathAsync(f.target.path, f.target.agentId);
            } finally {
              vi.useRealTimers();
            }
          }
        }
      });
    },
  );

  it.each(["settle", "replace", "rollback", "finish"] as const)(
    "rejects admission before index repair after its cleanup owner is retired by %s",
    async (retire) => {
      const f = fixture();
      closeOpenClawAgentDatabasesForTest(f.root);
      clearOpenClawAgentIntegrityVerification(f.target.path, f.options.env);
      const writer = openNodeSqliteDatabase(f.target.path);
      try {
        writer.exec("DROP INDEX idx_agent_cache_expiry");
      } finally {
        writer.close();
      }
      let operationCalled = false;
      await f.withDeletion(async (deletion) => {
        const checked = createDeferred();
        const resume = createDeferred();
        const check = integrityWorker.assertSqliteIntegrityInWorker;
        vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker").mockImplementation(
          async (...args) => {
            await check(...args);
            checked.resolve();
            await resume.promise;
          },
        );
        let rejected: Promise<unknown> | undefined;
        const running = deletion.runDatabaseCleanup(f.target, async () => {
          rejected = expect(
            withOpenClawAgentDatabaseAsync(f.options, () => {
              operationCalled = true;
            }),
          ).rejects.toThrow(/no longer/);
          // A retained admission must not outlive a callback that did not await it.
          if (retire !== "settle") {
            await rejected;
          }
        });
        const settled =
          retire === "settle" ? running : expect(running).rejects.toThrow(/no longer/);
        try {
          await checked.promise;
          if (retire === "settle") {
            await running;
          } else if (retire === "replace") {
            beginAgentDeletionJournal(
              { ...f.entry, operationId: "replacement", deleteFiles: true },
              { env: f.options.env },
            );
          } else {
            await deletion[retire]();
          }
        } finally {
          resume.resolve();
          await settled;
          await rejected;
        }
      });
      const reader = openNodeSqliteDatabase(f.target.path, { readOnly: true });
      try {
        expect(
          reader
            .prepare("SELECT name FROM sqlite_schema WHERE name='idx_agent_cache_expiry'")
            .get(),
        ).toBeUndefined();
      } finally {
        reader.close();
      }
      expect(operationCalled).toBe(false);
      expect(() =>
        assertNoOpenClawAgentDatabaseLeases("worker", { env: f.options.env }),
      ).not.toThrow();
    },
  );

  it("does not expose cleanup admission to a coalesced operation outside its scope", async () => {
    const f = fixture();
    closeOpenClawAgentDatabasesForTest(f.root);
    clearOpenClawAgentIntegrityVerification(f.target.path, f.options.env);
    await f.withDeletion(async (deletion) => {
      const checked = createDeferred();
      const resume = createDeferred();
      const releaseOwner = createDeferred();
      const check = integrityWorker.assertSqliteIntegrityInWorker;
      vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker").mockImplementation(
        async (...args) => {
          await check(...args);
          checked.resolve();
          await resume.promise;
        },
      );
      const running = deletion.runDatabaseCleanup(f.target, () =>
        withOpenClawAgentDatabaseAsync(f.options, async () => {
          await releaseOwner.promise;
          f.write("owned");
        }),
      );
      try {
        await checked.promise;
        let outsideCalled = false;
        const rejected = expect(
          withOpenClawAgentDatabaseAsync(f.options, (database) => {
            outsideCalled = true;
            return database.db.isOpen;
          }),
        ).rejects.toThrow("active deletion cleanup");
        resume.resolve();
        await rejected;
        expect(outsideCalled).toBe(false);
      } finally {
        resume.resolve();
        releaseOwner.resolve();
        await running;
      }
    });
    expect(f.read()).toBe("owned");
  });

  it("rechecks a settled cleanup scope before an async operation on a borrowed survivor", async () => {
    const f = fixture();
    const options = { ...f.options, agentId: "kept", path: path.join(f.root, "shared.sqlite") };
    const kept = openOpenClawAgentDatabase(options);
    let operationCalled = false;
    await f.withDeletion(async (deletion) => {
      let rejected: Promise<unknown> | undefined;
      await deletion.runDatabaseCleanup({ agentId: "kept", path: kept.path }, async () => {
        rejected = expect(
          withOpenClawAgentDatabaseAsync(options, () => {
            operationCalled = true;
          }),
        ).rejects.toThrow("no longer active");
      });
      await rejected;
    });
    expect(operationCalled).toBe(false);
    expect(kept.db.isOpen).toBe(true);
    expect(openOpenClawAgentDatabase(options)).toBe(kept);
  });

  it("retries a settled shared-store close before admitting a fresh deletion cleanup", async () => {
    const f = fixture();
    const storePath = path.join(f.root, "shared.sqlite");
    const sharedOptions = { ...f.options, agentId: "kept", path: storePath };
    const cfg = {
      agents: { entries: { worker: {}, kept: {} } },
      session: { store: storePath },
    };
    openOpenClawAgentDatabase(sharedOptions);
    const workerScope = { ...f.options, storePath, sessionKey: "agent:worker:shared" };
    const keptScope = { ...workerScope, agentId: "kept", sessionKey: "agent:kept:shared" };
    replaceSessionEntrySync(workerScope, { sessionId: "remove", updatedAt: Date.now() });
    replaceSessionEntrySync(keptScope, { sessionId: "keep", updatedAt: Date.now() });
    closeOpenClawAgentDatabaseByPath(storePath, "kept");
    let retained: ReturnType<typeof openOpenClawAgentDatabase> | undefined;
    let closeCalls = 0;
    const runAttempt = async (deletion: AgentDeletionOperation, injectFailure: boolean) => {
      await prepareAgentDeleteDatabases(cfg, "worker", f.entry.agentDir, { env: f.options.env });
      return purgeAgentSessionStoreEntries(cfg, "worker", {
        env: f.options.env,
        runDatabaseCleanup: (target, run) =>
          deletion.runDatabaseCleanup(target, async () => {
            if (injectFailure && target.path === storePath) {
              retained = openOpenClawAgentDatabase(sharedOptions);
              const close = retained.db.close.bind(retained.db);
              vi.spyOn(retained.db, "close").mockImplementation(() => {
                closeCalls += 1;
                if (closeCalls === 1) {
                  throw new Error("one-time native close failure");
                }
                close();
              });
            }
            return await run();
          }),
      });
    };

    await expect(f.withDeletion((deletion) => runAttempt(deletion, true))).resolves.toBe(true);
    expect(closeCalls).toBe(1);
    expect(retained?.db.isOpen).toBe(true);
    expect(() => openOpenClawAgentDatabase(sharedOptions)).toThrow("active deletion cleanup");
    await expect(f.withDeletion((deletion) => runAttempt(deletion, false))).resolves.toBe(false);
    expect(closeCalls).toBe(2);
    expect(retained?.db.isOpen).toBe(false);
    expect(loadSessionEntryReadOnly(workerScope)).toBeUndefined();
    expect(loadSessionEntryReadOnly(keptScope)?.sessionId).toBe("keep");
    expect(openOpenClawAgentDatabase(sharedOptions).db.isOpen).toBe(true);
  });

  it("rejects cleanup settlement after awaited journal takeover", async () => {
    const f = fixture();
    await f.withDeletion(async (deletion) => {
      const opened = createDeferred();
      const release = createDeferred();
      const running = deletion.runDatabaseCleanup(f.target, async () => {
        openOpenClawAgentDatabase(f.options);
        opened.resolve();
        await release.promise;
      });
      const rejected = expect(running).rejects.toThrow("no longer owns");
      try {
        await opened.promise;
        beginAgentDeletionJournal(
          { ...f.entry, operationId: "replacement", deleteFiles: true },
          { env: f.options.env },
        );
      } finally {
        release.resolve();
      }
      await rejected;
      expect(f.read()).toBe("before");
      expect(getOpenClawAgentDatabaseIfOpen(f.options)).toBeUndefined();
    });
  });

  it.each([false, true])(
    "rolls back writes after precommit journal takeover (warm survivor: %s)",
    async (warmSurvivor) => {
      const f = fixture();
      const options = {
        ...f.options,
        agentId: warmSurvivor ? "kept" : f.options.agentId,
        path: warmSurvivor ? path.join(f.root, "shared.sqlite") : f.target.path,
      };
      const scope = { ...f.options, storePath: options.path, sessionKey: "agent:worker:main" };
      const write = (sessionId: string) =>
        replaceSessionEntrySync(scope, { sessionId, updatedAt: 1 });
      if (warmSurvivor) {
        openOpenClawAgentDatabase(options);
        write("before");
      }
      await f.withDeletion(async (deletion) => {
        await expect(
          deletion.runDatabaseCleanup(options, async () => {
            runOpenClawAgentWriteTransaction(() => {
              write("stale");
              beginAgentDeletionJournal(
                { ...f.entry, operationId: "replacement", deleteFiles: true },
                { env: f.options.env },
              );
            }, options);
          }),
        ).rejects.toThrow("no longer owns");
        expect(loadSessionEntryReadOnly(scope)?.sessionId).toBe("before");
      });
    },
  );

  it("keeps a cold cleanup handle private through awaits and closes it before settlement", async () => {
    const f = fixture();
    await f.withDeletion(async (deletion) => {
      const opened = createDeferred();
      const release = createDeferred();
      const late = createDeferred();
      let lateWrite: Promise<unknown> | undefined;
      const running = deletion.runDatabaseCleanup(f.target, async () => {
        const database = openOpenClawAgentDatabase(f.options);
        lateWrite = (async () => {
          await late.promise;
          expect(() => f.write("late")).toThrow("no longer active");
        })();
        opened.resolve();
        await release.promise;
        f.write("owned");
        return database;
      });
      try {
        await opened.promise;
        expect(() => openOpenClawAgentDatabase(f.options)).toThrow("active deletion cleanup");
        expect(() => getOpenClawAgentDatabaseIfOpen(f.options)).toThrow("active deletion cleanup");
        expect(() => f.write("ordinary")).toThrow("active deletion cleanup");
        const alias = path.join(f.root, "alias");
        fs.symlinkSync(
          path.dirname(f.target.path),
          alias,
          process.platform === "win32" ? "junction" : "dir",
        );
        expect(() =>
          openOpenClawAgentDatabase({
            ...f.options,
            path: path.join(alias, path.basename(f.target.path)),
          }),
        ).toThrow("active deletion cleanup");
        expect(f.read()).toBe("before");
      } finally {
        release.resolve();
        try {
          expect((await running).db.isOpen).toBe(false);
        } finally {
          late.resolve();
          await lateWrite;
        }
      }
      expect(f.read()).toBe("owned");
      expect(() =>
        assertNoOpenClawAgentDatabaseLeases("worker", { env: f.options.env }),
      ).not.toThrow();
    });
  });

  it.each(["replace", "rollback", "finish"] as const)(
    "rejects cleanup writes after its journal owner is retired by %s",
    async (retire) => {
      const f = fixture();
      await f.withDeletion(async (deletion) => {
        const opened = createDeferred();
        const release = createDeferred();
        let database: ReturnType<typeof openOpenClawAgentDatabase> | undefined;
        const running = deletion.runDatabaseCleanup(f.target, async () => {
          database = openOpenClawAgentDatabase(f.options);
          opened.resolve();
          await release.promise;
          expect(() => f.write("stale")).toThrow("no longer owns database cleanup");
          return database;
        });
        const rejected = expect(running).rejects.toThrow("no longer owns");
        try {
          await opened.promise;
          if (retire === "replace") {
            beginAgentDeletionJournal(
              { ...f.entry, operationId: "replacement", deleteFiles: true },
              { env: f.options.env },
            );
          } else {
            await deletion[retire]();
          }
        } finally {
          release.resolve();
          await rejected;
          expect(database?.db.isOpen).toBe(false);
        }
        expect(f.read()).toBe("before");
      });
    },
  );

  it("binds the cleanup target to its state database, identity, and physical locator", async () => {
    const f = fixture();
    const other = fixture();
    await f.withDeletion(async (deletion) => {
      await deletion.runDatabaseCleanup(f.target, async () => {
        const database = openOpenClawAgentDatabase(f.options);
        expect(() =>
          openOpenClawAgentDatabase({ ...f.options, env: other.options.env, path: f.target.path }),
        ).toThrow("another state database");
        expect(() =>
          openOpenClawAgentDatabase({ ...f.options, agentId: "kept", path: f.target.path }),
        ).toThrow("already open for agent worker");
        expect(() =>
          openOpenClawAgentDatabase({ ...f.options, path: path.join(f.root, "unowned.sqlite") }),
        ).toThrow("unavailable while agent worker is deleted");
        expect(database.db.isOpen).toBe(true);
      });
      const alias = path.join(f.root, "cleanup-alias");
      const aliasType = process.platform === "win32" ? "junction" : "dir";
      fs.symlinkSync(path.dirname(f.target.path), alias, aliasType);
      const target = { agentId: "worker", path: path.join(alias, path.basename(f.target.path)) };
      let called = false;
      const running = deletion.runDatabaseCleanup(target, async () => {
        called = true;
      });
      // Admission has yielded; changing the input object must not conceal a retargeted locator.
      fs.unlinkSync(alias);
      fs.symlinkSync(path.dirname(other.target.path), alias, aliasType);
      target.path = f.target.path;
      await expect(running).rejects.toThrow("database target changed before cleanup");
      expect(called).toBe(false);
      expect(f.read()).toBe("before");
      expect(other.read()).toBe("before");
    });
  });

  it.each([false, true])(
    "retains failed cleanup close ownership (operation also failed: %s)",
    async (failRun) => {
      const f = fixture();
      await f.withDeletion(async (deletion) => {
        let retained: ReturnType<typeof openOpenClawAgentDatabase> | undefined;
        const closeError = new Error("held native close");
        const runError = new Error("cleanup operation failed");
        const running = deletion.runDatabaseCleanup(f.target, async () => {
          retained = openOpenClawAgentDatabase(f.options);
          vi.spyOn(retained.db, "close").mockImplementationOnce(() => {
            throw closeError;
          });
          if (failRun) {
            throw runError;
          }
        });
        if (failRun) {
          await expect(running).rejects.toMatchObject({ errors: [runError, closeError] });
        } else {
          await expect(running).rejects.toBe(closeError);
        }
        expect(retained?.db.isOpen).toBe(true);
        expect(() => openOpenClawAgentDatabase(f.options)).toThrow("active deletion cleanup");
        expect(() => assertNoOpenClawAgentDatabaseLeases("worker", { env: f.options.env })).toThrow(
          "database is still open",
        );
        expect(closeOpenClawAgentDatabaseByPath(f.target.path, "worker")).toBe(true);
        await deletion.runDatabaseCleanup(f.target, async () => f.write("retried"));
        expect(f.read()).toBe("retried");
        expect(() =>
          assertNoOpenClawAgentDatabaseLeases("worker", { env: f.options.env }),
        ).not.toThrow();
      });
    },
  );

  it("never exempts a foreign deletion journal's overlapping path", async () => {
    const f = fixture();
    const foreign = beginAgentDeletionJournal(
      { ...f.entry, agentId: "kept", operationId: "foreign", deleteFiles: true },
      { env: f.options.env },
    );
    await f.withDeletion(async (deletion) => {
      await expect(
        deletion.runDatabaseCleanup(f.target, async () => f.write("blocked")),
      ).rejects.toThrow("agent kept deletion owns");
      expect(f.read()).toBe("before");
      removeAgentDeletionJournal("kept", foreign.operationId, { env: f.options.env });
      await deletion.runDatabaseCleanup(f.target, async () => f.write("retried"));
      expect(f.read()).toBe("retried");
    });
  });

  it.each([false, true])(
    "purges only target rows in a surviving shared store (cold: %s)",
    async (cold) => {
      const f = fixture();
      const storePath = path.join(f.root, "shared.sqlite");
      const sharedOptions = { ...f.options, agentId: "kept", path: storePath };
      const shared = openOpenClawAgentDatabase(sharedOptions);
      const workerScope = { ...f.options, storePath, sessionKey: "agent:worker:shared" };
      const keptScope = { ...workerScope, agentId: "kept", sessionKey: "agent:kept:shared" };
      replaceSessionEntrySync(workerScope, { sessionId: "remove", updatedAt: Date.now() });
      replaceSessionEntrySync(keptScope, { sessionId: "keep", updatedAt: Date.now() });
      if (cold) {
        closeOpenClawAgentDatabaseByPath(storePath);
      }
      await f.withDeletion(async (deletion) => {
        await expect(
          purgeAgentSessionStoreEntries(
            { agents: { entries: { worker: {}, kept: {} } }, session: { store: storePath } },
            "worker",
            { env: f.options.env, runDatabaseCleanup: deletion.runDatabaseCleanup },
          ),
        ).resolves.toBe(false);
        expect(loadSessionEntryReadOnly(workerScope)).toBeUndefined();
        expect(loadSessionEntryReadOnly(keptScope)?.sessionId).toBe("keep");
        expect(shared.db.isOpen).toBe(!cold);
        if (cold) {
          expect(getOpenClawAgentDatabaseIfOpen(sharedOptions)).toBeUndefined();
        }
      });
    },
  );
});
