import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------- mocks ----------

const buildWorkspaceSkillSnapshotMock = vi.fn();
const resolveAgentSkillsFilterMock = vi.fn();

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentConfig: vi.fn().mockReturnValue(undefined),
  resolveAgentDir: vi.fn().mockReturnValue("/tmp/agent-dir"),
  resolveAgentModelFallbacksOverride: vi.fn().mockReturnValue(undefined),
  resolveAgentWorkspaceDir: vi.fn().mockReturnValue("/tmp/workspace"),
  resolveDefaultAgentId: vi.fn().mockReturnValue("default"),
  resolveAgentSkillsFilter: resolveAgentSkillsFilterMock,
}));

vi.mock("../../agents/skills.js", () => ({
  buildWorkspaceSkillSnapshot: buildWorkspaceSkillSnapshotMock,
}));

vi.mock("../../agents/skills/refresh.js", () => ({
  getSkillsSnapshotVersion: vi.fn().mockReturnValue(42),
}));

vi.mock("../../agents/workspace.js", () => ({
  ensureAgentWorkspace: vi.fn().mockResolvedValue({ dir: "/tmp/workspace" }),
}));

vi.mock("../../agents/model-catalog.js", () => ({
  loadModelCatalog: vi.fn().mockResolvedValue({ models: [] }),
}));

vi.mock("../../agents/model-selection.js", () => ({
  getModelRefStatus: vi.fn().mockReturnValue({ allowed: false }),
  isCliProvider: vi.fn().mockReturnValue(false),
  resolveAllowedModelRef: vi.fn().mockReturnValue({ ref: { provider: "openai", model: "gpt-4" } }),
  resolveConfiguredModelRef: vi.fn().mockReturnValue({ provider: "openai", model: "gpt-4" }),
  resolveHooksGmailModel: vi.fn().mockReturnValue(null),
  resolveThinkingDefault: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../agents/model-fallback.js", () => ({
  runWithModelFallback: vi.fn().mockResolvedValue({
    result: {
      payloads: [{ text: "test output" }],
      meta: { agentMeta: { usage: { input: 10, output: 20 } } },
    },
    provider: "openai",
    model: "gpt-4",
  }),
}));

vi.mock("../../agents/pi-embedded.js", () => ({
  runEmbeddedPiAgent: vi.fn().mockResolvedValue({
    payloads: [{ text: "test output" }],
    meta: { agentMeta: { usage: { input: 10, output: 20 } } },
  }),
}));

vi.mock("../../agents/context.js", () => ({
  lookupContextTokens: vi.fn().mockReturnValue(128000),
}));

vi.mock("../../agents/date-time.js", () => ({
  formatUserTime: vi.fn().mockReturnValue("2026-02-10 12:00"),
  resolveUserTimeFormat: vi.fn().mockReturnValue("24h"),
  resolveUserTimezone: vi.fn().mockReturnValue("UTC"),
}));

vi.mock("../../agents/timeout.js", () => ({
  resolveAgentTimeoutMs: vi.fn().mockReturnValue(60_000),
}));

vi.mock("../../agents/usage.js", () => ({
  deriveSessionTotalTokens: vi.fn().mockReturnValue(30),
  hasNonzeroUsage: vi.fn().mockReturnValue(false),
}));

vi.mock("../../agents/subagent-announce.js", () => ({
  runSubagentAnnounceFlow: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../agents/cli-runner.js", () => ({
  runCliAgent: vi.fn(),
}));

vi.mock("../../agents/cli-session.js", () => ({
  getCliSessionId: vi.fn().mockReturnValue(undefined),
  setCliSessionId: vi.fn(),
}));

vi.mock("../../auto-reply/thinking.js", () => ({
  normalizeThinkLevel: vi.fn().mockReturnValue(undefined),
  normalizeVerboseLevel: vi.fn().mockReturnValue("off"),
  supportsXHighThinking: vi.fn().mockReturnValue(false),
}));

vi.mock("../../cli/outbound-send-deps.js", () => ({
  createOutboundSendDeps: vi.fn().mockReturnValue({}),
}));

vi.mock("../../config/sessions.js", () => ({
  resolveAgentMainSessionKey: vi.fn().mockReturnValue("main:default"),
  resolveSessionTranscriptPath: vi.fn().mockReturnValue("/tmp/transcript.jsonl"),
  updateSessionStore: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../routing/session-key.js", () => ({
  buildAgentMainSessionKey: vi.fn().mockReturnValue("agent:default:cron:test"),
  normalizeAgentId: vi.fn((id: string) => id),
}));

