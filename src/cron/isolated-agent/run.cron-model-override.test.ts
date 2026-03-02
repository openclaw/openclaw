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

vi.mock("../../agents/model-selection.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/model-selection.js")>();
  return {
    ...actual,
    getModelRefStatus: vi.fn().mockReturnValue({ allowed: false }),
    isCliProvider: vi.fn().mockReturnValue(false),
    resolveAllowedModelRef: resolveAllowedModelRefMock,
    resolveConfiguredModelRef: resolveConfiguredModelRefMock,
    resolveHooksGmailModel: vi.fn().mockReturnValue(null),
    resolveThinkingDefault: vi.fn().mockReturnValue(undefined),
  };
});

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
  setSessionRuntimeModel: vi.fn(),
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

const logWarnMock = vi.fn();
vi.mock("../../logger.js", () => ({
  logWarn: logWarnMock,
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

function makeFreshSessionEntry(overrides?: Record<string, unknown>) {
  return {
    sessionId: "test-session-id",
    updatedAt: 0,
    systemSent: false,
    skillsSnapshot: undefined,
    // Crucially: no model or modelProvider — simulates a brand-new session
    model: undefined as string | undefined,
    modelProvider: undefined as string | undefined,
    ...overrides,
  };
}

function makeSuccessfulRunResult(overrides?: Record<string, unknown>) {
  return {
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
    attempts: [],
    ...overrides,
  };
}

// ---------- tests ----------

describe("runCronIsolatedAgentTurn — cron model override (#21057)", () => {
  let previousFastTestEnv: string | undefined;
  // Hold onto the cron session *object* — the code may reassign its
  // `sessionEntry` property (e.g. during skills snapshot refresh), so
  // checking a stale reference would give a false negative.
  let cronSession: { sessionEntry: ReturnType<typeof makeFreshSessionEntry>; [k: string]: unknown };

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
    updateSessionStoreMock.mockResolvedValue(undefined);

    cronSession = {
      storePath: "/tmp/store.json",
      store: {},
      sessionEntry: makeFreshSessionEntry(),
      systemSent: false,
      isNewSession: true,
    };
    resolveCronSessionMock.mockReturnValue(cronSession);
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
    // BUG (#21057): before the fix, the model was only written to the session
    // entry AFTER a successful run (in the post-run telemetry block), so it
    // remained undefined when the run threw in the catch block.
    expect(cronSession.sessionEntry.model).toBe("claude-sonnet-4-6");
    expect(cronSession.sessionEntry.modelProvider).toBe("anthropic");
    expect(cronSession.sessionEntry.systemSent).toBe(true);
  });

  it("session entry already carries cron model at pre-run persist time (race condition)", async () => {
    // Capture a deep snapshot of the session entry at each persist call so we
    // can inspect what sessions_list would see mid-run — before the post-run
    // persist overwrites the entry with the actual model from agentMeta.
    const persistedSnapshots: Array<{
      model?: string;
      modelProvider?: string;
      systemSent?: boolean;
    }> = [];
    updateSessionStoreMock.mockImplementation(
      async (_path: string, cb: (s: Record<string, unknown>) => void) => {
        const store: Record<string, unknown> = {};
        cb(store);
        const entry = Object.values(store)[0] as
          | { model?: string; modelProvider?: string; systemSent?: boolean }
          | undefined;
        if (entry) {
          persistedSnapshots.push(JSON.parse(JSON.stringify(entry)));
        }
      },
    );

    runWithModelFallbackMock.mockResolvedValueOnce(makeSuccessfulRunResult());

    await runCronIsolatedAgentTurn(makeParams());

    // Persist ordering: [0] skills snapshot, [1] pre-run model+systemSent,
    // [2] post-run telemetry.  Index 1 is what a concurrent sessions_list
    // would read while the agent run is in flight.
    expect(persistedSnapshots.length).toBeGreaterThanOrEqual(3);
    const preRunSnapshot = persistedSnapshots[1];
    expect(preRunSnapshot.model).toBe("claude-sonnet-4-6");
    expect(preRunSnapshot.modelProvider).toBe("anthropic");
    expect(preRunSnapshot.systemSent).toBe(true);
  });

  it("returns error without persisting model when payload model is disallowed", async () => {
    resolveAllowedModelRefMock.mockReturnValueOnce({
      error: "Model not allowed: anthropic/claude-sonnet-4-6",
    });

    const result = await runCronIsolatedAgentTurn(makeParams());

    expect(result.status).toBe("error");
    expect(result.error).toContain("Model not allowed");
    // Model should remain undefined — the early return happens before the
    // pre-run persist block, so neither the session entry nor the store
    // should be touched with a rejected model.
    expect(cronSession.sessionEntry.model).toBeUndefined();
    expect(cronSession.sessionEntry.modelProvider).toBeUndefined();
  });

  it("persists session-level /model override on session entry before the run", async () => {
    // No cron payload model — the job has no model field
    const jobWithoutModel = makeJob({
      payload: { kind: "agentTurn", message: "run daily digest" },
    });

    // Session-level /model override set by user (e.g. via /model command)
    cronSession.sessionEntry = makeFreshSessionEntry({
      modelOverride: "claude-haiku-4-5",
      providerOverride: "anthropic",
    });
    resolveCronSessionMock.mockReturnValue(cronSession);

    // resolveAllowedModelRef is called for the session override path too
    resolveAllowedModelRefMock.mockReturnValue({
      ref: { provider: "anthropic", model: "claude-haiku-4-5" },
    });

    runWithModelFallbackMock.mockRejectedValueOnce(new Error("LLM provider timeout"));

    const result = await runCronIsolatedAgentTurn(makeParams({ job: jobWithoutModel }));

    expect(result.status).toBe("error");
    // Even though the run failed, the session-level model override should
    // be persisted on the entry — not the agent default (Opus).
    expect(cronSession.sessionEntry.model).toBe("claude-haiku-4-5");
    expect(cronSession.sessionEntry.modelProvider).toBe("anthropic");
  });

  it("logs warning and continues when pre-run persist fails", async () => {
    // Persist ordering: [1] skills snapshot, [2] pre-run, [3] post-run.
    // Only the pre-run persist (call 2) should fail — the skills snapshot
    // persist is pre-existing code without a try-catch guard.
    let callCount = 0;
    updateSessionStoreMock.mockImplementation(async () => {
      callCount++;
      if (callCount === 2) {
        throw new Error("ENOSPC: no space left on device");
      }
    });

    runWithModelFallbackMock.mockResolvedValueOnce(makeSuccessfulRunResult());

    const result = await runCronIsolatedAgentTurn(makeParams());

    // The run should still complete successfully despite the persist failure
    expect(result.status).toBe("ok");
    expect(logWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("Failed to persist pre-run session entry"),
    );
  });

  it("persists default model pre-run when no payload override is present", async () => {
    // No cron payload model override
    const jobWithoutModel = makeJob({
      payload: { kind: "agentTurn", message: "run daily digest" },
    });

    runWithModelFallbackMock.mockRejectedValueOnce(new Error("LLM provider timeout"));

    const result = await runCronIsolatedAgentTurn(makeParams({ job: jobWithoutModel }));

    expect(result.status).toBe("error");
    // With no override, the default model (Opus) should still be persisted
    // on the session entry rather than left undefined.
    expect(cronSession.sessionEntry.model).toBe("claude-opus-4-6");
    expect(cronSession.sessionEntry.modelProvider).toBe("anthropic");
  });
});
