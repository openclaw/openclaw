import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { handleUsageCommand } from "./commands-session.js";
import type { HandleCommandsParams } from "./commands-types.js";

const resolveSessionAgentIdMock = vi.hoisted(() => vi.fn(() => "main"));
const loadSessionCostSummaryMock = vi.hoisted(() => vi.fn(async () => null));
const loadCostUsageSummaryMock = vi.hoisted(() =>
  vi.fn(async () => ({
    daily: [],
    totals: { totalCost: 0, missingCostEntries: 0 },
  })),
);

vi.mock("../../agents/agent-scope.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/agent-scope.js")>(
    "../../agents/agent-scope.js",
  );
  return {
    ...actual,
    resolveSessionAgentId: resolveSessionAgentIdMock,
  };
});

vi.mock("../../infra/session-cost-usage.js", () => ({
  loadSessionCostSummary: loadSessionCostSummaryMock,
  loadCostUsageSummary: loadCostUsageSummaryMock,
}));

function buildUsageParams(): HandleCommandsParams {
  return {
    cfg: {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig,
    ctx: {
      Provider: "whatsapp",
      Surface: "whatsapp",
      CommandSource: "text",
    },
    command: {
      commandBodyNormalized: "/usage cost",
      isAuthorizedSender: true,
      senderIsOwner: true,
      senderId: "owner",
      channel: "whatsapp",
      channelId: "whatsapp",
      surface: "whatsapp",
      ownerList: [],
      from: "owner",
      to: "bot",
    },
    sessionKey: "agent:target:whatsapp:direct:12345",
    agentId: "main",
    sessionEntry: {
      sessionId: "session-1",
      updatedAt: Date.now(),
    },
  } as unknown as HandleCommandsParams;
}

describe("handleUsageCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveSessionAgentIdMock.mockReturnValue("target");
    loadSessionCostSummaryMock.mockResolvedValue({
      totalCost: 1.23,
      totalTokens: 100,
      missingCostEntries: 0,
    });
    loadCostUsageSummaryMock.mockResolvedValue({
      daily: [],
      totals: { totalCost: 4.56, missingCostEntries: 0 },
    });
  });

  it("uses the canonical target session agent for /usage cost", async () => {
    const result = await handleUsageCommand(buildUsageParams(), true);

    expect(result?.shouldContinue).toBe(false);
    expect(loadSessionCostSummaryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "target",
        sessionId: "session-1",
      }),
    );
  });
});
