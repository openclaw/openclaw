import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../../memory/sqlite.js";
import { serializeDoltSummaryFrontmatter } from "./contract.js";
import { DoltContextEngine } from "./engine.js";
import type { DoltRollupParams } from "./rollup.js";
import { SqliteDoltStore } from "./store/sqlite-dolt-store.js";
import { estimateDoltTokenCount } from "./store/token-count.js";
import type { DoltStore } from "./store/types.js";

const executeDoltRollupMock = vi.hoisted(() => vi.fn());

vi.mock("./rollup.js", async () => {
  const actual = await vi.importActual<typeof import("./rollup.js")>("./rollup.js");
  return {
    ...actual,
    executeDoltRollup: executeDoltRollupMock,
  };
});

type TestStore = {
  store: SqliteDoltStore;
  db: import("node:sqlite").DatabaseSync;
};

const createdStores: TestStore[] = [];
const createdTempDirs: string[] = [];

function createInMemoryStore(now: () => number = () => Date.now()): TestStore {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(":memory:");
  const store = new SqliteDoltStore({ db, now });
  const created = { store, db };
  createdStores.push(created);
  return created;
}

function setEngineStore(engine: DoltContextEngine, store: DoltStore): void {
  (engine as unknown as { store: DoltStore | null }).store = store;
}

function makeMessage(role: "user" | "assistant", content: string): AgentMessage {
  return { role, content } as unknown as AgentMessage;
}

beforeEach(() => {
  let rollupCounter = 0;
  executeDoltRollupMock.mockReset();
  executeDoltRollupMock.mockImplementation(async (params: DoltRollupParams) => {
    rollupCounter += 1;
    const sourceRecords = [...params.sourceRecords].toSorted(
      (a, b) => a.eventTsMs - b.eventTsMs || a.pointer.localeCompare(b.pointer),
    );
    const first = sourceRecords[0];
    const last = sourceRecords[sourceRecords.length - 1];
    const pointer = `${params.targetLevel}:mock:${rollupCounter}`;
    const summaryType = params.targetLevel === "leaf" ? "leaf" : "bindle";
    const childPointers = sourceRecords.map((record) => record.pointer);
    const summary = [
      serializeDoltSummaryFrontmatter({
        summaryType,
        datesCovered: {
          startEpochMs: first?.eventTsMs ?? Date.now(),
          endEpochMs: last?.eventTsMs ?? Date.now(),
        },
        children: childPointers,
        finalizedAtReset: params.finalizedAtReset === true,
      }),
      "",
      `${summaryType} summary`,
    ].join("\n");

    const parentRecord = params.store.upsertRecord({
      pointer,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      level: params.targetLevel,
      eventTsMs: last?.eventTsMs ?? Date.now(),
      payload: {
        summary,
        metadata: {
          summary_type: summaryType,
          finalized_at_reset: params.finalizedAtReset === true,
          prompt_template: summaryType === "leaf" ? "leaf" : "bindle",
          max_output_tokens: 2000,
        },
        modelSelection: {
          provider: "mock-provider",
          modelId: "mock-model",
        },
        sourcePointers: childPointers,
      },
      finalizedAtReset: params.finalizedAtReset,
    });

    params.store.replaceDirectChildren({
      parentPointer: parentRecord.pointer,
      children: sourceRecords.map((record, index) => ({
        pointer: record.pointer,
        level: record.level,
        index,
      })),
    });
    params.store.upsertActiveLane({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      level: params.targetLevel,
      pointer: parentRecord.pointer,
      isActive: true,
      lastEventTsMs: parentRecord.eventTsMs,
    });
    for (const sourceRecord of sourceRecords) {
      params.store.upsertActiveLane({
        sessionId: params.sessionId,
        sessionKey: sourceRecord.sessionKey,
        level: sourceRecord.level,
        pointer: sourceRecord.pointer,
        isActive: false,
        lastEventTsMs: parentRecord.eventTsMs,
      });
    }

    return {
      parentRecord,
      childPointers,
      mode: params.targetLevel === "leaf" ? "leaf" : "bindle",
      modelSelection: {
        provider: "mock-provider",
        modelId: "mock-model",
      },
    };
  });
});

