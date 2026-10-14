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
  it("returns false for undefined/empty", () => {
    expect(isSilentReplyText(undefined)).toBe(false);
    expect(isSilentReplyText("")).toBe(false);
  });

  it.each([".NO_REPLY", "\u{10100}No_RePlY NO_REPLY\u{10101}"])(
    "returns true for punctuation-wrapped token-only text: %j (#98166)",
    (text) => {
      expect(isSilentReplyText(text)).toBe(true);
    },
  );

  it("preserves exact custom-token matches with punctuation-edged tokens", () => {
    // Custom tokens whose first/last character is punctuation must still match
    expect(isSilentReplyText("*SILENT*", "*SILENT*")).toBe(true);
    expect(isSilentReplyText("**SILENT**", "*SILENT*")).toBe(false);
  });
});

describe("isSilentReplyPayloadText", () => {
  it.each(["NO_", "NO_R", "NO_RE", "NO_REP", "NO_REPL", " \nNO_R \n"])(
    "recognizes a truncated final silent token: %j",
    (text) => {
      expect(isSilentReplyPayloadText(text)).toBe(true);
    },
  );

  it.each(["N", "NO", "No", "no_r", "No issues found", "NO_R alert", "NO_REPLY_EXTRA"])(
    "preserves ordinary final text: %j",
    (text) => {
      expect(isSilentReplyPayloadText(text)).toBe(false);
    },
  );

  it("keeps custom silent tokens exact in final payloads", () => {
    expect(isSilentReplyPayloadText("HELP-", "HELP-QUIET")).toBe(false);
    expect(isSilentReplyPayloadText("NO_R", "NO_RESPONSE")).toBe(false);
  });

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

  it("keeps reasoning bodies that mention the token mid-text and close with it", () => {
    // Mixed reasoning + prose bodies stay deliverable: a standalone in-body
    // mention of the token is never treated as a silence decision, matching
    // the answer-preservation contract (#165025 untagged path: #138662).
    expect(
      isSilentReplyPayloadText(
        "think\nThe runtime context confirms another continuation event -- same inbound (msg 24682), and my reply already went out successfully (msg 24683).\n\nThe correct move: NO_REPLY. The user already has my response. Adding more text would be noise.\n\nNO_REPLY.",
      ),
    ).toBe(false);
    expect(
      isSilentReplyPayloadText(
        "analysis\nMeeting moved to 3 pm. The NO_REPLY token is a control marker.\nNO_REPLY",
      ),
    ).toBe(false);
  });

  it.each([".", "!", "?"])("suppresses reasoning text with trailing NO_REPLY%s", (punctuation) => {
    expect(isSilentReplyPayloadText(`think\ninternal reasoning\nNO_REPLY${punctuation}`)).toBe(
      true,
    );
  });

  it("keeps reasoning bodies that mention the token but decide to answer", () => {
    expect(
      isSilentReplyPayloadText(
        "think\nThe user asked me to reply NO_REPLY only when there is nothing new.\nHere is the answer: 2+2=4.\nNO_REPLY",
      ),
    ).toBe(false);
  });
});

describe("stripSilentToken", () => {
  it("preserves punctuation-attached silent-token literals", () => {
    const text = "Done as requested!NO_REPLY";
    expect(stripSilentToken(text)).toBe(text);
  });

  it.each([["Done. NO_REPLY NO_REPLY", "Done."]])(
    "strips adjacent trailing silent tokens in %j",
    (text, expected) => {
      expect(stripSilentToken(text)).toBe(expected);
    },
  );
});

describe("custom silent tokens", () => {
  it.each(["a+b?"])("keeps interleaved matching independent for %s", (token) => {
    const upper = token.toUpperCase();
    for (let pass = 0; pass < 2; pass++) {
      expect(isSilentReplyText(`${upper} ${token}`, token)).toBe(true);
      expect(isSilentReplyPayloadText(`think\ninternal reasoning\n${token}!`, token)).toBe(true);
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

describe("startsWithSilentToken", () => {
  it.each(["NO_REPLY NO_REPLY: explanation"])(
    "preserves repeated tokens before substantive punctuation: %j",
    (text) => {
      expect(startsWithSilentToken(text)).toBe(false);
    },
  );
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

  it("rejects non-prefixes and mixed characters", () => {
    expect(isSilentReplyPrefixText("NO_X")).toBe(false);
    expect(isSilentReplyPrefixText("NO_REPLY more")).toBe(false);
    expect(isSilentReplyPrefixText("NO-")).toBe(false);
  });

  it("rejects pure-letter prefixes for punctuated tokens to avoid false suppression", () => {
    expect(isSilentReplyPrefixText("HE", "HELP-QUIET")).toBe(false);
    expect(isSilentReplyPrefixText("HELP", "HELP-QUIET")).toBe(false);
    expect(isSilentReplyPrefixText("HELP-", "HELP-QUIET")).toBe(true);
    expect(isSilentReplyPrefixText("HELP-QUIET", "HELP-QUIET")).toBe(true);
  });
});
