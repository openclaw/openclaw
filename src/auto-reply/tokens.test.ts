/** Tests silent-reply and heartbeat token parsing helpers. */
import { describe, it, expect } from "vitest";
import {
  isInternalFormattingArtifact,
  isSilentReplyPrefixText,
  isSilentReplyPayloadText,
  isSilentReplyText,
  startsWithSilentToken,
  stripLeadingSilentToken,
  stripSilentToken,
} from "./tokens.js";

describe("isInternalFormattingArtifact", () => {
  it("matches Harmony channel markers (#88128)", () => {
    expect(isInternalFormattingArtifact("  <channel|>  ")).toBe(true);
    expect(isInternalFormattingArtifact("<channel|answer>")).toBe(true);
    expect(isInternalFormattingArtifact("<lane|reasoning>")).toBe(true);
    expect(isInternalFormattingArtifact("<|>")).toBe(true);
    expect(isInternalFormattingArtifact("<|channel|>")).toBe(true);
  });

  it("matches set-thought directives (#88128)", () => {
    expect(isInternalFormattingArtifact("  set-thought <channel|>  ")).toBe(true);
    expect(isInternalFormattingArtifact("set-thought <lane|reasoning>")).toBe(true);
  });

  it("matches box-drawing HR separators (#88128)", () => {
    expect(isInternalFormattingArtifact("  ───  ")).toBe(true);
  });

  it("does NOT match generic markdown separators (avoids false positives)", () => {
    expect(isInternalFormattingArtifact("---")).toBe(false);
    expect(isInternalFormattingArtifact("___")).toBe(false);
    expect(isInternalFormattingArtifact("***")).toBe(false);
  });

  it("does NOT match generic XML-like tags (avoids false positives)", () => {
    expect(isInternalFormattingArtifact("<tag>")).toBe(false);
    expect(isInternalFormattingArtifact("</tag>")).toBe(false);
    expect(isInternalFormattingArtifact("<br/>")).toBe(false);
  });

  it("returns false for undefined/empty", () => {
    expect(isInternalFormattingArtifact(undefined)).toBe(false);
    expect(isInternalFormattingArtifact("")).toBe(false);
  });

  it("returns false for text that merely contains an artifact pattern", () => {
    expect(isInternalFormattingArtifact("Here are the options:\n───\n1. Option A")).toBe(false);
    expect(isInternalFormattingArtifact("Use <channel|> in your config.")).toBe(false);
    expect(isInternalFormattingArtifact("The set-thought mechanism works like this...")).toBe(
      false,
    );
  });
});

describe("isSilentReplyText", () => {
  it("returns true for exact token", () => {
    expect(isSilentReplyText("NO_REPLY")).toBe(true);
  });

  it("returns true for token with surrounding whitespace", () => {
    expect(isSilentReplyText("  NO_REPLY  ")).toBe(true);
  });

  it("returns true for mixed-case token", () => {
    expect(isSilentReplyText("  No_RePlY  ")).toBe(true);
  });

  it("returns true for repeated token-only text separated by whitespace", () => {
    expect(isSilentReplyText("NO_REPLY\n\nNO_REPLY")).toBe(true);
    expect(isSilentReplyText("  no_reply \t No_RePlY  ")).toBe(true);
  });

  it("returns false for undefined/empty", () => {
    expect(isSilentReplyText(undefined)).toBe(false);
    expect(isSilentReplyText("")).toBe(false);
  });

  it("returns false for substantive text ending with token (#19537)", () => {
    const text = "Here is a helpful response.\n\nNO_REPLY";
    expect(isSilentReplyText(text)).toBe(false);
  });

  it("returns false for substantive text starting with token", () => {
    const text = "NO_REPLY but here is more content";
    expect(isSilentReplyText(text)).toBe(false);
  });

  it("returns false for token embedded in text", () => {
    expect(isSilentReplyText("Please NO_REPLY to this")).toBe(false);
  });

  it.each([
    ".NO_REPLY",
    "NO_REPLY.",
    " *NO_REPLY* ",
    "«NO_REPLY»",
    "\u{10100}No_RePlY NO_REPLY\u{10101}",
  ])("returns true for punctuation-wrapped token-only text: %j (#98166)", (text) => {
    expect(isSilentReplyText(text)).toBe(true);
  });

  it.each([
    "the sentinel is NO_REPLY, fyi",
    "💬NO_REPLY",
    "NO_REPLY👍",
    "NO_REPLY\ud800",
    "NO_REPLY\udc00",
  ])("keeps substantive punctuation or symbols: %j", (text) => {
    expect(isSilentReplyText(text)).toBe(false);
  });

  it("preserves exact custom-token matches with punctuation-edged tokens", () => {
    // Custom tokens whose first/last character is punctuation must still match
    expect(isSilentReplyText("*SILENT*", "*SILENT*")).toBe(true);
    expect(isSilentReplyText("**SILENT**", "*SILENT*")).toBe(false);
  });
});

