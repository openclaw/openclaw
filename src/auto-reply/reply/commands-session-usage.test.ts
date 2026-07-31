// Tests session usage command output and token accounting summaries.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type {
  CostUsageSummary,
  CostUsageTotals,
  SessionCostSummary,
} from "../../infra/session-cost-usage.js";
import { handleFastCommand, handleStreamCommand, handleUsageCommand } from "./commands-session.js";
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
  wrapperUsage?: "off" | "tokens" | "full";
  configDefault?: "off" | "tokens" | "full";
  shareTargetEntry?: boolean;
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
const getChannelPluginMock = vi.hoisted(() =>
  vi.fn(() => ({ capabilities: { previewStreamingSessionOverride: true } })),
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

vi.mock("../../channels/plugins/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../channels/plugins/index.js")>(
    "../../channels/plugins/index.js",
  );
  return {
    ...actual,
    getChannelPlugin: getChannelPluginMock,
  };
});

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

function expectSessionCostArgs(): Record<string, unknown> {
  expect(loadSessionCostSummaryMock).toHaveBeenCalledTimes(1);
  const call = loadSessionCostSummaryMock.mock.calls[0] as unknown[] | undefined;
  if (!call) {
    throw new Error("expected loadSessionCostSummary call");
  }
  const args = call[0];
  if (!args || typeof args !== "object") {
    throw new Error("expected loadSessionCostSummary args");
  }
  return args as Record<string, unknown>;
}

function expectFastModeArgs(): Record<string, unknown> {
  expect(resolveFastModeStateMock).toHaveBeenCalledTimes(1);
  const call = resolveFastModeStateMock.mock.calls[0] as unknown[] | undefined;
  if (!call) {
    throw new Error("expected resolveFastModeState call");
  }
  const args = call[0];
  if (!args || typeof args !== "object") {
    throw new Error("expected resolveFastModeState args");
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
    const args = expectSessionCostArgs();
    expect(args.agentId).toBe("target");
    expect(args.sessionId).toBe("session-1");
    expect(loadCostUsageSummaryMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "target" }),
    );
  });

  it("keeps the current agent for an unqualified global session key", async () => {
    const params = buildUsageParams();
    params.agentId = "other";
    params.sessionKey = "global";

    await handleUsageCommand(params, true);

    const args = expectSessionCostArgs();
    expect(args.agentId).toBe("other");
    expect(args.sessionTarget).toMatchObject({ agentId: "other", sessionKey: "global" });
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

    const args = expectSessionCostArgs();
    expect(args.sessionId).toBe("target-session");
    expect(args.sessionTarget).toMatchObject({
      agentId: "target",
      sessionId: "target-session",
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    });
  });

  it.each([
    {
      name: "prefers the target session entry from sessionStore for /usage footer mode",
      command: "/usage",
      targetUsage: "tokens",
      wrapperUsage: "off",
      expectedUsage: "full",
      expectedText: "⚙️ Usage footer: full.",
    },
    {
      name: "updates usage footer mode as a session preference",
      command: "/usage tokens",
      targetUsage: "full",
      shareTargetEntry: true,
      expectedUsage: "tokens",
      expectedText: "⚙️ Usage footer: tokens.",
    },
    {
      name: "persists an explicit /usage off so a configured default cannot re-enable it",
      command: "/usage off",
      targetUsage: "tokens",
      expectedUsage: "off",
      expectedText: "⚙️ Usage footer: off.",
    },
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
      name: "/usage inherit (alias) clears the session override",
      command: "/usage inherit",
      targetUsage: "full",
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
    const params = buildUsageParams();
    params.command.commandBodyNormalized = scenario.command;
    if (scenario.configDefault) {
      params.cfg = { ...params.cfg, messages: { responseUsage: scenario.configDefault } };
    }
    const targetEntry: NonNullable<HandleCommandsParams["sessionEntry"]> = {
      sessionId: "target-session",
      updatedAt: Date.now(),
      ...(scenario.targetUsage ? { responseUsage: scenario.targetUsage } : {}),
    };
    params.sessionStore = { [params.sessionKey]: targetEntry };
    if (scenario.shareTargetEntry) {
      params.sessionEntry = targetEntry;
    } else if (scenario.wrapperUsage) {
      params.sessionEntry = {
        sessionId: "wrapper-session",
        updatedAt: Date.now(),
        responseUsage: scenario.wrapperUsage,
      };
    }

    const result = await handleUsageCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toBe(scenario.expectedText);
    expect(params.sessionStore[params.sessionKey]?.responseUsage).toBe(scenario.expectedUsage);
    if (scenario.shareTargetEntry) {
      expect(params.sessionEntry?.responseUsage).toBe(scenario.expectedUsage);
    }
    if (scenario.wrapperUsage) {
      expect(params.sessionEntry?.responseUsage).toBe(scenario.wrapperUsage);
    }
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
    const params = buildUsageParams();
    params.command.commandBodyNormalized = "/fast status";
    params.provider = "openai";
    params.model = "gpt-5.4";

    const result = await handleFastCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    const args = expectFastModeArgs();
    expect(args.agentId).toBe("target");
    expect(args.provider).toBe("openai");
    expect(args.model).toBe("gpt-5.4");
    expect(result?.reply?.text).toContain("Current fast mode: on");
  });

  it("shows the resolved auto threshold for /fast status", async () => {
    resolveFastModeStateMock.mockReturnValue({
      mode: "auto",
      enabled: true,
      source: "config",
      fastAutoOnSeconds: 30,
    });
    const params = buildUsageParams();
    params.command.commandBodyNormalized = "/fast status";
    params.provider = "openai-codex";
    params.model = "gpt-5.5";

    const result = await handleFastCommand(params, true);

    expect(result?.reply?.text).toContain("Current fast mode: auto (30 sec) (default: model)");
  });

  it("prefers the target session entry from sessionStore for /fast status", async () => {
    const params = buildUsageParams();
    params.command.commandBodyNormalized = "/fast status";
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

    const args = expectFastModeArgs();
    const sessionEntry = args.sessionEntry as Record<string, unknown> | undefined;
    expect(sessionEntry?.sessionId).toBe("target-session");
    expect(sessionEntry?.fastMode).toBe(true);
  });

  it("clears fast mode for /fast default", async () => {
    const params = buildUsageParams();
    params.command.commandBodyNormalized = "/fast default";
    params.sessionEntry = {
      sessionId: "target-session",
      updatedAt: Date.now(),
      fastMode: true,
    };
    params.sessionStore = { [params.sessionKey]: params.sessionEntry };

    const result = await handleFastCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toBe("⚙️ Fast mode reset to default.");
    expect(params.sessionEntry.fastMode).toBeUndefined();
    expect(params.sessionStore[params.sessionKey]?.fastMode).toBeUndefined();
  });

  it("clears fast mode on the target store entry for /fast default", async () => {
    const params = buildUsageParams();
    params.command.commandBodyNormalized = "/fast default";
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

    const result = await handleFastCommand(params, true);

    expect(result?.reply?.text).toBe("⚙️ Fast mode reset to default.");
    expect(params.sessionEntry.fastMode).toBe(false);
    expect(params.sessionStore[params.sessionKey]?.fastMode).toBeUndefined();
  });
});

