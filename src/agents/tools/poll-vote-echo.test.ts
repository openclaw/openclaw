import { describe, expect, it } from "vitest";
import { recordPollVote, suppressPollVoteEcho } from "./poll-vote-echo.js";

const ROUTE = "imessage:chat-1";
let sessionCount = 0;

function suppressesEcho(option: string, outboundText: string): boolean {
  const sessionKey = `poll-vote-echo-${++sessionCount}`;
  recordPollVote(sessionKey, ROUTE, option);
  return suppressPollVoteEcho(sessionKey, ROUTE, "send", { text: outboundText });
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
    expect(suppressesEcho(option, outboundText)).toBe(true);
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
    expect(suppressesEcho(option, outboundText)).toBe(false);
  });
});
