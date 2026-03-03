import { describe, expect, it } from "vitest";
import { parseFfprobeCodecAndSampleRate, parseFfprobeCsvFields } from "./ffmpeg-exec.js";

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
