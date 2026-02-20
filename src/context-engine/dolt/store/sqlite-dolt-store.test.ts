import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../../../memory/sqlite.js";
import { serializeDoltSummaryFrontmatter } from "../contract.js";
import { SqliteDoltStore } from "./sqlite-dolt-store.js";
import { estimateDoltTokenCount } from "./token-count.js";

type TestStore = {
  store: SqliteDoltStore;
  db: import("node:sqlite").DatabaseSync;
};

const createdStores: TestStore[] = [];
const createdDirs: string[] = [];

function createInMemoryStore(now: () => number = () => Date.now()): TestStore {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(":memory:");
  const store = new SqliteDoltStore({ db, now });
  const created = { store, db };
  createdStores.push(created);
  return created;
}

function makeSummaryPayload(params: {
  summaryType: "leaf" | "bindle";
  startEpochMs: number;
  endEpochMs: number;
  children: string[];
  finalizedAtReset: boolean;
  body: string;
}): { summary: string } {
  const frontmatter = serializeDoltSummaryFrontmatter({
    summaryType: params.summaryType,
    datesCovered: {
      startEpochMs: params.startEpochMs,
      endEpochMs: params.endEpochMs,
    },
    children: params.children,
    finalizedAtReset: params.finalizedAtReset,
  });
  return {
    summary: `${frontmatter}\n${params.body}`,
  };
}

