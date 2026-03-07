import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearFastTestEnv,
  loadRunCronIsolatedAgentTurn,
  resolveAgentConfigMock,
  resetRunCronIsolatedAgentTurnHarness,
  restoreFastTestEnv,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

// ---------- helpers ----------

function makeJob(overrides?: Record<string, unknown>) {
  return {
    id: "sandbox-test-job",
    name: "Sandbox Test",
    schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
    sessionTarget: "isolated",
    payload: { kind: "agentTurn", message: "test" },
    ...overrides,
  } as never;
}

function makeParams(overrides?: Record<string, unknown>) {
  return {
    cfg: {
      agents: {
        defaults: {
          sandbox: { mode: "all" as const },
        },
      },
    },
    deps: {} as never,
    job: makeJob(),
    message: "test",
    sessionKey: "cron:sandbox-test",
    ...overrides,
  };
}

// ---------- tests ----------

describe("runCronIsolatedAgentTurn — sandbox config preserved (#38663)", () => {
  let previousFastTestEnv: string | undefined;

  beforeEach(() => {
    previousFastTestEnv = clearFastTestEnv();
    resetRunCronIsolatedAgentTurnHarness();
  });

  afterEach(() => {
    restoreFastTestEnv(previousFastTestEnv);
  });

  it("preserves sandbox.mode from defaults when agent override has no sandbox", async () => {
    // Agent config exists (e.g. has a name) but does NOT configure sandbox.
    // resolveAgentConfig returns { sandbox: undefined, ... } for such entries;
    // before the fix Object.assign would overwrite the global sandbox config.
    resolveAgentConfigMock.mockReturnValue({
      name: "my-agent",
      sandbox: undefined,
    });

    await runCronIsolatedAgentTurn(makeParams({ agentId: "my-agent" }));

    expect(runWithModelFallbackMock).toHaveBeenCalledTimes(1);
    const cfg = runWithModelFallbackMock.mock.calls[0][0].cfg;
    expect(cfg.agents.defaults.sandbox).toEqual({ mode: "all" });
  });

  it("preserves sandbox.mode when agent override has other properties", async () => {
    resolveAgentConfigMock.mockReturnValue({
      name: "worker",
      workspace: "/custom/workspace",
      sandbox: undefined,
      heartbeat: undefined,
      tools: undefined,
    });

    await runCronIsolatedAgentTurn(makeParams({ agentId: "worker" }));

    expect(runWithModelFallbackMock).toHaveBeenCalledTimes(1);
    const cfg = runWithModelFallbackMock.mock.calls[0][0].cfg;
    expect(cfg.agents.defaults.sandbox).toEqual({ mode: "all" });
  });

  it("uses agent-specific sandbox config when explicitly set", async () => {
    resolveAgentConfigMock.mockReturnValue({
      name: "sandboxed-agent",
      sandbox: { mode: "non-main", scope: "per-session" },
    });

    await runCronIsolatedAgentTurn(makeParams({ agentId: "sandboxed-agent" }));

    expect(runWithModelFallbackMock).toHaveBeenCalledTimes(1);
    const cfg = runWithModelFallbackMock.mock.calls[0][0].cfg;
    expect(cfg.agents.defaults.sandbox).toEqual({
      mode: "non-main",
      scope: "per-session",
    });
  });

  it("works correctly when no agent config override exists", async () => {
    resolveAgentConfigMock.mockReturnValue(undefined);

    await runCronIsolatedAgentTurn(makeParams());

    expect(runWithModelFallbackMock).toHaveBeenCalledTimes(1);
    const cfg = runWithModelFallbackMock.mock.calls[0][0].cfg;
    expect(cfg.agents.defaults.sandbox).toEqual({ mode: "all" });
  });
});
