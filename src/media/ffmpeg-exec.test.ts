import { describe, expect, it } from "vitest";
import {
  parseFfprobeCodecAndSampleRate,
  parseFfprobeCsvFields,
  parseFfprobeDurationSecs,
} from "./ffmpeg-exec.js";

describe("parseFfprobeCsvFields", () => {
  it("splits ffprobe csv output across commas and newlines", () => {
    expect(parseFfprobeCsvFields("opus,\n48000\n", 2)).toEqual(["opus", "48000"]);
  });
});

describe("parseFfprobeCodecAndSampleRate", () => {
  it("parses opus codec and numeric sample rate", () => {
    expect(parseFfprobeCodecAndSampleRate("Opus,48000\n")).toEqual({
      codec: "opus",
      sampleRateHz: 48_000,
    });
  });

  it("returns null sample rate for invalid numeric fields", () => {
    expect(parseFfprobeCodecAndSampleRate("opus,not-a-number")).toEqual({
      codec: "opus",
      sampleRateHz: null,
    });
  });
});

describe("parseFfprobeDurationSecs", () => {
  it("parses a plain decimal string", () => {
    expect(parseFfprobeDurationSecs("3.456\n")).toBe(3.456);
  });

  it("returns undefined for N/A", () => {
    expect(parseFfprobeDurationSecs("N/A\n")).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(parseFfprobeDurationSecs("")).toBeUndefined();
  });

  it("returns undefined for negative value", () => {
    expect(parseFfprobeDurationSecs("-1.0")).toBeUndefined();
  });
});