describe("handleStreamCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveSessionAgentIdMock.mockReturnValue("target");
    getChannelPluginMock.mockReturnValue({
      capabilities: { previewStreamingSessionOverride: true },
    });
  });

  it("sets stream mode on the target store entry", async () => {
    const params = buildUsageParams();
    params.command.commandBodyNormalized = "/stream progress";
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

    const result = await handleStreamCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toBe("⚙️ Stream mode set to progress.");
    expect(params.sessionEntry.streamingMode).toBeUndefined();
    expect(params.sessionStore[params.sessionKey]?.streamingMode).toBe("progress");
  });

  it("handles the /streaming alias and persists the override", async () => {
    const params = buildUsageParams();
    params.command.commandBodyNormalized = "/streaming block";
    const sessionEntry = params.sessionEntry;
    if (!sessionEntry) {
      throw new Error("expected session entry");
    }
    params.sessionStore = { [params.sessionKey]: sessionEntry };

    const result = await handleStreamCommand(params, true);

    expect(result?.reply?.text).toBe("⚙️ Stream mode set to block.");
    expect(sessionEntry.streamingMode).toBe("block");
  });

  it("maps /stream final to canonical off mode", async () => {
    const params = buildUsageParams();
    params.command.commandBodyNormalized = "/stream final";
    const sessionEntry = params.sessionEntry;
    if (!sessionEntry) {
      throw new Error("expected session entry");
    }
    params.sessionStore = { [params.sessionKey]: sessionEntry };

    const result = await handleStreamCommand(params, true);

    expect(result?.reply?.text).toBe("⚙️ Stream mode set to off (final-only).");
    expect(sessionEntry.streamingMode).toBe("off");
  });

  it("reports session override status without pretending config defaults are active", async () => {
    const params = buildUsageParams();
    params.command.commandBodyNormalized = "/stream status";
    params.sessionStore = {
      [params.sessionKey]: {
        sessionId: "target-session",
        updatedAt: Date.now(),
        streamingMode: "block",
      },
    };

    const result = await handleStreamCommand(params, true);

    expect(result?.reply?.text).toBe("⚙️ Current stream mode: block (session).");
  });

  it("reports inherited channel config status when no session override is set", async () => {
    const params = buildUsageParams();
    params.command.commandBodyNormalized = "/stream status";
    params.cfg = {
      commands: { text: true },
      channels: { whatsapp: { streaming: { mode: "off" } } },
    } as OpenClawConfig;

    const result = await handleStreamCommand(params, true);

    expect(result?.reply?.text).toBe("⚙️ Current stream mode: off (final-only) (channel config).");
  });

  it("reports the supported channel default when no override or config is set", async () => {
    const params = buildUsageParams();
    params.command.commandBodyNormalized = "/stream status";

    const result = await handleStreamCommand(params, true);

    expect(result?.reply?.text).toBe("⚙️ Current stream mode: partial (channel default).");
  });

  it("clears stream mode for /stream default", async () => {
    const params = buildUsageParams();
    params.command.commandBodyNormalized = "/stream default";
    params.sessionEntry = {
      sessionId: "target-session",
      updatedAt: Date.now(),
      streamingMode: "progress",
    };
    params.sessionStore = { [params.sessionKey]: params.sessionEntry };

    const result = await handleStreamCommand(params, true);

    expect(result?.reply?.text).toBe("⚙️ Stream mode reset to channel default.");
    expect(params.sessionEntry.streamingMode).toBeUndefined();
  });

  it("does not persist stream mode on channels that do not honor the override", async () => {
    getChannelPluginMock.mockReturnValue({
      capabilities: { previewStreamingSessionOverride: false },
    });
    const params = buildUsageParams();
    params.command.commandBodyNormalized = "/stream progress";
    const sessionEntry = params.sessionEntry;
    if (!sessionEntry) {
      throw new Error("expected session entry");
    }
    params.sessionStore = { [params.sessionKey]: sessionEntry };

    const result = await handleStreamCommand(params, true);

    expect(result?.reply?.text).toBe("⚙️ /stream isn't supported on this channel yet.");
    expect(sessionEntry.streamingMode).toBeUndefined();
  });
});
