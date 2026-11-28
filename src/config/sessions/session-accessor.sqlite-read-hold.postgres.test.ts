import { randomUUID } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  installDatabaseProcessRole,
  withEngineStoreAdmission,
} from "../../infra/database-engine/admission-scope.js";
import {
  mixedAgentConnection,
  useMixedAgentPair,
} from "../../infra/database-engine/mixed-agent.conformance.test-support.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { readTranscriptExportSnapshotReadOnlySync } from "./session-accessor.sqlite-export-read.js";
import { readTranscriptStatsSync } from "./session-accessor.sqlite-read.js";
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
    beforeAll(() => {
      // Deferred slices are read after the batch's first await, as in the transcript worker.
      installDatabaseProcessRole("cli-oneshot");
    });

    function seedLargeSession(rows?: { count: number; bytes: number }) {
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
        // By default two 2.5 MiB rows take the transcript past the 4 MiB retained-snapshot limit,
        // and each fills a 2 MiB slice.
        ...Array.from({ length: rows?.count ?? 2 }, (_, index) => ({
          type: "message",
          id: `entry-${index}`,
          parentId: index === 0 ? null : `entry-${index - 1}`,
          timestamp: "2026-04-01T05:46:40.000Z",
          message: {
            role: "user",
            content: "lobster ".repeat((rows?.bytes ?? 2.5 * MIB) / 8),
            timestamp: 1,
          },
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
    // Head reads project the decoded row as "event_json"; slice reads also select its size.
    const payloadQueries = () => observed.filter((sql) => sql.includes(' as "event_json"'));
    const sliceQueries = () => observed.filter((sql) => sql.includes('as "payload_bytes"'));

    it("memory batch streams a large transcript in bounded read-only slices without the writer lock", async () => {
      const { scope } = seedLargeSession();
      const entry = {
        absPath: path.join(path.dirname(scope.storePath), `${scope.sessionId}.jsonl`),
        options: scope,
      };
      // The batch head is read synchronously before the first await.
      let prepared: ReturnType<typeof collectSessionMemoryEntries> | undefined;
      withEngineStoreAdmission(() => {
        prepared = collectSessionMemoryEntries([entry]);
      });
      const [result] = await prepared!;
      expect(result && "entry" in result ? result.entry?.content : undefined).toContain("lobster");
      expect(begins().length).toBeGreaterThan(1);
      expect(new Set(begins())).toEqual(
        new Set(["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"]),
      );
      expect(observed.filter((sql) => sql.includes("pg_advisory_xact_lock"))).toEqual([]);
      expect(payloadQueries()).toEqual([]);
      expect(sliceQueries().length).toBeGreaterThan(0);
    });

    it("single export reads a large transcript one byte-budgeted row per slice", () => {
      const { events, scope } = seedLargeSession();
      const snapshot = withEngineStoreAdmission(() =>
        readTranscriptExportSnapshotReadOnlySync(scope),
      );
      expect(snapshot?.events).toEqual(events);
      expect(payloadQueries()).toEqual([]);
      // Each 2.5 MiB row ends a slice (the session row shares the first); a final empty
      // slice confirms nothing follows the last row.
      expect(sliceQueries()).toHaveLength(3);
    });

    // Many small rows never reach the byte budget, so only a row bound keeps PostgreSQL
    // from buffering the whole transcript in one result (#201571).
    it("pages a many-row transcript with row-bounded queries", () => {
      const { events, scope } = seedLargeSession({ count: 600, bytes: 8 * 1024 });
      const snapshot = withEngineStoreAdmission(() =>
        readTranscriptExportSnapshotReadOnlySync(scope),
      );
      expect(snapshot?.events).toEqual(events);
      expect(payloadQueries()).toEqual([]);
      expect(sliceQueries().length).toBeGreaterThanOrEqual(3);
      for (const query of sliceQueries()) {
        expect(query).toMatch(/\blimit\b/iu);
      }
    });
  },
);
