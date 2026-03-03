import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearFastTestEnv,
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  makeCronSessionEntry,
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
    id: "sandbox-test-job",
    name: "Sandbox Test",
    schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
    sessionTarget: "isolated",
    agentId: "test-agent",
    payload: {
      kind: "agentTurn",
      message: "test sandbox merge",
    },
    ...overrides,
  } as never;
}

function makeParams(overrides?: Record<string, unknown>) {
  return {
    cfg: {
      agents: {
        defaults: {
          sandbox: { mode: "all" as const, workspaceAccess: "rw" as const },
        },
      },
    },
    deps: {} as never,
    job: makeJob(),
    message: "test sandbox merge",
    sessionKey: "cron:sandbox-test",
    ...overrides,
  };
}

/**
 * Extract the config passed to runWithModelFallback so we can inspect
 * the merged agents.defaults.sandbox values.
 */
function getCfgPassedToModelFallback(): Record<string, unknown> | undefined {
  const call = runWithModelFallbackMock.mock.calls[0];
  return call?.[0]?.cfg;
}

// ---------- tests ----------

describe("runCronIsolatedAgentTurn — sandbox config merge", () => {
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
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({ sessionEntry: makeCronSessionEntry() }),
    );
  });

  afterEach(() => {
    restoreFastTestEnv(previousFastTestEnv);
  });

  it("preserves agents.defaults.sandbox.mode when agent config has no sandbox", async () => {
    // Agent exists in config but has no sandbox settings
    resolveAgentConfigMock.mockReturnValue({
      name: "test-agent",
      workspace: "/tmp/test",
    });

    await runCronIsolatedAgentTurn(makeParams());

    const cfg = getCfgPassedToModelFallback() as {
      agents?: { defaults?: { sandbox?: { mode?: string; workspaceAccess?: string } } };
    };
    expect(cfg?.agents?.defaults?.sandbox?.mode).toBe("all");
    expect(cfg?.agents?.defaults?.sandbox?.workspaceAccess).toBe("rw");
  });

  it("preserves agents.defaults.sandbox.mode when agent config has sandbox: undefined", async () => {
    // Agent config explicitly returns sandbox: undefined (the resolveAgentConfig pattern)
    resolveAgentConfigMock.mockReturnValue({
      name: "test-agent",
      sandbox: undefined,
    });

    await runCronIsolatedAgentTurn(makeParams());

    const cfg = getCfgPassedToModelFallback() as {
      agents?: { defaults?: { sandbox?: { mode?: string } } };
    };
    expect(cfg?.agents?.defaults?.sandbox?.mode).toBe("all");
  });

  it("deep-merges agent-specific sandbox overrides without clobbering defaults", async () => {
    // Agent has partial sandbox config — only workspaceAccess, no mode
    resolveAgentConfigMock.mockReturnValue({
      name: "test-agent",
      sandbox: { workspaceAccess: "none" },
    });

    await runCronIsolatedAgentTurn(makeParams());

    const cfg = getCfgPassedToModelFallback() as {
      agents?: { defaults?: { sandbox?: { mode?: string; workspaceAccess?: string } } };
    };
    // mode from defaults must survive the merge
    expect(cfg?.agents?.defaults?.sandbox?.mode).toBe("all");
    // workspaceAccess should be overridden by agent-specific value
    expect(cfg?.agents?.defaults?.sandbox?.workspaceAccess).toBe("none");
  });

  it("allows agent-specific sandbox to override mode", async () => {
    // Agent explicitly sets sandbox.mode = "off"
    resolveAgentConfigMock.mockReturnValue({
      name: "test-agent",
      sandbox: { mode: "off" },
    });

    await runCronIsolatedAgentTurn(makeParams());

    const cfg = getCfgPassedToModelFallback() as {
      agents?: { defaults?: { sandbox?: { mode?: string; workspaceAccess?: string } } };
    };
    // Agent override takes precedence
    expect(cfg?.agents?.defaults?.sandbox?.mode).toBe("off");
    // Default workspaceAccess should still be present
    expect(cfg?.agents?.defaults?.sandbox?.workspaceAccess).toBe("rw");
  });

  it("preserves sandbox defaults when no agent config exists at all", async () => {
    // No agent-specific config
    resolveAgentConfigMock.mockReturnValue(undefined);

    await runCronIsolatedAgentTurn(makeParams({ job: makeJob({ agentId: undefined }) }));

    const cfg = getCfgPassedToModelFallback() as {
      agents?: { defaults?: { sandbox?: { mode?: string; workspaceAccess?: string } } };
    };
    expect(cfg?.agents?.defaults?.sandbox?.mode).toBe("all");
    expect(cfg?.agents?.defaults?.sandbox?.workspaceAccess).toBe("rw");
  });
});
