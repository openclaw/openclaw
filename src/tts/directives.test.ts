import { describe, expect, it } from "vitest";
import { parseTtsDirectives } from "./directives.js";
import type { SpeechModelOverridePolicy } from "./provider-types.js";

const OPEN_POLICY: SpeechModelOverridePolicy = {
  enabled: true,
  allowProvider: true,
  allowVoice: true,
  allowModel: true,
  allowText: true,
  allowVoiceSettings: true,
};

describe("parseTtsDirectives", () => {
  it("strips a well-paired [[tts:text]]...[[/tts:text]] block and captures the text", () => {
    const result = parseTtsDirectives(
      "[[tts:voiceId=XXX model=eleven_v3]][[tts:text]]spoken content[[/tts:text]]",
      OPEN_POLICY,
      { providers: [] },
    );
    expect(result.cleanedText).toBe("");
    expect(result.ttsText).toBe("spoken content");
    expect(result.hasDirective).toBe(true);
  });

  it("strips a stray '[/tts:text]]' closing tag that does not pair with an opener (#67343)", () => {
    // Reporter's exact symptom: the caption leaked `spoken content[/tts:text]]`
    // because the model emitted a single '[' before the closer, so the paired
    // blockRegex did not match and the closer survived.
    const result = parseTtsDirectives(
      "[[tts:voiceId=XXX model=eleven_v3]][[tts:text]]spoken content[/tts:text]]",
      OPEN_POLICY,
      { providers: [] },
    );
    expect(result.cleanedText).toBe("spoken content");
    expect(result.hasDirective).toBe(true);
  });

  it("strips a stray '[[/tts:text]' closer that is missing a trailing ']'", () => {
    const result = parseTtsDirectives(
      "[[tts:text]]content[[/tts:text]",
      OPEN_POLICY,
      { providers: [] },
    );
    expect(result.cleanedText).toBe("content");
    expect(result.hasDirective).toBe(true);
  });

  it("strips a stray '/tts:text]]' closer with no leading brackets", () => {
    const result = parseTtsDirectives(
      "hello [/tts:text]] world",
      OPEN_POLICY,
      { providers: [] },
    );
    expect(result.cleanedText).toBe("hello  world");
    expect(result.hasDirective).toBe(true);
  });

  it("tolerates whitespace inside a stray closer", () => {
    const result = parseTtsDirectives(
      "[[tts:text]]content[[ / tts : text ]]",
      OPEN_POLICY,
      { providers: [] },
    );
    expect(result.cleanedText).toBe("content");
    expect(result.hasDirective).toBe(true);
  });

  it("leaves unrelated text that merely mentions 'tts:text' untouched", () => {
    const result = parseTtsDirectives("this mentions tts:text in prose", OPEN_POLICY, {
      providers: [],
    });
    expect(result.cleanedText).toBe("this mentions tts:text in prose");
    // No opener and no closer-shaped tokens → no directive.
    expect(result.hasDirective).toBe(false);
  });

  it("returns the raw text verbatim when the policy is disabled", () => {
    const result = parseTtsDirectives(
      "[[tts:text]]content[/tts:text]]",
      { ...OPEN_POLICY, enabled: false },
      { providers: [] },
    );
    expect(result.cleanedText).toBe("[[tts:text]]content[/tts:text]]");
    expect(result.hasDirective).toBe(false);
  });
});
