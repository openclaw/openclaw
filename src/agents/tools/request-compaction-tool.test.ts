import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRequestCompactionTool,
  _resetGuardState,
  _resetVolitionalCounts,
  _setPending,
  _guards,
  getVolitionalCompactionCount,
  incrementVolitionalCompactionCount,
  type RequestCompactionToolOpts,
} from "./request-compaction-tool.js";

describe("request_compaction tool", () => {
  const SESSION_KEY = "test-session";
  const SESSION_ID = "session-uuid-1234";

  let contextUsage: number;
  let mockTriggerCompaction: ReturnType<
    typeof vi.fn<RequestCompactionToolOpts["triggerCompaction"]>
  >;

  function makeOpts(overrides?: Partial<RequestCompactionToolOpts>): RequestCompactionToolOpts {
    return {
      agentSessionKey: SESSION_KEY,
      sessionId: SESSION_ID,
      getContextUsage: () => contextUsage,
      triggerCompaction: mockTriggerCompaction,
      ...overrides,
    };
  }

  function makeTool(overrides?: Partial<RequestCompactionToolOpts>) {
    return createRequestCompactionTool(makeOpts(overrides));
  }

  async function executeTool(
    tool: ReturnType<typeof createRequestCompactionTool>,
    args: Record<string, unknown> = { reason: "test compaction request" },
  ) {
    return (await tool.execute("call-1", args))?.details as Record<string, unknown>;
  }

  beforeEach(() => {
    contextUsage = 0.85; // above threshold by default
    _resetGuardState();
    _resetVolitionalCounts();
    mockTriggerCompaction = vi.fn().mockResolvedValue({
      ok: true,
      compacted: true,
      result: {
        summary: "Session compacted successfully with key decisions preserved.",
        firstKeptEntryId: "entry-42",
        tokensBefore: 850_000,
        tokensAfter: 120_000,
      },
    });
  });

  afterEach(() => {
    _resetGuardState();
    _resetVolitionalCounts();
  });

  // -------------------------------------------------------------------------
  // Precondition errors
  // -------------------------------------------------------------------------

  it("throws when no session key is provided", async () => {
    const tool = makeTool({ agentSessionKey: undefined });
    await expect(tool.execute("call-1", {})).rejects.toThrow(/requires an active session/);
  });

  it("throws when no session id is provided", async () => {
    const tool = makeTool({ sessionId: undefined });
    await expect(tool.execute("call-1", {})).rejects.toThrow(/requires a sessionId/);
  });

  // -------------------------------------------------------------------------
  // Guard: context threshold
  // -------------------------------------------------------------------------

  it("rejects when context usage is below threshold", async () => {
    contextUsage = 0.5;
    const tool = makeTool();
    const result = await executeTool(tool);

    expect(result).toMatchObject({
      status: "rejected",
      guard: "context_threshold",
      contextUsage: 50,
      threshold: _guards.MIN_CONTEXT_THRESHOLD * 100,
    });
    expect(mockTriggerCompaction).not.toHaveBeenCalled();
  });

  it("accepts when context usage is exactly at threshold", async () => {
    contextUsage = _guards.MIN_CONTEXT_THRESHOLD;
    const tool = makeTool();
    const result = await executeTool(tool);

    expect(result).toMatchObject({ status: "compaction_requested" });
    expect(mockTriggerCompaction).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // Guard: rate limit
  // -------------------------------------------------------------------------

  it("rejects a second request within the rate limit window", async () => {
    const tool = makeTool();

    // First call succeeds
    const first = await executeTool(tool);
    expect(first).toMatchObject({ status: "compaction_requested" });

    // Second call within 5 minutes is rate-limited
    const second = await executeTool(tool);
    expect(second).toMatchObject({
      status: "rejected",
      guard: "rate_limit",
    });
    expect(second.retryAfterSeconds).toBeGreaterThan(0);
    expect(mockTriggerCompaction).toHaveBeenCalledTimes(1);
  });

  it("allows a request after the rate limit window expires", async () => {
    const tool = makeTool();

    let fakeNow = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => fakeNow);

    // First call
    const first = await executeTool(tool);
    expect(first).toMatchObject({ status: "compaction_requested" });

    // Advance past rate limit
    fakeNow += _guards.RATE_LIMIT_MS + 1;

    const second = await executeTool(tool);
    expect(second).toMatchObject({ status: "compaction_requested" });
    expect(mockTriggerCompaction).toHaveBeenCalledTimes(2);

    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // No generation guard (RFC 2026-04-15): compaction is not blocked by
  // unrelated channel activity.
  // -------------------------------------------------------------------------

  it("proceeds regardless of session generation drift (post-RFC 2026-04-15)", async () => {
    const tool = makeTool();
    const result = await executeTool(tool);

    expect(result).toMatchObject({ status: "compaction_requested" });
    expect(mockTriggerCompaction).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Async fire-and-forget
  // -------------------------------------------------------------------------

  it("returns compaction_requested immediately without awaiting compaction", async () => {
    // triggerCompaction returns a promise that never resolves — tool should
    // still return immediately because it does not await.
    let resolveCompaction!: () => void;
    mockTriggerCompaction.mockReturnValue(
      new Promise<{ ok: boolean; compacted: boolean }>((resolve) => {
        resolveCompaction = () => resolve({ ok: true, compacted: true });
      }),
    );

    const tool = makeTool();
    const result = await executeTool(tool);

    // Tool returned before compaction completed
    expect(result).toMatchObject({ status: "compaction_requested" });
    expect(mockTriggerCompaction).toHaveBeenCalledOnce();

    // Clean up the dangling promise
    resolveCompaction();
  });

  it("logs errors from background compaction without crashing the tool", async () => {
    mockTriggerCompaction.mockRejectedValue(new Error("Lane contention timeout"));

    const tool = makeTool();
    const result = await executeTool(tool);

    // Tool still returns success — the error is handled in the background
    expect(result).toMatchObject({ status: "compaction_requested" });

    // Let the rejection propagate through the microtask queue
    await vi.waitFor(() => {
      expect(mockTriggerCompaction).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // Reason parameter
  // -------------------------------------------------------------------------

  it("passes through the reason parameter in the result", async () => {
    const tool = makeTool();
    const result = await executeTool(tool, { reason: "thermal evacuation complete" });

    expect(result).toMatchObject({
      status: "compaction_requested",
      reason: "thermal evacuation complete",
    });
  });

  it("truncates long reasons to 1024 characters", async () => {
    const tool = makeTool();
    const longReason = "x".repeat(2000);
    const result = await executeTool(tool, { reason: longReason });

    expect((result.reason as string).length).toBe(1024);
  });

  // -------------------------------------------------------------------------
  // Collision edge cases (Trigger dedup)
  // -------------------------------------------------------------------------

  it("two request_compaction calls in same turn — second is rate-limited", async () => {
    const tool = makeTool();

    const first = await executeTool(tool);
    expect(first).toMatchObject({ status: "compaction_requested" });

    // Second call in same turn
    const second = await executeTool(tool);
    expect(second).toMatchObject({
      status: "rejected",
      guard: "rate_limit",
    });
    expect(mockTriggerCompaction).toHaveBeenCalledTimes(1);
  });

  it("request_compaction below 70% is rejected", async () => {
    contextUsage = 0.69;
    const tool = makeTool();
    const result = await executeTool(tool);

    expect(result).toMatchObject({
      status: "rejected",
      guard: "context_threshold",
    });
  });

  // -------------------------------------------------------------------------
  // Guard isolation per session
  // -------------------------------------------------------------------------

  it("rate limits are per-session, not global", async () => {
    const toolA = makeTool({ agentSessionKey: "session-a" });
    const toolB = makeTool({ agentSessionKey: "session-b" });

    // Session A compacts
    const resultA = await executeTool(toolA);
    expect(resultA).toMatchObject({ status: "compaction_requested" });

    // Session B can still compact
    const resultB = await executeTool(toolB);
    expect(resultB).toMatchObject({ status: "compaction_requested" });

    // Session A is rate-limited
    const resultA2 = await executeTool(toolA);
    expect(resultA2).toMatchObject({ status: "rejected", guard: "rate_limit" });
  });

  // -------------------------------------------------------------------------
  // Guard ordering
  // -------------------------------------------------------------------------

  it("checks context threshold before rate limit", async () => {
    const tool = makeTool();

    // First: succeed to set rate limit state
    await executeTool(tool);

    // Now drop context below threshold
    contextUsage = 0.3;

    // Should get threshold rejection, not rate limit rejection
    const result = await executeTool(tool);
    expect(result).toMatchObject({
      status: "rejected",
      guard: "context_threshold",
    });
  });

  // -------------------------------------------------------------------------
  // _resetGuardState
  // -------------------------------------------------------------------------

  it("_resetGuardState clears per-session state", async () => {
    const tool = makeTool();

    await executeTool(tool);
    _resetGuardState(SESSION_KEY);

    // After reset, should be able to request compaction again
    const result = await executeTool(tool);
    expect(result).toMatchObject({ status: "compaction_requested" });
    expect(mockTriggerCompaction).toHaveBeenCalledTimes(2);
  });

  it("_resetGuardState with no arg clears all sessions", async () => {
    const toolA = makeTool({ agentSessionKey: "session-a" });
    const toolB = makeTool({ agentSessionKey: "session-b" });

    await executeTool(toolA);
    await executeTool(toolB);

    _resetGuardState();

    const resultA = await executeTool(toolA);
    const resultB = await executeTool(toolB);
    expect(resultA).toMatchObject({ status: "compaction_requested" });
    expect(resultB).toMatchObject({ status: "compaction_requested" });
  });

  it("expires volitional compaction counts after the diagnostic TTL", () => {
    let fakeNow = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => fakeNow);

    incrementVolitionalCompactionCount(SESSION_KEY);
    expect(getVolitionalCompactionCount(SESSION_KEY)).toBe(1);

    fakeNow += _guards.VOLITIONAL_COMPACTION_COUNT_TTL_MS + 1;
    expect(getVolitionalCompactionCount(SESSION_KEY)).toBe(0);

    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Guard: dedup (compaction already pending)
  // -------------------------------------------------------------------------

  it("returns already_pending when compaction is in-flight", async () => {
    _setPending(SESSION_KEY);

    const tool = makeTool();
    const result = await executeTool(tool);

    expect(result).toMatchObject({ status: "already_pending" });
    expect(mockTriggerCompaction).not.toHaveBeenCalled();
  });

  it("dedup is cleared after triggerCompaction resolves", async () => {
    let resolveCompaction!: () => void;
    mockTriggerCompaction.mockReturnValue(
      new Promise<{ ok: boolean; compacted: boolean }>((resolve) => {
        resolveCompaction = () => resolve({ ok: true, compacted: true });
      }),
    );

    const tool = makeTool();
    const first = await executeTool(tool);
    expect(first).toMatchObject({ status: "compaction_requested" });

    // Resolve the background compaction and flush microtasks
    resolveCompaction();
    await new Promise((r) => setTimeout(r, 0));

    // After resolution, pending is cleared — a new call (with fresh guard state) works
    _resetGuardState(SESSION_KEY);
    const second = await executeTool(tool);
    expect(second).toMatchObject({ status: "compaction_requested" });
  });

  // -------------------------------------------------------------------------
  // Required reason parameter
  // -------------------------------------------------------------------------

  it("throws ToolInputError when reason is missing", async () => {
    const tool = makeTool();
    await expect(tool.execute("call-1", {})).rejects.toThrow(/reason required/);
  });

  it("throws ToolInputError when reason is empty string", async () => {
    const tool = makeTool();
    await expect(tool.execute("call-1", { reason: "  " })).rejects.toThrow(/reason required/);
  });
});
