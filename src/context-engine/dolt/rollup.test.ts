import { afterEach, describe, expect, it, vi } from "vitest";
import type { DoltRecord } from "./store/types.js";
import type { DoltSummarizeParams, DoltSummarizeResult } from "./summarizer.js";
import { requireNodeSqlite } from "../../memory/sqlite.js";
import { serializeDoltSummaryFrontmatter } from "./contract.js";
import { executeDoltRollup } from "./rollup.js";
import { SqliteDoltStore } from "./store/sqlite-dolt-store.js";

type TestStore = {
  store: SqliteDoltStore;
  db: import("node:sqlite").DatabaseSync;
};

const createdStores: TestStore[] = [];

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
  body: string;
  finalizedAtReset?: boolean;
}): { summary: string } {
  const frontmatter = serializeDoltSummaryFrontmatter({
    summaryType: params.summaryType,
    datesCovered: {
      startEpochMs: params.startEpochMs,
      endEpochMs: params.endEpochMs,
    },
    children: params.children,
    finalizedAtReset: params.finalizedAtReset === true,
  });
  return {
    summary: `${frontmatter}\n${params.body}`,
  };
}

afterEach(() => {
  for (const created of createdStores.splice(0, createdStores.length)) {
    created.store.close();
  }
});

describe("executeDoltRollup", () => {
  it("rejects invalid source levels for leaf and bindle targets", async () => {
    const { store } = createInMemoryStore(() => 1_000);
    const leaf = store.upsertRecord({
      pointer: "leaf-1",
      sessionId: "session-a",
      level: "leaf",
      eventTsMs: 10,
      payload: makeSummaryPayload({
        summaryType: "leaf",
        startEpochMs: 1,
        endEpochMs: 10,
        children: ["turn-1"],
        body: "leaf one",
      }),
    });
    const bindle = store.upsertRecord({
      pointer: "bindle-1",
      sessionId: "session-a",
      level: "bindle",
      eventTsMs: 20,
      payload: makeSummaryPayload({
        summaryType: "bindle",
        startEpochMs: 1,
        endEpochMs: 20,
        children: ["leaf-1"],
        body: "bindle one",
      }),
    });

    await expect(
      executeDoltRollup({
        store,
        sessionId: "session-a",
        targetLevel: "leaf",
        sourceRecords: [leaf],
      }),
    ).rejects.toThrow(/expects turn sources/);

    await expect(
      executeDoltRollup({
        store,
        sessionId: "session-a",
        targetLevel: "bindle",
        sourceRecords: [bindle],
      }),
    ).rejects.toThrow(/expects leaf sources/);
  });

  it("rolls turn chunks into a leaf and updates lineage + active lanes", async () => {
    const { store } = createInMemoryStore(() => 2_000);
    const turn1 = upsertTurn({
      store,
      pointer: "turn-1",
      sessionId: "session-a",
      eventTsMs: 100,
      role: "user",
      content: "first user turn",
    });
    const turn2 = upsertTurn({
      store,
      pointer: "turn-2",
      sessionId: "session-a",
      eventTsMs: 200,
      role: "assistant",
      content: "second assistant turn",
    });
    markActive(store, turn1);
    markActive(store, turn2);

    const summarize = vi.fn(
      async (params: DoltSummarizeParams): Promise<DoltSummarizeResult> => ({
        summary: makeSummaryPayload({
          summaryType: "leaf",
          startEpochMs: params.datesCovered.startEpochMs,
          endEpochMs: params.datesCovered.endEpochMs,
          children: params.childPointers,
          body: "leaf summary body",
        }).summary,
        metadata: {
          summary_type: "leaf" as const,
          finalized_at_reset: false,
          prompt_template: "leaf" as const,
          max_output_tokens: 2000,
        },
        modelSelection: {
          provider: "openai",
          modelId: "gpt-5",
        },
      }),
    );

    const result = await executeDoltRollup({
      store,
      sessionId: "session-a",
      targetLevel: "leaf",
      sourceRecords: [turn2, turn1],
      summarize,
    });

    expect(summarize).toHaveBeenCalledTimes(1);
    expect(result.childPointers).toEqual(["turn-1", "turn-2"]);
    expect(result.parentRecord.level).toBe("leaf");

    const children = store.listDirectChildren(result.parentRecord.pointer);
    expect(children.map((edge) => edge.childPointer)).toEqual(["turn-1", "turn-2"]);

    const activeTurns = store.listActiveLane({
      sessionId: "session-a",
      level: "turn",
      activeOnly: true,
    });
    expect(activeTurns).toHaveLength(0);

    const activeLeaves = store.listActiveLane({
      sessionId: "session-a",
      level: "leaf",
      activeOnly: true,
    });
    expect(activeLeaves.map((lane) => lane.pointer)).toEqual([result.parentRecord.pointer]);
  });

  it("rolls leaf chunks into a bindle and keeps path bounded at L2", async () => {
    const { store } = createInMemoryStore(() => 3_000);
    const leaf1 = upsertLeaf({
      store,
      pointer: "leaf-1",
      sessionId: "session-a",
      eventTsMs: 1_000,
      children: ["turn-1", "turn-2"],
      body: "leaf one",
    });
    const leaf2 = upsertLeaf({
      store,
      pointer: "leaf-2",
      sessionId: "session-a",
      eventTsMs: 2_000,
      children: ["turn-3", "turn-4"],
      body: "leaf two",
    });
    markActive(store, leaf1);
    markActive(store, leaf2);

    const summarize = vi.fn(
      async (params: DoltSummarizeParams): Promise<DoltSummarizeResult> => ({
        summary: makeSummaryPayload({
          summaryType: "bindle",
          startEpochMs: params.datesCovered.startEpochMs,
          endEpochMs: params.datesCovered.endEpochMs,
          children: params.childPointers,
          body: "bindle summary body",
        }).summary,
        metadata: {
          summary_type: "bindle" as const,
          finalized_at_reset: false,
          prompt_template: "bindle" as const,
          max_output_tokens: 2000,
        },
        modelSelection: {
          provider: "openai",
          modelId: "gpt-5",
        },
      }),
    );

    const result = await executeDoltRollup({
      store,
      sessionId: "session-a",
      targetLevel: "bindle",
      sourceRecords: [leaf1, leaf2],
      summarize,
    });

    expect(result.parentRecord.level).toBe("bindle");
    expect(
      store.listDirectChildRecords(result.parentRecord.pointer).map((record) => record.pointer),
    ).toEqual(["leaf-1", "leaf-2"]);
    expect(
      store.listActiveLane({ sessionId: "session-a", level: "leaf", activeOnly: true }),
    ).toHaveLength(0);
    expect(
      store
        .listActiveLane({ sessionId: "session-a", level: "bindle", activeOnly: true })
        .map((lane) => lane.pointer),
    ).toEqual([result.parentRecord.pointer]);
  });
});

