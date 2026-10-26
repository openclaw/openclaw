// TTS directive number tests cover parsing numeric speech directives.
import { describe, expect, it } from "vitest";
import { parseSpeechDirectiveNumberOverride } from "./directive-number.js";
import { createFullSpeechPolicy } from "./speech-provider.test-support.js";

const policy = createFullSpeechPolicy();

describe("parseSpeechDirectiveNumberOverride", () => {
  it("respects exclusive range bounds", () => {
    expect(
      parseSpeechDirectiveNumberOverride({
        ctx: { key: "temperature", value: "0", policy },
        overrideKey: "temperature",
        range: { min: 0, minExclusive: true, max: 2 },
        warning: (value) => `invalid temperature ${value}`,
      }),
    ).toEqual({ handled: true, warnings: ["invalid temperature 0"] });
  });

  it("suppresses settings when policy disallows voice settings", () => {
    expect(
      parseSpeechDirectiveNumberOverride({
        ctx: {
          key: "speed",
          get value(): never {
            throw new Error("disabled settings must not read the token");
          },
          policy: { ...policy, allowVoiceSettings: false },
        },
        overrideKey: "speed",
        get range(): never {
          throw new Error("disabled settings must not read the range");
        },
        get warning(): never {
          throw new Error("disabled settings must not read the warning");
        },
      }),
    ).toEqual({ handled: true });
  });

  it.each([
    { mergeCurrentOverrides: undefined, expected: { speed: 1.25 } },
    { mergeCurrentOverrides: true, expected: { voice: "retained", speed: 1.25 } },
  ])(
    "preserves input when merge is $mergeCurrentOverrides",
    ({ mergeCurrentOverrides, expected }) => {
      const currentOverrides = Object.freeze({ voice: "retained", speed: 0.75 });
      const result = parseSpeechDirectiveNumberOverride({
        ctx: { key: "speed", value: "1.25", policy, currentOverrides },
        overrideKey: "speed",
        range: { min: 0.5, max: 2 },
        warning: () => "invalid speed",
        mergeCurrentOverrides,
      });
      expect(result).toEqual({ handled: true, overrides: expected });
      expect(result.overrides).not.toBe(currentOverrides);
      expect(currentOverrides).toEqual({ voice: "retained", speed: 0.75 });
    },
  );
});
