import { describe, expect, it } from "vitest";
import {
  classifyExternalAction,
  createExternalActionFirewallModule,
} from "./external-action-firewall.js";

describe("external action firewall", () => {
  it("classifies Telegram/message, Linear/GitHub, email/social, Zoho/payment, deploy/publish, and internal", () => {
    expect(classifyExternalAction({ channel: "telegram", action: "send" })).toBe("external");
    expect(classifyExternalAction({ target: "github comment" })).toBe("external");
    expect(classifyExternalAction({ target: "email customer" })).toBe("customer");
    expect(classifyExternalAction({ target: "zoho payment" })).toBe("operator");
    expect(classifyExternalAction({ target: "production deploy publish" })).toBe("operator");
    expect(classifyExternalAction({ target: "local file" })).toBe("internal");
  });

  it("requires approval unless allowlisted", () => {
    const mod = createExternalActionFirewallModule({
      externalAllowlist: [{ targetPattern: "internal-*" }],
    });
    expect(
      mod.evaluate(
        { policyVersion: "v1", actionType: "message_send", targetResource: "telegram chat" },
        {},
      ),
    ).toMatchObject({ decision: "requireApproval" });
    expect(
      mod.evaluate(
        { policyVersion: "v1", actionType: "message_send", targetResource: "internal-bot" },
        {},
      ),
    ).toBeUndefined();
  });
});