function upsertTurn(params: {
  store: SqliteDoltStore;
  pointer: string;
  sessionId: string;
  eventTsMs: number;
  role: string;
  content: string;
}): DoltRecord {
  return params.store.upsertRecord({
    pointer: params.pointer,
    sessionId: params.sessionId,
    level: "turn",
    eventTsMs: params.eventTsMs,
    payload: {
      role: params.role,
      content: params.content,
    },
  });
}

function upsertLeaf(params: {
  store: SqliteDoltStore;
  pointer: string;
  sessionId: string;
  eventTsMs: number;
  children: string[];
  body: string;
}): DoltRecord {
  return params.store.upsertRecord({
    pointer: params.pointer,
    sessionId: params.sessionId,
    level: "leaf",
    eventTsMs: params.eventTsMs,
    payload: makeSummaryPayload({
      summaryType: "leaf",
      startEpochMs: params.eventTsMs - 100,
      endEpochMs: params.eventTsMs,
      children: params.children,
      body: params.body,
    }),
  });
}

function markActive(store: SqliteDoltStore, record: DoltRecord): void {
  store.upsertActiveLane({
    sessionId: record.sessionId,
    sessionKey: record.sessionKey,
    level: record.level,
    pointer: record.pointer,
    isActive: true,
    lastEventTsMs: record.eventTsMs,
  });
}
