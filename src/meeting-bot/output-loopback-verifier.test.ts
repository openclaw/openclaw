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

function pcmEnergyFrames(amplitudes: readonly number[], scale = 1): Buffer {
  return Buffer.concat(
    amplitudes.map((amplitude) => {
      const roundedAmplitude = Math.round(amplitude * scale);
      const pair = Buffer.alloc(4);
      pair.writeInt16LE(roundedAmplitude, 0);
      pair.writeInt16LE(-roundedAmplitude, 2);
      return Buffer.alloc(240 * 2).fill(pair);
    }),
  );
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
    const captured = pcmEnergyFrames(outputEnvelope, 0.5);
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
    const health = () => verifier.getHealth();
    verifier.recordInput(output);
    const verified = health();
    expect(verified.verifiedOutputGeneration).toBe(1);

    // Six seconds queued after the match keep the same generation past its original deadline.
    verifier.recordOutput(Buffer.concat(Array<Buffer>(7).fill(output)));
    verifier.recordOutput(output.subarray(0, output.byteLength / 2));
    nowMs = 6_000;
    verifier.recordOutput(output);
    verifier.recordInput(output);
    expect(health()).toEqual(verified);
    nowMs = 12_600;
    verifier.recordOutput(Buffer.alloc(0));
    expect(health()).toEqual(verified);

    nowMs += 1;
    verifier.recordOutput(output);
    expect(health()).toMatchObject({ outputGeneration: 2, verifiedOutputGeneration: 1 });
    verifier.recordInput(output);
    expect(health()).toMatchObject({
      verifiedOutputGeneration: 2,
      outputLoopbackSignalBytes: output.byteLength * 2,
    });
    const nextVerified = health();
    verifier.cancelOutput();
    verifier.recordInput(output);
    expect(health()).toEqual(nextVerified);
  });

  const first = pcmEnergyFrames(outputEnvelope.slice(0, 30));
  const second = pcmEnergyFrames(outputEnvelope.slice(30, 60));
  const silence = pcmEnergyFrames(Array(30).fill(0));
  const recent = Buffer.concat([silence.subarray(4_800), second]);
  const quietCapture = Buffer.concat([
    pcmEnergyFrames(outputEnvelope.slice(0, 20), 0.0005),
    pcmEnergyFrames(unrelatedEnvelope.slice(0, 20)),
  ]);
  it.each<[string, Buffer[], Buffer, boolean]>([
    ["sub-frame delay", [first], Buffer.concat([Buffer.alloc(240), first]), true],
    ["silent streamed spacing", [first, silence, second], recent, true],
    [
      "below-threshold correlation",
      [pcmEnergyFrames(outputEnvelope.slice(0, 20))],
      quietCapture,
      false,
    ],
  ])("checks %s", (_name, chunks, capture, matches) => {
    const verifier = createVerifier({}, chunks[0]);
    for (const chunk of chunks.slice(1)) {
      verifier.recordOutput(chunk);
    }
    verifier.recordInput(capture);
    expect(verifier.getHealth().outputLoopbackSignalBytes).toBe(matches ? capture.byteLength : 0);
  });
});
