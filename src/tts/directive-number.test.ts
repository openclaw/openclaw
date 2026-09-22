// TTS directive number tests cover parsing numeric speech directives.
import { describe, expect, it, vi } from "vitest";
import { parseSpeechDirectiveNumberOverride } from "./directive-number.js";

const policy = {
  enabled: true,
  allowText: true,
  allowProvider: true,
  allowVoice: true,
  allowModelId: true,
  allowVoiceSettings: true,
  allowNormalization: true,
  allowSeed: true,
};

describe("parseSpeechDirectiveNumberOverride", () => {
  it("parses strict decimal directive numbers into overrides", () => {
    expect(
      parseSpeechDirectiveNumberOverride({
        ctx: { key: "speed", value: "1.25", policy },
        overrideKey: "speed",
        range: { min: 0.5, max: 2 },
        warning: (value) => `invalid speed ${value}`,
      }),
    ).toEqual({ handled: true, overrides: { speed: 1.25 } });
  });

  it("rejects non-decimal directive numbers", () => {
    expect(
      parseSpeechDirectiveNumberOverride({
        ctx: { key: "speed", value: "0x1", policy },
        overrideKey: "speed",
        range: { min: 0.5, max: 2 },
        warning: (value) => `invalid speed ${value}`,
      }),
    ).toEqual({ handled: true, warnings: ["invalid speed 0x1"] });
  });

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
    { value: "0", range: { min: 0, max: 1 }, expected: 0 },
    { value: "-0", range: { min: 0, max: 1 }, expected: -0 },
    { value: "0.5", range: { min: 0.5, max: 2 }, expected: 0.5 },
    { value: "2", range: { min: 0.5, max: 2 }, expected: 2 },
    { value: "1.5", range: { min: 0, max: 2, maxExclusive: true }, expected: 1.5 },
    { value: "-0.5", range: { max: 0 }, expected: -0.5 },
    { value: "2e1", range: { min: 0 }, expected: 20 },
    { value: "-100", range: {}, expected: -100 },
  ])("preserves $value within the configured bounds", ({ value, range, expected }) => {
    const result = parseSpeechDirectiveNumberOverride({
      ctx: { key: "speed", value, policy },
      overrideKey: "speed",
      range,
      warning: () => "out of range",
    });
    expect(result).toEqual({ handled: true, overrides: { speed: expected } });
    expect(result.overrides?.speed).toBe(expected);
  });

  it.each([
    { value: "2", range: { max: 2, maxExclusive: true } },
    { value: "0.4", range: { min: 0.5 } },
    { value: "2.1", range: { max: 2 } },
  ])("rejects $value outside the configured bounds", ({ value, range }) => {
    expect(
      parseSpeechDirectiveNumberOverride({
        ctx: { key: "speed", value, policy },
        overrideKey: "speed",
        range,
        warning: () => "out of range",
      }),
    ).toEqual({ handled: true, warnings: ["out of range"] });
  });

  it.each(["", " ", "NaN", "Infinity", "-Infinity", "1e309", "1.2x"])(
    "rejects invalid token %j before reading the range",
    (value) => {
      const warning = vi.fn(() => "invalid speed");
      expect(
        parseSpeechDirectiveNumberOverride({
          ctx: { key: "speed", value, policy },
          overrideKey: "speed",
          get range(): never {
            throw new Error("invalid tokens must not read the range");
          },
          warning,
        }),
      ).toEqual({ handled: true, warnings: ["invalid speed"] });
      expect(warning).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenCalledWith(value);
    },
  );

  it.each([
    { mergeCurrentOverrides: undefined, expected: { speed: 1.25 } },
    { mergeCurrentOverrides: false, expected: { speed: 1.25 } },
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
