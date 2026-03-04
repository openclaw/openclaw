import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearFastTestEnv,
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  resolveAgentConfigMock,
  resolveAllowedModelRefMock,
  resolveConfiguredModelRefMock,
  resolveCronSessionMock,
  resetRunCronIsolatedAgentTurnHarness,
  restoreFastTestEnv,
  runWithModelFallbackMock,
  updateSessionStoreMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

// ---------- helpers ----------

function makeJob(overrides?: Record<string, unknown>) {
  return {
    id: "webhook-job",
    agentId: "test_agent",
    name: "Webhook Test",
    schedule: { kind: "at", at: new Date().toISOString() },
    sessionTarget: "isolated",
    payload: {
      kind: "agentTurn",
      message: "test message",
    },
    state: { nextRunAtMs: Date.now() },
    ...overrides,
  } as never;
}

function makeParams(overrides?: Record<string, unknown>) {
  return {
    cfg: {
      agents: {
        defaults: {
          sandbox: { mode: "all" },
        },
        entries: [{ id: "test_agent" }],
      },
    },
    deps: {} as never,
    job: makeJob(),
    message: "test message",
    sessionKey: "webhook:test",
    ...overrides,
  };
}

// ---------- tests ----------

describe("runCronIsolatedAgentTurn — sandbox config preserved (#33349)", () => {
  let previousFastTestEnv: string | undefined;

  beforeEach(() => {
    previousFastTestEnv = clearFastTestEnv();
    resetRunCronIsolatedAgentTurnHarness();

    resolveConfiguredModelRefMock.mockReturnValue({
      provider: "openai",
      model: "gpt-4",
    });
    resolveAllowedModelRefMock.mockReturnValue({
      ref: { provider: "openai", model: "gpt-4" },
    });

    updateSessionStoreMock.mockResolvedValue(undefined);
    resolveCronSessionMock.mockReturnValue(makeCronSession());
  });

  afterEach(() => {
    restoreFastTestEnv(previousFastTestEnv);
  });

  it("preserves agents.defaults.sandbox when agent entry has no sandbox config", async () => {
    // Agent entry exists but has no sandbox config → resolveAgentConfig returns
    // { sandbox: undefined, ... }. Before the fix, Object.assign would overwrite
    // the global sandbox config with undefined, causing sandbox mode to be "off".
    resolveAgentConfigMock.mockReturnValue({
      name: "Test Agent",
      sandbox: undefined,
      tools: undefined,
      heartbeat: undefined,
      identity: undefined,
      groupChat: undefined,
      memorySearch: undefined,
      humanDelay: undefined,
      skills: undefined,
      workspace: undefined,
      agentDir: undefined,
      subagents: undefined,
    });

    const params = makeParams();

    await runCronIsolatedAgentTurn(params);

    // runWithModelFallback receives cfgWithAgentDefaults as `cfg`.
    // Verify that agents.defaults.sandbox.mode is still "all".
    const call = runWithModelFallbackMock.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call.cfg.agents.defaults.sandbox).toEqual({ mode: "all" });
  });

  it("preserves sandbox config when agent entry is not found", async () => {
    // No agent entry → resolveAgentConfig returns undefined → agentOverrideRest is {}
    resolveAgentConfigMock.mockReturnValue(undefined);

    const params = makeParams();

    await runCronIsolatedAgentTurn(params);

    const call = runWithModelFallbackMock.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call.cfg.agents.defaults.sandbox).toEqual({ mode: "all" });
  });

  it("applies agent-specific sandbox override when explicitly set", async () => {
    // Agent has explicit sandbox config → should override the global
    resolveAgentConfigMock.mockReturnValue({
      name: "Sandbox Agent",
      sandbox: { mode: "non-main" },
      tools: undefined,
      heartbeat: undefined,
      identity: undefined,
      groupChat: undefined,
      memorySearch: undefined,
      humanDelay: undefined,
      skills: undefined,
      workspace: undefined,
      agentDir: undefined,
      subagents: undefined,
    });

    const params = makeParams();

    await runCronIsolatedAgentTurn(params);

    const call = runWithModelFallbackMock.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call.cfg.agents.defaults.sandbox).toEqual({ mode: "non-main" });
  });

  it("preserves other global defaults when agent entry has partial overrides", async () => {
    // Agent entry sets heartbeat but not sandbox → sandbox should survive
    resolveAgentConfigMock.mockReturnValue({
      name: "Partial Agent",
      heartbeat: { enabled: true },
      sandbox: undefined,
      tools: undefined,
      identity: undefined,
      groupChat: undefined,
      memorySearch: undefined,
      humanDelay: undefined,
      skills: undefined,
      workspace: undefined,
      agentDir: undefined,
      subagents: undefined,
    });

    const params = makeParams({
      cfg: {
        agents: {
          defaults: {
            sandbox: { mode: "all" },
            heartbeat: { enabled: false },
          },
          entries: [{ id: "test_agent" }],
        },
      },
    });

    await runCronIsolatedAgentTurn(params);

    const call = runWithModelFallbackMock.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    // Sandbox preserved from global defaults
    expect(call.cfg.agents.defaults.sandbox).toEqual({ mode: "all" });
    // Heartbeat overridden by agent config
    expect(call.cfg.agents.defaults.heartbeat).toEqual({ enabled: true });
  });
});
