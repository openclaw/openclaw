import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type {
  CostUsageSummary,
  CostUsageTotals,
  SessionCostSummary,
} from "../../infra/session-cost-usage.js";
import { handleUsageCommand } from "./commands-session.js";
import type { HandleCommandsParams } from "./commands-types.js";

const resolveSessionAgentIdMock = vi.hoisted(() => vi.fn(() => "main"));
const loadSessionCostSummaryMock = vi.hoisted(() =>
  vi.fn<() => Promise<SessionCostSummary | null>>(async () => null),
);
const loadCostUsageSummaryMock = vi.hoisted(() =>
  vi.fn<() => Promise<CostUsageSummary>>(async () => ({
    updatedAt: 0,
    days: 30,
    daily: [],
    totals: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      totalCost: 0,
      inputCost: 0,
      outputCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      missingCostEntries: 0,
    },
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

function buildCostTotals(overrides: Partial<CostUsageTotals> = {}): CostUsageTotals {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    totalCost: 0,
    inputCost: 0,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    missingCostEntries: 0,
    ...overrides,
  };
}

describe("handleUsageCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveSessionAgentIdMock.mockReturnValue("target");
    loadSessionCostSummaryMock.mockResolvedValue({
      ...buildCostTotals({
        totalCost: 1.23,
        totalTokens: 100,
        missingCostEntries: 0,
      }),
    });
    loadCostUsageSummaryMock.mockResolvedValue({
      updatedAt: 0,
      days: 30,
      daily: [],
      totals: buildCostTotals({
        totalCost: 4.56,
        missingCostEntries: 0,
      }),
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
