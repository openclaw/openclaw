import { expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { prepareEmbeddedRunSession } from "../../agents/embedded-agent-runner/run/session-bootstrap.js";
import { getReplyOperationSessionReader } from "../../auto-reply/reply/reply-run-registry.state.js";
import { createTestReplyOperation } from "../../auto-reply/reply/reply-run-registry.test-helpers.js";
import { bindReplyOperationDatabaseAdmission } from "../../auto-reply/reply/reply-turn-database-admission.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import * as readOnly from "../../state/openclaw-agent-db-readonly.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { loadAgentEntryReadOperations } from "../../state/openclaw-agent-execution-operations.js";
import type { AgentWorkerOperationContext } from "../../state/openclaw-agent-operation-context.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { loadSessionEntryForAdmission } from "./session-accessor.sqlite-entry-admission.js";
import * as entryCache from "./session-accessor.sqlite-entry-cache.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.native.js";
import { replaceTranscriptEventsSync } from "./session-accessor.sqlite-transcript-write.js";
import * as coldStorage from "./session-cold-storage.js";
import type { SessionEntryCohortRequest } from "./session-entry-read.types.js";
import { addSessionMember } from "./session-sharing-store.native.js";
import { projectionLane } from "./session-transcript-worker-resources.js";

it("prepares bounded facts on one admitted source and refreshes after foreign and local writes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const sessionKey = "agent:main:cohort";
    const parentKey = "agent:main:parent";
    const scope = {
      agentId: "main",
      env,
      storePath: database.path,
      sessionKey,
      sessionId: "cohort",
    };
    const entry = {
      sessionId: "cohort",
      lifecycleRevision: "original",
      updatedAt: 1,
      parentSessionKey: parentKey,
    };
    writeSessionEntry(database, parentKey, { sessionId: "parent", updatedAt: 1 });
    writeSessionEntry(database, sessionKey, { ...entry, sessionId: "retained" });
    writeSessionEntry(database, sessionKey, entry);
    addSessionMember(scope, { identityId: "member", addedBy: "owner", addedAt: 1 });
    recordSessionParticipant(scope, {
      identity: { type: "agent", id: "participant" },
      sessionAgentId: "main",
      promptedAt: 1,
    });
    replaceTranscriptEventsSync(scope, [
      { type: "session", id: "cohort", version: 3, timestamp: 123 },
      {
        type: "message",
        id: "question",
        parentId: null,
        message: { role: "user", content: "cohort input" },
      },
    ]);
    const operations = await loadAgentEntryReadOperations();
    const context: AgentWorkerOperationContext = {
      open: () => database,
      options: { agentId: "main", path: database.path, env },
      admit: () => {},
      writeTransaction: () => {
        throw new Error("Cohort reads cannot open a write transaction");
      },
    };
    const request: SessionEntryCohortRequest = {
      sessionKeys: [sessionKey],
      runtimeTarget: { agentId: "logical", sessionId: "retained", sessionKey },
      snapshotFields: [],
      replyInitializationSessionKey: sessionKey,
      includeMembers: true,
      includeParticipantRecords: true,
      includeAuthProfileSource: true,
      lifecycleSessionKey: sessionKey,
      transcript: { sessionKey, entryIds: ["question", "missing"], includeHeader: true },
    };
    const read = (input = request) => operations["session.entry.read"](input, context);
    const first = read();
    expect(first.entries.map(({ sessionKey: key }) => key)).toEqual([sessionKey, parentKey]);
    expect(first.members?.[sessionKey]?.map(({ identityId }) => identityId)).toEqual(["member"]);
    expect(first.participantRecords?.[sessionKey]).toMatchObject([
      { identity: { id: "participant" }, contributionCount: 1 },
    ]);
    expect(first.runtimeTarget).toEqual({
      agentId: "logical",
      sessionId: "retained",
      sessionKey,
      storePath: database.path,
    });
    expect(first.lifecycleTimestamps.sessionStartedAt).toBe(123);
    expect(first.authProfileSource).toBe(false);
    expect(first.transcript).toMatchObject({
      header: { id: "cohort" },
      anchors: [{ entryId: "question", sessionId: "cohort" }],
    });
    request.expected = {
      incarnation: first.databaseIdentity.incarnation,
      sessions: [{ sessionKey, sessionId: "cohort", lifecycleRevision: "original" }],
    };
    const peer = new (requireNodeSqlite().DatabaseSync)(database.path);
    const nativeRead = entryCache.readExactSessionEntryCandidatesInDatabase;
    const commit = vi
      .spyOn(entryCache, "readExactSessionEntryCandidatesInDatabase")
      .mockImplementationOnce((...args) => {
        const rows = nativeRead(...args);
        peer.prepare("DELETE FROM session_members WHERE session_key = ?").run(sessionKey);
        peer
          .prepare("UPDATE session_windows SET session_key = ? WHERE session_id = ?")
          .run(parentKey, "retained");
        peer
          .prepare("UPDATE session_participants SET contribution_count = 9 WHERE session_key = ?")
          .run(sessionKey);
        return rows;
      });
    const reopen = vi
      .spyOn(readOnly, "withOpenClawAgentDatabaseReadOnly")
      .mockImplementation(() => {
        throw new Error("An admitted cohort must not open a second read connection");
      });
    // Compare warm standalone reads after their original canonical admission has settled.
    operations["session.entry.read"]({ sessionKey }, context);
    const transactionCommands: string[] = [];
    const exec = database.db.exec.bind(database.db);
    const transactions = vi.spyOn(database.db, "exec").mockImplementation((statement) => {
      if (/^(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/iu.test(statement.trim())) {
        transactionCommands.push(statement.trim());
      }
      return exec(statement);
    });
    const sql = trackSqliteStatementExecutions(database.db, ["fresh", "authSchema"], (statement) =>
      /^PRAGMA data_version$|FROM main\.pragma_data_version\(\)\s*$/iu.test(statement.trim())
        ? "fresh"
        : /^SELECT type FROM sqlite_master WHERE name = \?$/iu.test(statement.trim())
          ? "authSchema"
          : null,
    );
    try {
      const standalone = operations["session.entry.read"]({ sessionKey }, context);
      expect(standalone.entries).toMatchObject([{ sessionKey, entry: { sessionId: "cohort" } }]);
      expect(standalone.source).toEqual(first.source);
      expect(standalone.databaseIdentity).toEqual(first.databaseIdentity);
      expect(standalone.lifecycleTimestamps).toEqual({});
      expect(transactionCommands).toEqual([]);
      expect(sql.counts.fresh).toBe(1);
      sql.counts.fresh = 0;
      const pinned = read();
      expect(pinned.members?.[sessionKey]?.map(({ identityId }) => identityId)).toEqual(["member"]);
      expect(pinned.runtimeTarget?.sessionKey).toBe(sessionKey);
      expect(sql.counts.fresh).toBe(1);
      expect(sql.counts.authSchema).toBe(0);
      expect(transactionCommands).toEqual(["BEGIN", "COMMIT"]);
      // A known write cannot hide the foreign change from this connection's next use.
      writeSessionEntry(database, parentKey, { sessionId: "parent", updatedAt: 2 });
      sql.counts.fresh = 0;
      transactionCommands.length = 0;
      const current = read();
      expect(current.members?.[sessionKey]).toEqual([]);
      expect(current.runtimeTarget).toEqual({
        agentId: "logical",
        sessionId: "retained",
        sessionKey: parentKey,
        storePath: database.path,
      });
      expect(current.participantRecords?.[sessionKey]).toMatchObject([{ contributionCount: 9 }]);
      expect(
        current.entries.find(({ sessionKey: key }) => key === parentKey)?.entry.updatedAt,
      ).toBe(2);
      expect(sql.counts.fresh).toBe(1);
      expect(transactionCommands).toEqual(["BEGIN", "COMMIT"]);
      expect(reopen).not.toHaveBeenCalled();
      expect(
        read({
          ...request,
          runtimeTarget: { agentId: "logical", sessionId: "missing", sessionKey },
        }).runtimeTarget?.sessionKey,
      ).toBe(sessionKey);
      expect(() =>
        read({
          ...request,
          runtimeTarget: { agentId: "logical", sessionId: "retained", sessionKey: parentKey },
        }),
      ).toThrow("must belong to its entry cohort");
      expect(() =>
        read({ ...request, sessionKeys: Array.from({ length: 64 }, (_, i) => `agent:main:${i}`) }),
      ).toThrow("at most 64");
      expect(() =>
        read({ ...request, expected: { incarnation: "another-native-owner", sessions: [] } }),
      ).toThrow("changed during read");
      writeSessionEntry(database, sessionKey, { ...entry, lifecycleRevision: "successor" });
      expect(() => read()).toThrow("changed during read");
      writeSessionEntry(database, sessionKey, { ...entry, sessionId: "replacement" });
      expect(() => read()).toThrow("changed during read");
    } finally {
      sql.restore();
      transactions.mockRestore();
      reopen.mockRestore();
      commit.mockRestore();
      peer.close();
    }
  });
});