describe("isSilentReplyPayloadText", () => {
  it("returns true when leaked reasoning text ends in NO_REPLY", () => {
    expect(
      isSilentReplyPayloadText(
        "think\nCav is talking about a follow-up conversation.\nI will stay quiet here.NO_REPLY",
      ),
    ).toBe(true);
    expect(isSilentReplyPayloadText("think\ninternal reasoning\nNO_REPLY")).toBe(true);
    expect(isSilentReplyPayloadText("<think>internal reasoning</think>\nNO_REPLY")).toBe(true);
    expect(
      isSilentReplyPayloadText(
        "<think>internal reasoning</think>\nI will stay quiet here.NO_REPLY",
      ),
    ).toBe(true);
    expect(isSilentReplyPayloadText("<think>I will stay quiet here.NO_REPLY")).toBe(true);
  });

  it.each([
    ["closed", "<mm:think>internal reasoning</mm:think>\nNO_REPLY"],
    ["open", "<mm:think>internal reasoning\nNO_REPLY"],
  ])("returns true for %s MiniMax reasoning followed by NO_REPLY", (_kind, text) => {
    expect(isSilentReplyPayloadText(text)).toBe(true);
  });

  it("returns true when leaked reasoning ends in NO_REPLY with a padded closing line (#165025)", () => {
    const deliberation = [
      "The runtime context confirms another continuation event -- same inbound (msg 24682, prior diagnosis message), and my reply already went out successfully (msg 24683).",
      "There's no new user message after my reply. The pattern is the same as prior continuations: the runtime is replaying the same inbound event after my messages.",
      "The correct move: NO_REPLY. The user already has my response. Adding more text would be noise.",
      "NO_REPLY.",
    ].join("\n\n");
    expect(isSilentReplyPayloadText(`thinking:\n${deliberation}`)).toBe(true);
  });

  it("returns true when the final line wraps the silent intent in extra deliberation (#165025)", () => {
    expect(
      isSilentReplyPayloadText(
        "think:\nI checked the logs, nothing to add. I will stay silent. NO_REPLY",
      ),
    ).toBe(true);
    expect(isSilentReplyPayloadText("think:\nno need to reply here\nNO_REPLY")).toBe(true);
    expect(isSilentReplyPayloadText("think:\nnothing more to add\nNO_REPLY")).toBe(true);
    expect(
      isSilentReplyPayloadText("think:\nNothing new came in. No need to reply.\nNO_REPLY"),
    ).toBe(true);
  });

  it("returns true when the final token carries trailing punctuation (#165025)", () => {
    expect(isSilentReplyPayloadText("think:\nI will stay quiet here. NO_REPLY.")).toBe(true);
    expect(isSilentReplyPayloadText("think:\ninternal reasoning\nNO_REPLY!")).toBe(true);
  });

  it("keeps substantive answers that end with a padded silent intent deliverable", () => {
    expect(
      isSilentReplyPayloadText("think:\nHere is the actual answer. I will stay silent. NO_REPLY"),
    ).toBe(false);
    expect(
      isSilentReplyPayloadText(
        "think:\nPlease use the attached draft. No need to reply.\nNO_REPLY",
      ),
    ).toBe(false);
    expect(
      isSilentReplyPayloadText(
        "think:\nThe moderator asked everyone to stay silent during the ceremony.\nNO_REPLY",
      ),
    ).toBe(false);
    expect(
      isSilentReplyPayloadText("think:\nThe correct sentinel here is NO_REPLY.\nNO_REPLY"),
    ).toBe(false);
  });

  it("keeps substantive replies that also contain a trailing NO_REPLY token", () => {
    expect(isSilentReplyPayloadText("Here is a helpful response.\n\nNO_REPLY")).toBe(false);
    expect(
      isSilentReplyPayloadText(
        "think\nHere is the actual answer.\nI will stay quiet here.NO_REPLY",
      ),
    ).toBe(false);
    expect(
      isSilentReplyPayloadText("think\nCav is talking about a follow-up conversation.\nNO_REPLY"),
    ).toBe(false);
    expect(isSilentReplyPayloadText("analysis\nMeeting moved to 3 pm.\nNO_REPLY")).toBe(false);
    expect(
      isSilentReplyPayloadText(
        "think\nThe user is asking whether the outage is resolved. Tell them the service is back up and they should retry.\nNO_REPLY",
      ),
    ).toBe(false);
    expect(
      isSilentReplyPayloadText("<think>internal reasoning</think>\nHere is the answer.\nNO_REPLY"),
    ).toBe(false);
    expect(isSilentReplyPayloadText("think\nHere is the actual answer.\nNO_REPLY")).toBe(false);
    expect(
      isSilentReplyPayloadText(
        "<think>internal reasoning</think>\nYou should not reply to that email.\nNO_REPLY",
      ),
    ).toBe(false);
    expect(
      isSilentReplyPayloadText("<think>internal notes\nHere is the actual answer.\nNO_REPLY"),
    ).toBe(false);
    expect(
      isSilentReplyPayloadText(
        "<think>internal reasoning</think>\nHere is the answer: I will stay quiet in the meeting, but you should still send the agenda.NO_REPLY",
      ),
    ).toBe(false);
  });
});

