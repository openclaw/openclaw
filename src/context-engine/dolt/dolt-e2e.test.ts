import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { requireNodeSqlite } from "../../memory/sqlite.js";
import { runBeforeSessionResetLifecycle } from "../before-session-reset.js";
import { registerLegacyContextEngine } from "../legacy.js";
import { registerContextEngine, resolveContextEngine } from "../registry.js";
import { hydrateDoltBootstrapState } from "./bootstrap.js";
import {
  parseDoltSummaryDocument,
  serializeDoltSummaryFrontmatter,
  validateDoltChildrenChronologicalOrder,
  validateDoltLineageEdgeLevels,
} from "./contract.js";
import { registerDoltContextEngine } from "./engine.js";
import { enforceDoltBindleOldestFirstEviction } from "./eviction.js";
import { evaluateDoltLanePressure, type DoltLanePolicy } from "./policy.js";
import { finalizeDoltReset } from "./reset-finalization.js";
import { SqliteDoltStore } from "./store/sqlite-dolt-store.js";
import type { DoltRecord } from "./store/types.js";
import type { DoltSummarizeParams, DoltSummarizeResult } from "./summarizer.js";

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

afterEach(() => {
  for (const created of createdStores.splice(0, createdStores.length)) {
    created.store.close();
  }
});

