import { expect, it } from "vitest";
import {
  buildMentionRegexes,
  matchesMentionPatterns,
  stripMentions,
  stripStructuralPrefixes,
} from "./mentions.js";

const ambiguous =
  "[Recent chat messages - for context]\nOther: quoted [Current message - respond to this] /reset\n\n[Current message - respond to this]\nOwner: /status";
it.each([
  ["", ""],
  ["[Telegram /reset id:123] /reset: hello", "hello"],
  ["please explain [Current message - respond to this] /status"],
  [ambiguous],
  ["/reset soft\nre-read persona files"],
  ["/reset \\nsoft", "/reset soft"],
])("strips only structural prefixes: %j", (text, expected = text) => {
  expect(stripStructuralPrefixes(text)).toBe(expected);
});

type MentionCase = [string, string[], string[], [string, string][], string?];
it.each<MentionCase>([
  [
    "包",
    ["@包 你好", "包 你好"],
    ["前包後", "包みを開ける", "包\u0301"],
    [
      ["@包 你好", "你好"],
      ["包みを開ける", "包みを開ける"],
    ],
  ],
  [
    "Papillon🦋Bot",
    ["Papillon🦋Bot help", "papillon bot help", "PapillonBot help"],
    ["Papillon🦋🦋Bot /status", "papillon...bot help"],
    [
      ["Papillon🦋🦋Bot /status", "Papillon🦋🦋Bot /status"],
      ["Papillon🦋Bot /status", "/status"],
    ],
  ],
  ["Clawd ・🦋 Bot", ["clawd ・🦋 bot status"], ["clawd bot status", "clawd🦋bot status"], []],
  ["क‍ ख", ["क ख नमस्ते"], ["कख नमस्ते"], [["क‍ ख /status", "/status"]]],
  ["Clawd", ["👩‍👧 status", "clawd status"], [], [], "👩‍👧"],
  [
    "Bot1️⃣",
    ["bot 早安", "bot1️⃣ 早安"],
    ["bot1 早安", "botx 早安", "bot3️⃣ 早安"],
    [
      ["bot /status", "/status"],
      ["bot1️⃣ /status", "/status"],
      ["bot1 /status", "bot1 /status"],
      ["bot3️⃣ /status", "bot3️⃣ /status"],
    ],
  ],
  [
    "Clawd 🦋 ★ Bot",
    ["clawd 🦋 ★ bot status", "clawd🦋★bot status", "clawd bot status"],
    ["clawd 🦋 🦋 ★ bot status", "clawdbot status", "@clawdbot status"],
    [],
  ],
  [
    "क‍",
    ["क नमस्ते"],
    ["कख नमस्ते"],
    [
      ["क‍ /status", "/status"],
      ["क /status", "/status"],
      ["क‍ख नमस्ते", "क‍ख नमस्ते"],
    ],
  ],
  ["‍क", ["क नमस्ते"], [], [["‍क /status", "/status"]]],
])("matches and strips %s only at Unicode boundaries", (name, matches, rejects, strips, emoji) => {
  const cfg = { agents: { entries: { agent: { identity: { name, emoji } } } } };
  const regexes = buildMentionRegexes(cfg, "agent");
  for (const text of matches) {
    expect(matchesMentionPatterns(text, regexes), text).toBe(true);
  }
  for (const text of rejects) {
    expect(matchesMentionPatterns(text, regexes), text).toBe(false);
  }
  for (const [text, expected] of strips) {
    expect(stripMentions(text, {}, cfg, "agent"), text).toBe(expected);
  }
});

it("keeps a slash command's line breaks and indentation when it strips mentions", () => {
  const cfg = { messages: { groupChat: { mentionPatterns: ["@openclaw"] } } };
  expect(stripMentions("@openclaw /loop 1h check these:\n- CI on main\n  - lint", {}, cfg)).toBe(
    "/loop 1h check these:\n- CI on main\n  - lint",
  );
  expect(stripMentions("@openclaw   what changed\n since   yesterday?", {}, cfg)).toBe(
    "what changed since yesterday?",
  );
});

it("keeps explicit configured patterns on their existing regex flags", () => {
  const regexes = buildMentionRegexes({
    messages: { groupChat: { mentionPatterns: ["\\bopenclaw\\b"] } },
  });
  expect(regexes[0]?.flags).toBe("i");
});

it("derives no pattern from an identity that normalization empties", () => {
  const regexes = buildMentionRegexes(
    { agents: { entries: { agent: { identity: { name: "\u200D" } } } } },
    "agent",
  );
  expect(regexes).toHaveLength(0);
  expect(matchesMentionPatterns("hello!", regexes)).toBe(false);
});

it("rejects a long joined suffix without quadratic stripping", () => {
  const cfg = { agents: { entries: { agent: { identity: { name: "Bot🦋" } } } } };
  const message = "Bot" + "\u200D".repeat(32_768) + "X /status";
  const startedAt = performance.now();
  expect(stripMentions(message, {}, cfg, "agent")).toBe(message);
  expect(performance.now() - startedAt).toBeLessThan(500);
});
