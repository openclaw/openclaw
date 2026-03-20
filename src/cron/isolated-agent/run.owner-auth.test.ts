import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "../../agents/test-helpers/fast-coding-tools.js";
import { createOpenClawCodingTools } from "../../agents/pi-tools.js";
import {
  clearFastTestEnv,
  loadRunCronIsolatedAgentTurn,
  resetRunCronIsolatedAgentTurnHarness,
  resolveDeliveryTargetMock,
  restoreFastTestEnv,
  runEmbeddedPiAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

function makeParams() {
  return {
    cfg: {},
    deps: {} as never,
    job: {
      id: "owner-auth",
      name: "Owner Auth",
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "check owner tools" },
      delivery: { mode: "none" },
    } as never,
    message: "check owner tools",
    sessionKey: "cron:owner-auth",
  };
}

describe("runCronIsolatedAgentTurn owner auth", () => {
  let previousFastTestEnv: string | undefined;

  beforeEach(() => {
    previousFastTestEnv = clearFastTestEnv();
    resetRunCronIsolatedAgentTurnHarness();
    resolveDeliveryTargetMock.mockResolvedValue({
      channel: "telegram",
      to: "123",
      accountId: undefined,
      error: undefined,
    });
    runWithModelFallbackMock.mockImplementation(async ({ provider, model, run }) => {
      const result = await run(provider, model);
      return { result, provider, model, attempts: [] };
    });
  });

  afterEach(() => {
    restoreFastTestEnv(previousFastTestEnv);
  });

  it("passes senderIsOwner=false to prevent config-write tools (#44940)", async () => {
    await runCronIsolatedAgentTurn(makeParams());

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    const senderIsOwner = runEmbeddedPiAgentMock.mock.calls[0]?.[0]?.senderIsOwner;
    expect(senderIsOwner).toBe(false);

    // With senderIsOwner=false, cron and gateway tools are stripped,
    // preventing isolated sessions from rewriting their own config.
    const toolNames = createOpenClawCodingTools({ senderIsOwner }).map((tool) => tool.name);
    expect(toolNames).not.toContain("cron");
    expect(toolNames).not.toContain("gateway");
  });
});
