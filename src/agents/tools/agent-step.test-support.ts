import type { callGateway } from "../../gateway/call.js";
import "./agent-step.js";

type AgentStepTesting = {
  setDepsForTest(
    overrides?: Partial<{
      callGateway: typeof callGateway;
    }>,
  ): void;
};
type AgentStepTestApi = {
  testing: AgentStepTesting;
};

function getTestApi(): AgentStepTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.agentStepTestApi")
  ] as AgentStepTestApi;
}

export const testing = getTestApi().testing;
