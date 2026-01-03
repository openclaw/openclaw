import { describe, expect, test } from "vitest";
import { defaultVoiceWakeTriggers } from "../infra/voicewake.js";
import { formatError, normalizeVoiceWakeTriggers } from "./server-utils.js";

describe("normalizeVoiceWakeTriggers", () => {
  test("returns defaults when input is empty", () => {
    expect(normalizeVoiceWakeTriggers([])).toEqual(defaultVoiceWakeTriggers());
    expect(normalizeVoiceWakeTriggers(null)).toEqual(defaultVoiceWakeTriggers());
  });

  test("trims and limits entries", () => {
    const result = normalizeVoiceWakeTriggers(["  hello  ", "", "world"]);
    expect(result).toEqual(["hello", "world"]);
  });
});

describe("formatError", () => {
  test("prefers message for Error", () => {
    expect(formatError(new Error("boom"))).toBe("boom");
  });

  test("handles status/code", () => {
    expect(formatError({ status: 500, code: "EPIPE" })).toBe("500 EPIPE");
    expect(formatError({ status: 404 })).toBe("404");
    expect(formatError({ code: "ENOENT" })).toBe("ENOENT");
  });
});
