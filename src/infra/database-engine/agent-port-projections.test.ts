import type { Client } from "pg";
import { describe, expect, it } from "vitest";
import { TRANSCRIPT_INSERT_BATCH_SIZE } from "../../config/sessions/transcript-payload.js";
import { rebuildAgentPortProjections } from "./agent-port-projections.js";

type Recorded = { sql: string; values: readonly unknown[] };

function transcriptEvents(count: number) {
  return Array.from({ length: count }, (_, seq) => ({
    seq: String(seq),
    created_at: "1",
    event_json: JSON.stringify({
      type: "message",
      id: `m-${seq}`,
      parentId: seq === 0 ? null : `m-${seq - 1}`,
      timestamp: 1_000 + seq,
      message: { role: seq % 2 === 0 ? "user" : "assistant", content: `hello ${seq}` },
    }),
  }));
}

/** A recording stand-in for the network connection; the batching contract is its query count. */
function recordingPostgres(eventsBySession: Record<string, ReturnType<typeof transcriptEvents>>) {
  const queries: Recorded[] = [];
  const client = {
    async query(sql: string, values: readonly unknown[] = []) {
      queries.push({ sql, values });
      if (sql.includes("FROM session_windows")) {
        return {
          rows: Object.keys(eventsBySession).map((session_id) => ({
            session_id,
            generation: "generation",
            transcript_updated_at: "1",
          })),
        };
      }
      if (sql.includes("FROM transcript_events")) {
        return { rows: eventsBySession[String(values[0])] ?? [] };
      }
      return { rows: [] };
    },
  };
  // SAFETY: the projection rebuild only calls query() on the PostgreSQL endpoint.
  return { queries, db: client as unknown as Client };
}

describe("rebuildAgentPortProjections on PostgreSQL", () => {
  it("writes transcript search rows in bounded batches that keep message order", async () => {
    const count = TRANSCRIPT_INSERT_BATCH_SIZE * 2 + 76;
    const { queries, db } = recordingPostgres({ "session-a": transcriptEvents(count) });

    await rebuildAgentPortProjections({ engine: "postgres", db, namespace: "agent_port" });

    const writes = queries.filter(({ sql }) => sql.includes("session_transcript_fts"));
    expect(
      writes.map(({ values }) => values.filter((value) => /^m-\d+$/.test(String(value)))),
    ).toEqual([
      Array.from({ length: TRANSCRIPT_INSERT_BATCH_SIZE }, (_, index) => `m-${index}`),
      Array.from(
        { length: TRANSCRIPT_INSERT_BATCH_SIZE },
        (_, index) => `m-${TRANSCRIPT_INSERT_BATCH_SIZE + index}`,
      ),
      Array.from({ length: 76 }, (_, index) => `m-${TRANSCRIPT_INSERT_BATCH_SIZE * 2 + index}`),
    ]);
    for (const { sql, values } of writes) {
      // Every row's content travels with its identity, and ids are allocated in message order.
      expect(sql).toContain("nextval");
      expect(sql).toContain('order by "position"');
      expect(values).toContain("session-a");
      expect(values.length).toBeLessThan(65_535);
    }
    const firstBatch = writes[0]!.values;
    const row = firstBatch.indexOf("m-1");
    expect(firstBatch.slice(row, row + 4)).toEqual(["m-1", "hello 1", "assistant", 1_001]);
  });

  it("batches per session and skips sessions without searchable messages", async () => {
    const { queries, db } = recordingPostgres({
      "session-a": transcriptEvents(3),
      "session-empty": [],
    });

    await rebuildAgentPortProjections({ engine: "postgres", db, namespace: "agent_port" });

    const writes = queries.filter(({ sql }) => sql.includes("session_transcript_fts"));
    expect(writes).toHaveLength(1);
    expect(writes[0]!.values).toContain("session-a");
  });
});
