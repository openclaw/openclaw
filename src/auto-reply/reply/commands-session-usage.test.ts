// Tests session usage command output and token accounting summaries.
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import type {
  CostUsageSummary,
  CostUsageTotals,
  SessionCostSummary,
} from "../../infra/session-cost-usage.js";
import { withTempDir } from "../../test-utils/temp-dir.js";
import { handleFastCommand, handleUsageCommand } from "./commands-session.js";
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
type FastModeStateMockResult = {
  mode: boolean | "auto" | undefined;
  enabled: boolean;
  source: "session" | "agent" | "config" | "default";
  fastAutoOnSeconds?: number;
};
type UsageFooterScenario = {
  name: string;
  command: string;
  targetUsage?: "off" | "tokens" | "full";
  configDefault?: "off" | "tokens" | "full";
  expectedUsage: "off" | "tokens" | "full" | undefined;
  expectedText: string;
};
const resolveFastModeStateMock = vi.hoisted(() =>
  vi.fn<() => FastModeStateMockResult>(() => ({
    mode: true,
    enabled: true,
    source: "agent",
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

vi.mock("../../agents/fast-mode.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/fast-mode.js")>(
    "../../agents/fast-mode.js",
  );
  return {
    ...actual,
    resolveFastModeState: resolveFastModeStateMock,
  };
});

function buildUsageParams(command = "/usage cost"): HandleCommandsParams {
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
      commandBodyNormalized: command,
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
    agentId: "target",
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

function expectArgs(mock: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  expect(mock).toHaveBeenCalledTimes(1);
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error("expected mock call");
  }
  const args = call[0];
  if (!args || typeof args !== "object") {
    throw new Error("expected mock args");
  }
  return args as Record<string, unknown>;
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
    expect(expectArgs(loadSessionCostSummaryMock)).toMatchObject({
      agentId: "target",
      sessionId: "session-1",
    });
    expect(loadCostUsageSummaryMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "target" }),
    );
  });

  it("keeps the current agent for an unqualified global session key", async () => {
    const params = buildUsageParams();
    params.agentId = "other";
    params.sessionKey = "global";

    await handleUsageCommand(params, true);

    expect(expectArgs(loadSessionCostSummaryMock)).toMatchObject({
      agentId: "other",
      sessionTarget: { agentId: "other", sessionKey: "global" },
    });
    expect(resolveSessionAgentIdMock).not.toHaveBeenCalled();
  });

  it("prefers the target session entry from sessionStore for /usage cost", async () => {
    const params = buildUsageParams();
    params.storePath = "/tmp/custom-session-store.sqlite";
    params.sessionEntry = {
      sessionId: "wrapper-session",
      updatedAt: Date.now(),
    };
    params.sessionStore = {
      [params.sessionKey]: {
        sessionId: "target-session",
        updatedAt: Date.now(),
      },
    };

    await handleUsageCommand(params, true);

    expect(expectArgs(loadSessionCostSummaryMock)).toMatchObject({
      sessionId: "target-session",
      sessionTarget: {
        agentId: "target",
        sessionId: "target-session",
        sessionKey: params.sessionKey,
        storePath: params.storePath,
      },
    });
  });

  it.each([
    {
      name: "no-arg toggle uses the effective mode (config default) when session is unset",
      command: "/usage",
      configDefault: "tokens",
      expectedUsage: "full",
      expectedText: "⚙️ Usage footer: full.",
    },
    {
      name: "/usage reset clears the session override so the config default takes over",
      command: "/usage reset",
      targetUsage: "off",
      expectedUsage: undefined,
      expectedText: "⚙️ Usage footer: reset to default.",
    },
    {
      name: "explicit off is stored and not treated as unset — config default cannot override it",
      command: "/usage",
      targetUsage: "off",
      configDefault: "tokens",
      expectedUsage: "tokens",
      expectedText: "⚙️ Usage footer: tokens.",
    },
  ] satisfies UsageFooterScenario[])("$name", async (scenario: UsageFooterScenario) => {
    const params = buildUsageParams(scenario.command);
    if (scenario.configDefault) {
      params.cfg = { ...params.cfg, messages: { responseUsage: scenario.configDefault } };
    }
    const targetEntry: NonNullable<HandleCommandsParams["sessionEntry"]> = {
      sessionId: "target-session",
      updatedAt: Date.now(),
      ...(scenario.targetUsage ? { responseUsage: scenario.targetUsage } : {}),
    };
    params.sessionStore = { [params.sessionKey]: targetEntry };

    const result = await handleUsageCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toBe(scenario.expectedText);
    expect(params.sessionStore[params.sessionKey]?.responseUsage).toBe(scenario.expectedUsage);
  });
});

