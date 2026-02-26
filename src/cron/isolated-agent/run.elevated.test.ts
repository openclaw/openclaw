import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWithModelFallback } from "../../agents/model-fallback.js";

// ---------- mocks ----------

const resolveAgentConfigMock = vi.fn();
const getModelRefStatusMock = vi.fn().mockReturnValue({ allowed: false });
const isCliProviderMock = vi.fn().mockReturnValue(false);
const resolveAllowedModelRefMock = vi.fn();
const resolveConfiguredModelRefMock = vi.fn();
const resolveHooksGmailModelMock = vi.fn();
const resolveThinkingDefaultMock = vi.fn();

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

vi.mock("../../agents/model-selection.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/model-selection.js")>();
  return {
    ...actual,
    getModelRefStatus: getModelRefStatusMock,
    isCliProvider: isCliProviderMock,
    resolveAllowedModelRef: resolveAllowedModelRefMock,
    resolveConfiguredModelRef: resolveConfiguredModelRefMock,
    resolveHooksGmailModel: resolveHooksGmailModelMock,
    resolveThinkingDefault: resolveThinkingDefaultMock,
  };
});

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

const runWithModelFallbackMock = vi.mocked(runWithModelFallback);

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

vi.mock("../../auto-reply/thinking.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../auto-reply/thinking.js")>();
  return {
    normalizeElevatedLevel: actual.normalizeElevatedLevel,
    normalizeThinkLevel: vi.fn().mockReturnValue(undefined),
    normalizeVerboseLevel: vi.fn().mockReturnValue("off"),
    supportsXHighThinking: vi.fn().mockReturnValue(false),
  };
});

vi.mock("../../cli/outbound-send-deps.js", () => ({
  createOutboundSendDeps: vi.fn().mockReturnValue({}),
}));

