import { describe, it, expect } from "vitest";
import {
  isReasoningPrefacedSilentReply,
  isSilentReplyPayloadText,
  isSilentReplyPrefixText,
  isSilentReplyText,
  startsWithSilentToken,
  stripLeadingSilentToken,
  stripSilentToken,
} from "./tokens.js";

describe("isSilentReplyText", () => {
  it("returns true for exact token", () => {
    expect(isSilentReplyText("NO_REPLY")).toBe(true);
  });

  it("returns true for token with surrounding whitespace", () => {
    expect(isSilentReplyText("  NO_REPLY  ")).toBe(true);
    expect(isSilentReplyText("\nNO_REPLY\n")).toBe(true);
  });

  it("returns true for mixed-case token", () => {
    expect(isSilentReplyText("no_reply")).toBe(true);
    expect(isSilentReplyText("  No_RePlY  ")).toBe(true);
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

  it("works with custom token", () => {
    expect(isSilentReplyText("HEARTBEAT_OK", "HEARTBEAT_OK")).toBe(true);
    expect(isSilentReplyText("Checked inbox. HEARTBEAT_OK", "HEARTBEAT_OK")).toBe(false);
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

  it("does not strip embedded token suffix without whitespace delimiter", () => {
    expect(stripSilentToken("interject.NO_REPLY")).toBe("interject.NO_REPLY");
  });

  it("strips only trailing occurrence", () => {
    expect(stripSilentToken("NO_REPLY ok NO_REPLY")).toBe("NO_REPLY ok");
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

  it("works with custom token", () => {
    expect(stripSilentToken("done HEARTBEAT_OK", "HEARTBEAT_OK")).toBe("done");
  });
});

describe("stripLeadingSilentToken", () => {
  it("strips glued leading token text", () => {
    expect(stripLeadingSilentToken("NO_REPLYThe user is saying")).toBe("The user is saying");
  });
});

describe("startsWithSilentToken", () => {
  it("matches leading glued silent tokens case-insensitively", () => {
    expect(startsWithSilentToken("NO_REPLYThe user is saying")).toBe(true);
    expect(startsWithSilentToken("No_RePlYThe user is saying")).toBe(true);
    expect(startsWithSilentToken("no_replyThe user is saying")).toBe(true);
  });

  it("rejects separated substantive prefixes and exact-token-only text", () => {
    expect(startsWithSilentToken("NO_REPLY -- nope")).toBe(false);
    expect(startsWithSilentToken("NO_REPLY: explanation")).toBe(false);
    expect(startsWithSilentToken("NO_REPLY—note")).toBe(false);
    expect(startsWithSilentToken("NO_REPLY")).toBe(false);
    expect(startsWithSilentToken("  NO_REPLY  ")).toBe(false);
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
    expect(isSilentReplyPrefixText("HEART", "HEARTBEAT_OK")).toBe(false);
    expect(isSilentReplyPrefixText("HEARTBEAT", "HEARTBEAT_OK")).toBe(false);
    expect(isSilentReplyPrefixText("HEARTBEAT_", "HEARTBEAT_OK")).toBe(true);
  });

  it("rejects non-prefixes and mixed characters", () => {
    expect(isSilentReplyPrefixText("NO_X")).toBe(false);
    expect(isSilentReplyPrefixText("NO_REPLY more")).toBe(false);
    expect(isSilentReplyPrefixText("NO-")).toBe(false);
  });
});

describe("isReasoningPrefacedSilentReply", () => {
  it("classifies reasoning preamble + trailing NO_REPLY as silent", () => {
    const text =
      "think\n" +
      "The user's message is from Aftermath in the #general channel.\n" +
      "The message is a self-promotional advertisement.\n" +
      "Silence is the required action.\n" +
      "Therefore, I should output NO_REPLY.NO_REPLY";
    expect(isReasoningPrefacedSilentReply(text)).toBe(true);
  });

  it("classifies single trailing NO_REPLY with reasoning preamble as silent", () => {
    const text = "think\nThe user is saying hello. I will not reply.\nNO_REPLY";
    expect(isReasoningPrefacedSilentReply(text)).toBe(true);
  });

  it("accepts other reasoning heading words", () => {
    for (const heading of ["thinking", "thought", "reasoning", "analysis"]) {
      const text = `${heading}\nUser asked a trivial question.\nNO_REPLY`;
      expect(isReasoningPrefacedSilentReply(text)).toBe(true);
    }
  });

  it("accepts reasoning heading with trailing colon", () => {
    expect(isReasoningPrefacedSilentReply("thinking:\nSome analysis.\nNO_REPLY")).toBe(true);
  });

  it("collapses doubled trailing NO_REPLY forms with inner punctuation", () => {
    // The exact observed pattern from the bug report.
    expect(isReasoningPrefacedSilentReply("think\nbody\nNO_REPLY.NO_REPLY")).toBe(true);
    expect(isReasoningPrefacedSilentReply("think\nbody\nNO_REPLY NO_REPLY")).toBe(true);
    expect(isReasoningPrefacedSilentReply("think\nbody\nNO_REPLY. NO_REPLY")).toBe(true);
  });

  it("preserves #19537 — substantive replies ending with NO_REPLY are not silent", () => {
    const substantive = "Here is the answer you asked for.\n\nNO_REPLY";
    expect(isReasoningPrefacedSilentReply(substantive)).toBe(false);
  });

  it("returns false when message does not end with the silent token", () => {
    expect(isReasoningPrefacedSilentReply("think\nbody\nactual reply")).toBe(false);
  });

  it("returns false for plain substantive text without reasoning preamble", () => {
    expect(isReasoningPrefacedSilentReply("I should reply to this. NO_REPLY")).toBe(false);
  });

  it("returns false for empty or whitespace-only input", () => {
    expect(isReasoningPrefacedSilentReply("")).toBe(false);
    expect(isReasoningPrefacedSilentReply(undefined)).toBe(false);
    expect(isReasoningPrefacedSilentReply("   ")).toBe(false);
  });

  it("returns true when only the silent token remains after trimming", () => {
    expect(isReasoningPrefacedSilentReply("  NO_REPLY  ")).toBe(true);
    expect(isReasoningPrefacedSilentReply("NO_REPLY.NO_REPLY")).toBe(true);
  });

  it("does not match when reasoning heading is followed inline by prose on same line", () => {
    // A bare heading must be on its own line; inline "think the answer is X" is
    // natural language and should not be suppressed.
    expect(isReasoningPrefacedSilentReply("think the answer is yes\nNO_REPLY")).toBe(false);
  });
});

describe("isSilentReplyPayloadText integration", () => {
  it("returns true for reasoning-prefaced silent replies", () => {
    expect(isSilentReplyPayloadText("think\nanalysis goes here\nNO_REPLY.NO_REPLY")).toBe(true);
  });

  it("still returns true for exact token", () => {
    expect(isSilentReplyPayloadText("NO_REPLY")).toBe(true);
  });

  it("still returns true for JSON action envelope", () => {
    expect(isSilentReplyPayloadText('{"action":"NO_REPLY"}')).toBe(true);
  });

  it("still returns false for substantive replies ending with NO_REPLY (#19537)", () => {
    expect(isSilentReplyPayloadText("Here is a helpful response.\n\nNO_REPLY")).toBe(false);
  });
});
