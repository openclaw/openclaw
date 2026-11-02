/** Alternating sessions on one retained connection must not thrash the warm cache. */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../infra/sqlite-database-admission.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/sqlite-database-admission.js")>()),
  readSqliteDatabaseScopedWriteToken: () => "warm-token",
}));
vi.mock("../../infra/sqlite-schema-facts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/sqlite-schema-facts.js")>()),
  hasUncommittedSqliteWrites: () => false,
}));

const { readModelContextNavigationPages } = await import("./session-model-context-pages.js");

const database = {} as never;

function navigationRow(seq: number) {
  return {
    entry: {
      id: `entry-${seq}`,
      seq,
      parentId: seq === 0 ? null : `entry-${seq - 1}`,
      timestamp: "2026-07-17T00:00:00.000Z",
      type: "message" as const,
      message: { role: "user" as const, content: `message ${seq}`, timestamp: seq },
    },
    bytes: 16,
    withoutCheckpointBytes: 16,
  };
}

function readSession(sessionId: string, reads: { count: number }) {
  return readModelContextNavigationPages({
    database,
    sessionId,
    generation: "gen-1",
    through: 3,
    maxEvents: 10,
    readRows: (after, through) => {
      reads.count += 1;
      return [0, 1, 2, 3]
        .filter((seq) => seq > after && seq <= through)
        .map((seq) => navigationRow(seq));
    },
  });
}

function readAnchor(sessionId: string, anchorId: string) {
  return readModelContextNavigationPages({
    database,
    sessionId,
    generation: "gen-1",
    through: 3,
    anchorId,
    maxEvents: 10,
    readRows: (after, through) =>
      [0, 1, 2, 3].filter((seq) => seq > after && seq <= through).map((seq) => navigationRow(seq)),
  });
}

/**
 * A long history whose projected message payloads are far larger than the retained
 * navigation suffix (only `maxEvents` rows survive trimRequests).
 */
const LONG_HISTORY_EVENTS = 2_048;
const LONG_MESSAGE_BYTES = 16 * 1_024;

function readLongSession(sessionId: string, reads: { count: number }) {
  return readModelContextNavigationPages({
    database,
    sessionId,
    generation: "gen-1",
    through: LONG_HISTORY_EVENTS - 1,
    maxEvents: 16,
    readRows: (after, through) => {
      reads.count += 1;
      const rows = [];
      for (let seq = Math.max(0, after + 1); seq <= through; seq += 1) {
        rows.push({
          ...navigationRow(seq),
          bytes: LONG_MESSAGE_BYTES,
          withoutCheckpointBytes: LONG_MESSAGE_BYTES,
        });
      }
      return rows;
    },
  });
}

describe("model-context navigation cache", () => {
  it("keeps both sessions warm when reads alternate on one connection", () => {
    const a = { count: 0 };
    const b = { count: 0 };

    readSession("session-a", a);
    readSession("session-b", b);
    readSession("session-a", a);
    readSession("session-b", b);

    // One seed read per session: switching back answers from the retained snapshot.
    expect(a.count).toBe(1);
    expect(b.count).toBe(1);
  });

  it("keeps the current snapshot warm across historical anchor reads", () => {
    const current = { count: 0 };
    readSession("session-anchors", current);
    for (let index = 0; index < 4; index += 1) {
      readAnchor("session-anchors", `entry-${index}`);
    }
    readSession("session-anchors", current);

    // Historical anchors stay transient: they never displace the current snapshot.
    expect(current.count).toBe(1);
  });

  it("evicts the least recently used session once the bound is exceeded", () => {
    const reads = new Map<string, { count: number }>();
    for (let index = 0; index < 6; index += 1) {
      const state = { count: 0 };
      reads.set(`session-${index}`, state);
      readSession(`session-${index}`, state);
    }

    const first = reads.get("session-0")!;
    readSession("session-0", first);

    expect(first.count).toBe(2);
  });

  it("keeps long histories warm when discarded payloads dwarf retained navigation", () => {
    const a = { count: 0 };
    const b = { count: 0 };

    readLongSession("long-session-a", a);
    readLongSession("long-session-b", b);
    readLongSession("long-session-a", a);
    readLongSession("long-session-b", b);

    // Trimmed payload bytes are not retained, so both bounded suffixes stay resident.
    expect(a.count).toBe(1);
    expect(b.count).toBe(1);
  });

  it("evicts a session whose retained tool-call identifiers exceed the byte budget", () => {
    // Navigation keeps tool-call ids even though the message payload around them is dropped;
    // a handful of oversized ids must still be charged so the bounded warm set evicts.
    const hugeId = "x".repeat(6 * 1024 * 1024);
    const readHugeSession = (sessionId: string, reads: { count: number }) =>
      readModelContextNavigationPages({
        database,
        sessionId,
        generation: "gen-1",
        through: 9,
        maxEvents: 10,
        readRows: (after, through) => {
          reads.count += 1;
          return Array.from({ length: through + 1 }, (_unused, seq) => ({
            entry: {
              id: `huge-entry-${seq}`,
              seq,
              parentId: null,
              timestamp: "2026-07-17T00:00:00.000Z",
              type: "message" as const,
              message: {
                role: "toolResult" as const,
                toolCallId: hugeId,
                toolName: "read",
                content: [],
                isError: false,
                timestamp: seq,
              },
            },
            bytes: 16,
            withoutCheckpointBytes: 16,
          }));
        },
      });
    const first = { count: 0 };
    const rest = [{ count: 0 }, { count: 0 }, { count: 0 }];
    [first, ...rest].forEach((reads, index) => readHugeSession(`huge-session-${index}`, reads));

    readHugeSession("huge-session-0", first);
    expect(first.count).toBe(2);
  });
});