describe("stripSilentToken", () => {
  it("strips token from end of text", () => {
    expect(stripSilentToken("Done.\n\nNO_REPLY")).toBe("Done.");
  });

  it("does not strip token from start of text", () => {
    expect(stripSilentToken("NO_REPLY 👍")).toBe("NO_REPLY 👍");
  });

  it("strips token with emoji (#30916)", () => {
    expect(stripSilentToken("😄 NO_REPLY")).toBe("😄");
  });

  it("preserves punctuation-attached silent-token literals", () => {
    const text = "Done as requested!NO_REPLY";
    expect(stripSilentToken(text)).toBe(text);
  });

  it("does not strip embedded token suffix without whitespace delimiter", () => {
    expect(stripSilentToken("interject.NO_REPLY")).toBe("interject.NO_REPLY");
    expect(stripSilentToken("The example is interject.NO_REPLY")).toBe(
      "The example is interject.NO_REPLY",
    );
    expect(stripSilentToken("Done as requested.NO_REPLY")).toBe("Done as requested.NO_REPLY");
  });

  it("strips only trailing occurrence", () => {
    expect(stripSilentToken("NO_REPLY ok NO_REPLY")).toBe("NO_REPLY ok");
  });

  it.each([
    ["Done. NO_REPLY NO_REPLY", "Done."],
    ["Done.\r\nno_reply\tNO_REPLY\u00a0", "Done."],
    ["**NO_REPLY NO_REPLY", ""],
    ["Done.NO_REPLY NO_REPLY", "Done.NO_REPLY"],
  ])("strips adjacent trailing silent tokens in %j", (text, expected) => {
    expect(stripSilentToken(text)).toBe(expected);
  });

  it("returns empty string when only token remains", () => {
    expect(stripSilentToken("NO_REPLY")).toBe("");
    expect(stripSilentToken("  NO_REPLY  ")).toBe("");
  });

  it("strips token preceded by bold markdown formatting", () => {
    expect(stripSilentToken("**NO_REPLY")).toBe("");
    expect(stripSilentToken("some text **NO_REPLY")).toBe("some text");
    expect(stripSilentToken("reasoning**NO_REPLY")).toBe("reasoning");
  });
});

describe("custom silent tokens", () => {
  it.each([
    {
      name: "exact-token detection",
      check: () => isSilentReplyText("HEARTBEAT_OK", "HEARTBEAT_OK"),
      expected: true,
    },
    {
      name: "substantive text detection",
      check: () => isSilentReplyText("Checked inbox. HEARTBEAT_OK", "HEARTBEAT_OK"),
      expected: false,
    },
    {
      name: "repeated-token detection",
      check: () => isSilentReplyText("HEARTBEAT_OK\nHEARTBEAT_OK", "HEARTBEAT_OK"),
      expected: true,
    },
    {
      name: "trailing token stripping",
      check: () => stripSilentToken("done HEARTBEAT_OK", "HEARTBEAT_OK"),
      expected: "done",
    },
    {
      name: "trailing token with regex punctuation",
      check: () => stripSilentToken("done [quiet] [QUIET]\n", "[quiet]"),
      expected: "done",
    },
    {
      name: "trailing token containing whitespace",
      check: () => stripSilentToken("done KEEP QUIET KEEP QUIET", "KEEP QUIET"),
      expected: "done",
    },
  ])("handles custom token for $name", ({ check, expected }) => {
    expect(check()).toBe(expected);
  });

  it.each(["[quiet]", "a+b?"])("keeps interleaved matching independent for %s", (token) => {
    const upper = token.toUpperCase();
    for (let pass = 0; pass < 2; pass++) {
      expect(isSilentReplyText(`${upper} ${token}`, token)).toBe(true);
      expect(stripSilentToken(`done ${upper}\n`, token)).toBe("done");
      expect(startsWithSilentToken(`${upper}你好`, token)).toBe(true);
      expect(stripLeadingSilentToken(`${upper}你好`, token)).toBe("你好");
      expect(startsWithSilentToken(`${upper}7`, token)).toBe(true);
      expect(startsWithSilentToken(`${upper}: literal`, token)).toBe(false);
      expect(startsWithSilentToken(`${upper}\n: visible`, token)).toBe(true);
      expect(stripLeadingSilentToken(`${upper}\n: visible`, token)).toBe(": visible");
      expect(isSilentReplyText(`visible ${upper}`, token)).toBe(false);
    }
  });
});

