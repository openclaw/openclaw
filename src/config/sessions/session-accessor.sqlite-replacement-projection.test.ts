import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { cleanupTempDirs, makeTempDir } from "../../../test/helpers/temp-dir.js";
import { getSqliteReadScopeRevision } from "../../infra/sqlite-schema-facts.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import {
  applySessionEntryReplacements,
  assignSessionOwner,
  loadSessionEntry,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import {
  readExactSessionEntryRow,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.native.js";
import { readSessionEntryReplacementState } from "./session-accessor.sqlite-replacement-read.js";
import { prepareSessionEntryReplacementPublication } from "./session-accessor.sqlite-replacement-state.js";

describe("session entry replacement compare-and-swap", () => {
  const tempDirs: string[] = [];
  let storePath: string;
  let scope: { sessionKey: string; storePath: string };

  beforeEach(async () => {
    storePath = `${makeTempDir(tempDirs, "replacement-cas")}/openclaw-agent.sqlite`;
    scope = { sessionKey: "agent:main:replacement-row", storePath };
    await upsertSessionEntryCore(scope, {
      model: "base",
      sessionId: "replacement-row",
      updatedAt: 10,
    });
  });

  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    cleanupTempDirs(tempDirs);
  });

  it("hydrates replacement candidates once while preserving detached snapshots", async () => {
    const prompt = "synthetic replacement payload ".repeat(8192);
    for (const suffix of ["a", "b"]) {
      await upsertSessionEntryCore(
        { storePath, sessionKey: `agent:main:payload-${suffix}` },
        {
          sessionId: `payload-${suffix}`,
          updatedAt: 10,
          skillsSnapshot: { prompt, skills: [] },
        },
      );
    }
    const database = openOpenClawAgentDatabase({ agentId: "main", path: storePath });
    const reads = trackSqliteStatementExecutions(database.db, ["entries"], (sql) =>
      /\bfrom\s+"session_nodes"/iu.test(sql) ? "entries" : null,
    );
    try {
      const snapshot = readSessionEntryReplacementState(database, {});
      const selected = snapshot.entries.filter(({ sessionKey }) => sessionKey.includes("payload-"));
      expect(selected).toHaveLength(2);
      for (const { entry } of selected) {
        expect(entry.skillsSnapshot?.prompt).toBe(prompt);
        if (entry.skillsSnapshot) {
          entry.skillsSnapshot.prompt = "detached mutation";
        }
      }
      // Two full candidate payloads, with room for their small metadata; enumeration must not hydrate them again.
      expect(reads.textBytes.entries).toBeLessThan(prompt.length * 3);
    } finally {
      reads.restore();
    }
    expect(
      loadSessionEntry({ storePath, sessionKey: "agent:main:payload-a" })?.skillsSnapshot?.prompt,
    ).toBe(prompt);
  });

  it("rejects a row deleted during its detached snapshot", async () => {
    await expect(
      applySessionEntryReplacements({
        sessionKeys: [scope.sessionKey],
        storePath,
        update: (entries) => {
          openOpenClawAgentDatabase({ agentId: "main", path: storePath })
            .db.prepare("DELETE FROM session_nodes WHERE session_key = ?")
            .run(scope.sessionKey);
          return {
            replacements: entries.map(({ entry, sessionKey }) => ({
              entry: { ...entry, model: "stale-replacement" },
              sessionKey,
            })),
            result: undefined,
          };
        },
      }),
    ).rejects.toThrow("changed before replacement");
    expect(loadSessionEntry({ ...scope, readConsistency: "latest" })).toBeUndefined();
  });

  it("publishes persisted writer bytes and participants until a later transaction mutation", () => {
    recordSessionParticipant(scope, {
      identity: { type: "agent", id: "contributor" },
      promptedAt: 1,
    });
    runOpenClawAgentWriteTransaction(
      (database) => {
        const previous = readExactSessionEntryRow(database, scope.sessionKey)!.entry;
        const written = writeSessionEntry(
          database,
          scope.sessionKey,
          {
            ...previous,
            model: "committed",
            participantCount: 99,
            participants: [{ identity: { type: "agent", id: "forged" } }],
            skillsSnapshot: { prompt: "private saved prompt", skills: [] },
          },
          {
            canonicalPreviousEntry: previous,
            canonicalPreviousEntryRevision: getSqliteReadScopeRevision(database.db),
          },
        );
        const changes = {
          previous: new Map([[scope.sessionKey, previous]]),
          current: new Map([[scope.sessionKey, written]]),
          pendingArchiveRecovery: false,
          membershipInvalidatedKeys: [],
          maintenancePlans: [],
        };
        const reads = trackSqliteStatementExecutions(database.db, ["participants"], (sql) =>
          /\bfrom\s+"session_participants"/iu.test(sql) ? "participants" : null,
        );
        try {
          // The returned entry remains caller-owned; publication must retain its committed bytes.
          written.model = "not committed";
          const publication = prepareSessionEntryReplacementPublication(changes, database);
          expect(publication.current.get(scope.sessionKey)).toMatchObject({
            model: "committed",
            participants: [{ identity: { type: "agent", id: "contributor" } }],
            participantCount: 1,
          });
          expect(publication.current.get(scope.sessionKey)?.skillsSnapshot).toBeUndefined();
          expect(reads.counts.participants).toBe(0);
          const callerParticipant = previous.participants?.[0]?.identity;
          if (callerParticipant) {
            callerParticipant.id = "caller-owned";
          }
          expect(publication.current.get(scope.sessionKey)?.participants?.[0]?.identity.id).toBe(
            "contributor",
          );

          database.db
            .prepare("UPDATE session_participants SET actor_id = ? WHERE session_key = ?")
            .run("changed-in-transaction", scope.sessionKey);
          const afterMutation = prepareSessionEntryReplacementPublication(changes, database);
          expect(afterMutation.current.get(scope.sessionKey)).toMatchObject({
            model: "committed",
            participants: [{ identity: { type: "agent", id: "changed-in-transaction" } }],
            participantCount: 1,
          });
          expect(reads.counts.participants).toBe(1);

          const beforeGetter = readExactSessionEntryRow(database, scope.sessionKey)!.entry;
          let getterMutated = false;
          const getterWritten = writeSessionEntry(
            database,
            scope.sessionKey,
            {
              ...beforeGetter,
              get model() {
                if (!getterMutated) {
                  getterMutated = true;
                  database.db
                    .prepare("UPDATE session_participants SET actor_id = ? WHERE session_key = ?")
                    .run("changed-by-getter", scope.sessionKey);
                }
                return "getter-committed";
              },
            },
            {
              canonicalPreviousEntry: beforeGetter,
              canonicalPreviousEntryRevision: getSqliteReadScopeRevision(database.db),
            },
          );
          const afterGetter = prepareSessionEntryReplacementPublication(
            { ...changes, current: new Map([[scope.sessionKey, getterWritten]]) },
            database,
          );
          expect(afterGetter.current.get(scope.sessionKey)).toMatchObject({
            model: "getter-committed",
            participants: [{ identity: { type: "agent", id: "changed-by-getter" } }],
            participantCount: 1,
          });
        } finally {
          reads.restore();
        }
      },
      { agentId: "main", path: storePath },
    );
    expect(loadSessionEntry(scope)).toMatchObject({
      model: "getter-committed",
      skillsSnapshot: { prompt: "private saved prompt" },
      participants: [{ identity: { type: "agent", id: "changed-by-getter" } }],
    });
  });

  it("rejects a replacement prepared under a session owner that changes before commit", async () => {
    const assignedBy = { id: "assigner", type: "human" as const };
    assignSessionOwner(scope, {
      assignedBy,
      owner: { id: "owner-a", type: "human" },
    });

    await expect(
      applySessionEntryReplacements({
        sessionKeys: [scope.sessionKey],
        storePath,
        update: (entries) => {
          expect(entries[0]?.entry.owner?.actor.id).toBe("owner-a");
          assignSessionOwner(scope, {
            assignedBy,
            owner: { id: "owner-b", type: "human" },
          });
          return {
            replacements: entries.map(({ entry, sessionKey }) => ({
              entry: { ...entry, model: "stale-owner-replacement" },
              sessionKey,
            })),
            result: undefined,
          };
        },
      }),
    ).rejects.toThrow("changed before replacement");

    expect(loadSessionEntry({ ...scope, readConsistency: "latest" })).toMatchObject({
      model: "base",
      owner: { actor: { id: "owner-b", type: "human" } },
      sessionId: "replacement-row",
    });
  });
});
