import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildSubagentsDispatchContext } from "./commands-subagents-send-steer.test-support.js";
import { buildSubagentRun, buildSubagentsSendContext } from "./commands-subagents.test-helpers.js";
import { handleSubagentsSendAction } from "./commands-subagents/action-send.js";

const sendControlledSubagentMessageMock = vi.hoisted(() => vi.fn());
const steerControlledSubagentRunMock = vi.hoisted(() => vi.fn());

vi.mock("./commands-subagents-control.runtime.js", () => ({
  sendControlledSubagentMessage: sendControlledSubagentMessageMock,
  steerControlledSubagentRun: steerControlledSubagentRunMock,
}));

const buildContext = () =>
  buildSubagentsDispatchContext({
    handledPrefix: "/subagents",
    restTokens: ["1", "continue", "with", "follow-up", "details"],
  });

describe("subagents send action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("formats accepted send replies", async () => {
    sendControlledSubagentMessageMock.mockResolvedValue({
      status: "accepted",
      runId: "run-followup-1",
      replyText: "custom reply",
    });
    const result = await handleSubagentsSendAction(buildContext(), false);
    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "custom reply" },
    });
  });

  it("formats forbidden send replies", async () => {
    sendControlledSubagentMessageMock.mockResolvedValue({
      status: "forbidden",
      error: "Leaf subagents cannot control other sessions.",
    });
    const result = await handleSubagentsSendAction(buildContext(), false);
    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "⚠️ Leaf subagents cannot control other sessions." },
    });
  });

  it("lets /spawn steer target the subagent tied to the current thread", async () => {
    steerControlledSubagentRunMock.mockResolvedValue({
      status: "accepted",
      runId: "run-steer-1",
    });
    const result = await handleSubagentsSendAction(
      buildSubagentsSendContext({
        handledPrefix: "/spawn",
        restTokens: ["tighten", "scope"],
        ctx: {
          OriginatingChannel: "slack",
          AccountId: "default",
          OriginatingTo: "channel:D123",
          MessageThreadId: "1710000000.000100",
        },
        command: {
          channel: "slack",
          to: "channel:D123",
        },
        runs: [
          {
            ...buildSubagentRun(),
            requesterOrigin: {
              channel: "slack",
              accountId: "default",
              to: "channel:D123",
              threadId: "1710000000.000100",
            },
          },
        ],
      }),
      true,
    );
    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "steered do thing (run run-stee)." },
    });
    expect(steerControlledSubagentRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({ runId: "run-1" }),
        message: "tighten scope",
      }),
    );
  });
});
