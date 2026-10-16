import { describe, expect, it } from "vitest";
import { createSpeechDirectiveParser } from "./directive-parser.js";
import type { SpeechModelOverridePolicy } from "./provider-types.js";

const policy: SpeechModelOverridePolicy = {
  enabled: true,
  allowText: true,
  allowProvider: true,
  allowVoice: true,
  allowModelId: true,
  allowVoiceSettings: true,
  allowNormalization: true,
  allowSeed: true,
};

describe("speech directive dispatch", () => {
  it("maps exact aliases and leaves unknown tokens unhandled", () => {
    const parse = createSpeechDirectiveParser({
      voiceId: ["allowVoice", ["voice", "voice_id"]],
    });
    expect(parse({ key: "voice_id", value: "speaker", policy })).toStrictEqual({
      handled: true,
      overrides: { voiceId: "speaker" },
    });
    expect(parse({ key: "__proto__", value: "speaker", policy })).toStrictEqual({ handled: false });
  });

  it("checks policy before invoking provider validation", () => {
    const parse = createSpeechDirectiveParser({
      voiceId: [
        "allowVoice",
        ["voice"],
        {
          value: () => {
            throw new Error("must not parse");
          },
        },
      ],
    });
    expect(
      parse({ key: "voice", value: "speaker", policy: { ...policy, allowVoice: false } }),
    ).toStrictEqual({ handled: true });
  });

  it("returns numeric patches without copying or mutating accumulated overrides", () => {
    const parse = createSpeechDirectiveParser({
      speed: [
        "allowVoiceSettings",
        ["speed"],
        {
          number: { range: { min: 0.5, max: 2 }, warning: (value) => `bad speed ${value}` },
        },
      ],
    });
    const currentOverrides = { voice: "speaker" };
    expect(parse({ key: "speed", value: "0", policy, currentOverrides })).toStrictEqual({
      handled: true,
      warnings: ["bad speed 0"],
    });
    expect(parse({ key: "speed", value: "1.25", policy, currentOverrides })).toStrictEqual({
      handled: true,
      overrides: { speed: 1.25 },
    });
    expect(currentOverrides).toStrictEqual({ voice: "speaker" });
  });

  it("retains provider non-handling and explicit warning conversion", () => {
    const rules = {
      model: ["allowModelId", ["model"], { parse: () => ({ handled: false }) }],
      seed: [
        "allowSeed",
        ["seed"],
        {
          value: () => {
            throw new Error("bad seed");
          },
        },
      ],
    } as const;
    const parse = createSpeechDirectiveParser(rules, { formatErrorMessage: String });
    expect(parse({ key: "model", value: "other-provider", policy })).toStrictEqual({
      handled: false,
    });
    expect(parse({ key: "seed", value: "bad", policy })).toStrictEqual({
      handled: true,
      warnings: ["Error: bad seed"],
    });
    expect(() => createSpeechDirectiveParser(rules)({ key: "seed", value: "bad", policy })).toThrow(
      "bad seed",
    );
  });
});
