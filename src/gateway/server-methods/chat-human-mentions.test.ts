import { expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isHumanAddressedChatMessage } from "./chat-human-mentions.js";

const cfg = { agents: { entries: { main: { identity: { name: "Robo" } } } } } as OpenClawConfig;

it.each([
  ["@Bob some of the stickers are cool", "bob", 4, true],
  ["@Bob look at this. Robo, put them on one sheet.", "bob", 4, false],
  ["@robo-bot nice work", "robo-bot", 9, true],
] as const)("detects whether %j is addressed only to people", (text, profileId, end, expected) => {
  expect(
    isHumanAddressedChatMessage({
      cfg,
      agentId: "main",
      text,
      mentions: [{ profileId, start: 0, end }],
    }),
  ).toBe(expected);
});
