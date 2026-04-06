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
    handledPrefix: "/steer",
    requesterKey: params?.requesterKey ?? "agent:main:main",
    runs: params?.runs ?? [buildRun()],
    restTokens: params?.restTokens ?? ["1", "check", "timer.ts", "instead"],
  } as Parameters<typeof handleSubagentsSendAction>[0];
}

describe("subagents steer action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("formats accepted steer replies", async () => {
    steerControlledSubagentRunMock.mockResolvedValue({
      status: "accepted",
      runId: "run-steer-1",
    });
    const result = await handleSubagentsSendAction(buildContext(), true);
    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "steered do thing (run run-stee)." },
    });
  });

  it("formats steer dispatch errors", async () => {
    steerControlledSubagentRunMock.mockResolvedValue({
      status: "error",
      error: "dispatch failed",
    });
    const result = await handleSubagentsSendAction(buildContext(), true);
    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "send failed: dispatch failed" },
    });
  });
});
