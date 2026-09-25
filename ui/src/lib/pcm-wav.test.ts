import { describe, expect, it } from "vitest";
import { encodeWavPcm16Mono, floatToPcm16 } from "./pcm-wav.ts";

describe("PCM16 WAV encoding", () => {
  it("writes a mono 24 kHz header around the PCM payload", () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1]);
    const pcm = floatToPcm16(samples);
    const wav = encodeWavPcm16Mono(pcm, 24_000);
    const view = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...wav.subarray(8, 12))).toBe("WAVE");
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(24_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(pcm.byteLength);
    expect(wav.subarray(44)).toEqual(pcm);
  });
});
