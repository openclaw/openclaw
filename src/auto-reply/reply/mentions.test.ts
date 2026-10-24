import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  buildMentionRegexes,
  matchesMentionPatterns,
  stripCommandAddressingMentions,
  stripMentions,
  stripStructuralPrefixes,
} from "./mentions.js";

vi.mock("../../channels/plugins/registry-loaded.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../channels/plugins/registry-loaded.js")>()),
  getLoadedChannelPluginById: (id: string) =>
    id === "discord"
      ? {
          mentions: {
            stripPatterns: () => ["@12345"],
            stripMentions: ({ text }: { text: string }) =>
              text
                .replace(/<@bot>/gu, "")
                .replace(/<\s*>/gu, "")
                .replace("[Bot Name]", "")
                .replaceAll("[A A]", "")
                .replace("@Norma", ""),
          },
        }
      : undefined,
}));

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

describe("command mention stripping", () => {
  const cfg: OpenClawConfig = {
    messages: { groupChat: { mentionPatterns: ["@Norma", "Norma"] } },
  };

  it("removes leading and command-suffix mentions", () => {
    expect(stripCommandAddressingMentions("@Norma /status", {}, cfg)).toBe("/status");
    expect(stripCommandAddressingMentions("/status@Norma", {}, cfg)).toBe("/status");
    expect(stripCommandAddressingMentions("/status@NormaEvil", {}, cfg)).toBe("/status@NormaEvil");
    expect(stripCommandAddressingMentions("/status@Norma.extra", {}, cfg)).toBe(
      "/status@Norma.extra",
    );
    const splitSuffixCfg: OpenClawConfig = {
      messages: { groupChat: { mentionPatterns: ["@Norma", "Evil"] } },
    };
    expect(stripCommandAddressingMentions("/status@NormaEvil", {}, splitSuffixCfg)).toBe(
      "/status@NormaEvil",
    );
    expect(stripCommandAddressingMentions("/status@NormaEvil", { Provider: "discord" }, {})).toBe(
      "/status@NormaEvil",
    );
  });

  it("preserves matching text in command arguments", () => {
    const command = "/acp spawn codex --cwd /Users/me/norma/projects/linkauto-app";
    expect(stripCommandAddressingMentions(command, {}, cfg)).toBe(command);
    expect(stripCommandAddressingMentions("/steer:Norma continue", {}, cfg)).toBe(
      "/steer:Norma continue",
    );
  });

  it("continues removing standalone addressing mentions after commands", () => {
    expect(stripCommandAddressingMentions("/steer Norma", {}, cfg)).toBe("/steer");
    expect(stripCommandAddressingMentions("/status @Norma", {}, cfg)).toBe("/status");
    expect(stripCommandAddressingMentions("/steer @Norma continue", {}, cfg)).toBe(
      "/steer continue",
    );
    expect(
      stripCommandAddressingMentions("/steer @Norma preserve  two spaces\nand a newline", {}, cfg),
    ).toBe("/steer preserve  two spaces\nand a newline");
  });

  it("strips configured mentions whose pattern consumes its whitespace boundary", () => {
    const boundaryCfg: OpenClawConfig = {
      messages: { groupChat: { mentionPatterns: [String.raw`(?:^|\s)@Norma(?=$|\s)`] } },
    };
    expect(stripCommandAddressingMentions("/status @Norma", {}, boundaryCfg)).toBe("/status");
    const suffixBoundaryCfg: OpenClawConfig = {
      messages: { groupChat: { mentionPatterns: [String.raw`@Norma(?:$|\s)`] } },
    };
    expect(stripCommandAddressingMentions("/status@Norma continue", {}, suffixBoundaryCfg)).toBe(
      "/status continue",
    );
  });

  it("does not strip a configured pattern from the command name", () => {
    const commandCfg: OpenClawConfig = {
      messages: { groupChat: { mentionPatterns: ["acp"] } },
    };
    expect(stripCommandAddressingMentions("/acp spawn codex", {}, commandCfg)).toBe(
      "/acp spawn codex",
    );
  });

  it("evaluates configured patterns against the complete command text", () => {
    const anchoredCfg: OpenClawConfig = {
      messages: { groupChat: { mentionPatterns: ["acp$"] } },
    };
    const command = "/acp spawn codex --cwd /tmp/app";

    expect(stripCommandAddressingMentions(command, {}, anchoredCfg)).toBe(command);
  });

  it("ignores zero-width mention matches in command arguments", () => {
    const zeroWidthCfg: OpenClawConfig = {
      messages: { groupChat: { mentionPatterns: ["$"] } },
    };
    const command = "/steer preserve  two spaces\nand a newline";

    expect(stripCommandAddressingMentions(command, {}, zeroWidthCfg)).toBe(command);
  });

  it("strips standalone provider mentions without changing embedded argument text", () => {
    const ctx = { Provider: "discord" };
    expect(stripCommandAddressingMentions("/status <@bot>", ctx, {})).toBe("/status");
    expect(stripCommandAddressingMentions("/status [Bot Name]", ctx, {})).toBe("/status");
    expect(stripCommandAddressingMentions("/status [A A] A", ctx, {})).toBe("/status A");
    expect(stripCommandAddressingMentions("/status [A A] A [A A] tail", ctx, {})).toBe(
      "/status A tail",
    );
    expect(stripCommandAddressingMentions("/steer A AA", ctx, {})).toBe("/steer A AA");
    expect(stripCommandAddressingMentions("/steer /path/<@bot>/file", ctx, {})).toBe(
      "/steer /path/<@bot>/file",
    );
    expect(stripCommandAddressingMentions("/steer <@bot>/file", ctx, {})).toBe(
      "/steer <@bot>/file",
    );
    expect(stripCommandAddressingMentions("/steer /path/[Bot Name]/file", ctx, {})).toBe(
      "/steer /path/[Bot Name]/file",
    );
    expect(stripCommandAddressingMentions("/steer [Bot Name]/file", ctx, {})).toBe(
      "/steer [Bot Name]/file",
    );
  });

  it("handles unmatched provider delimiters without quadratic scanning", () => {
    const command = `/steer ${"[ ".repeat(16_384)}`;
    const startedAt = performance.now();
    expect(stripCommandAddressingMentions(command, { Provider: "discord" }, {})).toBe(command);
    expect(performance.now() - startedAt).toBeLessThan(500);
  });

  it("keeps full mention stripping for non-command text", () => {
    expect(stripCommandAddressingMentions("hello Norma", {}, cfg)).toBe("hello");
    expect(stripMentions("hello <@12345>", { Provider: "discord" }, {})).toBe("hello");
  });
});
