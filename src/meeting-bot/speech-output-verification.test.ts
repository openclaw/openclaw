import { describe, expect, it } from "vitest";
import {
  isMeetingSpeechOutputVerified,
  readMeetingSpeechOutputBaseline,
} from "./speech-output-verification.js";

describe("meeting speech output verification", () => {
  it("requires fresh sink bytes and fresh non-silent loopback capture", () => {
    const baseline = readMeetingSpeechOutputBaseline({
      lastOutputBytes: 100,
      outputGeneration: 7,
      verifiedOutputGeneration: 7,
    });

    expect(
      isMeetingSpeechOutputVerified(
        {
          lastOutputBytes: 101,
          outputGeneration: 8,
          verifiedOutputGeneration: 7,
        },
        baseline,
      ),
    ).toBe(false);
    expect(
      isMeetingSpeechOutputVerified(
        {
          lastOutputBytes: 100,
          outputGeneration: 8,
          verifiedOutputGeneration: 8,
        },
        baseline,
      ),
    ).toBe(false);
    expect(
      isMeetingSpeechOutputVerified(
        {
          lastOutputBytes: 101,
          outputGeneration: 8,
          verifiedOutputGeneration: 8,
        },
        baseline,
      ),
    ).toBe(true);
  });
});