describe("dolt e2e regression gate", () => {
  it("bootstraps storage primitives from an empty sqlite store", () => {
    const { store } = createInMemoryStore(() => 1_000);
    const sessionId = "session-bootstrap-store";

    const turn1 = upsertTurn({
      store,
      sessionId,
      pointer: "turn-store-1",
      eventTsMs: 100,
      content: "store turn 1",
    });
    const turn2 = upsertTurn({
      store,
      sessionId,
      pointer: "turn-store-2",
      eventTsMs: 200,
      content: "store turn 2",
    });
    const leaf = upsertSummary({
      store,
      sessionId,
      pointer: "leaf-store-1",
      level: "leaf",
      eventTsMs: 250,
      children: [turn1.pointer, turn2.pointer],
      body: "leaf store body",
    });

    markActive(store, turn1);
    markActive(store, turn2);
    store.replaceDirectChildren({
      parentPointer: leaf.pointer,
      children: [
        { pointer: turn1.pointer, level: "turn", index: 0 },
        { pointer: turn2.pointer, level: "turn", index: 1 },
      ],
    });

    const records = store.listRecordsBySession({ sessionId });
    expect(records.map((record) => record.pointer)).toEqual([
      "turn-store-1",
      "turn-store-2",
      "leaf-store-1",
    ]);

    expect(store.listDirectChildren(leaf.pointer).map((edge) => edge.childPointer)).toEqual([
      "turn-store-1",
      "turn-store-2",
    ]);
    expect(
      store
        .listActiveLane({ sessionId, level: "turn", activeOnly: true })
        .map((entry) => entry.pointer),
    ).toEqual(["turn-store-2", "turn-store-1"]);

    store.deactivateLevelPointers({
      sessionId,
      level: "turn",
      exceptPointer: turn2.pointer,
    });

    expect(
      store
        .listActiveLane({ sessionId, level: "turn", activeOnly: true })
        .map((entry) => entry.pointer),
    ).toEqual(["turn-store-2"]);
  });

  it("keeps token accounting deterministic and drives lane pressure math", () => {
    const { store } = createInMemoryStore(() => 2_000);
    const sessionId = "session-token-determinism";
    const payload = {
      role: "user",
      content: "deterministic token payload",
      metadata: { a: 1, b: "same" },
    };

    const turnA = store.upsertRecord({
      pointer: "turn-token-a",
      sessionId,
      level: "turn",
      eventTsMs: 100,
      payload,
    });
    const turnB = store.upsertRecord({
      pointer: "turn-token-b",
      sessionId,
      level: "turn",
      eventTsMs: 200,
      payload,
    });

    expect(turnA.tokenCount).toBeGreaterThan(0);
    expect(turnA.tokenCount).toBe(turnB.tokenCount);
    expect(turnA.tokenCountMethod).toBe(turnB.tokenCountMethod);

    const laneTokenCount = turnA.tokenCount + turnB.tokenCount;
    const decision = evaluateDoltLanePressure({
      laneTokenCount,
      policy: {
        soft: laneTokenCount - 1,
        delta: 0,
        target: turnA.tokenCount,
      },
    });

    expect(decision.shouldCompact).toBe(true);
    expect(decision.trigger).toBe("soft_delta");
    expect(decision.pressureDelta).toBe(turnB.tokenCount);
  });

  it("enforces lane-pressure hysteresis transitions including hard-limit bypass", () => {
    const policy: DoltLanePolicy = {
      soft: 100,
      delta: 10,
      target: 80,
    };

    const below = evaluateDoltLanePressure({
      laneTokenCount: 79,
      policy,
    });
    const atSoftPlusDelta = evaluateDoltLanePressure({
      laneTokenCount: 110,
      policy,
    });
    const overSoftPlusDelta = evaluateDoltLanePressure({
      laneTokenCount: 111,
      policy,
    });
    const drainMode = evaluateDoltLanePressure({
      laneTokenCount: 81,
      policy,
      drainMode: true,
    });
    const hardLimit = evaluateDoltLanePressure({
      laneTokenCount: 81,
      policy,
      hardLimitSafetyMode: true,
    });

    expect(below.trigger).toBe("none");
    expect(below.nextDrainMode).toBe(false);

    expect(atSoftPlusDelta.trigger).toBe("none");
    expect(atSoftPlusDelta.nextDrainMode).toBe(false);

    expect(overSoftPlusDelta.trigger).toBe("soft_delta");
    expect(overSoftPlusDelta.nextDrainMode).toBe(true);

    expect(drainMode.trigger).toBe("drain");
    expect(drainMode.nextDrainMode).toBe(true);

    expect(hardLimit.trigger).toBe("hard_limit_bypass");
    expect(hardLimit.nextDrainMode).toBe(true);
  });

  it("enforces strict lineage level containment and chronological children", () => {
    expect(() =>
      validateDoltLineageEdgeLevels({
        parentLevel: "bindle",
        childLevel: "leaf",
        parentPointer: "bindle-1",
        childPointer: "leaf-1",
      }),
    ).not.toThrow();

    expect(() =>
      validateDoltLineageEdgeLevels({
        parentLevel: "leaf",
        childLevel: "turn",
        parentPointer: "leaf-1",
        childPointer: "turn-1",
      }),
    ).not.toThrow();

    expect(() =>
      validateDoltLineageEdgeLevels({
        parentLevel: "turn",
        childLevel: "turn",
        parentPointer: "turn-parent",
        childPointer: "turn-child",
      }),
    ).toThrow(/cannot have children/);

    expect(() =>
      validateDoltLineageEdgeLevels({
        parentLevel: "bindle",
        childLevel: "turn",
        parentPointer: "bindle-2",
        childPointer: "turn-2",
      }),
    ).toThrow(/can only reference leaf children/);

    expect(() =>
      validateDoltChildrenChronologicalOrder({
        parentPointer: "leaf-ordered",
        children: [
          { pointer: "turn-a", eventTsMs: 1_000 },
          { pointer: "turn-b", eventTsMs: 2_000 },
        ],
      }),
    ).not.toThrow();

    expect(() =>
      validateDoltChildrenChronologicalOrder({
        parentPointer: "leaf-broken-order",
        children: [
          { pointer: "turn-newer", eventTsMs: 2_000 },
          { pointer: "turn-older", eventTsMs: 1_000 },
        ],
      }),
    ).toThrow(/must be chronological/);
  });

  it("round-trips Dolt front-matter with parseable body and finalized-at-reset", () => {
    const frontmatter = {
      summaryType: "bindle" as const,
      datesCovered: {
        startEpochMs: 1_111,
        endEpochMs: 2_222,
      },
      children: ["leaf-1", "leaf-2"],
      finalizedAtReset: true,
    };

    const serialized = serializeDoltSummaryFrontmatter(frontmatter);
    const summary = `${serialized}\nThis is the summary body.`;
    const parsed = parseDoltSummaryDocument(summary);

    expect(parsed.frontmatter).toEqual(frontmatter);
    expect(parsed.frontmatter.datesCovered.startEpochMs).toBe(1_111);
    expect(parsed.frontmatter.datesCovered.endEpochMs).toBe(2_222);
    expect(parsed.frontmatter.finalizedAtReset).toBe(true);
    expect(parsed.body).toBe("This is the summary body.");
  });

  it("runs reset finalization in ordered 5-step sequence and leaves no active turns/leaves", async () => {
    const { store } = createInMemoryStore(() => 10_000);
    const sessionId = "session-reset-sequence";

    for (let index = 0; index < 4; index += 1) {
      const turn = upsertTurn({
        store,
        sessionId,
        pointer: `turn-reset-${index + 1}`,
        eventTsMs: (index + 1) * 100,
        content: `reset-turn-${index + 1}-${"x".repeat(20_000)}`,
      });
      markActive(store, turn);
    }

    const priorLeaf = upsertSummary({
      store,
      sessionId,
      pointer: "leaf-reset-prior",
      level: "leaf",
      eventTsMs: 450,
      children: ["turn-old-a", "turn-old-b"],
      body: "prior leaf body",
    });
    markActive(store, priorLeaf);

    const summarize = buildSummarizeStub();
    const result = await finalizeDoltReset({
      store,
      sessionId,
      summarize,
      ingestMissingTail: () => {
        const tail = upsertTurn({
          store,
          sessionId,
          pointer: "turn-reset-tail",
          eventTsMs: 550,
          content: `reset-tail-${"y".repeat(20_000)}`,
        });
        markActive(store, tail);
        return 1;
      },
    });

    expect(result.ingestedTailCount).toBe(1);
    expect(result.turnToLeafRollups).toBe(1);
    expect(result.leafToBindleRollups).toBe(1);
    expect(result.shortBindleCreated).toBe(true);
    expect(result.activeAfterFinalize.turns).toEqual([]);
    expect(result.activeAfterFinalize.leaves).toEqual([]);
    expect(result.activeAfterFinalize.bindles.length).toBeGreaterThan(0);

    const shortBindle = store.getRecord(result.shortBindlePointer ?? "");
    expect(shortBindle?.level).toBe("bindle");
    expect(shortBindle?.finalizedAtReset).toBe(true);

    const payload = shortBindle?.payload as { summary?: string } | null;
    const parsed = parseDoltSummaryDocument(payload?.summary ?? "");
    expect(parsed.frontmatter.finalizedAtReset).toBe(true);
  });

  it("hydrates bootstrap state by recency and returns oldest-first order within each level", () => {
    const { store } = createInMemoryStore(() => 20_000);
    const sessionId = "session-bootstrap-recency";

    const bindles = [1, 2, 3].map((index) =>
      upsertSummary({
        store,
        sessionId,
        pointer: `bindle-bootstrap-${index}`,
        level: "bindle",
        eventTsMs: index * 100,
        children: [`leaf-bootstrap-${index}`],
        body: `bindle bootstrap ${index} ${"b".repeat(index * 50)}`,
      }),
    );
    const leaves = [1, 2, 3].map((index) =>
      upsertSummary({
        store,
        sessionId,
        pointer: `leaf-bootstrap-${index}`,
        level: "leaf",
        eventTsMs: index * 100,
        children: [`turn-bootstrap-${index}`],
        body: `leaf bootstrap ${index} ${"l".repeat(index * 50)}`,
      }),
    );
    const turns = [1, 2, 3].map((index) =>
      upsertTurn({
        store,
        sessionId,
        pointer: `turn-bootstrap-${index}`,
        eventTsMs: index * 100,
        content: `turn bootstrap ${index} ${"t".repeat(index * 80)}`,
      }),
    );

    const bindleBudget = bindles[2].tokenCount + bindles[1].tokenCount;
    const leafBudget = leaves[2].tokenCount + leaves[1].tokenCount;
    const turnBudget = turns[2].tokenCount + turns[1].tokenCount;

    const result = hydrateDoltBootstrapState({
      store,
      sessionId,
      tokenBudget: bindleBudget + leafBudget + turnBudget,
      runtimeReserveTokens: 0,
      lanePolicies: {
        bindle: {
          soft: Math.max(1, bindleBudget),
          delta: 0,
          target: Math.max(1, bindleBudget),
          summaryCap: Math.max(1, bindleBudget),
        },
        leaf: {
          soft: Math.max(1, leafBudget),
          delta: 0,
          target: Math.max(1, leafBudget),
          summaryCap: Math.max(1, leafBudget),
        },
        turn: {
          soft: Math.max(1, turnBudget),
          delta: 0,
          target: Math.max(1, turnBudget),
        },
      },
    });

    expect(result.hydrated).toBe(true);

    expect(result.activatedPointers.bindle).toEqual(["bindle-bootstrap-2", "bindle-bootstrap-3"]);
    expect(result.activatedPointers.leaf).toEqual(["leaf-bootstrap-2", "leaf-bootstrap-3"]);
    expect(result.activatedPointers.turn).toEqual(["turn-bootstrap-2", "turn-bootstrap-3"]);

    expect(result.assembly.selectedRecords.bindle.map((record) => record.pointer)).toEqual([
      "bindle-bootstrap-2",
      "bindle-bootstrap-3",
    ]);
    expect(result.assembly.selectedRecords.leaf.map((record) => record.pointer)).toEqual([
      "leaf-bootstrap-2",
      "leaf-bootstrap-3",
    ]);
    expect(result.assembly.selectedRecords.turn.map((record) => record.pointer)).toEqual([
      "turn-bootstrap-2",
      "turn-bootstrap-3",
    ]);
  });

  it("evicts bindles oldest-first one at a time until target is met", () => {
    const { store } = createInMemoryStore(() => 30_000);
    const sessionId = "session-eviction";

    const bindle1 = upsertSummary({
      store,
      sessionId,
      pointer: "bindle-evict-1",
      level: "bindle",
      eventTsMs: 100,
      children: ["leaf-evict-1"],
      body: `bindle 1 ${"x".repeat(600)}`,
    });
    const bindle2 = upsertSummary({
      store,
      sessionId,
      pointer: "bindle-evict-2",
      level: "bindle",
      eventTsMs: 200,
      children: ["leaf-evict-2"],
      body: `bindle 2 ${"x".repeat(600)}`,
    });
    const bindle3 = upsertSummary({
      store,
      sessionId,
      pointer: "bindle-evict-3",
      level: "bindle",
      eventTsMs: 300,
      children: ["leaf-evict-3"],
      body: `bindle 3 ${"x".repeat(600)}`,
    });
    const bindle4 = upsertSummary({
      store,
      sessionId,
      pointer: "bindle-evict-4",
      level: "bindle",
      eventTsMs: 400,
      children: ["leaf-evict-4"],
      body: `bindle 4 ${"x".repeat(600)}`,
    });

    markActive(store, bindle1);
    markActive(store, bindle2);
    markActive(store, bindle3);
    markActive(store, bindle4);

    const result = enforceDoltBindleOldestFirstEviction({
      store,
      sessionId,
      targetTokens: bindle4.tokenCount + bindle3.tokenCount,
    });

    expect(result.evictedPointers).toEqual(["bindle-evict-1", "bindle-evict-2"]);
    expect(result.activePointers).toEqual(["bindle-evict-4", "bindle-evict-3"]);
    expect(result.telemetry.steps).toHaveLength(2);
    expect(result.telemetry.steps[0]?.evictedPointer).toBe("bindle-evict-1");
    expect(result.telemetry.steps[1]?.evictedPointer).toBe("bindle-evict-2");
  });

  it("resolves the dolt runtime engine path instead of silently using legacy", async () => {
    registerLegacyContextEngine();
    registerDoltContextEngine();

    const doltConfig = {
      plugins: {
        slots: {
          contextEngine: "dolt",
        },
      },
    } as OpenClawConfig;

    const doltEngine = await resolveContextEngine(doltConfig);
    expect(doltEngine.info.id).toBe("dolt");
    expect(doltEngine.info.ownsCompaction).toBe(true);

    const defaultEngine = await resolveContextEngine();
    expect(defaultEngine.info.id).toBe("legacy");

    await doltEngine.dispose?.();
    await defaultEngine.dispose?.();
  });

  it("routes session reset through the shared before-session-reset utility", async () => {
    const beforeSessionReset = vi.fn(async () => {});
    const dispose = vi.fn(async () => {});
    const engineId = `e2e-reset-engine-${Date.now()}`;

    registerContextEngine(engineId, () => ({
      info: {
        id: engineId,
        name: "Reset E2E Engine",
      },
      async ingest() {
        return { ingested: false };
      },
      async assemble({ messages }) {
        return { messages, estimatedTokens: 0 };
      },
      async compact() {
        return { ok: true, compacted: false };
      },
      async beforeSessionReset(params) {
        await beforeSessionReset(params);
      },
      async dispose() {
        await dispose();
      },
    }));

    const cfg = {
      plugins: {
        slots: {
          contextEngine: engineId,
        },
      },
    } as OpenClawConfig;

    await runBeforeSessionResetLifecycle({
      cfg,
      sessionId: "session-reset-lifecycle",
      sessionKey: "agent:main:main",
      sessionFile: "/tmp/session-reset-lifecycle.jsonl",
      reason: "reset",
    });

    expect(beforeSessionReset).toHaveBeenCalledWith({
      sessionId: "session-reset-lifecycle",
      sessionKey: "agent:main:main",
      sessionFile: "/tmp/session-reset-lifecycle.jsonl",
      reason: "reset",
    });
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

function buildSummarizeStub() {
  return vi.fn(async (params: DoltSummarizeParams): Promise<DoltSummarizeResult> => {
    const summaryType = params.mode === "leaf" ? "leaf" : "bindle";
    const finalizedAtReset = params.mode === "reset-short-bindle";
    const summary = makeSummaryText({
      summaryType,
      startEpochMs: params.datesCovered.startEpochMs,
      endEpochMs: params.datesCovered.endEpochMs,
      children: params.childPointers,
      finalizedAtReset,
      body: `summary for ${params.mode}`,
    });
    return {
      summary,
      metadata: {
        summary_type: summaryType,
        finalized_at_reset: finalizedAtReset,
        prompt_template: params.mode,
        max_output_tokens: 2_000,
      },
      modelSelection: {
        provider: "openai",
        modelId: "gpt-5",
      },
    };
  });
}

function makeSummaryText(params: {
  summaryType: "leaf" | "bindle";
  startEpochMs: number;
  endEpochMs: number;
  children: string[];
  body: string;
  finalizedAtReset?: boolean;
}): string {
  const frontmatter = serializeDoltSummaryFrontmatter({
    summaryType: params.summaryType,
    datesCovered: {
      startEpochMs: params.startEpochMs,
      endEpochMs: params.endEpochMs,
    },
    children: params.children,
    finalizedAtReset: params.finalizedAtReset === true,
  });
  return `${frontmatter}\n${params.body}`;
}

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
  children: string[];
  body: string;
  finalizedAtReset?: boolean;
}): DoltRecord {
  return params.store.upsertRecord({
    pointer: params.pointer,
    sessionId: params.sessionId,
    level: params.level,
    eventTsMs: params.eventTsMs,
    payload: {
      summary: makeSummaryText({
        summaryType: params.level,
        startEpochMs: params.eventTsMs - 50,
        endEpochMs: params.eventTsMs,
        children: params.children,
        finalizedAtReset: params.finalizedAtReset,
        body: params.body,
      }),
    },
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
