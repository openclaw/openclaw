import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearFastTestEnv,
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  resetRunCronIsolatedAgentTurnHarness,
  restoreFastTestEnv,
  runEmbeddedPiAgentMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

function makeJob(overrides?: Record<string, unknown>) {
  return {
    id: "sandbox-activation-job",
    name: "Sandbox Activation",
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
          sandbox: {
            mode: "all" as const,
            workspaceAccess: "rw" as const,
          },
        },
      },
    },
    deps: {} as never,
    job: makeJob(),
    message: "run sandbox test",
    sessionKey: "cron:sandbox-activation",
    ...overrides,
  };
}

describe("runCronIsolatedAgentTurn sandbox activation", () => {
  let previousFastTestEnv: string | undefined;

  beforeEach(() => {
    previousFastTestEnv = clearFastTestEnv();
    resetRunCronIsolatedAgentTurnHarness();
    mockRunCronFallbackPassthrough();
  });

  afterEach(() => {
    restoreFastTestEnv(previousFastTestEnv);
  });

  it("passes non-empty sessionKey to runEmbeddedPiAgent so sandbox resolves", async () => {
    await runCronIsolatedAgentTurn(makeParams());

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    const callArgs = runEmbeddedPiAgentMock.mock.calls[0]?.[0];
    expect(callArgs.sessionKey).toBeTruthy();
    expect(callArgs.config?.agents?.defaults?.sandbox?.mode).toBe("all");
  });

  it("sandbox.mode='off' still passes config through without forcing sandbox", async () => {
    await runCronIsolatedAgentTurn(
      makeParams({
        cfg: {
          agents: {
            defaults: {
              sandbox: {
                mode: "off" as const,
              },
            },
          },
        },
      }),
    );

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    const callArgs = runEmbeddedPiAgentMock.mock.calls[0]?.[0];
    expect(callArgs.config?.agents?.defaults?.sandbox?.mode).toBe("off");
  });

  it("passes original sessionKey when sessionKey is undefined", async () => {
    await runCronIsolatedAgentTurn(makeParams({ sessionKey: undefined }));

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    const callArgs = runEmbeddedPiAgentMock.mock.calls[0]?.[0];
    // Falls back to cron:<job.id> so the key is always non-empty.
    expect(callArgs.sessionKey).toBeTruthy();
    expect(callArgs.config?.agents?.defaults?.sandbox?.mode).toBe("all");
  });
});
