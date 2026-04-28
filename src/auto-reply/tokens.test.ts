import { describe, it, expect } from "vitest";
import {
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

  describe("reasoning-wrapped silent replies (#66701)", () => {
    it("detects silent reply wrapped in a bare 'think' reasoning preamble", () => {
      const text = [
        "think",
        "Cav is talking about a follow-up conversation with someone else.",
        "I will stay quiet here.NO_REPLY",
      ].join("\n");
      expect(isSilentReplyText(text)).toBe(true);
    });

    it("detects silent reply wrapped in <think>...</think> tags", () => {
      const text = "<think>Internal reasoning here.</think>\nNO_REPLY";
      expect(isSilentReplyText(text)).toBe(true);
    });

    it("detects silent reply with <think> attributes", () => {
      const text = '<think type="internal">Reasoning</think> NO_REPLY';
      expect(isSilentReplyText(text)).toBe(true);
    });

    it("detects silent token at end even when glued to punctuation after reasoning", () => {
      const text = "think\nReasoning lines.\nFinal thought.NO_REPLY";
      expect(isSilentReplyText(text)).toBe(true);
    });

    it("does not treat substantive replies that happen to contain 'think' as silent (#19537)", () => {
      // No leading reasoning marker -> still not silent.
      expect(isSilentReplyText("I think this is a helpful response.\n\nNO_REPLY")).toBe(false);
    });

    it("does not match when 'think' is part of a word, not a reasoning marker", () => {
      expect(isSilentReplyText("thinking about it. NO_REPLY")).toBe(false);
    });

    it("works with custom token", () => {
      const text = "<think>Reasoning</think> HEARTBEAT_OK";
      expect(isSilentReplyText(text, "HEARTBEAT_OK")).toBe(true);
    });

    // Codex P1 review on PR #66755: a model that prefixes a substantive
    // reply with a reasoning block must NOT have its reply suppressed
    // just because it happens to end with NO_REPLY. Verify the predicate
    // rejects any case where there's prose between the reasoning preamble
    // and the trailing silent token.
    it("does NOT classify as silent when substantive prose follows the reasoning block", () => {
      const text = [
        "<think>Internal reasoning here.</think>",
        "Here is the answer you should send to the user.",
        "NO_REPLY",
      ].join("\n");
      expect(isSilentReplyText(text)).toBe(false);
    });

    it("does NOT classify as silent when bare-think preamble is followed by an answer", () => {
      const text = [
        "think",
        "Reasoning about the request.",
        "",
        "Hi there, here is what I found.",
        "NO_REPLY",
      ].join("\n");
      expect(isSilentReplyText(text)).toBe(false);
    });

    it("still classifies pure reasoning + NO_REPLY as silent (no prose between)", () => {
      const text = "<think>Just thinking, nothing to say.</think>\nNO_REPLY";
      expect(isSilentReplyText(text)).toBe(true);
    });

    // Codex P1 re-review on PR #66755: in bare-think form without a
    // blank-line separator, we cannot safely distinguish trailing
    // reasoning from a substantive reply that the model happened to
    // suffix with NO_REPLY on its own line. Only classify as silent in
    // this form when the token is GLUED to its preceding text (the
    // specific #66701 shape). If the token sits on its own line, be
    // conservative and return false.
    it("does NOT classify as silent when bare-think ends with token alone on a line (no blank-line separator)", () => {
      const text = [
        "think",
        "Reasoning about the request.",
        "Here is the answer for the user.",
        "NO_REPLY",
      ].join("\n");
      expect(isSilentReplyText(text)).toBe(false);
    });

    // Codex P1 re-review (3rd round) on PR #66755: the "glued"
    // adjacency check must require the character immediately before
    // the token to be non-whitespace. A SPACE-separated token (not
    // just newline-separated) still leaves the reasoning/output
    // boundary ambiguous and should return false.
    it("does NOT classify as silent when bare-think ends with space-separated token", () => {
      const text = ["think", "Reasoning about the request.", "Here is the answer. NO_REPLY"].join(
        "\n",
      );
      expect(isSilentReplyText(text)).toBe(false);
    });

    // Positive guard: true adjacency (no whitespace before token)
    // remains the #66701 shape and must stay silent.
    it("classifies bare-think with token truly glued to preceding punctuation as silent", () => {
      const text = "think\nReasoning.\nI will stay quiet here.NO_REPLY";
      expect(isSilentReplyText(text)).toBe(true);
    });

    // Codex P1 re-review on PR #66755 (line 109): the bare-think marker
    // regex previously used `\s*` which includes newlines, so a
    // blank-line separator like `think\n\nHere is the answer.NO_REPLY`
    // got swallowed by the marker. With the boundary gone, the
    // adjacency check would then misclassify the substantive answer as
    // silent. Marker now only eats horizontal whitespace + one newline.
    it("does NOT classify as silent when blank line separates marker from substantive reply (token glued)", () => {
      const text = "think\n\nHere is the answer.NO_REPLY";
      expect(isSilentReplyText(text)).toBe(false);
    });

    // Codex P2 re-review on PR #66755: an unclosed <think> tag (common
    // during streaming) where the body ends with the trailing token
    // should still be treated as silent — otherwise the reasoning
    // wrapper leaks when the model truncates before emitting </think>.
    it("classifies unclosed <think> block as silent when body ends with token", () => {
      const text = "<think>Reasoning lines without a close tag. NO_REPLY";
      expect(isSilentReplyText(text)).toBe(true);
    });

    it("does NOT classify unclosed <think> as silent when non-empty content follows token", () => {
      // A streamed block that happens to contain NO_REPLY mid-body
      // with user-facing text after it is NOT silent.
      const text = "<think>Reasoning NO_REPLY here is the answer";
      expect(isSilentReplyText(text)).toBe(false);
    });
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
