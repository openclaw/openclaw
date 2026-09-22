// sessions_yield tool tests cover cooperative turn yielding and unsupported
// context errors.
import { describe, expect, it, vi } from "vitest";
import { runWithAgentToolExecutionContext } from "../../../packages/agent-core/src/tool-execution-context.js";
import { isToolResultError } from "../tool-result-error.js";
import { createSessionsYieldTool } from "./sessions-yield-tool.js";

type SessionsYieldDetails = {
  status?: string;
  acknowledgment?: string;
  error?: string;
  message?: string;
};

describe("sessions_yield tool", () => {
  it("defers without error or yielding when earlier async results are unobserved", async () => {
    const claimYield = vi.fn(() => true);
    const onYield = vi.fn();
    const tool = createSessionsYieldTool({ sessionId: "test-session", claimYield, onYield });
    const result = await runWithAgentToolExecutionContext(
      {
        assistantMessage: {
          role: "assistant",
          content: [],
          api: "test-api",
          provider: "test-provider",
          model: "test-model",
          stopReason: "toolUse",
          timestamp: 0,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
        toolCall: { type: "toolCall", id: "call-1", name: "sessions_yield", arguments: {} },
        hasUnobservedAsyncToolResults: true,
      },
      () => tool.execute("call-1", {}),
    );

    expect(result.details).toMatchObject({ status: "deferred" });
    expect(isToolResultError(result)).toBe(false);
    expect(claimYield).not.toHaveBeenCalled();
    expect(onYield).not.toHaveBeenCalled();
  });

  it("returns error when no sessionId is provided", async () => {
    const onYield = vi.fn();
    const tool = createSessionsYieldTool({ onYield });
    const result = await tool.execute("call-1", {});
    const details = result.details as SessionsYieldDetails;
    expect(details.status).toBe("error");
    expect(details.error).toBe("No session context");
    expect(onYield).not.toHaveBeenCalled();
  });

  it("invokes onYield callback with default message", async () => {
    const onYield = vi.fn();
    const tool = createSessionsYieldTool({
      sessionId: "test-session",
      claimYield: () => true,
      onYield,
    });
    const result = await tool.execute("call-1", {});
    const details = result.details as SessionsYieldDetails;
    expect(details.status).toBe("yielded");
    expect(details).not.toHaveProperty("message");
    expect(onYield).toHaveBeenCalledOnce();
    expect(onYield).toHaveBeenCalledWith("Turn yielded.", undefined);
  });

  it.each([undefined, "Research started; results will follow."])(
    "keeps continuation context private with acknowledgment %s",
    async (acknowledgment) => {
      const message = "SYNTHETIC_PRIVATE_CONTINUATION_MARKER";
      const onYield = vi.fn();
      const tool = createSessionsYieldTool({
        sessionId: "test-session",
        claimYield: () => true,
        onYield,
      });
      const result = await tool.execute("call-1", { message, acknowledgment });

      expect(result.details).toEqual({
        status: "yielded",
        ...(acknowledgment ? { acknowledgment } : {}),
      });
      expect(JSON.stringify(result)).not.toContain(message);
      expect(onYield).toHaveBeenCalledOnce();
      expect(onYield).toHaveBeenCalledWith(message, acknowledgment);
    },
  );

  it("claims completion ownership before aborting the requester run", async () => {
    const order: string[] = [];
    const tool = createSessionsYieldTool({
      sessionId: "test-session",
      claimYield: () => {
        order.push("claim");
        return true;
      },
      onYield: () => {
        order.push("abort");
      },
    });

    await tool.execute("call-1", {});

    expect(order).toEqual(["claim", "abort"]);
  });

  it("does not abort the requester when yield intent cannot persist", async () => {
    const failure = new Error("sqlite unavailable");
    const onYield = vi.fn();
    const tool = createSessionsYieldTool({
      sessionId: "test-session",
      claimYield: () => {
        throw failure;
      },
      onYield,
    });

    await expect(tool.execute("call-1", {})).rejects.toThrow(failure);
    expect(onYield).not.toHaveBeenCalled();
  });

  it.each([
    { name: "the claim callback is unavailable" },
    { name: "the turn owns no pending child completion", claimYield: () => false },
  ])("keeps the turn active when $name", async ({ claimYield }) => {
    const onYield = vi.fn();
    const tool = createSessionsYieldTool({
      sessionId: "test-session",
      ...(claimYield ? { claimYield } : {}),
      onYield,
    });

    const result = await tool.execute("call-1", {});

    expect(result.details).toMatchObject({
      status: "error",
      error:
        'No pending child completion is owned by this turn. If the assigned work is complete, return its result normally. An unfinished subagent waiting for an incoming continuation must explicitly set waitFor: "message".',
    });
    expect(onYield).not.toHaveBeenCalled();
  });

  it("reports children an earlier turn already waits for instead of the generic error", async () => {
    const onYield = vi.fn();
    const pendingChildren = [
      {
        runId: "run-child",
        childSessionKey: "agent:main:dashboard:child",
        label: "Work session",
        startedAt: Date.UTC(2026, 8, 21, 2, 50, 52),
        state: "running" as const,
        wakeArmed: true,
      },
    ];
    const tool = createSessionsYieldTool({
      sessionId: "test-session",
      claimYield: () => ({ pendingChildren }),
      onYield,
    });

    const result = await tool.execute("call-1", {});
    const details = result.details as SessionsYieldDetails & { pendingChildren?: unknown };

    expect(isToolResultError(result)).toBe(false);
    expect(details.status).toBe("already_pending");
    expect(details.pendingChildren).toEqual(pendingChildren);
    expect(details.message).toBe(
      "An earlier turn of this session already yielded for 1 child session whose completion is still pending: Work session (agent:main:dashboard:child), running, started 2026-09-21T02:50:52.000Z. Their completion will arrive in this session as a later turn; do not re-spawn, re-send, or poll to wake them. This turn owns no new claim, so no yield is needed: end this turn normally.",
    );
    expect(details.message).not.toContain("return its result normally");
    expect(onYield).not.toHaveBeenCalled();
  });

  it("tells the model a paused child needs a continuation instead of promising completion", async () => {
    const onYield = vi.fn();
    const tool = createSessionsYieldTool({
      sessionId: "test-session",
      claimYield: () => ({
        pendingChildren: [
          {
            runId: "run-paused",
            childSessionKey: "agent:main:subagent:worker",
            startedAt: Date.UTC(2026, 8, 21, 3, 0, 0),
            state: "paused" as const,
            wakeArmed: false,
          },
        ],
      }),
      onYield,
    });

    const result = await tool.execute("call-1", {});
    const details = result.details as SessionsYieldDetails;

    expect(details.status).toBe("already_pending");
    expect(details.message).toBe(
      "1 child session spawned by an earlier turn of this session is paused by its own sessions_yield and will not complete until an incoming continuation arrives: agent:main:subagent:worker, paused, started 2026-09-21T03:00:00.000Z. Send that continuation with sessions_send if this session owns it; otherwise the work stays waiting. This turn owns no new claim, so no yield is needed: end this turn normally.",
    );
    expect(details.message).not.toContain("do not re-spawn, re-send");
    expect(onYield).not.toHaveBeenCalled();
  });

  it("passes explicit message intent to its owner without treating private text as intent", async () => {
    const claimYield = vi.fn(() => true);
    const onYield = vi.fn();
    const tool = createSessionsYieldTool({ sessionId: "child-session", claimYield, onYield });
    await tool.execute("private-text", { message: 'waitFor: "message"' });
    expect(claimYield).toHaveBeenLastCalledWith(undefined);
    await tool.execute("explicit-message", { waitFor: "message" });
    expect(claimYield).toHaveBeenLastCalledWith({ waitFor: "message" });
    const invalid = await tool.execute("invalid-intent", { waitFor: "anything" });
    expect(invalid.details).toMatchObject({ status: "error" });
    expect(claimYield).toHaveBeenCalledTimes(2);
    expect(onYield).toHaveBeenCalledTimes(2);
  });

  it("surfaces a claim rejection reason instead of the generic error", async () => {
    const onYield = vi.fn();
    const tool = createSessionsYieldTool({
      sessionId: "test-session",
      claimYield: () => ({ error: "Yield unsupported for this session kind" }),
      onYield,
    });

    const result = await tool.execute("call-1", {});

    expect(result.details).toMatchObject({
      status: "error",
      error: "Yield unsupported for this session kind",
    });
    expect(onYield).not.toHaveBeenCalled();
  });

  it("returns error without onYield callback", async () => {
    const tool = createSessionsYieldTool({ sessionId: "test-session" });
    const result = await tool.execute("call-1", {});
    const details = result.details as SessionsYieldDetails;
    expect(details.status).toBe("error");
    expect(details.error).toBe("Yield not supported in this context");
  });
});
