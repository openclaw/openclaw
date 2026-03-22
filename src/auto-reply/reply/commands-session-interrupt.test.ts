import { beforeEach, describe, expect, it, vi } from "vitest";

const abortMock = vi.hoisted(() => ({
  abortEmbeddedPiRun: vi.fn<(sessionId: string) => boolean>(),
  isEmbeddedPiRunActive: vi.fn().mockReturnValue(false),
  isEmbeddedPiRunStreaming: vi.fn().mockReturnValue(false),
  resolveEmbeddedSessionLane: vi.fn().mockReturnValue("main"),
}));

const clearQueuesMock = vi.hoisted(() => ({
  clearSessionQueues: vi.fn(),
  clearFollowupQueue: vi.fn(),
  enqueueFollowupRun: vi.fn(),
  getFollowupQueueDepth: vi.fn().mockReturnValue(0),
  scheduleFollowupDrain: vi.fn(),
  resetRecentQueuedMessageIdDedupe: vi.fn(),
}));

const callGatewayMock = vi.hoisted(() => ({
  callGateway: vi.fn(),
}));

const abortUtilsMock = vi.hoisted(() => ({
  resolveSessionEntryForKey: vi.fn(),
  setAbortMemory: vi.fn(),
  stopSubagentsForRequester: vi.fn().mockReturnValue({ stopped: 0 }),
  formatAbortReplyText: vi.fn().mockReturnValue("stopped"),
  isAbortTrigger: vi.fn().mockReturnValue(false),
  isAbortRequestText: vi.fn().mockReturnValue(false),
  getAbortMemory: vi.fn().mockReturnValue(false),
  resetAbortMemoryForTest: vi.fn(),
  getAbortMemorySizeForTest: vi.fn().mockReturnValue(0),
  resolveAbortCutoffFromContext: vi.fn(),
  shouldSkipMessageByAbortCutoff: vi.fn().mockReturnValue(false),
  tryFastAbortFromMessage: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../agents/pi-embedded.js", () => abortMock);
vi.mock("./queue.js", () => clearQueuesMock);
vi.mock("../../gateway/call.js", () => callGatewayMock);
vi.mock("./abort.js", () => abortUtilsMock);
vi.mock("../../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: vi.fn().mockReturnValue(null),
}));
vi.mock("../../agents/subagent-registry.js", () => ({
  listSubagentRunsForController: vi.fn().mockReturnValue([]),
  markSubagentRunTerminated: vi.fn(),
}));

const { handleInterruptCommand, MAX_INTERRUPT_CHARS, INTERRUPT_CONTEXT_NOTE } =
  await import("./commands-session-interrupt.js");

function buildParams(commandBody: string, opts?: { authorized?: boolean; sessionId?: string }) {
  const isAuthorizedSender = opts?.authorized ?? true;
  const sessionEntry = opts?.sessionId
    ? { sessionId: opts.sessionId, updatedAt: Date.now() }
    : undefined;
  return {
    command: {
      commandBodyNormalized: commandBody,
      rawBodyNormalized: commandBody,
      isAuthorizedSender,
      surface: "telegram",
      channel: "telegram",
      to: "telegram:123",
      from: "telegram:456",
    },
    ctx: {
      Channel: "telegram",
      To: "telegram:123",
    },
    sessionKey: "agent:main:main",
    sessionEntry,
    sessionStore: sessionEntry ? { "agent:main:main": sessionEntry as never } : undefined,
    cfg: {} as never,
    elevated: { enabled: false, allowed: false, failures: [] },
    agentId: "main",
    directives: { hasThinkDirective: false, thinkLevel: undefined },
  } as never;
}

describe("handleInterruptCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    abortMock.abortEmbeddedPiRun.mockReturnValue(true);
    clearQueuesMock.clearSessionQueues.mockReturnValue({
      followupCleared: 0,
      laneCleared: 0,
      keys: [],
    });
    callGatewayMock.callGateway.mockResolvedValue({});
    abortUtilsMock.resolveSessionEntryForKey.mockReturnValue({ entry: undefined, key: undefined });
  });

  it("returns null for non-/interrupt commands", async () => {
    const result = await handleInterruptCommand(buildParams("/stop"), true);
    expect(result).toBeNull();
  });

  it("returns null for commands that merely start with /interrupt but are different words", async () => {
    // e.g. /interruption should NOT be treated as /interrupt
    const result = await handleInterruptCommand(buildParams("/interruption do stuff"), true);
    expect(result).toBeNull();
  });

  it("returns null when text commands are not allowed", async () => {
    const result = await handleInterruptCommand(buildParams("/interrupt hello"), false);
    expect(result).toBeNull();
  });

  it("returns usage help when no message is provided", async () => {
    const result = await handleInterruptCommand(buildParams("/interrupt"), true);
    expect(result?.shouldContinue).toBe(false);
    expect((result?.reply as { text?: string })?.text).toMatch(/Usage:/);
  });

  it("returns error for unauthorized sender", async () => {
    const result = await handleInterruptCommand(
      buildParams("/interrupt do something else", { authorized: false }),
      true,
    );
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply).toBeUndefined();
  });

  it("rejects messages that exceed MAX_INTERRUPT_CHARS", async () => {
    const longMsg = "/interrupt " + "x".repeat(MAX_INTERRUPT_CHARS + 1);
    const result = await handleInterruptCommand(buildParams(longMsg), true);
    expect(result?.shouldContinue).toBe(false);
    expect((result?.reply as { text?: string })?.text).toMatch(/too long/i);
  });

  it("aborts the current run and re-queues the message", async () => {
    const sessionId = "session-uuid-123";
    abortUtilsMock.resolveSessionEntryForKey.mockReturnValue({
      entry: { sessionId },
      key: "agent:main:main",
    });
    const result = await handleInterruptCommand(
      buildParams("/interrupt focus on the billing module", { sessionId }),
      true,
    );

    expect(result?.shouldContinue).toBe(false);
    expect((result?.reply as { text?: string })?.text).toMatch(/Interrupted/i);

    // Should have aborted the current session.
    expect(abortMock.abortEmbeddedPiRun).toHaveBeenCalledWith(sessionId);
    // Should have cleared queues.
    expect(clearQueuesMock.clearSessionQueues).toHaveBeenCalled();
    // Should have stopped any subagents before re-queuing.
    expect(abortUtilsMock.stopSubagentsForRequester).toHaveBeenCalled();
    // Should have re-queued the new message via the gateway with an idempotency key.
    expect(callGatewayMock.callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "agent",
        params: expect.objectContaining({
          message: expect.stringContaining("focus on the billing module"),
          idempotencyKey: expect.any(String),
        }),
      }),
    );
    // The message should include the context note.
    const [callArgs] = callGatewayMock.callGateway.mock.calls as Array<
      [{ params: { message: string } }]
    >;
    expect(callArgs[0].params.message).toContain(INTERRUPT_CONTEXT_NOTE.trim());
  });

  it("proceeds without session abort when no sessionId is stored", async () => {
    abortUtilsMock.resolveSessionEntryForKey.mockReturnValue({
      entry: undefined,
      key: "agent:main:main",
    });
    const result = await handleInterruptCommand(
      buildParams("/interrupt try a different approach"),
      true,
    );
    expect(result?.shouldContinue).toBe(false);
    expect(abortMock.abortEmbeddedPiRun).not.toHaveBeenCalled();
    expect(callGatewayMock.callGateway).toHaveBeenCalled();
  });
});
