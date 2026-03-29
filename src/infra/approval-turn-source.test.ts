import { describe, expect, it } from "vitest";
import { hasApprovalTurnSourceRoute } from "./approval-turn-source.js";

describe("hasApprovalTurnSourceRoute", () => {
  it("accepts operator UI turn sources", () => {
    expect(hasApprovalTurnSourceRoute({ turnSourceChannel: "webchat" })).toBe(true);
    expect(hasApprovalTurnSourceRoute({ turnSourceChannel: "tui" })).toBe(true);
  });

  it("accepts deliverable chat channels", () => {
    expect(hasApprovalTurnSourceRoute({ turnSourceChannel: "slack" })).toBe(true);
    expect(hasApprovalTurnSourceRoute({ turnSourceChannel: "discord" })).toBe(true);
  });

  it("rejects missing or unknown turn sources", () => {
    expect(hasApprovalTurnSourceRoute({ turnSourceChannel: undefined })).toBe(false);
    expect(hasApprovalTurnSourceRoute({ turnSourceChannel: "unknown-channel" })).toBe(false);
  });
});