it("prepares the admitted run target with its entry and refuses source loss after cold preparation", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const sessionKey = "agent:bootstrap:cohort";
    const scope = { agentId: "bootstrap", env: state.env, sessionKey };
    replaceSessionEntrySync(scope, { sessionId: "bootstrap", updatedAt: 1 });
    const admission = await loadSessionEntryForAdmission(scope);
    const operation = createTestReplyOperation({ sessionKey, sessionId: "bootstrap" });
    const bound = bindReplyOperationDatabaseAdmission(
      operation,
      { sessionKey },
      undefined,
      admission.databaseClaim,
    );
    const reader = getReplyOperationSessionReader(operation);
    if (!reader) {
      await admission.databaseClaim.release();
      operation.complete();
      throw new Error("Expected an admitted bootstrap reader");
    }
    const controller = new AbortController();
    const input = {
      agentId: "bootstrap",
      config: { agents: { entries: { bootstrap: {} } } },
      sessionId: "bootstrap",
      sessionKey,
      sessionFile: sessionKey,
      sessionTarget: {
        agentId: "bootstrap",
        sessionId: "bootstrap",
        sessionKey,
        storePath: reader.database.path,
      },
      replyOperation: operation,
      abortSignal: controller.signal,
      runId: "bootstrap",
      prompt: "prepare the original run",
      workspaceDir: state.workspaceDir,
      timeoutMs: 30_000,
    };
    const reads = vi.spyOn(reader, "withRead");
    const runRequest = projectionLane.pool.run.bind(projectionLane.pool);
    let runtimeTargets = 0;
    const requests = vi.spyOn(projectionLane.pool, "run").mockImplementation(async (...args) => {
      const reply = await runRequest(...args);
      if (
        reply.ok &&
        typeof reply.value === "object" &&
        reply.value !== null &&
        "kind" in reply.value &&
        reply.value.kind === "session-runtime-target"
      ) {
        runtimeTargets++;
      }
      return reply;
    });
    try {
      const prepared = await prepareEmbeddedRunSession(input);
      expect(prepared.sessionAdmission?.entry.sessionId).toBe("bootstrap");
      expect(prepared.runSessionTarget).toMatchObject({
        agentId: "bootstrap",
        sessionId: "bootstrap",
        sessionKey,
      });
      expect(reads).toHaveBeenCalledTimes(1);
      expect(runtimeTargets).toBe(0);

      const restore = coldStorage.restoreSessionColdTranscript;
      const interrupted = new Error("bootstrap source ended after cold preparation");
      const restoring = vi
        .spyOn(coldStorage, "restoreSessionColdTranscript")
        .mockImplementationOnce(async (...args) => {
          await restore(...args);
          controller.abort(interrupted);
        });
      try {
        await expect(prepareEmbeddedRunSession(input)).rejects.toBe(interrupted);
      } finally {
        restoring.mockRestore();
      }
    } finally {
      reads.mockRestore();
      requests.mockRestore();
      await bound.releaseWorkerDatabaseClaim?.();
      operation.complete();
    }
  });
});