afterEach(async () => {
  for (const created of createdStores.splice(0, createdStores.length)) {
    created.store.close();
  }
  for (const dir of createdDirs.splice(0, createdDirs.length)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("SqliteDoltStore", () => {
  it("creates required schema tables and indexes", () => {
    const { db } = createInMemoryStore();
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all() as Array<{ name: string }>;
    const tableNames = new Set(tables.map((row) => row.name));
    expect(tableNames.has("dolt_records")).toBe(true);
    expect(tableNames.has("dolt_lineage")).toBe(true);
    expect(tableNames.has("dolt_active_lane")).toBe(true);
    expect(tableNames.has("dolt_store_meta")).toBe(true);

    const indexes = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`)
      .all() as Array<{ name: string }>;
    const indexNames = new Set(indexes.map((row) => row.name));
    expect(indexNames.has("idx_dolt_records_session_level_event")).toBe(true);
    expect(indexNames.has("idx_dolt_lineage_parent_index")).toBe(true);
    expect(indexNames.has("idx_dolt_active_lane_lookup")).toBe(true);
  });

  it("persists and reads records ordered by event timestamp", () => {
    const { store } = createInMemoryStore(() => 1_000);
    store.upsertRecord({
      pointer: "turn-2",
      sessionId: "session-a",
      level: "turn",
      eventTsMs: 200,
      payload: { role: "assistant", content: "later" },
    });
    store.upsertRecord({
      pointer: "turn-1",
      sessionId: "session-a",
      level: "turn",
      eventTsMs: 100,
      payload: { role: "user", content: "earlier" },
    });
    store.upsertRecord({
      pointer: "leaf-1",
      sessionId: "session-a",
      level: "leaf",
      eventTsMs: 150,
      payload: makeSummaryPayload({
        summaryType: "leaf",
        startEpochMs: 100,
        endEpochMs: 200,
        children: ["turn-1", "turn-2"],
        finalizedAtReset: true,
        body: "rollup",
      }),
      finalizedAtReset: true,
    });

    expect(store.countSessionRecords("session-a")).toBe(3);
    const turns = store.listRecordsBySession({ sessionId: "session-a", level: "turn" });
    expect(turns.map((row) => row.pointer)).toEqual(["turn-1", "turn-2"]);

    const leaf = store.getRecord("leaf-1");
    expect(leaf?.finalizedAtReset).toBe(true);
    expect(leaf?.tokenCountMethod).toBe("estimateTokens");
    expect(leaf?.tokenCount).toBeGreaterThanOrEqual(0);
    expect(leaf?.payload).toEqual(
      makeSummaryPayload({
        summaryType: "leaf",
        startEpochMs: 100,
        endEpochMs: 200,
        children: ["turn-1", "turn-2"],
        finalizedAtReset: true,
        body: "rollup",
      }),
    );
  });

  it("replaces and lists direct lineage children in index order", () => {
    const { store } = createInMemoryStore(() => 2_000);
    store.upsertRecord({
      pointer: "leaf-parent",
      sessionId: "session-a",
      level: "leaf",
      eventTsMs: 300,
      payload: makeSummaryPayload({
        summaryType: "leaf",
        startEpochMs: 100,
        endEpochMs: 200,
        children: ["turn-a", "turn-b"],
        finalizedAtReset: false,
        body: "parent leaf",
      }),
    });
    store.upsertRecord({
      pointer: "turn-a",
      sessionId: "session-a",
      level: "turn",
      eventTsMs: 100,
    });
    store.upsertRecord({
      pointer: "turn-b",
      sessionId: "session-a",
      level: "turn",
      eventTsMs: 200,
    });

    store.replaceDirectChildren({
      parentPointer: "leaf-parent",
      children: [
        { pointer: "turn-b", level: "turn", index: 1 },
        { pointer: "turn-a", level: "turn", index: 0 },
      ],
    });

    const edges = store.listDirectChildren("leaf-parent");
    expect(edges.map((row) => row.childPointer)).toEqual(["turn-a", "turn-b"]);
    const childRecords = store.listDirectChildRecords("leaf-parent");
    expect(childRecords.map((row) => row.pointer)).toEqual(["turn-a", "turn-b"]);
  });

  it("tracks active-lane rows and deactivates by level", () => {
    const { store } = createInMemoryStore(() => 3_000);
    store.upsertRecord({
      pointer: "turn-a",
      sessionId: "session-a",
      level: "turn",
      eventTsMs: 100,
    });
    store.upsertRecord({
      pointer: "turn-b",
      sessionId: "session-a",
      level: "turn",
      eventTsMs: 200,
    });

    store.upsertActiveLane({
      sessionId: "session-a",
      level: "turn",
      pointer: "turn-a",
      isActive: true,
      lastEventTsMs: 100,
    });
    store.upsertActiveLane({
      sessionId: "session-a",
      level: "turn",
      pointer: "turn-b",
      isActive: true,
      lastEventTsMs: 200,
    });

    const before = store.listActiveLane({
      sessionId: "session-a",
      level: "turn",
      activeOnly: true,
    });
    expect(before.map((row) => row.pointer)).toEqual(["turn-b", "turn-a"]);

    store.deactivateLevelPointers({
      sessionId: "session-a",
      level: "turn",
      exceptPointer: "turn-b",
    });

    const after = store.listActiveLane({ sessionId: "session-a", level: "turn", activeOnly: true });
    expect(after.map((row) => row.pointer)).toEqual(["turn-b"]);
  });

  it("bootstraps turns from session JSONL when session store is empty", async () => {
    const { store } = createInMemoryStore(() => 4_000);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-dolt-store-"));
    createdDirs.push(dir);
    const sessionFile = path.join(dir, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 7,
          id: "session-a",
          timestamp: "2026-02-20T00:00:00.000Z",
          cwd: dir,
        }),
        JSON.stringify({
          type: "message",
          id: "m1",
          parentId: null,
          timestamp: "2026-02-20T00:00:01.000Z",
          message: {
            role: "user",
            content: "hello",
            usage: { input: 12, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        }),
        JSON.stringify({
          type: "message",
          id: "m2",
          parentId: "m1",
          timestamp: "2026-02-20T00:00:02.000Z",
          message: {
            role: "assistant",
            content: "world",
            usage: { total: 18 },
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    const bootstrap = await store.bootstrapFromJsonl({
      sessionId: "session-a",
      sessionKey: "agent:main:session-a",
      sessionFile,
    });
    expect(bootstrap).toEqual({
      bootstrapped: true,
      importedRecords: 2,
      source: "jsonl",
    });

    const turns = store.listRecordsBySession({ sessionId: "session-a", level: "turn" });
    expect(turns).toHaveLength(2);
    expect(turns.map((row) => row.pointer)).toEqual([
      "turn:session-a:msg:m1",
      "turn:session-a:msg:m2",
    ]);
    for (const turn of turns) {
      expect(turn.tokenCount).toBeGreaterThanOrEqual(0);
      expect(turn.tokenCountMethod).toBe("estimateTokens");
    }
    expect(
      store.listActiveLane({ sessionId: "session-a", level: "turn", activeOnly: true }),
    ).toHaveLength(2);
  });

  it("skips bootstrap when records already exist for the session", async () => {
    const { store } = createInMemoryStore(() => 5_000);
    store.upsertRecord({
      pointer: "existing",
      sessionId: "session-a",
      level: "turn",
      eventTsMs: 1,
    });

    const result = await store.bootstrapFromJsonl({
      sessionId: "session-a",
      sessionFile: "/tmp/does-not-matter.jsonl",
    });

    expect(result).toEqual({
      bootstrapped: false,
      importedRecords: 0,
      reason: "session_not_empty",
    });
  });

  it("bootstraps from supplied history turns when provided", async () => {
    const { store } = createInMemoryStore(() => 6_000);
    const result = await store.bootstrapFromJsonl({
      sessionId: "session-history",
      sessionFile: "/tmp/unneeded.jsonl",
      historyTurns: [
        {
          pointer: "turn-history-1",
          eventTsMs: 10,
          payload: { role: "user", content: "hello" },
        },
        {
          pointer: "turn-history-2",
          eventTsMs: 20,
          payload: { role: "assistant", content: "hi" },
        },
      ],
    });

    expect(result).toEqual({
      bootstrapped: true,
      importedRecords: 2,
      source: "history",
    });
    const turns = store.listRecordsBySession({ sessionId: "session-history", level: "turn" });
    expect(turns.map((row) => row.pointer)).toEqual(["turn-history-1", "turn-history-2"]);
  });

  it("intercepts oversized turn payloads before persisting lane accounting token counts", () => {
    const { store } = createInMemoryStore(() => 6_100);
    const hugePayload = {
      role: "tool",
      content: "x".repeat(70_000),
    };

    const rawEstimate = estimateDoltTokenCount({ payload: hugePayload });
    const record = store.upsertRecord({
      pointer: "turn-outlier",
      sessionId: "session-a",
      level: "turn",
      eventTsMs: 200,
      payload: hugePayload,
    });

    const persistedPayload = record.payload as {
      doltAccountingIntercept?: { sourceTokenEstimate?: number; reason?: string };
    };
    expect(persistedPayload.doltAccountingIntercept?.reason).toBe("oversized_turn_payload");
    expect(persistedPayload.doltAccountingIntercept?.sourceTokenEstimate).toBe(
      rawEstimate.tokenCount,
    );
    expect(record.tokenCount).toBeLessThan(rawEstimate.tokenCount);
  });

  it("rejects malformed summary front-matter for leaf records", () => {
    const { store } = createInMemoryStore(() => 7_000);
    expect(() =>
      store.upsertRecord({
        pointer: "leaf-bad-frontmatter",
        sessionId: "session-a",
        level: "leaf",
        eventTsMs: 300,
        payload: { summary: "not-frontmatter body only" },
      }),
    ).toThrow(/YAML front-matter/);
  });

  it("rejects lineage child-level violations", () => {
    const { store } = createInMemoryStore(() => 8_000);
    store.upsertRecord({
      pointer: "bindle-parent",
      sessionId: "session-a",
      level: "bindle",
      eventTsMs: 500,
      payload: makeSummaryPayload({
        summaryType: "bindle",
        startEpochMs: 100,
        endEpochMs: 200,
        children: ["leaf-1"],
        finalizedAtReset: false,
        body: "bindle summary",
      }),
    });
    store.upsertRecord({
      pointer: "turn-1",
      sessionId: "session-a",
      level: "turn",
      eventTsMs: 100,
      payload: { role: "user", content: "hi" },
    });

    expect(() =>
      store.upsertLineageEdge({
        parentPointer: "bindle-parent",
        childPointer: "turn-1",
        childIndex: 0,
        childLevel: "turn",
      }),
    ).toThrow(/lineage violation/);
  });

  it("rejects non-chronological child ordering when replacing lineage", () => {
    const { store } = createInMemoryStore(() => 9_000);
    store.upsertRecord({
      pointer: "leaf-parent",
      sessionId: "session-a",
      level: "leaf",
      eventTsMs: 300,
      payload: makeSummaryPayload({
        summaryType: "leaf",
        startEpochMs: 100,
        endEpochMs: 200,
        children: ["turn-newer", "turn-older"],
        finalizedAtReset: false,
        body: "parent",
      }),
    });
    store.upsertRecord({
      pointer: "turn-newer",
      sessionId: "session-a",
      level: "turn",
      eventTsMs: 200,
      payload: { role: "assistant", content: "newer" },
    });
    store.upsertRecord({
      pointer: "turn-older",
      sessionId: "session-a",
      level: "turn",
      eventTsMs: 100,
      payload: { role: "user", content: "older" },
    });

    expect(() =>
      store.replaceDirectChildren({
        parentPointer: "leaf-parent",
        children: [
          { pointer: "turn-newer", level: "turn", index: 0 },
          { pointer: "turn-older", level: "turn", index: 1 },
        ],
      }),
    ).toThrow(/must be chronological/);
  });

  it("rejects finalizedAtReset mismatch between payload front-matter and record flag", () => {
    const { store } = createInMemoryStore(() => 10_000);
    expect(() =>
      store.upsertRecord({
        pointer: "leaf-mismatch",
        sessionId: "session-a",
        level: "leaf",
        eventTsMs: 300,
        finalizedAtReset: false,
        payload: makeSummaryPayload({
          summaryType: "leaf",
          startEpochMs: 100,
          endEpochMs: 200,
          children: ["turn-1"],
          finalizedAtReset: true,
          body: "body",
        }),
      }),
    ).toThrow(/finalized-at-reset/);
  });
});
