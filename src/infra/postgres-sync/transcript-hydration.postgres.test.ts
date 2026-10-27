import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { streamSessionTranscriptHydration } from "../../config/sessions/session-transcript-hydration.worker.js";
import { runWithSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import type { SessionTranscriptHydrationChunk } from "../../config/sessions/session-transcript-worker.types.js";
import * as readonlyStore from "../../state/openclaw-agent-db-readonly.js";
import { installDatabaseProcessRole } from "../database-engine/admission-scope.js";
import { PostgresSyncConnection } from "./connection.js";
import { usePostgresTestHarness } from "./postgres.test-support.js";

const harness = usePostgresTestHarness("hydration");
const { connection, prefix: schema, client: admin } = harness;
type Event = { seq: number; text: string; recordedBytes?: number };

describe.skipIf(!connection)("PostgreSQL transcript hydration", () => {
  beforeAll(async () => {
    installDatabaseProcessRole("cli-oneshot");
    await admin.query(`CREATE SCHEMA "${schema}";
      CREATE TABLE "${schema}".transcript_events (
        session_id TEXT, seq INTEGER, event_json TEXT, event_zstd BYTEA,
        event_utf8_bytes INTEGER, PRIMARY KEY (session_id, seq));
      CREATE TABLE "${schema}".session_transcript_cold_archives (session_id TEXT, last_seq INTEGER);
      CREATE TABLE "${schema}".transcript_rewrite_watermarks (session_id TEXT, generation TEXT);
      CREATE TABLE "${schema}".session_windows (session_id TEXT, transcript_updated_at INTEGER);
      INSERT INTO "${schema}".transcript_rewrite_watermarks VALUES ('fixture', 'original');
      INSERT INTO "${schema}".session_windows VALUES ('fixture', 7)`);
  });
  afterEach(() => vi.restoreAllMocks());

  async function fixture(events: Event[]) {
    await admin.query(`TRUNCATE "${schema}".transcript_events`);
    await admin.query(
      `INSERT INTO "${schema}".transcript_events
        (session_id, seq, event_json, event_utf8_bytes)
        SELECT 'fixture', * FROM unnest($1::integer[], $2::text[], $3::integer[])`,
      [
        events.map((event) => event.seq),
        events.map((event) => event.text),
        events.map((event) => event.recordedBytes ?? null),
      ],
    );
    const anchor = new DatabaseSync(":memory:");
    const cleanup: { closeReader?: () => void } = {};
    harness.onClose(() => {
      cleanup.closeReader?.();
      anchor.close();
    });
    const reader = new PostgresSyncConnection(connection!, schema, anchor, schema);
    cleanup.closeReader = () => reader.close();
    const queries = vi.spyOn(reader, "query");
    const pathname = `/synthetic/${schema}/anchor.sqlite`;
    const closedTransactions: boolean[] = [];
    vi.spyOn(readonlyStore, "openOpenClawAgentDatabaseReadOnly").mockReturnValue({
      found: true,
      database: {
        agentId: "main",
        path: pathname,
        db: reader,
        close() {
          closedTransactions.push(reader.isTransaction);
          reader.close();
        },
      },
    });
    const chunks: SessionTranscriptHydrationChunk[] = [];
    const stream = (
      options: {
        afterSeq?: number;
        beforeSeq?: number;
        onChunk?: () => Promise<void>;
      } = {},
    ) =>
      runWithSessionTranscriptReadFence(
        options.beforeSeq === undefined
          ? undefined
          : {
              agentId: "main",
              sessionId: "fixture",
              sessionKey: "fixture",
              storePath: pathname,
              generation: "original",
              entryId: "fence",
              rawSeq: options.beforeSeq,
              effectiveParentId: null,
              activeMessagePosition: 0,
              logicalTurnId: "turn",
              role: "user",
            },
        () =>
          streamSessionTranscriptHydration(
            {
              kind: "transcript-hydration",
              database: { agentId: "main", path: pathname },
              resolvedScope: { agentId: "main", sessionId: "fixture", path: pathname },
              target: { sessionId: "fixture" },
              includeEventJson: true,
              afterSeq: options.afterSeq,
            },
            {
              consumeInput() {},
              notify() {},
              async request(value, transferList) {
                chunks.push(
                  structuredClone(value, {
                    transfer: transferList?.slice(),
                  }) as SessionTranscriptHydrationChunk,
                );
                await options.onChunk?.();
                return { input: undefined, consumed() {} };
              },
            },
            {
              runNativeSection: async (operation) => operation(),
              throwIfCancelled() {},
            },
          ),
      );
    const payloadPages = () =>
      queries.mock.results.flatMap((result, index) => {
        const sql = queries.mock.calls[index]![0];
        if (
          result.type !== "return" ||
          !sql.includes('"data"') ||
          !sql.includes('"transcript_events"')
        ) {
          return [];
        }
        return [
          result.value.rows.reduce(
            (bytes, row) => bytes + (row.data instanceof Uint8Array ? row.data.byteLength : 0),
            0,
          ),
        ];
      });
    return { reader, chunks, payloadPages, queries, closedTransactions, stream };
  }

  function expectHydrated(chunks: SessionTranscriptHydrationChunk[], expected: Event[]) {
    let index = 0;
    let parts: Uint8Array[] = [];
    for (const chunk of chunks) {
      expect(chunk.encoding).toBe("UTF-8");
      expect(
        chunk.frames.reduce((bytes, frame) => bytes + frame.data.byteLength, 0),
      ).toBeLessThanOrEqual(1024 * 1024);
      for (const frame of chunk.frames) {
        expect(frame.data.byteLength).toBeLessThanOrEqual(65536);
        parts.push(frame.data);
        if (frame.endOfEvent) {
          expect(frame.seq).toBe(expected[index]?.seq);
          expect(Buffer.concat(parts)).toEqual(Buffer.from(expected[index++]!.text));
          parts = [];
        }
      }
    }
    expect(parts).toEqual([]);
    expect(index).toBe(expected.length);
  }

  it("hydrates 5,000 events in at most three payload trips without changing its snapshot", async () => {
    const events = Array.from({ length: 5000 }, (_, index) => ({
      seq: index - 5,
      text: JSON.stringify({ id: index, text: "🦞" }),
    }));
    const f = await fixture(events);
    let acknowledgements = 0;
    const result = await f.stream({
      onChunk: async () => {
        expect(f.reader.isTransaction).toBe(true);
        if (acknowledgements++ === 0) {
          await admin.query(
            `UPDATE "${schema}".transcript_events SET event_json = 'changed' WHERE seq = 4900`,
          );
          await admin.query(
            `INSERT INTO "${schema}".transcript_events VALUES ('fixture', 5000, 'new', NULL, NULL)`,
          );
        }
      },
    });
    expect(result).toEqual({
      kind: "full",
      eventCount: 5000,
      version: { generation: "original", rawSeq: 4994, updatedAt: 7 },
    });
    expectHydrated(f.chunks, events);
    expect(f.closedTransactions).toEqual([false]);
    expect(f.reader.isOpen).toBe(false);
    expect(f.payloadPages().length).toBeLessThanOrEqual(3);
    expect(f.queries.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it("bounds large-row pages while preserving UTF-8 bytes and exclusive sequence fences", async () => {
    const events = Array.from({ length: 90 }, (_, index) => {
      const text = index === 2 ? "" : `${" ".repeat(index === 3 ? 65535 : 60000)}"🦞${index}"`;
      return {
        seq: index - 4,
        text,
        ...(index % 2 ? { recordedBytes: Buffer.byteLength(text) } : {}),
      };
    });
    const f = await fixture(events);
    const result = await f.stream({ afterSeq: -3, beforeSeq: 84 });
    const selected = events.filter(({ seq }) => seq > -3 && seq < 84);
    expect(result.eventCount).toBe(selected.length);
    expectHydrated(f.chunks, selected);
    expect(f.payloadPages().length).toBeGreaterThan(1);
    expect(f.payloadPages().length).toBeLessThanOrEqual(5);
    expect(f.payloadPages().every((bytes) => bytes <= 4 * 1024 * 1024)).toBe(true);
  });
});