vi.mock("../../infra/agent-events.js", () => ({
  registerAgentRunContext: vi.fn(),
}));

vi.mock("../../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../infra/skills-remote.js", () => ({
  getRemoteSkillEligibility: vi.fn().mockReturnValue({}),
}));

vi.mock("../../logger.js", () => ({
  logWarn: vi.fn(),
}));

vi.mock("../../security/external-content.js", () => ({
  buildSafeExternalPrompt: vi.fn().mockReturnValue("safe prompt"),
  detectSuspiciousPatterns: vi.fn().mockReturnValue([]),
  getHookType: vi.fn().mockReturnValue("unknown"),
  isExternalHookSession: vi.fn().mockReturnValue(false),
}));

vi.mock("../delivery.js", () => ({
  resolveCronDeliveryPlan: vi.fn().mockReturnValue({ requested: false }),
}));

vi.mock("./delivery-target.js", () => ({
  resolveDeliveryTarget: vi.fn().mockResolvedValue({
    channel: "discord",
    to: undefined,
    accountId: undefined,
    error: undefined,
  }),
}));

vi.mock("./helpers.js", () => ({
  isHeartbeatOnlyResponse: vi.fn().mockReturnValue(false),
  pickLastDeliverablePayload: vi.fn().mockReturnValue(undefined),
  pickLastNonEmptyTextFromPayloads: vi.fn().mockReturnValue("test output"),
  pickSummaryFromOutput: vi.fn().mockReturnValue("summary"),
  pickSummaryFromPayloads: vi.fn().mockReturnValue("summary"),
  resolveHeartbeatAckMaxChars: vi.fn().mockReturnValue(100),
}));

const resolveCronSessionMock = vi.fn();
vi.mock("./session.js", () => ({
  resolveCronSession: resolveCronSessionMock,
}));

vi.mock("../../agents/defaults.js", () => ({
  DEFAULT_CONTEXT_TOKENS: 128000,
  DEFAULT_MODEL: "gpt-4",
  DEFAULT_PROVIDER: "openai",
}));

// ---------- helpers ----------

function makeJob(overrides?: Record<string, unknown>) {
  return {
    id: "test-job",
    name: "Test Job",
    schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
    sessionTarget: "isolated",
    payload: { kind: "agentTurn", message: "test" },
    ...overrides,
  } as never;
}

function makeParams(overrides?: Record<string, unknown>) {
  return {
    cfg: {},
    deps: {} as never,
    job: makeJob(),
    message: "test",
    sessionKey: "cron:test",
    ...overrides,
  };
}

// ---------- tests ----------

describe("runCronIsolatedAgentTurn — skill filter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildWorkspaceSkillSnapshotMock.mockReturnValue({
      prompt: "<available_skills></available_skills>",
      resolvedSkills: [],
      version: 42,
    });
    resolveAgentSkillsFilterMock.mockReturnValue(undefined);
    // Fresh session object per test — prevents mutation leaking between tests
    resolveCronSessionMock.mockReturnValue({
      storePath: "/tmp/store.json",
      store: {},
      sessionEntry: {
        sessionId: "test-session-id",
        updatedAt: 0,
        systemSent: false,
        skillsSnapshot: undefined,
      },
      systemSent: false,
      isNewSession: true,
    });
  });

  it("passes agent-level skillFilter to buildWorkspaceSkillSnapshot", async () => {
    resolveAgentSkillsFilterMock.mockReturnValue(["meme-factory", "weather"]);

    const { runCronIsolatedAgentTurn } = await import("./run.js");

    const result = await runCronIsolatedAgentTurn(
      makeParams({
        cfg: { agents: { list: [{ id: "scout", skills: ["meme-factory", "weather"] }] } },
        agentId: "scout",
      }),
    );

    expect(result.status).toBe("ok");
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledOnce();
    expect(buildWorkspaceSkillSnapshotMock.mock.calls[0][1]).toHaveProperty("skillFilter", [
      "meme-factory",
      "weather",
    ]);
  });

  it("omits skillFilter when agent has no skills config", async () => {
    resolveAgentSkillsFilterMock.mockReturnValue(undefined);

    const { runCronIsolatedAgentTurn } = await import("./run.js");

    const result = await runCronIsolatedAgentTurn(
      makeParams({
        cfg: { agents: { list: [{ id: "general" }] } },
        agentId: "general",
      }),
    );

    expect(result.status).toBe("ok");
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledOnce();
    // When no skills config, skillFilter should be undefined (no filtering applied)
    expect(buildWorkspaceSkillSnapshotMock.mock.calls[0][1].skillFilter).toBeUndefined();
  });
});
