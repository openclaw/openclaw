import assert from "node:assert/strict";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import {
  withSessionTranscriptWriteLock,
  type SessionTranscriptWriteLockContext,
} from "../../plugin-sdk/session-transcript-runtime.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import {
  persistSessionTranscriptTurn,
  replaceSessionEntrySync,
  withTranscriptWriteLock,
} from "./session-accessor.js";
import * as archiveWorkers from "./session-accessor.sqlite-archive.js";
import { loadTranscriptEventsSync } from "./session-accessor.sqlite-read.js";
import { readSessionColdTranscript } from "./session-cold-storage-state.js";
import { runSessionColdStorageMaintenance } from "./session-cold-storage.js";
import {
  createSessionColdStorageFixture,
  currentId,
  historicalId,
  maintenanceConfig,
} from "./session-cold-storage.test-support.js";
import { captureSessionEntryCurrentRead } from "./session-entry-current-runtime.js";
import { withSessionEntryReadOnlyInWorker } from "./session-entry-read-runtime.js";
import type { PreparedSessionSourceAuthority } from "./session-source-authority.js";
import { waitForSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";
import { withSessionTranscriptWriteAssertion } from "./transcript-write-context.js";

describe("selected transcript turn cold restoration", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const databasePaths: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const databasePath of databasePaths.splice(0)) {
      await waitForSessionTranscriptIndexReconcile({ agentId: "main", path: databasePath });
    }
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
  });

  async function createFixture() {
    const root = tempDirs.make("openclaw-cold-turn-");
    const storePath = path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite");
    databasePaths.push(storePath);
    const fixture = await createSessionColdStorageFixture(storePath, "global");
    expect(
      await runSessionColdStorageMaintenance({ config: maintenanceConfig(storePath) }),
    ).toEqual({ archivedTranscripts: 1, externalizedTranscripts: 0 });
    replaceSessionEntrySync(fixture.scope, {
      sessionId: historicalId,
      updatedAt: 1,
      lifecycleRevision: "selected",
    });
    const descriptor = readSessionColdTranscript(fixture.database(), historicalId);
    expect(descriptor).toBeDefined();
    const prepareMessage = vi.fn(async (message: unknown) => {
      expect(readSessionColdTranscript(fixture.database(), historicalId)).toBeUndefined();
      return message;
    });
    const append = () =>
      persistSessionTranscriptTurn(
        { ...fixture.scope, sessionKey: "agent:main:global" },
        {
          expectedSessionId: historicalId,
          expectedLifecycleRevision: "selected",
          messages: [
            {
              message: {
                role: "user",
                content: "Resume selected history",
                idempotencyKey: "resume-selected-history",
              },
              workerPreparation: {
                prepareMessageAfterIdempotencyCheckAsync: prepareMessage,
              },
            },
          ],
          updateMode: "none",
        },
      );
    const replaceRevision = () =>
      replaceSessionEntrySync(fixture.scope, {
        sessionId: historicalId,
        updatedAt: 2,
        lifecycleRevision: "successor",
      });
    return { ...fixture, append, descriptor, replaceRevision, prepareMessage };
  }

  it.each(["turn", "locked worker with owner fence", "locked SDK released-sync"])(
    "restores raw-key history and appends through its selected identity (%s)",
    async (mode) => {
      const fixture = await createFixture();
      if (mode === "turn") {
        await expect(fixture.append()).resolves.toMatchObject({ appendedCount: 1 });
        expect(fixture.prepareMessage).toHaveBeenCalledOnce();
      } else {
        const message = { role: "user", content: "Resume selected history" };
        const prepare = vi.fn((value: typeof message) => value);
        const readAndAppend = async (
          locked: Pick<SessionTranscriptWriteLockContext, "appendMessage" | "readEvents">,
        ) => {
          expect(await locked.readEvents()).toContainEqual(
            expect.objectContaining({ id: "history-user" }),
          );
          await expect(
            locked.appendMessage({
              message,
              ...(mode === "locked SDK released-sync"
                ? { prepareMessageAfterIdempotencyCheck: prepare }
                : {}),
            }),
          ).resolves.toMatchObject({ appended: true });
        };
        if (mode === "locked worker with owner fence") {
          await withTranscriptWriteLock(
            {
              ...fixture.scope,
              expectedOwner: { lifecycleRevision: "selected", activeWriterRunId: undefined },
            },
            readAndAppend,
          );
        } else {
          await withSessionTranscriptWriteLock(
            { ...fixture.scope, sessionKey: "agent:main:global" },
            readAndAppend,
          );
        }
        expect(prepare).toHaveBeenCalledTimes(mode === "locked SDK released-sync" ? 1 : 0);
      }
      expect(readSessionColdTranscript(fixture.database(), historicalId)).toBeUndefined();
      const events = loadTranscriptEventsSync(fixture.scope);
      expect(events).toContainEqual(expect.objectContaining({ id: "history-user" }));
      expect(events).toContainEqual(
        expect.objectContaining({
          message: expect.objectContaining({ role: "user", content: "Resume selected history" }),
        }),
      );
      expect(fixture.database().prepare("SELECT session_key FROM session_nodes").all()).toEqual([
        { session_key: "global" },
      ]);
    },
  );

  it("restores archived history through the bounded manager's own read admission", async () => {
    const fixture = await createFixture();
    const manager = await SessionManager.openBoundedAsync(
      { ...fixture.scope, sessionKey: "agent:main:global" },
      { maxBytes: 2 * 1024 * 1024, maxEvents: 5 },
    );
    expect(manager.getEntry("history-user")).toMatchObject({
      message: { content: [{ type: "text", text: "你好 🦞\n".repeat(12_000) }] },
    });
    expect(manager.getEntry("history-assistant")).toMatchObject({
      parentId: "history-user",
      message: { content: [{ type: "text", text: "Preserved response" }] },
    });
    expect(readSessionColdTranscript(fixture.database(), historicalId)).toBeUndefined();
    expect(fixture.snapshot().events.filter((event) => event.session_id === historicalId)).toEqual(
      fixture.original.events.filter((event) => event.session_id === historicalId),
    );
  });

  it.each(["before restoration", "at worker admission"])(
    "keeps the archive cold when the captured revision changes %s",
    async (timing) => {
      const fixture = await createFixture();
      let admitted = false;
      let commitRequested = false;
      if (timing === "at worker admission") {
        const original = archiveWorkers.runSqliteTranscriptArchiveWorkerOperation;
        vi.spyOn(archiveWorkers, "runSqliteTranscriptArchiveWorkerOperation").mockImplementation(
          (params) => {
            if (params.expectedMessageType !== "reclaimed") {
              return original(params);
            }
            return original({
              ...params,
              withWriteAdmission: (run, diagnostics) =>
                params.withWriteAdmission((refusal) => {
                  if (!refusal) {
                    admitted = true;
                    fixture.replaceRevision();
                  }
                  return run(refusal);
                }, diagnostics),
              onCommitRequest: () => {
                commitRequested = true;
                params.onCommitRequest();
              },
            });
          },
        );
      }
      const pending = fixture.append();
      if (timing === "before restoration") {
        fixture.replaceRevision();
      }
      await expect(pending).resolves.toMatchObject({
        rejectedReason: "session-rebound",
        appendedCount: 0,
      });
      expect(admitted).toBe(timing === "at worker admission");
      expect(commitRequested).toBe(false);
      expect(fixture.prepareMessage).not.toHaveBeenCalled();
      expect(readSessionColdTranscript(fixture.database(), historicalId)).toEqual(
        fixture.descriptor,
      );
      expect(
        fixture
          .database()
          .prepare("SELECT seq FROM transcript_events WHERE session_id = ?")
          .all(historicalId),
      ).toEqual([]);
    },
  );

  it.for(["prepared source", "optional writer fence"] as const)(
    "keeps a locked read cold when its %s changes during restoration admission",
    async (guard, { signal }) => {
      const fixture = await createFixture();
      const sourceScope = {
        ...fixture.scope,
        sessionKey: "agent:main:cold-source",
        sessionId: "cold-source",
      };
      replaceSessionEntrySync(sourceScope, {
        sessionId: sourceScope.sessionId,
        updatedAt: 1,
        label: "prepared",
      });
      const prepared = await withSessionEntryReadOnlyInWorker(
        sourceScope,
        () => {},
        async (read, owner) => {
          assert(read.ok && read.value);
          const captured = captureSessionEntryCurrentRead(sourceScope, owner);
          assert(captured.kind === "file");
          return {
            assertCurrent: captured.assertSourceCurrent,
            checks: [
              {
                predicate: {
                  source: captured.source,
                  sessionKey: captured.source.sessionKey,
                  fields: ["sessionId", "label"],
                  expected: read.value,
                },
                refuse: () => {
                  throw new Error("Prepared cold source changed");
                },
              },
            ],
          } satisfies PreparedSessionSourceAuthority;
        },
      );
      const assertion = Object.assign(prepared.assertCurrent, {
        prepareSessionSource: vi.fn(async () => prepared),
      });
      const scope = {
        ...fixture.scope,
        ...(guard === "optional writer fence"
          ? { expectedOwner: { lifecycleRevision: "selected", activeWriterRunId: undefined } }
          : {}),
      };
      const rawRows = () =>
        fixture
          .database()
          .prepare("SELECT * FROM transcript_events ORDER BY session_id, seq")
          .all();
      const before = rawRows();
      const requested = createDeferred();
      const resume = createDeferred();
      const original = archiveWorkers.runSqliteTranscriptArchiveWorkerOperation;
      vi.spyOn(archiveWorkers, "runSqliteTranscriptArchiveWorkerOperation").mockImplementation(
        (params) =>
          params.expectedMessageType !== "reclaimed"
            ? original(params)
            : original({
                ...params,
                withWriteAdmission: async (run, diagnostics) => {
                  requested.resolve();
                  await resume.promise;
                  return params.withWriteAdmission(run, diagnostics);
                },
              }),
      );
      const callback = vi.fn(async (locked: { readEvents: () => Promise<unknown[]> }) =>
        locked.readEvents(),
      );
      const pending = withSessionTranscriptWriteAssertion(scope, assertion, () =>
        guard === "optional writer fence"
          ? withTranscriptWriteLock(scope, callback)
          : withSessionTranscriptWriteLock(scope, callback),
      );
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            requested.promise,
            pending,
            "Locked read settled before cold restoration admission",
          ),
          signal,
        );
        expect(assertion.prepareSessionSource).toHaveBeenCalled();
        if (guard === "prepared source") {
          replaceSessionEntrySync(sourceScope, {
            sessionId: sourceScope.sessionId,
            updatedAt: 2,
            label: "revoked",
          });
        } else {
          replaceSessionEntrySync(fixture.scope, {
            sessionId: historicalId,
            updatedAt: 1,
            lifecycleRevision: "selected",
            activeWriterRunId: "successor-writer",
          });
        }
        resume.resolve();
        if (guard === "prepared source") {
          await expect(pending).rejects.toThrow("Prepared cold source changed");
        } else {
          await expect(pending).rejects.toMatchObject({
            name: "SessionTranscriptWriterClaimReboundError",
            cause: { code: "session-rebound" },
          });
        }
        expect(callback).not.toHaveBeenCalled();
        expect(readSessionColdTranscript(fixture.database(), historicalId)).toEqual(
          fixture.descriptor,
        );
        expect(rawRows()).toEqual(before);
      } finally {
        resume.resolve();
        await pending.catch(() => {});
      }
    },
  );

  it("restores an unfenced locked historical window without changing the current session", async () => {
    const fixture = await createFixture();
    replaceSessionEntrySync(fixture.scope, { sessionId: currentId, updatedAt: 2 });

    await withSessionTranscriptWriteLock(fixture.scope, async (locked) => {
      expect(await locked.readEvents()).toContainEqual(
        expect.objectContaining({ id: "history-user" }),
      );
    });

    expect(readSessionColdTranscript(fixture.database(), historicalId)).toBeUndefined();
    expect(
      fixture.database().prepare("SELECT current_session_id FROM session_nodes").all(),
    ).toEqual([{ current_session_id: currentId }]);
  });
});
