import { describe, expect, it } from "vitest";
import { recordPollVote, suppressPollVoteEcho } from "./poll-vote-echo.js";

function expectPollEchoSuppression(option: string, outboundText: string, expected: boolean) {
  const sessionKey = JSON.stringify([option, outboundText]);
  recordPollVote(sessionKey, "poll-route", option);
  expect(suppressPollVoteEcho(sessionKey, "poll-route", "send", { text: outboundText })).toBe(
    expected,
  );
}

describe("poll vote echo suppression", () => {
  it.each([
    ["Lobster 🦞 ", "🦞 Lobster."],
    ["USA 🇺🇸 ", "🇺🇸 USA."],
    ["Scotland 🏴󠁧󠁢󠁳󠁣󠁴󠁿", "🏴󠁧󠁢󠁳󠁣󠁴󠁿 Scotland."],
    ["Team 👍🏽", "👍🏽 Team."],
    ["Family 👨‍👩‍👧", "👨‍👩‍👧 Family."],
    ["Option 1️⃣", "1️⃣ Option."],
    ["1️⃣", "1️⃣"],
    ["Blue", "Blue!"],
    ["Blue", "🦞 Blue."],
    ["Lobster 🦞", "Lobster."],
    ["🍎", "🍎"],
  ])("matches the same label and emoji signature: %s", (option, outboundText) => {
    expectPollEchoSuppression(option, outboundText, true);
  });

  it.each([
    ["Option 1️⃣", "2️⃣ Option."],
    ["1️⃣", "2️⃣"],
    ["1", "1️⃣"],
    ["Lobster 🦞", "🦀 Lobster."],
    ["C#", "C"],
    ["C++", "C"],
    ["Node.js", "Node js"],
    ["Blue", "Red"],
    ["", ""],
  ])("does not collapse distinct labels or emoji: %s / %s", (option, outboundText) => {
    expectPollEchoSuppression(option, outboundText, false);
  });
});
