import { describe, expect, it, vi } from "vitest";
import { runWithAgentToolExecutionContext } from "../../../packages/agent-core/src/tool-execution-context.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { isToolResultError } from "../tool-result-error.js";
import { createSessionsYieldTool } from "./sessions-yield-tool.js";

function setup(options: Parameters<typeof createSessionsYieldTool>[0] = {}) {
  const onYield = vi.fn();
  const tool = createSessionsYieldTool({ sessionId: "test-session", onYield, ...options });
  return { onYield, tool, execute: (args = {}) => tool.execute("call-1", args) };
}

describe("sessions_yield tool", () => {
  it("defers without error or yielding when earlier async results are unobserved", async () => {
    const claimYield = vi.fn(() => true);
    const { onYield, tool } = setup({ claimYield });
    const result = await runWithAgentToolExecutionContext(
      {
        assistantMessage: makeAgentAssistantMessage({
          content: [],
          api: "test-api",
          provider: "test-provider",
          stopReason: "toolUse",
        }),
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

  it.each([
    { name: "no session context", options: { sessionId: undefined }, error: "No session context" },
    {
      name: "no callback",
      options: { onYield: undefined },
      error: "Yield not supported in this context",
    },
    {
      name: "a rejected claim",
      options: { claimYield: () => ({ error: "Yield unsupported for this session kind" }) },
      error: "Yield unsupported for this session kind",
    },
  ])("returns the specific error for $name without yielding", async ({ options, error }) => {
    const { onYield, execute } = setup(options);
    expect((await execute()).details).toMatchObject({ status: "error", error });
    expect(onYield).not.toHaveBeenCalled();
  });

  it("keeps continuation context private with an acknowledgment", async () => {
    const acknowledgment = "Research started; results will follow.";
    const message = "SYNTHETIC_PRIVATE_CONTINUATION_MARKER";
    const { onYield, execute } = setup({ claimYield: () => true });
    const result = await execute({ message, acknowledgment });

    expect(result.details).toEqual({
      status: "yielded",
      acknowledgment,
    });
    expect(JSON.stringify(result)).not.toContain(message);
    expect(onYield).toHaveBeenCalledExactlyOnceWith(message, acknowledgment, undefined);
  });

  it("claims completion ownership before aborting the requester run", async () => {
    const order: string[] = [];
    const { execute } = setup({
      claimYield: () => {
        order.push("claim");
        return true;
      },
      onYield: () => {
        order.push("abort");
      },
    });

    await execute();

    expect(order).toEqual(["claim", "abort"]);
  });

  it("does not abort the requester when yield intent cannot persist", async () => {
    const failure = new Error("sqlite unavailable");
    const { onYield, execute } = setup({
      claimYield: () => {
        throw failure;
      },
    });

    await expect(execute()).rejects.toThrow(failure);
    expect(onYield).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, "test-session", "did not pause the turn or schedule a continuation"],
    ["message", "root", "eligible active native task"],
  ] as const)(
    "keeps an ineligible turn active with intent %s",
    async (waitFor, sessionId, message) => {
      const { onYield, execute } = setup({ sessionId, claimYield: () => false });
      const result = await execute({ waitFor });
      expect(isToolResultError(result)).toBe(false);
      expect(result.details).toMatchObject({
        status: "nothing_pending",
        message: expect.stringContaining(message),
      });
      if (waitFor) {
        expect(JSON.stringify(result)).not.toContain("set waitFor");
      }
      expect(onYield).not.toHaveBeenCalled();
    },
  );

  it("reports children an earlier turn already waits for instead of the generic error", async () => {
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
    const { onYield, execute } = setup({ claimYield: () => ({ pendingChildren }) });
    const result = await execute();

    expect(isToolResultError(result)).toBe(false);
    expect(result.details).toMatchObject({
      status: "already_pending",
      message:
        "An earlier turn of this session already yielded for 1 child session whose completion is still pending: Work session (agent:main:dashboard:child), running, started 2026-09-21T02:50:52.000Z. Their completion will arrive in this session as a later turn; do not re-spawn, re-send, or poll to wake them. This turn owns no new claim, so no yield is needed: end this turn normally.",
    });
    expect(result.details).toHaveProperty("pendingChildren", pendingChildren);
    expect(onYield).not.toHaveBeenCalled();
  });

  it("tells the model a paused child needs a continuation instead of promising completion", async () => {
    const { onYield, execute } = setup({
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
    });

    const result = await execute();
    expect(result.details).toMatchObject({
      status: "already_pending",
      message:
        "1 child session spawned by an earlier turn of this session is paused by its own sessions_yield and will not complete until an incoming continuation arrives: agent:main:subagent:worker, paused, started 2026-09-21T03:00:00.000Z. An authorized caller can send that continuation with sessions_send; owning a child does not grant that tool. Otherwise the work stays waiting. This turn owns no new claim, so no yield is needed: end this turn normally.",
    });
    expect(onYield).not.toHaveBeenCalled();
  });

  it("passes explicit message intent to its owner without treating private text as intent", async () => {
    const claimYield = vi.fn(() => true);
    const { onYield, tool } = setup({ sessionId: "child-session", claimYield });
    await tool.execute("private-text", { message: 'waitFor: "message"' });
    expect(claimYield).toHaveBeenLastCalledWith(undefined);
    await tool.execute("explicit-message", { waitFor: "message" });
    expect(claimYield).toHaveBeenLastCalledWith({ waitFor: "message" });
    const invalid = await tool.execute("invalid-intent", { waitFor: "anything" });
    expect(invalid.details).toMatchObject({ status: "error" });
    expect(claimYield).toHaveBeenCalledTimes(2);
    expect(onYield).toHaveBeenCalledTimes(2);
  });
});
