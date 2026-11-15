import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type {
  CostUsageSummary,
  CostUsageTotals,
  SessionCostSummary,
} from "../../infra/session-cost-usage.js";
import { withTempDir } from "../../test-utils/temp-dir.js";
import { buildSessionCommandTestParams } from "./commands-session-params.test-support.js";
import { handleFastCommand, handleUsageCommand } from "./commands-session.js";
import type { HandleCommandsParams } from "./commands-types.js";

const resolveSessionAgentIdMock = vi.hoisted(() => vi.fn(() => "main"));
const loadSessionCostSummaryMock = vi.hoisted(() =>
  vi.fn<() => Promise<SessionCostSummary | null>>(),
);
const loadCostUsageSummaryMock = vi.hoisted(() => vi.fn<() => Promise<CostUsageSummary>>());
type FastModeStateMockResult = {
  mode: boolean | "auto" | undefined;
  enabled: boolean;
  source: "session" | "agent" | "config" | "default";
  fastAutoOnSeconds?: number;
};
const resolveFastModeStateMock = vi.hoisted(() => vi.fn<() => FastModeStateMockResult>());

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

function entry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return { sessionId: "target-session", updatedAt: Date.now(), ...overrides };
}

function buildUsageParams(
  command = "/usage cost",
  overrides: Partial<Omit<HandleCommandsParams, "command">> = {},
): HandleCommandsParams {
  return buildSessionCommandTestParams(
    {
      commandBodyNormalized: command,
      rawBodyNormalized: command,
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
    {
      cfg: { commands: { text: true }, channels: { whatsapp: { allowFrom: ["*"] } } },
      ctx: { Provider: "whatsapp", Surface: "whatsapp", CommandSource: "text" },
      sessionKey: "agent:target:whatsapp:direct:12345",
      agentId: "target",
      sessionEntry: entry({ sessionId: "session-1" }),
      ...overrides,
    },
  );
}

function fastParams(command = "/fast status", overrides: Partial<HandleCommandsParams> = {}) {
  return buildUsageParams(command, { provider: "openai", model: "gpt-5.4", ...overrides });
}

function setTarget(params: HandleCommandsParams, target: SessionEntry) {
  params.sessionStore = { [params.sessionKey]: target };
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

function expectArgs(mock: { mock: { calls: unknown[][] } }, expected: object) {
  expect(mock).toHaveBeenCalledTimes(1);
  expect(mock.mock.calls[0]?.[0]).toMatchObject(expected);
}

describe("handleUsageCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveSessionAgentIdMock.mockReturnValue("target");
    loadSessionCostSummaryMock.mockResolvedValue(
      buildCostTotals({ totalCost: 1.23, totalTokens: 100 }),
    );
    loadCostUsageSummaryMock.mockResolvedValue({
      updatedAt: 0,
      days: 30,
      daily: [],
      totals: buildCostTotals({ totalCost: 4.56 }),
    });
  });

  it("uses the canonical target session agent for /usage cost", async () => {
    const result = await handleUsageCommand(buildUsageParams(), true);

    expect(result?.shouldContinue).toBe(false);
    expectArgs(loadSessionCostSummaryMock, {
      agentId: "target",
      sessionId: "session-1",
    });
    expect(loadCostUsageSummaryMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "target" }),
    );
  });

  it("keeps the current agent for an unqualified global session key", async () => {
    const params = buildUsageParams(undefined, { agentId: "other", sessionKey: "global" });

    await handleUsageCommand(params, true);

    expectArgs(loadSessionCostSummaryMock, {
      agentId: "other",
      sessionTarget: { agentId: "other", sessionKey: "global" },
    });
    expect(resolveSessionAgentIdMock).not.toHaveBeenCalled();
  });

  it("prefers the target session entry from sessionStore for /usage cost", async () => {
    const params = buildUsageParams(undefined, {
      storePath: "/tmp/custom-session-store.sqlite",
      sessionEntry: entry({ sessionId: "wrapper-session" }),
    });
    setTarget(params, entry());

    await handleUsageCommand(params, true);

    expectArgs(loadSessionCostSummaryMock, {
      sessionId: "target-session",
      sessionTarget: {
        agentId: "target",
        sessionId: "target-session",
        sessionKey: params.sessionKey,
        storePath: params.storePath,
      },
    });
  });

  it.each<
    [
      name: string,
      command: string,
      targetUsage: "off" | undefined,
      configDefault: "tokens" | undefined,
      expectedUsage: "full" | "tokens" | undefined,
      text: string,
    ]
  >([
    ["config default toggle", "/usage", undefined, "tokens", "full", "full"],
    ["reset override", "/usage reset", "off", undefined, undefined, "reset to default"],
    ["explicit off beats default", "/usage", "off", "tokens", "tokens", "tokens"],
  ])("%s", async (_name, command, targetUsage, configDefault, expectedUsage, text) => {
    const params = buildUsageParams(command);
    if (configDefault) {
      params.cfg = { ...params.cfg, messages: { responseUsage: configDefault } };
    }
    setTarget(params, entry({ responseUsage: targetUsage }));
    expect(await handleUsageCommand(params, true)).toMatchObject({
      shouldContinue: false,
      reply: { text: `⚙️ Usage footer: ${text}.` },
    });
    expect(params.sessionStore?.[params.sessionKey]?.responseUsage).toBe(expectedUsage);
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
    const params = fastParams();

    const result = await handleFastCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expectArgs(resolveFastModeStateMock, {
      agentId: "target",
      provider: "openai",
      model: "gpt-5.4",
    });
    expect(result?.reply?.text).toContain("Current fast mode: on");
  });

  it("prefers the target session entry from sessionStore for /fast status", async () => {
    const params = fastParams(undefined, {
      sessionEntry: entry({ sessionId: "wrapper-session", fastMode: false }),
    });
    setTarget(params, entry({ fastMode: true }));

    await handleFastCommand(params, true);

    expectArgs(resolveFastModeStateMock, {
      sessionEntry: { sessionId: "target-session", fastMode: true },
    });
  });

  it.each(["/fast ultrafast", "/fast ultra", "/fast ULTRA"])(
    "keeps the %s reply without a target entry",
    async (command) => {
      const params = fastParams(command, { sessionEntry: undefined });

      expect(await handleFastCommand(params, true)).toEqual({
        shouldContinue: false,
        reply: { text: "⚙️ Ultrafast mode enabled." },
      });
      expect(params.sessionStore).toBeUndefined();
      expect(resolveFastModeStateMock).not.toHaveBeenCalled();
    },
  );

  it.each(["/fast invalid", "/fast ultr", "/fast ultra-fast"])(
    "rejects invalid %s without mutating the target",
    async (command) => {
      const target = entry({ updatedAt: 1, fastMode: true });
      const params = fastParams(command, { sessionEntry: target });
      setTarget(params, target);

      expect(await handleFastCommand(params, true)).toEqual({
        shouldContinue: false,
        reply: { text: "⚙️ Usage: /fast status|auto|on|off|ultrafast|default" },
      });
      expect(target).toEqual({ sessionId: "target-session", updatedAt: 1, fastMode: true });
      expect(resolveFastModeStateMock).not.toHaveBeenCalled();
    },
  );

  it("reports a /fast default persistence conflict", async () => {
    await withTempDir("openclaw-fast-conflict-", async (dir) => {
      const target = entry({ sessionId: "missing-session", updatedAt: 1, fastMode: true });
      const params = fastParams("/fast default", {
        storePath: path.join(dir, "sessions.json"),
        sessionEntry: target,
        initialSessionEntry: { ...target },
      });
      setTarget(params, target);

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
