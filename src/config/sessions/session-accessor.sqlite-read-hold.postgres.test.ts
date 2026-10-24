import { randomUUID } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withEngineStoreAdmission } from "../../infra/database-engine/admission-scope.js";
import {
  mixedAgentConnection,
  useMixedAgentPair,
} from "../../infra/database-engine/mixed-agent.conformance.test-support.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import {
  readTranscriptExportSnapshotReadOnlySync,
  readTranscriptStatsSync,
} from "./session-accessor.sqlite-read.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { replaceSqliteTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { collectSessionMemoryEntries } from "./session-memory-entry.worker.test-support.js";

const MIB = 1024 * 1024;
const statements = channel("openclaw.database.statement");
let observed: string[] = [];
const observe = (message: unknown) => {
  observed.push((message as { sql?: string }).sql ?? "");
};

afterEach(() => {
  statements.unsubscribe(observe);
  observed = [];
});

// The Gateway runs these reads in its transcript worker; the tests admit them on the main thread.
describe.skipIf(!mixedAgentConnection)(
  "PostgreSQL transcript exports above the slice budget",
  () => {
    useMixedAgentPair("postgres", "postgres");

    function seedLargeSession() {
      const database = withEngineStoreAdmission(() =>
        openOpenClawAgentDatabase({ agentId: "main" }),
      );
      const sessionId = randomUUID();
      const scope = {
        agentId: "main",
        storePath: database.path,
        sessionKey: `agent:main:export-${sessionId}`,
        sessionId,
      };
      const events = [
        { type: "session", version: 3, id: sessionId, timestamp: "2026-04-01T05:46:39.000Z" },
        // Two 2.5 MiB rows take the transcript past the 4 MiB retained-snapshot limit, and each
        // fills a 2 MiB slice, so a sliced read would issue one payload query per row.
        ...[0, 1].map((index) => ({
          type: "message",
          id: `entry-${index}`,
          parentId: index === 0 ? null : "entry-0",
          timestamp: "2026-04-01T05:46:40.000Z",
          message: { role: "user", content: "lobster ".repeat((2.5 * MIB) / 8), timestamp: 1 },
        })),
      ];
      withEngineStoreAdmission(() => {
        replaceSessionEntrySync(scope, { sessionId, updatedAt: 1 });
        const resolved = resolveSqliteTranscriptScope(scope);
        runOpenClawAgentWriteTransaction(
          (writable) => replaceSqliteTranscriptEventsInTransaction(writable, resolved, events),
          toDatabaseOptions(resolved),
        );
        expect(readTranscriptStatsSync(scope).sizeBytes).toBeGreaterThan(4 * MIB);
      });
      statements.subscribe(observe);
      return { events, scope };
    }

    const begins = () => observed.filter((sql) => /^BEGIN\b/i.test(sql));
    // Payload reads project the decoded row as "event_json"; metadata reads only size it.
    const payloadQueries = () => observed.filter((sql) => sql.includes(' as "event_json"'));

    it("memory batch reads a large transcript in its read-only snapshot without the writer lock", async () => {
      const { scope } = seedLargeSession();
      const entry = {
        absPath: path.join(path.dirname(scope.storePath), `${scope.sessionId}.jsonl`),
        options: scope,
      };
      // The batch reads synchronously before the first await.
      let prepared: ReturnType<typeof collectSessionMemoryEntries> | undefined;
      withEngineStoreAdmission(() => {
        prepared = collectSessionMemoryEntries([entry]);
      });
      const [result] = await prepared!;
      expect(result && "entry" in result ? result.entry?.content : undefined).toContain("lobster");
      expect(begins()).toEqual(["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"]);
      expect(observed.filter((sql) => sql.includes("pg_advisory_xact_lock"))).toEqual([]);
      expect(payloadQueries()).toHaveLength(1);
    });

    it("single export fetches every payload with one query", () => {
      const { events, scope } = seedLargeSession();
      const snapshot = withEngineStoreAdmission(() =>
        readTranscriptExportSnapshotReadOnlySync(scope),
      );
      expect(snapshot?.events).toEqual(events);
      expect(begins()).toHaveLength(1);
      expect(payloadQueries()).toHaveLength(1);
    });
  },
);
