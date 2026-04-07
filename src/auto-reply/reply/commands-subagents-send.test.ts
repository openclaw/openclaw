import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentRunRecord } from "../../agents/subagent-registry.types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { handleSubagentsSendAction } from "./commands-subagents/action-send.js";

const sendControlledSubagentMessageMock = vi.hoisted(() => vi.fn());
const steerControlledSubagentRunMock = vi.hoisted(() => vi.fn());

vi.mock("./commands-subagents-control.runtime.js", () => ({
  sendControlledSubagentMessage: sendControlledSubagentMessageMock,
  steerControlledSubagentRun: steerControlledSubagentRunMock,
}));

function buildRun(): SubagentRunRecord {
  return {
    runId: "run-1",
    childSessionKey: "agent:main:subagent:abc",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "do thing",
    cleanup: "keep",
    createdAt: 1000,
    startedAt: 1000,
  };
}

function buildContext(params?: {
  cfg?: OpenClawConfig;
  requesterKey?: string;
  runs?: SubagentRunRecord[];
  restTokens?: string[];
}) {
  return {
    params: {
      cfg:
        params?.cfg ??
        ({
          commands: { text: true },
          channels: { whatsapp: { allowFrom: ["*"] } },
        } as OpenClawConfig),
      ctx: {},
      command: {
        channel: "whatsapp",
        to: "test-bot",
      },
    },
    handledPrefix: "/subagents",
    requesterKey: params?.requesterKey ?? "agent:main:main",
    runs: params?.runs ?? [buildRun()],
    restTokens: params?.restTokens ?? ["1", "continue", "with", "follow-up", "details"],
  } as Parameters<typeof handleSubagentsSendAction>[0];
}

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
});
