import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.sqlite-entry.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  openOpenClawAgentDatabase,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";
import {
  createFollowupTurnTestTypingController,
  createFollowupTurnTestTurn,
  executeFollowupTurnForTest,
  getFollowupTurnTestState,
  resetFollowupTurnTestState,
} from "./followup-turn-execution.test-support.js";
import { createReplySessionEntryHandle } from "./session-entry-handle.js";

const state = getFollowupTurnTestState();
let testState: OpenClawTestState;
let database: ReturnType<typeof openOpenClawAgentDatabase>;
let reads: typeof import("../../config/sessions/session-entry-read-runtime.js");

beforeAll(async () => {
  testState = await createOpenClawTestState({ scenario: "minimal" });
  database = openOpenClawAgentDatabase({ agentId: "main", env: testState.env });
  reads = await vi.importActual("../../config/sessions/session-entry-read-runtime.js");
});
beforeEach(() => {
  resetFollowupTurnTestState();
  state.withEntryReader.mockImplementation(reads.withSessionEntryReadOnlyInWorker);
  state.loadEntryReadOnly.mockImplementation(loadSessionEntryReadOnly);
});
afterAll(async () => testState.cleanup());

function createStoredTurn(params: {
  key: string;
  storedKey?: string;
  database?: typeof database;
  incognito?: true;
}) {
  const selectedDatabase = params.database ?? database;
  const entry: SessionEntry = {
    sessionId: "session",
    lifecycleRevision: "owned",
    updatedAt: 1,
    verboseLevel: "off",
    ...(params.incognito ? { incognito: true } : {}),
  };
  writeSessionEntry(selectedDatabase, params.storedKey ?? params.key, {
    ...entry,
    updatedAt: 2,
    verboseLevel: "full",
  });
  const handle = createReplySessionEntryHandle({
    sessionKey: params.key,
    sessionEntry: entry,
    generationFence: { sessionId: entry.sessionId },
  });
  const turn = createFollowupTurnTestTurn({
    session: {
      kind: "session",
      key: params.key,
      storePath: selectedDatabase.path,
      current: () => handle.getCurrent(),
      publish: (next) => next && handle.replaceCurrent(next),
      adopt: (next) => handle.adoptCurrent(next),
    },
  });
  turn.queued.run.agentId = selectedDatabase.agentId;
  turn.queued.run.sessionKey = params.key;
  return { turn, entry, handle };
}

function inspectVisibility(
  turn: ReturnType<typeof createStoredTurn>["turn"],
  inspect: (isActive: () => Promise<boolean>) => Promise<void>,
) {
  return executeFollowupTurnForTest({
    turn,
    defaults: {
      typing: createFollowupTurnTestTypingController(),
      typingMode: "never",
      defaultModel: "claude",
      opts: { onVerboseProgressVisibilityAsync: inspect },
    },
    onToolResult: vi.fn(async () => {}),
    onCompactionNoticePayload: vi.fn(async () => {}),
  });
}

it("qualifies unqualified visibility keys using the selected shared-store owner", async () => {
  const shared = openOpenClawAgentDatabase({
    agentId: "store-owner",
    path: testState.path("shared.sqlite"),
    env: testState.env,
  });
  const key = "followup-visibility";
  const { turn } = createStoredTurn({
    key,
    storedKey: "agent:store-owner:followup-visibility",
    database: shared,
  });
  turn.queued.run.agentId = "queued-agent";
  await inspectVisibility(turn, async (isActive) => {
    expect(await isActive()).toBe(true);
  });
});

it("refreshes incognito visibility from its process-held session", async () => {
  const native = openOpenClawAgentDatabase({
    agentId: "main",
    path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: testState.env }),
    env: testState.env,
  });
  const key = "agent:main:incognito:visibility";
  const { turn, entry } = createStoredTurn({ key, database: native, incognito: true });
  await inspectVisibility(turn, async (isActive) => {
    expect(await isActive()).toBe(true);
    writeSessionEntry(native, key, { ...entry, updatedAt: 3 });
    expect(await isActive()).toBe(false);
  });
});

it("updates synchronous tool gates from committed preferences without main-thread reads", async () => {
  const key = "agent:main:followup-visibility";
  const { turn, entry } = createStoredTurn({ key });
  state.execute.mockImplementation(async (params: AgentTurnParams) => {
    for (const level of ["off", "full"] as const) {
      writeSessionEntry(database, key, { ...entry, updatedAt: 3, verboseLevel: level });
      const sql = observeHostDataSql();
      try {
        expect(params.shouldEmitToolResult()).toBe(level === "full");
        expect(params.shouldEmitToolOutput()).toBe(level === "full");
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
      }
    }
    return { runId: "run-1", outcome: { kind: "rejected", payload: { text: "done" } } };
  });
  await inspectVisibility(turn, async (isActive) => {
    expect(await isActive()).toBe(true);
  });
});
