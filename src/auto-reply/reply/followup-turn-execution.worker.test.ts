import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.sqlite-entry.js";
import * as historyReaders from "../../config/sessions/session-transcript-worker-readers.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  openOpenClawAgentDatabase,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
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
let orderedReads: typeof import("../../config/sessions/session-entry-read-ordered.js");

beforeAll(async () => {
  testState = await createOpenClawTestState({ scenario: "minimal" });
  database = openOpenClawAgentDatabase({ agentId: "main", env: testState.env });
  reads = await vi.importActual("../../config/sessions/session-entry-read-runtime.js");
  orderedReads = await vi.importActual("../../config/sessions/session-entry-read-ordered.js");
});
beforeEach(() => {
  resetFollowupTurnTestState();
  state.withStoreReaderInWorker.mockImplementation(reads.withSessionStoreReaderInWorker);
  state.withOrderedEntriesInWorker.mockImplementation(
    orderedReads.withOrderedSessionEntriesInWorker,
  );
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

it("refuses scanned verbosity rewritten before awaited visibility consumes it", async () => {
  const key = "agent:main:followup-visibility";
  const { turn, entry, handle } = createStoredTurn({ key });
  let rewritten = false;
  const rewriteAfterScan = () => {
    if (!rewritten) {
      rewritten = true;
      writeSessionEntry(database, key, { ...entry, updatedAt: 3 });
    }
  };
  const createReaders = historyReaders.createSessionHistoryWorkerReaders;
  const intercept = vi
    .spyOn(historyReaders, "createSessionHistoryWorkerReaders")
    .mockImplementation((runRequest) => {
      const reader = createReaders(runRequest);
      return {
        ...reader,
        readExactEntries: async (...args) => {
          const result = await reader.readExactEntries(...args);
          rewriteAfterScan();
          return result;
        },
      };
    });
  try {
    await inspectVisibility(turn, async (isActive) => {
      const visible = await isActive();
      expect(rewritten).toBe(true);
      expect(handle.getCurrent()).toEqual(entry);
      expect(visible).toBe(false);
    });
  } finally {
    intercept.mockRestore();
  }
});
