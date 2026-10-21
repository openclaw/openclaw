import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { prepareAgentDeleteDatabases } from "../agents/agent-delete-databases.js";
import { withAgentDeletion } from "../agents/agent-lifecycle-registry.js";
import { acquireAuthProfileReadDatabase } from "../agents/auth-profiles/sqlite-read-pool.js";
import { captureRuntimeConfigAsyncReader } from "../config/io.runtime.js";
import { readSessionArchiveContentSync } from "../config/sessions/archive-compression.js";
import { resolveSessionArtifactDirectory } from "../config/sessions/paths.js";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import * as archiveWorker from "../config/sessions/session-accessor.sqlite-archive.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { withSessionEntryWorker } from "../config/sessions/session-accessor.sqlite-replacement-worker.js";
import { appendTranscriptEventSync } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { purgeDeletedAgentSessionEntries } from "../config/sessions/session-agent-purge.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import {
  captureSqliteDatabaseAdmissions,
  revokeSqliteDatabaseAdmissionsForPath,
} from "../infra/sqlite-database-admission.js";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "../infra/sqlite-handle-lifecycle.js";
import * as integrityWorker from "../infra/sqlite-integrity-worker.js";
import { openSqliteReadOnlyDatabase } from "../infra/sqlite-snapshot-source.js";
import * as admission from "../infra/sqlite-worker-operation-admission.js";
import { createWarnLogCapture } from "../logging/test-helpers/warn-log-capture.js";
import { onSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  beginAgentDeletionJournal,
  removeAgentDeletionJournal,
} from "../test-utils/agent-deletion-journal.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { useAgentDeletionFixture } from "./agent-deletion.test-support.js";
import { closeDeletedAgentDatabases, reviveAgentDatabases } from "./openclaw-agent-db-readers.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesForTest,
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  withOpenClawAgentDatabaseAsync,
} from "./openclaw-agent-db.js";
import * as native from "./openclaw-agent-execution-native.js";
import * as execution from "./openclaw-agent-execution.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

const fixture = useAgentDeletionFixture();

function holdIntegrityCheck() {
  const checked = createDeferred();
  const resume = createDeferred();
  const check = integrityWorker.assertSqliteIntegrityInWorker;
  vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker").mockImplementation(async (...args) => {
    await check(...args);
    checked.resolve();
    await resume.promise;
  });
  return { checked, resume };
}

function expectPublishedArchive(databasePath: string, sessionId: string, content: string): void {
  using reader = openNodeSqliteDatabase(databasePath, { readOnly: true });
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
}

