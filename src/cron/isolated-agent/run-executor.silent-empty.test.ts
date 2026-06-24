// Regression tests: cron executor must pass allowEmptyAssistantReplyAsSilent
// to both CLI and embedded runner paths so silent cron watchers succeed.
import "../isolated-agent.mocks.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as modelThinkingDefault from "../../agents/model-thinking-default.js";
import {
  DEFAULT_AGENT_TURN_PAYLOAD,
  runCronTurn,
  withTempHome,
} from "../isolated-agent.turn-test-helpers.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  isCliProviderMock,
  mockRunCronFallbackPassthrough,
  runCliAgentMock,
  runEmbeddedAgentMock,
} from "./run.test-harness.js";

setupRunCronIsolatedAgentTurnSuite();

describe("cron executor allowEmptyAssistantReplyAsSilent", () => {
  beforeEach(() => {
    vi.spyOn(modelThinkingDefault, "resolveThinkingDefault").mockReturnValue("off");
    isCliProviderMock.mockReturnValue(false);
    runEmbeddedAgentMock.mockClear();
    runCliAgentMock.mockClear();
    mockRunCronFallbackPassthrough();
  });

  it("passes allowEmptyAssistantReplyAsSilent to the embedded runner", async () => {
    await withTempHome(async (home) => {
      // Use mockTexts: [""] so the embedded runner mock produces truly empty
      // output — this exercises the code path where allowEmptyAssistantReplyAsSilent
      // is required to prevent empty_response errors.
      const { res } = await runCronTurn(home, {
        jobPayload: DEFAULT_AGENT_TURN_PAYLOAD,
        mockTexts: [""],
      });

      expect(res.status).toBe("ok");
      const call = runEmbeddedAgentMock.mock.calls.at(-1)?.[0];
      expect(call).toBeDefined();
      const params = call as Record<string, unknown>;
      expect(params.allowEmptyAssistantReplyAsSilent).toBe(true);
    });
  });

  it("passes allowEmptyAssistantReplyAsSilent to the CLI runner", async () => {
    isCliProviderMock.mockReturnValue(true);
    runCliAgentMock.mockResolvedValue({
      payloads: [{ text: "" }],
      meta: { agentMeta: { usage: { input: 5, output: 1 } } },
    });

    await withTempHome(async (home) => {
      const { res } = await runCronTurn(home, {
        jobPayload: DEFAULT_AGENT_TURN_PAYLOAD,
      });

      expect(res.status).toBe("ok");
      expect(runCliAgentMock).toHaveBeenCalled();
      const call = runCliAgentMock.mock.calls.at(-1)?.[0];
      expect(call).toBeDefined();
      const params = call as Record<string, unknown>;
      expect(params.allowEmptyAssistantReplyAsSilent).toBe(true);
    });
  });
});
