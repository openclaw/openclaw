import { expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isHumanAddressedChatMessage } from "./chat-human-mentions.js";

const cfg = { agents: { entries: { main: { identity: { name: "Robo" } } } } } as OpenClawConfig;

it("treats a message that only selects people as addressed to them", () => {
  const text = "@Bob some of the stickers are cool";
  expect(
    isHumanAddressedChatMessage({
      cfg,
      agentId: "main",
      text,
      mentions: [{ profileId: "bob", start: 0, end: 4 }],
    }),
  ).toBe(true);
});

it("keeps the agent turn when the text names the agent beside the people", () => {
  const text = "@Bob look at this. Robo, put them on one sheet.";
  expect(
    isHumanAddressedChatMessage({
      cfg,
      agentId: "main",
      text,
      mentions: [{ profileId: "bob", start: 0, end: 4 }],
    }),
  ).toBe(false);
});

it("ignores the agent name inside a selected person's token", () => {
  const text = "@robo-bot nice work";
  expect(
    isHumanAddressedChatMessage({
      cfg,
      agentId: "main",
      text,
      mentions: [{ profileId: "robo-bot", start: 0, end: 9 }],
    }),
  ).toBe(true);
});
