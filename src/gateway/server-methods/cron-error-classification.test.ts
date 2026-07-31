import { describe, expect, it } from "vitest";
import { AgentSelectionRequiredError } from "../../agents/agent-scope-config.js";
import { isCronInvalidRequestError } from "./cron-error-classification.js";

describe("isCronInvalidRequestError", () => {
  it("classifies conflicting cron agent and session owners as an invalid request", () => {
    expect(
      isCronInvalidRequestError(
        new Error("cron job agentId ops does not match sessionKey owner research"),
      ),
    ).toBe(true);
  });

  it("classifies missing explicit cron ownership as an invalid request", () => {
    expect(
      isCronInvalidRequestError(
        new AgentSelectionRequiredError([], {
          surface: "cron job creation",
          hint: "Set the job agentId.",
        }),
      ),
    ).toBe(true);
  });
});
