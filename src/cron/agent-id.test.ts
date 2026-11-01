import { expect, it } from "vitest";
import {
  CRON_AGENT_SELECTION_REQUIRED_MESSAGE,
  resolveCronJobEffectiveAgentId,
  tryResolveCronJobEffectiveAgentId,
} from "./agent-id.js";

it("reports missing cron ownership with a stable code and actionable message", () => {
  expect(() => resolveCronJobEffectiveAgentId({})).toThrow(
    expect.objectContaining({
      code: "AGENT_SELECTION_REQUIRED",
      message: CRON_AGENT_SELECTION_REQUIRED_MESSAGE,
    }),
  );
});

it("prefers the agent named by a session target over the configured default", () => {
  expect(
    tryResolveCronJobEffectiveAgentId(
      { sessionTarget: "session:agent:other:main" },
      "default-agent",
    ),
  ).toBe("other");
});

it("keeps an explicit agent ahead of the session target", () => {
  expect(
    tryResolveCronJobEffectiveAgentId(
      { agentId: "explicit", sessionTarget: "session:agent:other:main" },
      "default-agent",
    ),
  ).toBe("explicit");
});

it("keeps the session-key fallback when the target names no agent", () => {
  expect(
    tryResolveCronJobEffectiveAgentId(
      { sessionTarget: "isolated", sessionKey: "agent:from-key:main" },
      "default-agent",
    ),
  ).toBe("from-key");
});
