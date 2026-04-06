import { describe, expect, it } from "vitest";
import { parseFfprobeCodecAndSampleRate, parseFfprobeCsvFields } from "./ffmpeg-exec.js";

describe("parseFfprobeCsvFields", () => {
  function expectParsedFfprobeCsvCase(input: string, fieldCount: number, expected: string[]) {
    expect(parseFfprobeCsvFields(input, fieldCount)).toEqual(expected);
  }

  it.each([
    { input: "opus,\n48000\n", fieldCount: 2, expected: ["opus", "48000"] },
    { input: "opus,48000,stereo\n", fieldCount: 3, expected: ["opus", "48000", "stereo"] },
  ] as const)("splits ffprobe csv output %#", ({ input, fieldCount, expected }) => {
    expectParsedFfprobeCsvCase(input, fieldCount, [...expected]);
  });
});

describe("parseFfprobeCodecAndSampleRate", () => {
  function expectParsedCodecAndSampleRateCase(
    input: string,
    expected: { codec: string | null; sampleRateHz: number | null },
  ) {
    expect(parseFfprobeCodecAndSampleRate(input)).toEqual(expected);
  }

  it.each([
    {
      name: "normalizes codec casing and parses numeric sample rates",
      input: "Opus,48000\n",
      expected: {
        codec: "opus",
        sampleRateHz: 48_000,
      },
    },
    {
      name: "keeps codec when the sample rate is not numeric",
      input: "opus,not-a-number",
      expected: {
        codec: "opus",
        sampleRateHz: null,
      },
    },
  ] as const)("$name", ({ input, expected }) => {
    expectParsedCodecAndSampleRateCase(input, expected);
  });
});
