import { expect, it } from "vitest";
import {
  CRON_AGENT_SELECTION_REQUIRED_MESSAGE,
  resolveCronJobEffectiveAgentId,
} from "./agent-id.js";

it("reports missing cron ownership with a stable code and actionable message", () => {
  expect(() => resolveCronJobEffectiveAgentId({})).toThrow(
    expect.objectContaining({
      code: "AGENT_SELECTION_REQUIRED",
      message: CRON_AGENT_SELECTION_REQUIRED_MESSAGE,
    }),
  );
});
