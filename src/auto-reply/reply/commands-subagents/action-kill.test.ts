import { describe, expect, it, vi } from "vitest";

const { killAllControlledSubagentRuns, killControlledSubagentRun } = vi.hoisted(() => ({
  killAllControlledSubagentRuns: vi.fn(),
  killControlledSubagentRun: vi.fn(),
}));

vi.mock("../../../agents/subagent-control.js", () => ({
  killAllControlledSubagentRuns,
  killControlledSubagentRun,
}));

vi.mock("./core.js", () => ({
  COMMAND: "/subagents",
  resolveCommandSubagentController: () => ({
    controllerSessionKey: "agent:main:main",
    callerSessionKey: "agent:main:main",
    callerIsSubagent: false,
    controlScope: "children",
  }),
  stopWithText: (text: string) => ({
    shouldContinue: false,
    reply: { text },
  }),
}));

vi.mock("../commands-subagents-read.js", () => ({
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
}));

import { handleSubagentsKillAction } from "./action-kill.js";

describe("handleSubagentsKillAction", () => {
  it("surfaces forbidden text for kill all", async () => {
    killAllControlledSubagentRuns.mockResolvedValueOnce({
      status: "forbidden",
      error: "Leaf subagents cannot control other sessions.",
      killed: 0,
      labels: [],
    });

    const result = await handleSubagentsKillAction({
      params: { cfg: {} },
      handledPrefix: "/subagents",
      requesterKey: "agent:main:main",
      runs: [],
      restTokens: ["all"],
    } as never);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "⚠️ Leaf subagents cannot control other sessions." },
    });
  });

  it("surfaces done text for a single target", async () => {
    killControlledSubagentRun.mockResolvedValueOnce({
      status: "done",
      text: "worker task is already finished.",
    });

    const result = await handleSubagentsKillAction({
      params: { cfg: {} },
      handledPrefix: "/subagents",
      requesterKey: "agent:main:main",
      runs: [],
      restTokens: ["1"],
    } as never);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "worker task is already finished." },
    });
  });
});
