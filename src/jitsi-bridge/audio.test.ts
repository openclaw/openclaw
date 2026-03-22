import { describe, expect, it } from "vitest";
import { resamplePcm16Mono } from "./audio.js";

describe("jitsi-bridge audio", () => {
  it("resamples pcm16 mono buffers", () => {
    const input = Buffer.alloc(8);
    input.writeInt16LE(1000, 0);
    input.writeInt16LE(2000, 2);
    input.writeInt16LE(3000, 4);
    input.writeInt16LE(4000, 6);

    const output = resamplePcm16Mono(input, 48_000, 24_000);
    expect(output.length).toBe(4);
  });
});
