import { describe, expect, it } from "vitest";
import { buildChannelWizardMocks } from "../../scripts/control-ui-mock-channels.ts";

describe("buildChannelWizardMocks", () => {
  it("completes direct Slack setup as the selected channel", () => {
    const channel = "slack";
    const mocks = buildChannelWizardMocks();
    const completion = mocks.next.cases.find(
      (candidate) =>
        "match" in candidate && candidate.match?.answer.stepId === `mock-wizard-step-${channel}`,
    );

    expect(completion).toEqual({
      match: { answer: { stepId: `mock-wizard-step-${channel}`, value: null } },
      response: { done: true, status: "done", channels: [channel] },
    });
  });
});