afterEach(async () => {
  vi.clearAllMocks();
  for (const created of createdStores.splice(0, createdStores.length)) {
    try {
      created.store.close();
    } catch {
      // Ignore repeated closes.
    }
  }
  for (const dir of createdTempDirs.splice(0, createdTempDirs.length)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("DoltContextEngine", () => {
  it("constructs and disposes without errors", async () => {
    const { store } = createInMemoryStore();
    const engine = new DoltContextEngine();
    setEngineStore(engine, store);

    await expect(engine.dispose()).resolves.toBeUndefined();
    await expect(engine.dispose()).resolves.toBeUndefined();
  });

  it("bootstraps turns from session JSONL", async () => {
    const { store } = createInMemoryStore();
    const engine = new DoltContextEngine();
    setEngineStore(engine, store);
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dolt-engine-bootstrap-"));
    createdTempDirs.push(tmpDir);
    const sessionFile = path.join(tmpDir, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: "message",
          id: "msg-1",
          timestamp: 1,
          message: { role: "user", content: "hello from bootstrap" },
        }),
        JSON.stringify({
          type: "message",
          id: "msg-2",
          timestamp: 2,
          message: { role: "assistant", content: "bootstrap reply" },
        }),
      ].join("\n"),
      "utf8",
    );

    const result = await engine.bootstrap({
      sessionId: "session-bootstrap-engine",
      sessionFile,
    });

    expect(result).toEqual({
      bootstrapped: true,
      importedMessages: 2,
    });
    expect(store.countSessionRecords("session-bootstrap-engine")).toBe(2);
  });

  it("ingest writes turn records and active-lane entries", async () => {
    const { store } = createInMemoryStore();
    const engine = new DoltContextEngine();
    setEngineStore(engine, store);

    const result = await engine.ingest({
      sessionId: "session-ingest-engine",
      message: makeMessage("user", "ingest test turn"),
    });

    expect(result).toEqual({ ingested: true });
    const turns = store.listRecordsBySession({
      sessionId: "session-ingest-engine",
      level: "turn",
    });
    expect(turns).toHaveLength(1);
    const firstTurn = turns[0];
    expect(firstTurn).toBeTruthy();
    expect((firstTurn.payload as { role?: string }).role).toBe("user");
    expect((firstTurn.payload as { content?: string }).content).toBe("ingest test turn");
    expect(
      store
        .listActiveLane({
          sessionId: "session-ingest-engine",
          level: "turn",
          activeOnly: true,
        })
        .map((entry) => entry.pointer),
    ).toHaveLength(1);
  });

  it("ingest preserves structured content blocks and counts full payload tokens", async () => {
    const { store } = createInMemoryStore();
    const engine = new DoltContextEngine();
    setEngineStore(engine, store);
    const contentBlocks = [
      { type: "text", text: "Twas brillig, and the slithy toves" },
      { type: "text", text: "Did gyre and gimble in the wabe;" },
    ];

    await engine.ingest({
      sessionId: "session-ingest-structured-content",
      message: { role: "assistant", content: contentBlocks } as AgentMessage,
    });

    const [turn] = store.listRecordsBySession({
      sessionId: "session-ingest-structured-content",
      level: "turn",
    });
    expect(turn).toBeTruthy();
    const payload = turn?.payload as { role?: string; content?: unknown };
    expect(payload.role).toBe("assistant");
    expect(payload.content).toEqual(contentBlocks);

    const estimatedFull = estimateDoltTokenCount({ payload });
    const estimatedFirstBlockOnly = estimateDoltTokenCount({
      payload: {
        role: "assistant",
        content: [contentBlocks[0]],
      },
    });
    expect(turn?.tokenCount).toBe(estimatedFull.tokenCount);
    expect(turn?.tokenCount).toBeGreaterThan(estimatedFirstBlockOnly.tokenCount);
  });

  it("afterTurn ingests new turns and compacts when lane pressure exceeds threshold", async () => {
    const { store } = createInMemoryStore();
    const engine = new DoltContextEngine();
    setEngineStore(engine, store);
    const sessionId = "session-after-turn-engine";
    const messages: AgentMessage[] = Array.from({ length: 8 }, (_, idx) => {
      const role = idx % 2 === 0 ? "user" : "assistant";
      return makeMessage(role, `turn-${idx}-${"x".repeat(30_000)}`);
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: "/tmp/unused.jsonl",
      messages,
      prePromptMessageCount: 0,
    });

    expect(executeDoltRollupMock).toHaveBeenCalled();
    expect(executeDoltRollupMock.mock.calls[0]?.[0]?.targetLevel).toBe("leaf");
    expect(
      store.listRecordsBySession({
        sessionId,
        level: "leaf",
      }).length,
    ).toBeGreaterThan(0);
  });

  it("assemble returns bounded context with one message per selected record", async () => {
    const { store } = createInMemoryStore();
    const engine = new DoltContextEngine();
    setEngineStore(engine, store);
    const sessionId = "session-assemble-engine";

    await engine.ingestBatch({
      sessionId,
      messages: [
        makeMessage("user", "first assembled record"),
        makeMessage("assistant", "second assembled record"),
      ],
    });

    const assembled = await engine.assemble({
      sessionId,
      messages: [makeMessage("user", "fallback message")],
      tokenBudget: 50_000,
    });

    expect(assembled.messages).toHaveLength(2);
    expect((assembled.messages[0] as { content?: string }).content).toBe("first assembled record");
    expect((assembled.messages[1] as { content?: string }).content).toBe("second assembled record");
    expect(assembled.estimatedTokens).toBeGreaterThan(0);
  });

  it("assemble falls through when no session records are persisted", async () => {
    const { store } = createInMemoryStore();
    const engine = new DoltContextEngine();
    setEngineStore(engine, store);
    const messages = [makeMessage("user", "raw fallback context")];

    const assembled = await engine.assemble({
      sessionId: "session-empty-engine",
      messages,
      tokenBudget: 10_000,
    });

    expect(assembled.messages).toBe(messages);
    expect(assembled.estimatedTokens).toBe(0);
  });
});
