const WAV_HEADER_BYTES = 44;

export function resampleFloat32Mono(
  samples: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (!Number.isFinite(fromRate) || !Number.isFinite(toRate) || fromRate <= 0 || toRate <= 0) {
    throw new Error("PCM resample rates must be positive");
  }
  if (fromRate === toRate || samples.length === 0) {
    return samples;
  }
  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.round(samples.length / ratio));
  const out = new Float32Array(outLength);
  const last = Math.max(0, samples.length - 1);
  for (let i = 0; i < outLength; i += 1) {
    const src = i * ratio;
    const i0 = Math.min(last, Math.floor(src));
    const i1 = Math.min(last, i0 + 1);
    const frac = src - i0;
    out[i] = (samples[i0] ?? 0) * (1 - frac) + (samples[i1] ?? 0) * frac;
  }
  return out;
}

export function floatToPcm16(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return bytes;
}

export function encodeWavPcm16Mono(pcm16: Uint8Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  if (pcm16.byteLength % 2 !== 0) {
    throw new Error("PCM16 WAV payload must contain a whole number of samples");
  }
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new Error("PCM16 WAV sample rate must be a positive integer");
  }
  const wav = new Uint8Array(WAV_HEADER_BYTES + pcm16.byteLength);
  const view = new DataView(wav.buffer);
  const byteRate = sampleRate * 2;
  writeFourCc(wav, 0, "RIFF");
  view.setUint32(4, 36 + pcm16.byteLength, true);
  writeFourCc(wav, 8, "WAVE");
  writeFourCc(wav, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeFourCc(wav, 36, "data");
  view.setUint32(40, pcm16.byteLength, true);
  wav.set(pcm16, WAV_HEADER_BYTES);
  return wav;
}

function writeFourCc(bytes: Uint8Array, offset: number, value: string) {
  bytes[offset] = value.charCodeAt(0);
  bytes[offset + 1] = value.charCodeAt(1);
  bytes[offset + 2] = value.charCodeAt(2);
  bytes[offset + 3] = value.charCodeAt(3);
}
