import { describe, expect, it, vi } from "vitest";

const { sendControlledSubagentMessage, steerControlledSubagentRun } = vi.hoisted(() => ({
  sendControlledSubagentMessage: vi.fn(),
  steerControlledSubagentRun: vi.fn(),
}));

vi.mock("../../../agents/subagent-control.js", () => ({
  sendControlledSubagentMessage,
  steerControlledSubagentRun,
}));

vi.mock("./shared.js", () => ({
  COMMAND: "/subagents",
  resolveCommandSubagentController: () => ({
    controllerSessionKey: "agent:main:main",
    callerSessionKey: "agent:main:main",
    callerIsSubagent: false,
    controlScope: "children",
  }),
  resolveSubagentEntryForToken: () => ({
    entry: {
      runId: "run-target",
      childSessionKey: "agent:main:subagent:worker",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      controllerSessionKey: "agent:main:main",
      task: "worker task",
      cleanup: "keep",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
    },
  }),
  stopWithText: (text: string) => ({
    shouldContinue: false,
    reply: { text },
  }),
}));

import { handleSubagentsSendAction } from "./action-send.js";

describe("handleSubagentsSendAction", () => {
  it("surfaces finished-state text instead of reporting a fake successful send", async () => {
    sendControlledSubagentMessage.mockResolvedValueOnce({
      status: "done",
      runId: "run-stale",
      text: "worker task is already finished.",
    });

    const result = await handleSubagentsSendAction(
      {
        params: { cfg: {} },
        handledPrefix: "/subagents",
        requesterKey: "agent:main:main",
        runs: [],
        restTokens: ["1", "continue"],
      } as never,
      false,
    );

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "worker task is already finished." },
    });
  });
});
