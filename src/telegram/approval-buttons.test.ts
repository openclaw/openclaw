import { describe, expect, it } from "vitest";
import { buildTelegramExecApprovalButtons } from "./approval-buttons.js";

describe("telegram approval buttons", () => {
  it("builds allow-once/allow-always/deny buttons", () => {
    expect(buildTelegramExecApprovalButtons("fbd8daf7")).toEqual([
      [
        { text: "Allow Once", callback_data: "/approve fbd8daf7 allow-once" },
        { text: "Allow Always", callback_data: "/approve fbd8daf7 allow-always" },
      ],
      [{ text: "Deny", callback_data: "/approve fbd8daf7 deny" }],
    ]);
  });

  it("skips buttons when callback_data exceeds Telegram limit", () => {
    expect(buildTelegramExecApprovalButtons(`a${"b".repeat(60)}`)).toBeUndefined();
  });
});
