import { beforeEach, expect, it, vi } from "vitest";
import * as execHandoff from "../../agents/bash-tools.exec-approval-followup-state.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { stageSessionPendingInput } from "../../config/sessions/session-accessor.pending-inputs.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import { prepareAgentRunUserTurn } from "./agent-run-user-turn.js";
import type { AgentTurnContext } from "./types.js";

const mocks = vi.hoisted(() => ({
  loadSessionEntry: vi.fn(),
  resolveSessionTranscriptRuntimeTarget: vi.fn(),
  stageSessionPendingInput: vi.fn(),
  persistInboundImagesForTranscript: vi.fn(),
  deleteMediaBuffer: vi.fn(),
  persistedMessages: [] as unknown[],
  beforeTranscriptCommit: undefined as (() => void) | undefined,
}));

vi.mock(import("../chat-attachments.js"), async (original) => ({
  ...(await original()),
  persistInboundImagesForTranscript: mocks.persistInboundImagesForTranscript,
}));
vi.mock(import("../../media/store.js"), async (original) => ({
  ...(await original()),
  deleteMediaBuffer: mocks.deleteMediaBuffer,
}));

// mock-isolation: User-turn orchestration receives fixture session rows without starting a read worker.
vi.mock("../session-utils-store-worker.js", () => ({
  loadGatewaySessionEntryReadOnlyInWorker: mocks.loadSessionEntry,
}));

vi.mock(import("../../config/sessions/session-accessor.pending-inputs.js"), async (original) => ({
  ...(await original()),
  stageSessionPendingInput: mocks.stageSessionPendingInput,
}));
vi.mock(
  import("../../config/sessions/session-accessor.transcript-target.js"),
  async (original) => ({
    ...(await original()),
    resolveSessionTranscriptRuntimeTarget: mocks.resolveSessionTranscriptRuntimeTarget,
  }),
);

type TurnParams = Parameters<typeof prepareAgentRunUserTurn>[0];
const sessionEntry: SessionEntry = { sessionId: "admitted-session", updatedAt: 1 };
function prepareTurn(entry: SessionEntry, overrides: Partial<TurnParams> = {}) {
  const message = "user input";
  const runId = `${entry.sessionId}-run`;
  return prepareAgentRunUserTurn({
    sessionEntry: entry,
    message,
    effectiveTranscriptInputText: message,
    runId,
    request: { message, idempotencyKey: runId },
    admittedSessionId: entry.sessionId,
    resolvedSessionKey: "agent:main:worker-child",
    activeSessionAgentId: "main",
    cfg: {},
    client: null,
    images: [],
    offloadedRefs: [],
    suppressVisibleSessionEffects: false,
    requestedPromptPersistenceSuppression: false,
    canUseInternalRuntimeHandoff: false,
    onUserTurnMediaPersisted: vi.fn(),
    assertCurrent: () => {},
    context: { logGateway: { warn: vi.fn() } } as unknown as AgentTurnContext,
    ...overrides,
  });
}

function loadEntry(entry: SessionEntry | undefined, includeInStore = true) {
  mocks.loadSessionEntry.mockResolvedValue({
    storePath: "/tmp/sessions.json",
    entry,
    store: includeInStore && entry ? { "agent:main:worker-child": entry } : {},
  });
}

beforeEach(() => {
  mocks.loadSessionEntry.mockReset();
  mocks.resolveSessionTranscriptRuntimeTarget.mockReset().mockResolvedValue({});
  mocks.persistInboundImagesForTranscript.mockReset().mockResolvedValue({ entries: [] });
  mocks.deleteMediaBuffer.mockReset().mockResolvedValue(undefined);
  mocks.persistedMessages.length = 0;
  mocks.beforeTranscriptCommit = undefined;
  mocks.stageSessionPendingInput.mockReset().mockImplementation(async (_scope, options) => {
    options.assertCurrent();
    const message = options.prepareMessageAfterIdempotencyCheck
      ? options.prepareMessageAfterIdempotencyCheck(options.message)
      : options.message;
    if (!message) {
      return undefined;
    }
    mocks.beforeTranscriptCommit?.();
    options.assertCurrent();
    mocks.persistedMessages.push(message);
    return {
      inputId: "pending-user-turn",
      message,
      run: <T>(operation: () => T) => operation(),
      finish: vi.fn(),
    };
  });
  loadEntry(sessionEntry);
});

