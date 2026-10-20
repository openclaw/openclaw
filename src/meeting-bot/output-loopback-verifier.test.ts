import { afterEach, describe, expect, it, vi } from "vitest";
import { createMeetingOutputLoopbackVerifier } from "./output-loopback-verifier.js";

afterEach(vi.restoreAllMocks);

function createVerifier(
  options: Partial<Parameters<typeof createMeetingOutputLoopbackVerifier>[0]> = {},
  output?: Buffer,
) {
  const verifier = createMeetingOutputLoopbackVerifier({ audioFormat: "pcm16-24khz", ...options });
  if (output) {
    verifier.beginOutput();
    verifier.recordOutput(output);
  }
  return verifier;
}

function pcmEnergyFrames(amplitudes: readonly number[]): Buffer {
  const samplesPerFrame = 240;
  const audio = Buffer.alloc(amplitudes.length * samplesPerFrame * 2);
  amplitudes.forEach((amplitude, frameIndex) => {
    const roundedAmplitude = Math.round(amplitude);
    for (let sampleIndex = 0; sampleIndex < samplesPerFrame; sampleIndex += 1) {
      const sample = sampleIndex % 2 === 0 ? roundedAmplitude : -roundedAmplitude;
      audio.writeInt16LE(sample, (frameIndex * samplesPerFrame + sampleIndex) * 2);
    }
  });
  return audio;
}

const outputEnvelope = Array.from({ length: 80 }, (_, index) => 400 + ((index * 7919) % 12_000));
const unrelatedEnvelope = Array.from(
  { length: 80 },
  (_, index) => 500 + ((index * 3571 + 1_231) % 9_000),
);

describe("meeting output loopback verifier", () => {
  it("requires the current output energy envelope on the captured input", () => {
    let nowMs = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const verifier = createVerifier();
    verifier.recordInput(pcmEnergyFrames(outputEnvelope));
    verifier.recordOutput(pcmEnergyFrames(Array(80).fill(0)));
    verifier.recordInput(pcmEnergyFrames(outputEnvelope));
    expect(verifier.getHealth().outputLoopbackSignalBytes).toBe(0);

    verifier.beginOutput();
    verifier.recordOutput(pcmEnergyFrames(outputEnvelope));
    verifier.recordInput(pcmEnergyFrames(unrelatedEnvelope));
    expect(verifier.getHealth().outputLoopbackSignalBytes).toBe(0);

    nowMs = 1_100;
    const captured = pcmEnergyFrames(outputEnvelope.map((amplitude) => amplitude * 0.5));
    verifier.recordInput(captured);
    const health = verifier.getHealth();
    expect(health.lastOutputLoopbackAt).toBe("1970-01-01T00:00:01.100Z");
    expect(health.lastOutputLoopbackCorrelation).toBeGreaterThanOrEqual(0.9);
    expect(health.outputLoopbackSignalBytes).toBe(captured.byteLength);
    expect(health.verifiedOutputGeneration).toBe(health.outputGeneration);
  });

  it("keeps the rolling deadline after verification and starts fresh after expiry (g711-ulaw-8khz)", () => {
    let nowMs = 0;
    const output = Buffer.concat(
      outputEnvelope.map((_, index) => Buffer.alloc(80, (index * 37) % 220)),
    );
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const verifier = createVerifier({ audioFormat: "g711-ulaw-8khz" }, output);
    verifier.recordInput(output);
    const verified = verifier.getHealth();
    expect(verified.verifiedOutputGeneration).toBe(1);

    // Six seconds queued after the match keep the same generation past its original deadline.
    verifier.recordOutput(Buffer.concat(Array<Buffer>(7).fill(output)));
    verifier.recordOutput(output.subarray(0, output.byteLength / 2));
    nowMs = 6_000;
    verifier.recordOutput(output);
    verifier.recordInput(output);
    expect(verifier.getHealth()).toEqual(verified);
    nowMs = 12_600;
    verifier.recordOutput(Buffer.alloc(0));
    expect(verifier.getHealth()).toEqual(verified);

    nowMs += 1;
    verifier.recordOutput(output);
    expect(verifier.getHealth()).toMatchObject({
      outputGeneration: 2,
      verifiedOutputGeneration: 1,
    });
    verifier.recordInput(output);
    expect(verifier.getHealth()).toMatchObject({
      verifiedOutputGeneration: 2,
      outputLoopbackSignalBytes: output.byteLength * 2,
    });
    const nextVerified = verifier.getHealth();
    verifier.cancelOutput();
    verifier.recordInput(output);
    expect(verifier.getHealth()).toEqual(nextVerified);
  });

  it("matches loopback delayed by a sub-frame sample offset", () => {
    const output = pcmEnergyFrames(outputEnvelope.slice(0, 30));
    const capture = Buffer.concat([Buffer.alloc(120 * 2), output]);
    const verifier = createVerifier({}, output);
    verifier.recordInput(capture);
    expect(verifier.getHealth().outputLoopbackSignalBytes).toBe(capture.byteLength);
  });

  it("rejects a correlated waveform below the signal threshold", () => {
    const output = pcmEnergyFrames(outputEnvelope.slice(0, 20));
    const attenuated = pcmEnergyFrames(
      outputEnvelope.slice(0, 20).map((amplitude) => amplitude * 0.0005),
    );
    const unrelatedLoudAudio = pcmEnergyFrames(unrelatedEnvelope.slice(0, 20));

    const verifier = createVerifier({}, output);
    verifier.recordInput(Buffer.concat([attenuated, unrelatedLoudAudio]));
    expect(verifier.getHealth().outputLoopbackSignalBytes).toBe(0);
  });

  it("preserves silent spacing between streamed output chunks", () => {
    const first = pcmEnergyFrames(outputEnvelope.slice(0, 30));
    const silence = pcmEnergyFrames(Array(30).fill(0));
    const second = pcmEnergyFrames(outputEnvelope.slice(30, 60));
    const expectedRecentReference = Buffer.concat([silence.subarray(4_800), second]);

    const verifier = createVerifier({}, first);
    verifier.recordOutput(silence);
    verifier.recordOutput(second);
    verifier.recordInput(expectedRecentReference);
    expect(verifier.getHealth().outputLoopbackSignalBytes).toBe(expectedRecentReference.byteLength);
  });
});
