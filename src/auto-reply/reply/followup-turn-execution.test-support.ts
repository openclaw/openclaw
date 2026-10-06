import { vi } from "vitest";
import type { withOrderedSessionEntriesInWorker } from "../../config/sessions/session-entry-read-ordered.js";
import type { withSessionStoreReaderInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { createSessionHistoryWorkerReaders } from "../../config/sessions/session-transcript-worker-readers.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { AdmittedFollowupTurn } from "./followup-turn-admission.js";
import { createMockReplyOperation } from "./test-helpers.js";

const followupTurnTestState = vi.hoisted(() => ({
  execute: vi.fn(),
  loadEntryReadOnly: vi.fn(),
  readEntry: vi.fn<() => Promise<SessionEntry | undefined>>(),
  withStoreReaderInWorker: vi.fn<typeof withSessionStoreReaderInWorker>(),
  withOrderedEntriesInWorker: vi.fn<typeof withOrderedSessionEntriesInWorker>(),
}));

vi.mock("./agent-runner-execution.js", () => ({
  executeAgentTurn: (...args: unknown[]) => followupTurnTestState.execute(...args),
}));

vi.mock("../../config/sessions/session-accessor.js", async () => {
  const { bindSessionPendingInputSources } =
    await import("../../config/sessions/session-accessor.pending-inputs.js");
  const { loadSessionEntry, replaceSessionEntry } =
    await import("../../config/sessions/session-accessor.sqlite-entry.js");
  return {
    bindSessionPendingInputSources,
    loadSessionEntry,
    replaceSessionEntry,
    loadSessionEntryReadOnly: (...args: unknown[]) =>
      followupTurnTestState.loadEntryReadOnly(...args),
  };
});

vi.mock("../../config/sessions/session-entry-read-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/session-entry-read-runtime.js")>()),
  withSessionStoreReaderInWorker: followupTurnTestState.withStoreReaderInWorker,
}));

vi.mock("../../config/sessions/session-entry-read-ordered.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/session-entry-read-ordered.js")>()),
  withOrderedSessionEntriesInWorker: followupTurnTestState.withOrderedEntriesInWorker,
}));

const { executeFollowupTurn } = await import("./followup-turn-execution.js");

export const executeFollowupTurnForTest = executeFollowupTurn;

export function getFollowupTurnTestState() {
  return followupTurnTestState;
}

export function createFollowupTurnTestTypingController() {
  return {
    onReplyStart: vi.fn(async () => {}),
    startTypingLoop: vi.fn(async () => {}),
    startTypingOnText: vi.fn(async () => {}),
    refreshTypingTtl: vi.fn(),
    isActive: vi.fn(() => false),
    markRunComplete: vi.fn(),
    markDispatchIdle: vi.fn(),
    cleanup: vi.fn(),
  };
}

export function createFollowupTurnTestTurn(
  overrides: Partial<AdmittedFollowupTurn> = {},
): AdmittedFollowupTurn {
  return {
    runId: "run-1",
    queued: {
      prompt: "queued prompt",
      transcriptPrompt: "queued transcript",
      enqueuedAt: 1,
      messageId: "message-1",
      originatingChannel: "discord",
      originatingTo: "channel:C1",
      originatingThreadId: "thread-1",
      originatingAccountId: "acct-1",
      originatingChatType: "group",
      media: [{ kind: "audio", contentType: "audio/ogg" }],
      run: {
        agentId: "agent",
        agentDir: "/tmp/agent",
        sessionId: "session",
        sessionKey: "main",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        config: {},
        provider: "anthropic",
        model: "claude",
        messageProvider: "slack",
        senderId: "user-1",
        timeoutMs: 1_000,
        blockReplyBreak: "message_end",
      },
    },
    operation: createMockReplyOperation().replyOperation,
    config: {},
    session: {
      kind: "session",
      key: "main",
      current: () => ({ sessionId: "session", updatedAt: 1, verboseLevel: "on" }),
      publish: () => undefined,
      adopt: () => undefined,
    },
    sendPolicy: "allow",
    preflightCompactionApplied: false,
    ...overrides,
  };
}

export function resetFollowupTurnTestState() {
  vi.clearAllMocks();
  followupTurnTestState.loadEntryReadOnly.mockReturnValue(undefined);
  followupTurnTestState.readEntry.mockResolvedValue(undefined);
  followupTurnTestState.withStoreReaderInWorker.mockImplementation(async (scope, consume) => {
    const agentId = scope.agentId ?? "main";
    return consume({
      reader: {
        ...createSessionHistoryWorkerReaders(async () => {
          throw new Error("Visibility policy fixtures supply prepared entries");
        }),
        generation: 0,
        assertCurrent() {},
      },
      database: { agentId, path: scope.storePath, env: scope.env ?? {} },
      logicalAgentId: agentId,
      selectedStore: { path: scope.storePath, physicalPath: scope.storePath },
      assertCurrent() {},
    });
  });
  followupTurnTestState.withOrderedEntriesInWorker.mockImplementation(async ([input], consume) => {
    const entry = await followupTurnTestState.readEntry();
    return consume([
      {
        result: {
          kind: "session-exact-entries",
          entries: entry ? [{ sessionKey: input!.sessionKeys![0]!, entry }] : [],
          lifecycleTimestamps: {},
        },
        database: { agentId: input!.agentId, path: input!.storePath, env: input!.env ?? {} },
        assertCurrent: () => {},
      },
    ]);
  });
  followupTurnTestState.execute.mockResolvedValue({
    runId: "run-1",
    outcome: { kind: "rejected", payload: { text: "done" } },
  });
}
