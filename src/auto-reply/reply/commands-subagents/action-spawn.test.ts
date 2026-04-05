import { describe, expect, it, vi } from "vitest";

const { spawnSubagentDirect } = vi.hoisted(() => ({
  spawnSubagentDirect: vi.fn(),
}));

vi.mock("../../../agents/subagent-spawn.js", () => ({
  spawnSubagentDirect,
}));

vi.mock("./core.js", () => ({
  stopWithText: (text: string) => ({
    shouldContinue: false,
    reply: { text },
  }),
}));

import { handleSubagentsSpawnAction } from "./action-spawn.js";

describe("handleSubagentsSpawnAction", () => {
  it("shows usage when required args are missing", async () => {
    const result = await handleSubagentsSpawnAction({
      params: { cfg: {}, command: {}, ctx: {} },
      requesterKey: "agent:main:main",
      runs: [],
      restTokens: [],
    } as never);

    expect(result.reply?.text).toContain(
      "Usage: /subagents spawn <agentId> <task> [--model <model>] [--thinking <level>]",
    );
  });

  it("surfaces accepted spawn details", async () => {
    spawnSubagentDirect.mockResolvedValueOnce({
      status: "accepted",
      childSessionKey: "agent:writer:main",
      runId: "run-12345678",
    });

    const result = await handleSubagentsSpawnAction({
      params: {
        cfg: {},
        command: { channel: "slack", to: "C123" },
        ctx: { AccountId: "acct", OriginatingChannel: "slack", To: "C123" },
        sessionEntry: {},
      },
      requesterKey: "agent:main:main",
      runs: [],
      restTokens: ["writer", "draft", "spec"],
    } as never);

    expect(spawnSubagentDirect).toHaveBeenCalled();
    expect(result.reply?.text).toContain("Spawned subagent writer");
    expect(result.reply?.text).toContain("agent:writer:main");
  });
});
