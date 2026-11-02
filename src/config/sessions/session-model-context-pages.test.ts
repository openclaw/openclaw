/** Alternating sessions on one retained connection must not thrash the warm cache. */
import { describe, expect, it, vi } from "vitest";
import { createModelContextPairing } from "./session-model-context-pairing.js";

vi.mock("../../infra/sqlite-database-admission.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/sqlite-database-admission.js")>()),
  readSqliteDatabaseScopedWriteToken: () => "warm-token",
}));
vi.mock("../../infra/sqlite-schema-facts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/sqlite-schema-facts.js")>()),
  hasUncommittedSqliteWrites: () => false,
}));

const {
  readModelContextNavigationPages,
  navigationSnapshotBytes,
  storeNavigationSnapshot,
  NAVIGATION_CACHE_MAX_BYTES,
} = await import("./session-model-context-pages.js");

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

/** Builds the retained page receipts directly; replaying the equivalent history would be huge. */
function navigationSnapshotWithPages(sessionId: string, pageCount: number) {
  const pages = new Map<number, { through: number; membership: Uint8Array; bytes: number }>();
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    pages.set(pageIndex, {
      through: pageIndex * 512 + 511,
      membership: new Uint8Array(512),
      bytes: 0,
    });
  }
  return {
    sessionId,
    generation: "gen-1",
    through: pageCount * 512 - 1,
    maxEvents: 16,
    leafId: null,
    appendParentId: null,
    pages,
    rows: new Map(),
    requests: [],
    entries: [],
    prefixCount: 0,
    prefixBytes: 0,
    prefixHasUser: false,
    pairing: createModelContextPairing([], []),
  };
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

  it("evicts a session whose retained navigation exceeds the byte budget", () => {
    const cache = { entries: new Map(), bytes: 0 };
    const oversized = navigationSnapshotWithPages("oversized-session", 32_000);
    expect(navigationSnapshotBytes(oversized as never)).toBeGreaterThan(NAVIGATION_CACHE_MAX_BYTES);

    storeNavigationSnapshot(cache, "oversized-session", oversized as never);
    storeNavigationSnapshot(
      cache,
      "warm-session",
      navigationSnapshotWithPages("warm-session", 1) as never,
    );

    expect([...cache.entries.keys()]).toEqual(["warm-session"]);
  });
});