describe("handleFastCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveSessionAgentIdMock.mockReturnValue("target");
    resolveFastModeStateMock.mockReturnValue({
      mode: true,
      enabled: true,
      source: "agent",
    });
  });

  it("uses the canonical target session agent for /fast status", async () => {
    const params = buildUsageParams("/fast status");
    params.provider = "openai";
    params.model = "gpt-5.4";

    const result = await handleFastCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(expectArgs(resolveFastModeStateMock)).toMatchObject({
      agentId: "target",
      provider: "openai",
      model: "gpt-5.4",
    });
    expect(result?.reply?.text).toContain("Current fast mode: on");
  });

  it("prefers the target session entry from sessionStore for /fast status", async () => {
    const params = buildUsageParams("/fast status");
    params.provider = "openai";
    params.model = "gpt-5.4";
    params.sessionEntry = {
      sessionId: "wrapper-session",
      updatedAt: Date.now(),
      fastMode: false,
    };
    params.sessionStore = {
      [params.sessionKey]: {
        sessionId: "target-session",
        updatedAt: Date.now(),
        fastMode: true,
      },
    };

    await handleFastCommand(params, true);

    expect(expectArgs(resolveFastModeStateMock)).toMatchObject({
      sessionEntry: { sessionId: "target-session", fastMode: true },
    });
  });

  it.each([["ultrafast", "⚙️ Ultrafast mode enabled."]])(
    "keeps the /fast %s reply without a target entry",
    async (mode, text) => {
      const params = buildUsageParams(`/fast ${mode}`);
      params.sessionEntry = undefined;

      expect(await handleFastCommand(params, true)).toEqual({
        shouldContinue: false,
        reply: { text },
      });
      expect(params.sessionStore).toBeUndefined();
      expect(resolveFastModeStateMock).not.toHaveBeenCalled();
    },
  );

  it("rejects an invalid /fast mode without mutating the target", async () => {
    const params = buildUsageParams("/fast invalid");
    const target = { sessionId: "target-session", updatedAt: 1, fastMode: true };
    params.sessionEntry = target;
    params.sessionStore = { [params.sessionKey]: target };

    expect(await handleFastCommand(params, true)).toEqual({
      shouldContinue: false,
      reply: { text: "⚙️ Usage: /fast status|auto|on|off|ultrafast|default" },
    });
    expect(target).toEqual({ sessionId: "target-session", updatedAt: 1, fastMode: true });
    expect(resolveFastModeStateMock).not.toHaveBeenCalled();
  });

  it.each(["default"])("reports a /fast %s persistence conflict", async (mode) => {
    await withTempDir("openclaw-fast-conflict-", async (dir) => {
      const params = buildUsageParams(`/fast ${mode}`);
      params.storePath = path.join(dir, "sessions.json");
      const target = { sessionId: "missing-session", updatedAt: 1, fastMode: true };
      params.sessionEntry = target;
      params.initialSessionEntry = { ...target };
      params.sessionStore = { [params.sessionKey]: target };

      expect(await handleFastCommand(params, true)).toEqual({
        shouldContinue: false,
        reply: {
          text: "⚠️ Session changed before this setting could be saved. Retry the command.",
        },
      });
      expect(
        loadSessionEntry({ storePath: params.storePath, sessionKey: params.sessionKey }),
      ).toBeUndefined();
    });
  });
});
