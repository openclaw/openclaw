import { afterEach, describe, expect, it } from "vitest";
import type { DoltRecord } from "./store/types.js";
import { requireNodeSqlite } from "../../memory/sqlite.js";
import { assembleDoltContext } from "./assembly.js";
import { serializeDoltSummaryFrontmatter } from "./contract.js";
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

describe("assembleDoltContext", () => {
  it("applies lane budgets, keeps recency within lanes, and emits bucket order", () => {
    const { store } = createInMemoryStore(() => 1_000);
    const bindle1 = upsertSummary({
      store,
      sessionId: "session-a",
      pointer: "bindle-1",
      level: "bindle",
      eventTsMs: 100,
      body: "bindle body one",
      children: ["leaf-1"],
    });
    const bindle2 = upsertSummary({
      store,
      sessionId: "session-a",
      pointer: "bindle-2",
      level: "bindle",
      eventTsMs: 200,
      body: "bindle body two",
      children: ["leaf-2"],
    });
    const leaf1 = upsertSummary({
      store,
      sessionId: "session-a",
      pointer: "leaf-1",
      level: "leaf",
      eventTsMs: 300,
      body: "leaf body one",
      children: ["turn-1"],
    });
    const leaf2 = upsertSummary({
      store,
      sessionId: "session-a",
      pointer: "leaf-2",
      level: "leaf",
      eventTsMs: 400,
      body: "leaf body two",
      children: ["turn-2"],
    });
    const turn1 = upsertTurn({
      store,
      sessionId: "session-a",
      pointer: "turn-1",
      eventTsMs: 500,
      content: "turn body one",
    });
    const turn2 = upsertTurn({
      store,
      sessionId: "session-a",
      pointer: "turn-2",
      eventTsMs: 600,
      content: "turn body two",
    });
    const turn3 = upsertTurn({
      store,
      sessionId: "session-a",
      pointer: "turn-3",
      eventTsMs: 700,
      content: "turn body three",
    });

    for (const record of [bindle1, bindle2, leaf1, leaf2, turn1, turn2, turn3]) {
      markActive(store, record);
    }

    const result = assembleDoltContext({
      store,
      sessionId: "session-a",
      tokenBudget: 50_000,
      lanePolicyOverrides: {
        bindle: {
          target: 50_000,
          soft: 50_000,
          delta: 0,
          summaryCap: bindle2.tokenCount + 1,
        },
        leaf: {
          target: 50_000,
          soft: 50_000,
          delta: 0,
          summaryCap: leaf2.tokenCount + 1,
        },
        turn: {
          target: turn2.tokenCount + turn3.tokenCount + 1,
          soft: turn2.tokenCount + turn3.tokenCount + 1,
          delta: 0,
        },
      },
    });

    expect(result.selectedRecords.bindle.map((record) => record.pointer)).toEqual(["bindle-2"]);
    expect(result.selectedRecords.leaf.map((record) => record.pointer)).toEqual(["leaf-2"]);
    expect(result.selectedRecords.turn.map((record) => record.pointer)).toEqual([
      "turn-2",
      "turn-3",
    ]);
    expect(result.messages).toHaveLength(4);

    const rendered = result.messages.map((message) => stringifyMessageContent(message.content));
    expect(rendered[0]).toContain("bindle body two");
    expect(rendered[1]).toContain("leaf body two");
    expect(rendered[2]).toContain("turn body two");
    expect(rendered[3]).toContain("turn body three");

    const selectedTokenCount = [
      ...result.selectedRecords.bindle,
      ...result.selectedRecords.leaf,
      ...result.selectedRecords.turn,
    ].reduce((sum, record) => sum + record.tokenCount, 0);
    expect(result.estimatedTokens).toBe(selectedTokenCount);
  });

  it("drops older summaries first when lane budget cannot fit all active summaries", () => {
    const { store } = createInMemoryStore(() => 2_000);
    const leaf1 = upsertSummary({
      store,
      sessionId: "session-a",
      pointer: "leaf-1",
      level: "leaf",
      eventTsMs: 100,
      body: "leaf oldest",
      children: ["turn-1"],
    });
    const leaf2 = upsertSummary({
      store,
      sessionId: "session-a",
      pointer: "leaf-2",
      level: "leaf",
      eventTsMs: 200,
      body: "leaf middle",
      children: ["turn-2"],
    });
    const leaf3 = upsertSummary({
      store,
      sessionId: "session-a",
      pointer: "leaf-3",
      level: "leaf",
      eventTsMs: 300,
      body: "leaf newest",
      children: ["turn-3"],
    });
    for (const leaf of [leaf1, leaf2, leaf3]) {
      markActive(store, leaf);
    }

    const result = assembleDoltContext({
      store,
      sessionId: "session-a",
      tokenBudget: 50_000,
      lanePolicyOverrides: {
        bindle: { target: 0, soft: 0, delta: 0, summaryCap: 0 },
        leaf: {
          target: 50_000,
          soft: 50_000,
          delta: 0,
          summaryCap: leaf2.tokenCount + leaf3.tokenCount + 1,
        },
        turn: { target: 0, soft: 0, delta: 0 },
      },
    });

    expect(result.selectedRecords.leaf.map((record) => record.pointer)).toEqual([
      "leaf-2",
      "leaf-3",
    ]);
    expect(result.selectedRecords.bindle).toHaveLength(0);
    expect(result.selectedRecords.turn).toHaveLength(0);
  });

  it("reserves runtime budget before lane allocation", () => {
    const { store } = createInMemoryStore(() => 3_000);
    const turn1 = upsertTurn({
      store,
      sessionId: "session-a",
      pointer: "turn-1",
      eventTsMs: 100,
      content: "tail one",
    });
    const turn2 = upsertTurn({
      store,
      sessionId: "session-a",
      pointer: "turn-2",
      eventTsMs: 200,
      content: "tail two",
    });
    markActive(store, turn1);
    markActive(store, turn2);

    const result = assembleDoltContext({
      store,
      sessionId: "session-a",
      tokenBudget: turn2.tokenCount + 2,
      runtimeReserveTokens: turn2.tokenCount + 2,
      lanePolicyOverrides: {
        bindle: { target: 0, soft: 0, delta: 0, summaryCap: 0 },
        leaf: { target: 0, soft: 0, delta: 0, summaryCap: 0 },
        turn: { target: 50_000, soft: 50_000, delta: 0 },
      },
    });

    expect(result.budget.availableTokens).toBe(0);
    expect(result.messages).toHaveLength(0);
  });
});

function upsertTurn(params: {
  store: SqliteDoltStore;
  sessionId: string;
  pointer: string;
  eventTsMs: number;
  content: string;
}): DoltRecord {
  return params.store.upsertRecord({
    pointer: params.pointer,
    sessionId: params.sessionId,
    level: "turn",
    eventTsMs: params.eventTsMs,
    payload: {
      role: "user",
      content: params.content,
    },
  });
}

function upsertSummary(params: {
  store: SqliteDoltStore;
  sessionId: string;
  pointer: string;
  level: "leaf" | "bindle";
  eventTsMs: number;
  body: string;
  children: string[];
}): DoltRecord {
  return params.store.upsertRecord({
    pointer: params.pointer,
    sessionId: params.sessionId,
    level: params.level,
    eventTsMs: params.eventTsMs,
    payload: makeSummaryPayload({
      summaryType: params.level,
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

function stringifyMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const parts = content.map((entry) => {
      if (!entry || typeof entry !== "object") {
        return "";
      }
      const text = (entry as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    });
    const joined = parts.join("");
    if (joined) {
      return joined;
    }
  }
  return JSON.stringify(content);
}