describe("stripLeadingSilentToken", () => {
  it("strips glued leading token text", () => {
    expect(stripLeadingSilentToken("NO_REPLYThe user is saying")).toBe("The user is saying");
  });
});

describe("startsWithSilentToken", () => {
  it("matches leading glued silent tokens case-insensitively", () => {
    expect(startsWithSilentToken("No_RePlYThe user is saying")).toBe(true);
  });

  it("rejects separated substantive prefixes and exact-token-only text", () => {
    expect(startsWithSilentToken("NO_REPLY -- nope")).toBe(false);
    expect(startsWithSilentToken("NO_REPLY: explanation")).toBe(false);
    expect(startsWithSilentToken("NO_REPLY—note")).toBe(false);
    expect(startsWithSilentToken("NO_REPLY")).toBe(false);
    expect(startsWithSilentToken("  NO_REPLY  ")).toBe(false);
  });

  it.each([
    "NO_REPLY\n\nThe user is saying hello",
    "NO_REPLY\r\nThe user is saying hello",
    "NO_REPLY NO_REPLY\nThe user is saying hello",
    "NO_REPLY\n✅ Done",
  ])("matches newline-separated leading silent tokens: %j", (text) => {
    expect(startsWithSilentToken(text)).toBe(true);
  });

  it.each([
    "NO_REPLY NO_REPLY: explanation",
    "NO_REPLY\nNO_REPLY: explanation",
    "\nNO_REPLY explanation",
    "NO_REPLY\nNO_REPLY explanation",
  ])("preserves repeated tokens before substantive punctuation: %j", (text) => {
    expect(startsWithSilentToken(text)).toBe(false);
  });
});

describe("isSilentReplyPrefixText", () => {
  it("matches uppercase token lead fragments", () => {
    expect(isSilentReplyPrefixText("NO")).toBe(true);
    expect(isSilentReplyPrefixText("NO_")).toBe(true);
    expect(isSilentReplyPrefixText("NO_RE")).toBe(true);
    expect(isSilentReplyPrefixText("NO_REPLY")).toBe(true);
    expect(isSilentReplyPrefixText("  HEARTBEAT_", "HEARTBEAT_OK")).toBe(true);
  });

  it("rejects ambiguous natural-language prefixes", () => {
    expect(isSilentReplyPrefixText("N")).toBe(false);
    expect(isSilentReplyPrefixText("No")).toBe(false);
    expect(isSilentReplyPrefixText("no")).toBe(false);
    expect(isSilentReplyPrefixText("Hello")).toBe(false);
  });

  it("keeps underscore guard for non-NO_REPLY tokens", () => {
    expect(isSilentReplyPrefixText("HE", "HEARTBEAT_OK")).toBe(false);
    expect(isSilentReplyPrefixText("HEARTBEAT_", "HEARTBEAT_OK")).toBe(true);
  });

  it("rejects non-prefixes and mixed characters", () => {
    expect(isSilentReplyPrefixText("NO_X")).toBe(false);
    expect(isSilentReplyPrefixText("NO_REPLY more")).toBe(false);
    expect(isSilentReplyPrefixText("NO-")).toBe(false);
  });

  it("matches custom tokens with digits", () => {
    expect(isSilentReplyPrefixText("NOREPLY2", "NOREPLY2")).toBe(true);
    expect(isSilentReplyPrefixText("NOREPLY", "NOREPLY2")).toBe(false);
  });

  it("matches custom tokens with hyphens", () => {
    expect(isSilentReplyPrefixText("NO-ANSWER", "NO-ANSWER")).toBe(true);
    expect(isSilentReplyPrefixText("NO-AN", "NO-ANSWER")).toBe(true);
    expect(isSilentReplyPrefixText("NO-", "NO-ANSWER")).toBe(true);
  });

  it("rejects non-matching prefixes for custom tokens", () => {
    expect(isSilentReplyPrefixText("HE", "NOREPLY2")).toBe(false);
    expect(isSilentReplyPrefixText("HELLO", "NO-ANSWER")).toBe(false);
    expect(isSilentReplyPrefixText("NO-", "NOREPLY2")).toBe(false);
  });

  it("rejects pure-letter prefixes for punctuated tokens to avoid false suppression", () => {
    expect(isSilentReplyPrefixText("HE", "HELP-QUIET")).toBe(false);
    expect(isSilentReplyPrefixText("HELP", "HELP-QUIET")).toBe(false);
    expect(isSilentReplyPrefixText("HELP-", "HELP-QUIET")).toBe(true);
    expect(isSilentReplyPrefixText("HELP-QUIET", "HELP-QUIET")).toBe(true);
  });
});
