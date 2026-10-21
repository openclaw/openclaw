import { expect, it } from "vitest";
import { isAllowedParsedChatSender } from "./chat-target-prefixes.js";

it("matches the wildcard without parsing it as a target", () => {
  expect(
    isAllowedParsedChatSender({
      allowFrom: ["*"],
      sender: "other@example.com",
      normalizeSender: (sender) => sender.trim().toLowerCase(),
      parseAllowTarget: () => {
        throw new Error("wildcard must bypass target parsing");
      },
    }),
  ).toBe(true);
});