vi.mock("../../config/sessions.js", () => ({
  resolveAgentMainSessionKey: vi.fn().mockReturnValue("main:default"),
  resolveSessionTranscriptPath: vi.fn().mockReturnValue("/tmp/transcript.jsonl"),
  setSessionRuntimeModel: vi.fn(),
  updateSessionStore: vi.fn().mockResolvedValue(undefined),
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
    channel: "telegram",
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

describe("runCronIsolatedAgentTurn — elevated exec (#18748)", () => {
  let previousFastTestEnv: string | undefined;
  beforeEach(() => {
    vi.clearAllMocks();
    previousFastTestEnv = process.env.OPENCLAW_TEST_FAST;
    delete process.env.OPENCLAW_TEST_FAST;
    resolveAgentConfigMock.mockReturnValue(undefined);
    resolveConfiguredModelRefMock.mockReturnValue({ provider: "openai", model: "gpt-4" });
    resolveAllowedModelRefMock.mockReturnValue({ ref: { provider: "openai", model: "gpt-4" } });
    resolveHooksGmailModelMock.mockReturnValue(null);
    resolveThinkingDefaultMock.mockReturnValue(undefined);
    getModelRefStatusMock.mockReturnValue({ allowed: false });
    isCliProviderMock.mockReturnValue(false);
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

  afterEach(() => {
    if (previousFastTestEnv == null) {
      delete process.env.OPENCLAW_TEST_FAST;
      return;
    }
    process.env.OPENCLAW_TEST_FAST = previousFastTestEnv;
  });

  it("passes bashElevated with enabled+allowed when config enables elevated globally", async () => {
    const result = await runCronIsolatedAgentTurn(
      makeParams({
        cfg: {
          tools: {
            elevated: {
              enabled: true,
            },
          },
          agents: {
            defaults: {
              elevatedDefault: "full",
            },
          },
        },
      }),
    );

    expect(result.status).toBe("ok");
    expect(runWithModelFallbackMock).toHaveBeenCalledOnce();

    // Extract the run callback and invoke it to get the runEmbeddedPiAgent call
    const runFn = runWithModelFallbackMock.mock.calls[0][0].run;
    await runFn("openai", "gpt-4");

    const { runEmbeddedPiAgent } = await import("../../agents/pi-embedded.js");
    const callArgs = vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0];
    expect(callArgs).toHaveProperty("bashElevated");
    expect(callArgs.bashElevated).toEqual({
      enabled: true,
      allowed: true,
      defaultLevel: "full",
    });
  });

  it("passes bashElevated with enabled=false when elevated is disabled", async () => {
    const result = await runCronIsolatedAgentTurn(
      makeParams({
        cfg: {
          tools: {
            elevated: {
              enabled: false,
            },
          },
        },
      }),
    );

    expect(result.status).toBe("ok");
    expect(runWithModelFallbackMock).toHaveBeenCalledOnce();

    const runFn = runWithModelFallbackMock.mock.calls[0][0].run;
    await runFn("openai", "gpt-4");

    const { runEmbeddedPiAgent } = await import("../../agents/pi-embedded.js");
    const callArgs = vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0];
    expect(callArgs).toHaveProperty("bashElevated");
    expect(callArgs.bashElevated?.enabled).toBe(false);
  });

  it("defaults elevated level to 'on' when no elevatedDefault is configured", async () => {
    const result = await runCronIsolatedAgentTurn(
      makeParams({
        cfg: {
          tools: {
            elevated: {
              enabled: true,
            },
          },
        },
      }),
    );

    expect(result.status).toBe("ok");
    expect(runWithModelFallbackMock).toHaveBeenCalledOnce();

    const runFn = runWithModelFallbackMock.mock.calls[0][0].run;
    await runFn("openai", "gpt-4");

    const { runEmbeddedPiAgent } = await import("../../agents/pi-embedded.js");
    const callArgs = vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0];
    expect(callArgs.bashElevated).toEqual({
      enabled: true,
      allowed: true,
      defaultLevel: "on",
    });
  });

  it("disables elevated when tools.elevated is not configured (no implicit opt-in)", async () => {
    const result = await runCronIsolatedAgentTurn(
      makeParams({
        cfg: {},
      }),
    );

    expect(result.status).toBe("ok");
    expect(runWithModelFallbackMock).toHaveBeenCalledOnce();

    const runFn = runWithModelFallbackMock.mock.calls[0][0].run;
    await runFn("openai", "gpt-4");

    const { runEmbeddedPiAgent } = await import("../../agents/pi-embedded.js");
    const callArgs = vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0];
    expect(callArgs.bashElevated).toEqual({
      enabled: false,
      allowed: false,
      defaultLevel: "off",
    });
  });

  it("honours session persisted elevated level over config default", async () => {
    resolveCronSessionMock.mockReturnValue({
      storePath: "/tmp/store.json",
      store: {},
      sessionEntry: {
        sessionId: "test-session-id",
        updatedAt: 0,
        systemSent: false,
        skillsSnapshot: undefined,
        elevatedLevel: "off",
      },
      systemSent: false,
      isNewSession: false,
    });

    const result = await runCronIsolatedAgentTurn(
      makeParams({
        cfg: {
          tools: {
            elevated: {
              enabled: true,
            },
          },
          agents: {
            defaults: {
              elevatedDefault: "full",
            },
          },
        },
      }),
    );

    expect(result.status).toBe("ok");
    expect(runWithModelFallbackMock).toHaveBeenCalledOnce();

    const runFn = runWithModelFallbackMock.mock.calls[0][0].run;
    await runFn("openai", "gpt-4");

    const { runEmbeddedPiAgent } = await import("../../agents/pi-embedded.js");
    const callArgs = vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0];
    // Session has elevatedLevel: "off" which should override the config's "full" default
    expect(callArgs.bashElevated).toEqual({
      enabled: true,
      allowed: true,
      defaultLevel: "off",
    });
  });

  it("respects per-agent elevated config override", async () => {
    resolveAgentConfigMock.mockReturnValue({
      tools: { elevated: { enabled: false } },
    });

    const result = await runCronIsolatedAgentTurn(
      makeParams({
        cfg: {
          tools: {
            elevated: {
              enabled: true,
              allowFrom: { "*": ["*"] },
            },
          },
        },
        agentId: "scout",
      }),
    );

    expect(result.status).toBe("ok");
    expect(runWithModelFallbackMock).toHaveBeenCalledOnce();

    const runFn = runWithModelFallbackMock.mock.calls[0][0].run;
    await runFn("openai", "gpt-4");

    const { runEmbeddedPiAgent } = await import("../../agents/pi-embedded.js");
    const callArgs = vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0];
    expect(callArgs.bashElevated?.enabled).toBe(false);
  });
});