describe("agent deletion database cleanup authority", () => {
  it("purges through the live deletion owner without host SQLite with a warm survivor", async () => {
    const f = fixture();
    const { shared, sharedOptions: target, workerScope } = f.sharedStore();
    appendTranscriptEventSync(
      { ...workerScope, sessionId: "remove" },
      { type: "proof", data: "retirement archive proof" },
    );
    await f.withDeletion(async (deletion) => {
      const sql = observeHostDataSql();
      try {
        await deletion.runDatabaseCleanup(target, () => f.purge(target));
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
    expect(loadSessionEntryReadOnly(workerScope)).toBeUndefined();
    expectPublishedArchive(target.path, "remove", "retirement archive proof");
    expect(shared.db.isOpen).toBe(true);
  });

  it("retains an accepted archive export when journal takeover refuses its publication receipt", async () => {
    const f = fixture();
    appendTranscriptEventSync(
      { ...f.scope, sessionId: "before" },
      { type: "proof", data: "accepted export proof" },
    );
    await closeOpenClawAgentDatabaseByPathAsync(f.target.path, "worker");
    let exported: string | undefined;
    const publish = archiveWorker.runSqliteTranscriptArchivePublishWorker;
    vi.spyOn(archiveWorker, "runSqliteTranscriptArchivePublishWorker").mockImplementationOnce(
      async (...args) => {
        const results = await publish(...args);
        exported = results.find((result) => result.sessionId === "before")?.archivedPath;
        f.replaceJournal();
        return results;
      },
    );
    await f.withDeletion(async (deletion) => {
      await expect(deletion.runDatabaseCleanup(f.target, () => f.purge())).rejects.toThrow(
        /no longer owns/,
      );
    });
    assert(exported);
    expect(readSessionArchiveContentSync(exported)).toContain("accepted export proof");
    expect(f.read()).toBeUndefined();
    using reader = openNodeSqliteDatabase(f.target.path, { readOnly: true });
    expect(
      reader
        .prepare("SELECT published_at FROM session_transcript_archives WHERE session_id = ?")
        .get("before"),
    ).toMatchObject({ published_at: null });
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
      await captureRuntimeConfigAsyncReader()();
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
              using reader = openNodeSqliteDatabase(f.target.path, { readOnly: true });
              expect(
                reader
                  .prepare("SELECT current_session_id FROM session_nodes WHERE session_key = ?")
                  .get(sessionKey),
              ).toMatchObject({ current_session_id: "before" });
              held = true;
            }
            callback(request, grant);
          }, attachment),
      );
      try {
        const retiring = f.withDeletion(async (deletion) => {
          await deletion.runDatabaseCleanup(f.target, () => f.purge());
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
    const reader = acquireAuthProfileReadDatabase(f.target.path, openSqliteReadOnlyDatabase);
    expect(reader.status).toBe("readable");
    const retainedAdmission = captureSqliteDatabaseAdmissions().find(
      (record) => record.location === f.target.path,
    )!;
    await f.withDeletion(async (deletion) => {
      await prepareAgentDeleteDatabases({}, "worker", f.entry.agentDir, { env: f.options.env });
      expect(reader.status === "readable" && reader.db.isOpen).toBe(false);
      expect(await f.purgeStore(deletion, {})).toBe(false);
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
          const unregister = f.resource(async () => {
            closeCalls++;
            closeEntered.resolve();
            await releaseClose.promise;
            unregister();
            if (failNextClose) {
              failNextClose = false;
              throw closeError;
            }
          });
          lateWrite = (async () => {
            await inspectLateWrite.promise;
            expect(() => f.write("late")).toThrow(/no longer active|resources are closing/);
          })();
        });
        let settled = false;
        const running = f.purgeStore(deletion, cfg).then((failed) => {
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
          expect(f.assertDrained).toThrow("database is still open");
          releaseClose.resolve();
          expect(await running).toBe(failClose);
          expect(closeCalls).toBe(1);
          if (failClose) {
            vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS);
            expect(f.assertDrained).toThrow("database is still open");
            expect(() => f.resource()).toThrow("Agent database resources are closing");
            await deletion.runDatabaseCleanup(f.target, async () => {});
            expect(closeCalls).toBe(2);
          }
          expect(f.read()).toBeUndefined();
          expect(f.assertDrained).not.toThrow();
          const unregister = f.resource();
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

  it.each(["settle", "replace"] as const)(
    "rejects admission before index repair after its cleanup owner is retired by %s",
    async (retire) => {
      const f = fixture();
      closeOpenClawAgentDatabasesForTest(f.root);
      revokeSqliteDatabaseAdmissionsForPath(f.target.path);
      {
        using writer = openNodeSqliteDatabase(f.target.path);
        writer.exec("DROP INDEX idx_agent_cache_expiry");
      }
      let operationCalled = false;
      await f.withDeletion(async (deletion) => {
        const { checked, resume } = holdIntegrityCheck();
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
            f.replaceJournal();
          }
        } finally {
          resume.resolve();
          await settled;
          await rejected;
        }
      });
      using reader = openNodeSqliteDatabase(f.target.path, { readOnly: true });
      expect(
        reader.prepare("SELECT name FROM sqlite_schema WHERE name='idx_agent_cache_expiry'").get(),
      ).toBeUndefined();
      expect(operationCalled).toBe(false);
      expect(f.assertDrained).not.toThrow();
    },
  );

  it("does not expose cleanup admission to a coalesced operation outside its scope", async () => {
    const f = fixture();
    closeOpenClawAgentDatabasesForTest(f.root);
    revokeSqliteDatabaseAdmissionsForPath(f.target.path);
    await f.withDeletion(async (deletion) => {
      const { checked, resume } = holdIntegrityCheck();
      const releaseOwner = createDeferred();
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

  it("preserves a survivor handle first opened during cleanup", async () => {
    const f = fixture();
    const { sharedOptions, workerScope, keptScope, purge } = f.sharedStore();
    closeOpenClawAgentDatabaseByPath(sharedOptions.path, "kept");
    let retained: ReturnType<typeof openOpenClawAgentDatabase> | undefined;
    await f.withDeletion(async (deletion) => {
      await expect(
        purge({
          runDatabaseCleanup: (target, run) =>
            deletion.runDatabaseCleanup(target, async () => {
              retained = openOpenClawAgentDatabase(sharedOptions);
              return run();
            }),
        }),
      ).resolves.toBe(false);
    });
    expect(retained?.db.isOpen).toBe(true);
    expect(openOpenClawAgentDatabase(sharedOptions)).toBe(retained);
    expect(loadSessionEntryReadOnly(workerScope)).toBeUndefined();
    expect(loadSessionEntryReadOnly(keptScope)?.sessionId).toBe("keep");
  });

  it.each([false, true])(
    "rolls back writes after precommit journal takeover (warm survivor: %s)",
    async (warmSurvivor) => {
      const f = fixture();
      const shared = warmSurvivor ? f.sharedStore() : undefined;
      const options = shared?.sharedOptions ?? { ...f.options, path: f.target.path };
      const scope = shared?.workerScope ?? f.scope;
      const write = (sessionId: string) =>
        replaceSessionEntrySync(scope, { sessionId, updatedAt: 1 });
      await f.withDeletion(async (deletion) => {
        await expect(
          deletion.runDatabaseCleanup(options, async () => {
            runOpenClawAgentWriteTransaction(() => {
              write("stale");
              f.replaceJournal();
            }, options);
          }),
        ).rejects.toThrow("no longer owns");
        expect(loadSessionEntryReadOnly(scope)?.sessionId).toBe(warmSurvivor ? "remove" : "before");
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
        const database = f.open();
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
        expect(f.open).toThrow("active deletion cleanup");
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
      expect(f.assertDrained).not.toThrow();
    });
  });

  it.each(["replace", "finish"] as const)(
    "rejects cleanup writes after its journal owner is retired by %s",
    async (retire) => {
      const f = fixture();
      await f.withDeletion(async (deletion) => {
        const opened = createDeferred();
        const release = createDeferred();
        let database: ReturnType<typeof openOpenClawAgentDatabase> | undefined;
        const running = deletion.runDatabaseCleanup(f.target, async () => {
          database = f.open();
          opened.resolve();
          await release.promise;
          expect(() => f.write("stale")).toThrow("no longer owns database cleanup");
          return database;
        });
        const rejected = expect(running).rejects.toThrow("no longer owns");
        try {
          await opened.promise;
          if (retire === "replace") {
            f.replaceJournal();
          } else {
            await deletion[retire]();
          }
        } finally {
          release.resolve();
          await rejected;
          expect(database?.db.isOpen).toBe(false);
        }
        expect(f.read()).toBe("before");
        expect(getOpenClawAgentDatabaseIfOpen(f.options)).toBeUndefined();
      });
    },
  );

  it("binds the cleanup target to its state database, identity, and physical locator", async () => {
    const f = fixture();
    const other = fixture();
    await f.withDeletion(async (deletion) => {
      await deletion.runDatabaseCleanup(f.target, async () => {
        const database = f.open();
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
    "purges only target rows in a surviving shared store (cold: %s)",
    async (cold) => {
      const f = fixture();
      const { sharedOptions, shared, workerScope, keptScope, purge } = f.sharedStore();
      const storePath = shared.path;
      if (cold) {
        closeOpenClawAgentDatabaseByPath(storePath);
      }
      await f.withDeletion(async (deletion) => {
        await expect(purge(deletion)).resolves.toBe(false);
        expect(loadSessionEntryReadOnly(workerScope)).toBeUndefined();
        expect(loadSessionEntryReadOnly(keptScope)?.sessionId).toBe("keep");
        expect(shared.db.isOpen).toBe(!cold);
        if (cold) {
          expect(getOpenClawAgentDatabaseIfOpen(sharedOptions)).toBeUndefined();
        }
      });
    },
  );

  it("retains close ownership when cleanup and close both fail", async () => {
    const f = fixture();
    await f.withDeletion(async (deletion) => {
      let retained: ReturnType<typeof openOpenClawAgentDatabase> | undefined;
      const closeError = new Error("held native close");
      const runError = new Error("cleanup operation failed");
      const running = deletion.runDatabaseCleanup(f.target, async () => {
        retained = f.open();
        vi.spyOn(retained.db, "close").mockImplementationOnce(() => {
          throw closeError;
        });
        throw runError;
      });
      await expect(running).rejects.toMatchObject({ errors: [runError, closeError] });
      expect(retained?.db.isOpen).toBe(true);
      expect(f.open).toThrow("active deletion cleanup");
      expect(f.assertDrained).toThrow("database is still open");
      expect(closeOpenClawAgentDatabaseByPath(f.target.path, "worker")).toBe(true);
      await deletion.runDatabaseCleanup(f.target, async () => f.write("retried"));
      expect(f.read()).toBe("retried");
      expect(f.assertDrained).not.toThrow();
    });
  });

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
});

it("preserves a surviving shared-store executor across another agent's deletion", async () => {
  const f = fixture({ shared: true, retained: true });
  const { target, retained } = await f.retain();
  const purged = createDeferredCore();
  const survivorUsed = createDeferredCore();
  const read = (agentId: string) =>
    withSessionEntryWorker(
      target,
      undefined,
      () => retained.assertCurrent(),
      async (owner, source) => {
        await owner.prepare(source);
        const result = await owner.runExisting(source, (worker) =>
          worker.execute({
            type: "session.entry.read",
            input: { sessionKey: `agent:${agentId}:main` },
          }),
        );
        return result?.entries[0]?.entry;
      },
      undefined,
      retained,
    );
  try {
    expect(await read("kept")).toMatchObject({ sessionId: "kept" });
    const deleting = f.withDeletion(async (deletion) => {
      await expect(
        f.purgeStore({
          runDatabaseCleanup: (store, run) =>
            deletion.runDatabaseCleanup(store, async () => {
              const result = await run();
              purged.resolve();
              await survivorUsed.promise;
              return result;
            }),
        }),
      ).resolves.toBe(false);
      expect(await read("worker")).toBeUndefined();
      expect(await read("kept")).toMatchObject({ sessionId: "kept" });
      await deletion.finish();
    });
    try {
      await awaitGateBeforeSettlement(
        purged.promise,
        deleting,
        "shared-store purge did not finish",
      );
      expect(await read("kept")).toMatchObject({ sessionId: "kept" });
      const fresh = execution.captureOpenClawAgentDatabaseExecution(target);
      await fresh.release();
    } finally {
      survivorUsed.resolve();
      await deleting;
    }
    expect(await read("kept")).toMatchObject({ sessionId: "kept" });
  } finally {
    survivorUsed.resolve();
    await retained.release();
  }
});

it("keeps purge's native generation alive when a retained ordinary borrower is refused", async () => {
  const f = fixture({ retained: true });
  const { cfg, env } = f;
  const { target, retained } = await f.retain();
  const agentId = "worker";
  const prepared = createDeferredCore();
  const resumePurge = createDeferredCore();
  const closing = createDeferredCore();
  const create = native.createAgentDatabaseNativeGeneration;
  vi.spyOn(native, "createAgentDatabaseNativeGeneration").mockImplementationOnce((...args) => {
    const generation = create(...args);
    let operations = 0;
    return {
      ...generation,
      run(source, operation, ...request) {
        return generation.run(
          source,
          async (scope) => {
            if (++operations === 2) {
              prepared.resolve();
              await resumePurge.promise;
            }
            return operation(scope);
          },
          ...request,
        );
      },
      close() {
        closing.resolve();
        return generation.close();
      },
    };
  });
  try {
    await f.withDeletion(async (deletion) => {
      const purging = deletion.runDatabaseCleanup(target, () =>
        purgeDeletedAgentSessionEntries({
          cfg,
          agentId,
          storeAgentId: agentId,
          storePath: target.path,
          env,
        }),
      );
      const purged = expect(purging).resolves.toBeUndefined();
      try {
        await awaitGateBeforeSettlement(
          prepared.promise,
          purging,
          "purge did not prepare its native generation",
        );
        const staleOperation = vi.fn(async () => undefined);
        const refused = expect(
          retained.runExisting(
            {
              assertCurrent() {},
              createAdmission() {
                throw new Error("Refused borrower reached native admission");
              },
            },
            staleOperation,
            { retireNativeOnFailure: true },
          ),
        ).rejects.toThrow(/active deletion cleanup|execution admission is closed/);
        await Promise.race([closing.promise, refused]);
        resumePurge.resolve();
        await refused;
        expect(staleOperation).not.toHaveBeenCalled();
      } finally {
        resumePurge.resolve();
        await purged;
      }
    });
  } finally {
    resumePurge.resolve();
    await retained.release();
  }
  using reader = openNodeSqliteDatabase(target.path, { readOnly: true });
  expect(reader.prepare("SELECT session_key FROM session_nodes").all()).toEqual([]);
});