it.each([undefined, "replacement-session"])(
  "fails closed when the admitted session entry changed to %s before transcript persistence",
  async (currentSessionId) => {
    const sessionKey = "agent:main:main";
    loadEntry(
      currentSessionId ? { ...sessionEntry, sessionId: currentSessionId } : undefined,
      false,
    );

    await expect(prepareTurn(sessionEntry, { resolvedSessionKey: sessionKey })).rejects.toThrow(
      "agent turn was not durably admitted",
    );
    expect(mocks.stageSessionPendingInput).not.toHaveBeenCalled();
  },
);

it.each([
  ["input", false],
  ["input", true],
  ["media", false],
] as const)(
  "does not stage input after authority closes during %s (fresh child=%s)",
  async (phase, freshChild) => {
    const authority = new AbortController();
    const revoke = () =>
      authority.abort(new TypeError("agent runtime authority is no longer active"));
    if (phase === "input") {
      mocks.beforeTranscriptCommit = revoke;
    } else {
      mocks.persistInboundImagesForTranscript.mockImplementationOnce(async () => {
        revoke();
        return { entries: [{ id: "revoked-media", imageKind: "inline", fact: {} }] };
      });
    }

    await expect(
      prepareTurn(sessionEntry, {
        freshChildStorePath: freshChild ? "/tmp/sessions.json" : undefined,
        assertCurrent: () => authority.signal.throwIfAborted(),
      }),
    ).rejects.toThrow("agent runtime authority is no longer active");
    expect(mocks.persistedMessages).toEqual([]);
    if (phase === "media") {
      expect(mocks.deleteMediaBuffer).toHaveBeenCalledWith("revoked-media", "inbound");
      expect([
        mocks.loadSessionEntry.mock.calls,
        mocks.resolveSessionTranscriptRuntimeTarget.mock.calls,
        mocks.stageSessionPendingInput.mock.calls,
      ]).toEqual([[], [], []]);
    }
  },
);

it.each([
  ["committed", undefined],
  ["unknown", undefined],
  ["unretained", undefined],
  ["settlement-failed", undefined],
  ["committed", "restart"],
  ["committed", "rpc"],
] as const)(
  "transfers failed preparation cleanup exactly once for %s input custody (stop=%s)",
  async (custody, stopReason) => {
    mocks.persistInboundImagesForTranscript.mockResolvedValue({
      entries: [{ id: "retained-media", imageKind: "inline", fact: {} }],
    });
    const failure =
      custody === "unknown"
        ? new SqliteWorkerError("input settlement unavailable", "outcome-unknown")
        : new Error("input preparation failed");
    const settlementFailure = new Error("input settlement failed");
    const finish = vi.fn();
    const abort = new AbortController();
    mocks.stageSessionPendingInput.mockImplementationOnce(
      async (
        _scope: Parameters<typeof stageSessionPendingInput>[0],
        options: Parameters<typeof stageSessionPendingInput>[1],
      ) => {
        if (custody === "committed" || custody === "settlement-failed") {
          options.onCommitted?.({
            state: "queued",
            inputId: "committed-media-input",
            message: options.message,
            run: (operation) => operation(),
            finish,
            settled: async () => {
              if (custody === "settlement-failed") {
                throw settlementFailure;
              }
            },
          });
        }
        if (stopReason) {
          abort.abort();
        }
        throw failure;
      },
    );
    const onUserTurnMediaPersisted = vi.fn();
    const release = execHandoff.releaseExecApprovalFollowupRuntimeHandoff;
    const cleanup = vi
      .spyOn(execHandoff, "releaseExecApprovalFollowupRuntimeHandoff")
      .mockImplementation((params) => {
        expect(onUserTurnMediaPersisted).toHaveBeenCalledTimes(custody === "unretained" ? 0 : 1);
        return release(params);
      });
    try {
      const preparation = prepareTurn(sessionEntry, {
        onUserTurnMediaPersisted,
        abortSignal: abort.signal,
        getAbortStopReason: () => stopReason ?? "rpc",
      });
      if (custody === "settlement-failed") {
        await expect(preparation).rejects.toMatchObject({ errors: [failure, settlementFailure] });
      } else {
        await expect(preparation).rejects.toBe(failure);
      }
      if (custody === "committed" || custody === "settlement-failed") {
        expect(finish).toHaveBeenCalledExactlyOnceWith(
          stopReason === "rpc" ? "cancelled" : "interrupted",
        );
      }
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(onUserTurnMediaPersisted).toHaveBeenCalledTimes(custody === "unretained" ? 0 : 1);
      expect(mocks.deleteMediaBuffer).toHaveBeenCalledTimes(custody === "unretained" ? 1 : 0);
      if (custody === "unretained") {
        expect(mocks.deleteMediaBuffer).toHaveBeenCalledWith("retained-media", "inbound");
      }
    } finally {
      cleanup.mockRestore();
    }
  },
);
