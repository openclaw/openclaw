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
    through: 1,
    maxEvents: 10,
    readRows: (after, through) => {
      reads.count += 1;
      return [0, 1].filter((seq) => seq > after && seq <= through).map((seq) => navigationRow(seq));
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
});
