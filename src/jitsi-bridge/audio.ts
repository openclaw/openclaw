export const PCM16_BYTES_PER_SAMPLE = 2;
export const REALTIME_AUDIO_SAMPLE_RATE = 24_000;

function clamp16(value: number): number {
  return Math.max(-32768, Math.min(32767, value));
}

export function base64ToBuffer(base64: string): Buffer {
  return Buffer.from(base64, "base64");
}

export function bufferToBase64(buffer: Buffer): string {
  return buffer.toString("base64");
}

export function resamplePcm16Mono(
  input: Buffer,
  inputSampleRate: number,
  outputSampleRate: number,
) {
  if (inputSampleRate === outputSampleRate) {
    return input;
  }
  const inputSamples = Math.floor(input.length / PCM16_BYTES_PER_SAMPLE);
  if (inputSamples === 0) {
    return Buffer.alloc(0);
  }

  const ratio = inputSampleRate / outputSampleRate;
  const outputSamples = Math.max(1, Math.floor(inputSamples / ratio));
  const output = Buffer.alloc(outputSamples * PCM16_BYTES_PER_SAMPLE);

  for (let i = 0; i < outputSamples; i += 1) {
    const srcPos = i * ratio;
    const srcIndex = Math.floor(srcPos);
    const frac = srcPos - srcIndex;
    const s0 = input.readInt16LE(Math.min(srcIndex, inputSamples - 1) * 2);
    const s1 = input.readInt16LE(Math.min(srcIndex + 1, inputSamples - 1) * 2);
    const sample = Math.round(s0 + frac * (s1 - s0));
    output.writeInt16LE(clamp16(sample), i * 2);
  }

  return output;
}
