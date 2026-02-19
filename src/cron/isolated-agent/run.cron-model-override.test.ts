import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWithModelFallback } from "../../agents/model-fallback.js";

// ---------- mocks ----------

const resolveAgentConfigMock = vi.fn();

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentConfig: resolveAgentConfigMock,
  resolveAgentDir: vi.fn().mockReturnValue("/tmp/agent-dir"),
  resolveAgentModelFallbacksOverride: vi.fn().mockReturnValue(undefined),
  resolveAgentWorkspaceDir: vi.fn().mockReturnValue("/tmp/workspace"),
  resolveDefaultAgentId: vi.fn().mockReturnValue("default"),
  resolveAgentSkillsFilter: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../agents/skills.js", () => ({
  buildWorkspaceSkillSnapshot: vi.fn().mockReturnValue({
    prompt: "<available_skills></available_skills>",
    resolvedSkills: [],
    version: 42,
  }),
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

const resolveAllowedModelRefMock = vi.fn();
const resolveConfiguredModelRefMock = vi.fn();

vi.mock("../../agents/model-selection.js", () => ({
  getModelRefStatus: vi.fn().mockReturnValue({ allowed: false }),
  isCliProvider: vi.fn().mockReturnValue(false),
  resolveAllowedModelRef: resolveAllowedModelRefMock,
  resolveConfiguredModelRef: resolveConfiguredModelRefMock,
  resolveHooksGmailModel: vi.fn().mockReturnValue(null),
  resolveThinkingDefault: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../agents/model-fallback.js", () => ({
  runWithModelFallback: vi.fn(),
}));

const runWithModelFallbackMock = vi.mocked(runWithModelFallback);

vi.mock("../../agents/pi-embedded.js", () => ({
  runEmbeddedPiAgent: vi.fn(),
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

const updateSessionStoreMock = vi.fn().mockResolvedValue(undefined);

vi.mock("../../config/sessions.js", () => ({
  resolveAgentMainSessionKey: vi.fn().mockReturnValue("main:default"),
  resolveSessionTranscriptPath: vi.fn().mockReturnValue("/tmp/transcript.jsonl"),
  updateSessionStore: updateSessionStoreMock,
}));

vi.mock("../../routing/session-key.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../routing/session-key.js")>();
  return {
    ...actual,
    buildAgentMainSessionKey: vi.fn().mockReturnValue("agent:default:cron:test"),
    normalizeAgentId: vi.fn((id: string) => id),
  };
});

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

const { runCronIsolatedAgentTurn } = await import("./run.js");

// ---------- helpers ----------

function makeJob(overrides?: Record<string, unknown>) {
  return {
    id: "digest-job",
    name: "Daily Digest",
    schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
    sessionTarget: "isolated",
    payload: {
      kind: "agentTurn",
      message: "run daily digest",
      model: "anthropic/claude-sonnet-4-6",
    },
    ...overrides,
  } as never;
}

function makeParams(overrides?: Record<string, unknown>) {
  return {
    cfg: {},
    deps: {} as never,
    job: makeJob(),
    message: "run daily digest",
    sessionKey: "cron:digest",
    ...overrides,
  };
}

function makeFreshSessionEntry() {
  return {
    sessionId: "test-session-id",
    updatedAt: 0,
    systemSent: false,
    skillsSnapshot: undefined,
    // Crucially: no model or modelProvider — simulates a brand-new session
    model: undefined as string | undefined,
    modelProvider: undefined as string | undefined,
  };
}

// ---------- tests ----------

describe("runCronIsolatedAgentTurn — cron model override (#21057)", () => {
  let previousFastTestEnv: string | undefined;
  let sessionEntry: ReturnType<typeof makeFreshSessionEntry>;

  beforeEach(() => {
    vi.clearAllMocks();
    previousFastTestEnv = process.env.OPENCLAW_TEST_FAST;
    delete process.env.OPENCLAW_TEST_FAST;

    // Agent default model is Opus
    resolveConfiguredModelRefMock.mockReturnValue({
      provider: "anthropic",
      model: "claude-opus-4-6",
    });

    // Cron payload model override resolves to Sonnet
    resolveAllowedModelRefMock.mockReturnValue({
      ref: { provider: "anthropic", model: "claude-sonnet-4-6" },
    });

    resolveAgentConfigMock.mockReturnValue(undefined);

    sessionEntry = makeFreshSessionEntry();
    resolveCronSessionMock.mockReturnValue({
      storePath: "/tmp/store.json",
      store: {},
      sessionEntry,
      systemSent: false,
      isNewSession: true,
    });
  });

  afterEach(() => {
    if (previousFastTestEnv == null) {
      delete process.env.OPENCLAW_TEST_FAST;
      return;
    }
    process.env.OPENCLAW_TEST_FAST = previousFastTestEnv;
  });

  it("persists cron payload model on session entry even when the run throws", async () => {
    // Simulate the agent run throwing (e.g. LLM provider timeout)
    runWithModelFallbackMock.mockRejectedValueOnce(new Error("LLM provider timeout"));

    const result = await runCronIsolatedAgentTurn(makeParams());

    expect(result.status).toBe("error");

    // The session entry should record the intended cron model override (Sonnet)
    // so that sessions_list does not fall back to the agent default (Opus).
    //
    // BUG (#21057): the model is only written AFTER a successful run (line 520),
    // so it remains undefined when the run throws at the catch on line 502.
    expect(sessionEntry.model).toBe("claude-sonnet-4-6");
    expect(sessionEntry.modelProvider).toBe("anthropic");
  });

  it("persists cron payload model before the run starts (pre-run persist)", async () => {
    // Simulate a successful run
    runWithModelFallbackMock.mockResolvedValueOnce({
      result: {
        payloads: [{ text: "digest complete" }],
        meta: {
          agentMeta: {
            model: "claude-sonnet-4-6",
            provider: "anthropic",
            usage: { input: 100, output: 50 },
          },
        },
      },
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });

    await runCronIsolatedAgentTurn(makeParams());

    // The pre-run persist (line 432) should already include the cron model
    // override so that even a concurrent sessions_list call sees Sonnet, not
    // the agent default Opus.
    //
    // Inspect the updateSessionStore calls: the pre-run persist happens before
    // the run, and the post-run persist happens after.  Both should carry the
    // cron override model — not undefined.
    const preRunCalls = updateSessionStoreMock.mock.calls;
    expect(preRunCalls.length).toBeGreaterThanOrEqual(2);

    // Execute the pre-run persist callback (second call — first is skills snapshot)
    // against a fresh store to capture what it would write.
    const preRunStore: Record<string, unknown> = {};
    const preRunCallback = preRunCalls[1][1] as (store: Record<string, unknown>) => void;
    preRunCallback(preRunStore);

    const preRunEntry = Object.values(preRunStore)[0] as {
      model?: string;
      modelProvider?: string;
    };
    expect(preRunEntry.model).toBe("claude-sonnet-4-6");
    expect(preRunEntry.modelProvider).toBe("anthropic");
  });
});
