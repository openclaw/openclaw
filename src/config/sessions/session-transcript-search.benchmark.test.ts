import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { ensureSessionTranscriptArchiveSchema } from "../../state/openclaw-agent-session-transcript-archive-schema.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { searchSessionTranscripts } from "./session-transcript-search.js";

it.runIf(process.env.OPENCLAW_DB_WORKER_BENCH === "1")(
  "measures scoped transcript search for 50 viewers over 5,000 session rows",
  async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const rows = 5_000;
      const viewers = 50;
      const sessionKeys = Array.from({ length: rows }, (_, index) => `agent:main:bench-${index}`);
      runOpenClawAgentWriteTransaction(
        ({ db }) => {
          const kysely = getNodeSqliteKysely<DB>(db);
          for (const [index, sessionKey] of sessionKeys.entries()) {
            const sessionId = `bench-${index}`;
            replaceSessionEntrySync(
              { agentId: "main", sessionKey },
              { sessionId, updatedAt: index + 1, visibility: "shared" },
            );
            executeSqliteQuerySync(
              db,
              kysely.insertInto("session_transcript_fts").values({
                session_id: sessionId,
                message_id: `message-${index}`,
                role: "assistant",
                text: `Deployment needle context for session ${index}`,
                timestamp: String(index + 1),
              }),
            );
          }
        },
        { agentId: "main" },
      );
      const request = async () =>
        await searchSessionTranscripts({
          agentId: "main",
          query: "needle",
          sessionKeys,
          limit: 10,
        });
      const golden = JSON.stringify(await request());
      expect(JSON.parse(golden).hits).toHaveLength(10);
      const samples: Array<{ cpuMs: number; wallMs: number }> = [];
      for (let round = 0; round < 7; round++) {
        const start = performance.now();
        const cpu = process.threadCpuUsage();
        const responses = await Promise.all(Array.from({ length: viewers }, request));
        const elapsed = process.threadCpuUsage(cpu);
        if (round >= 2) {
          samples.push({
            cpuMs: (elapsed.user + elapsed.system) / 1_000 / viewers,
            wallMs: (performance.now() - start) / viewers,
          });
        }
        expect(responses.every((response) => JSON.stringify(response) === golden)).toBe(true);
      }
      console.log(
        JSON.stringify({
          method: "searchSessionTranscripts",
          rows,
          viewers,
          samples,
          medianCpuMs: samples.map((sample) => sample.cpuMs).toSorted((a, b) => a - b)[2],
          medianWallMs: samples.map((sample) => sample.wallMs).toSorted((a, b) => a - b)[2],
        }),
      );
    });
  },
);

it.runIf(process.env.OPENCLAW_DB_WORKER_BENCH === "1")(
  "measures scoped transcript search with 20,000 retained deleted-session archives",
  async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const liveRows = 500;
      const archives = 20_000;
      const archiveBlob = new Uint8Array(16 * 1024).fill(7);
      const sessionKeys = Array.from(
        { length: liveRows },
        (_, index) => `agent:main:bench-${index}`,
      );
      runOpenClawAgentWriteTransaction(
        ({ db }) => {
          const kysely = getNodeSqliteKysely<DB>(db);
          for (const [index, sessionKey] of sessionKeys.entries()) {
            const sessionId = `bench-${index}`;
            replaceSessionEntrySync(
              { agentId: "main", sessionKey },
              { sessionId, updatedAt: index + 1, visibility: "shared" },
            );
            executeSqliteQuerySync(
              db,
              kysely.insertInto("session_transcript_fts").values({
                session_id: sessionId,
                message_id: `message-${index}`,
                role: "assistant",
                text: `Deployment needle context for session ${index}`,
                timestamp: String(index + 1),
              }),
            );
          }
        },
        { agentId: "main" },
      );
      const request = async () =>
        await searchSessionTranscripts({
          agentId: "main",
          query: "needle",
          sessionKeys,
          limit: 10,
        });
      const measure = async () => {
        await request();
        const samples: number[] = [];
        for (let round = 0; round < 15; round++) {
          const start = performance.now();
          await request();
          samples.push(performance.now() - start);
        }
        return samples.toSorted((a, b) => a - b)[7];
      };
      const withoutArchivesMs = await measure();
      runOpenClawAgentWriteTransaction(
        ({ db }) => {
          ensureSessionTranscriptArchiveSchema(db);
          const kysely = getNodeSqliteKysely<DB>(db);
          for (let index = 0; index < archives; index++) {
            executeSqliteQuerySync(
              db,
              kysely.insertInto("session_transcript_archives").values({
                session_id: `deleted-${index}`,
                generation: "generation",
                // One in fifty archives belongs to a searched key; the rest are gone.
                session_key:
                  index % 50 === 0
                    ? sessionKeys[(index / 50) % liveRows]!
                    : `agent:main:gone-${index}`,
                reason: "deleted",
                encoding: "identity",
                archive_blob: archiveBlob,
                archive_sha256: "0".repeat(64),
                archive_name: `deleted-${index}.jsonl`,
                created_at: index + 1,
              }),
            );
          }
        },
        { agentId: "main" },
      );
      const result = await request();
      expect(result.deletedTranscriptsExcluded).toBe(archives / 50);
      const withArchivesMs = await measure();
      console.log(
        JSON.stringify({
          method: "searchSessionTranscripts",
          liveRows,
          archives,
          archiveBlobBytes: archiveBlob.byteLength,
          medianWallMsWithoutArchives: withoutArchivesMs,
          medianWallMsWithArchives: withArchivesMs,
        }),
      );
    });
  },
);
