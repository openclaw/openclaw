const SAMPLE_RATE = 48_000;
const FRAME_BYTES = 4;
const MAX_FRAMES = SAMPLE_RATE / 4;
const MAX_SOURCES = 32;

/** A live monitor, not a recording: prefer fresh samples over accumulated latency. */
export class DesktopPcmQueue {
  private remainder = new Uint8Array(0);
  private playhead = 0;
  private readonly sources = new Map<AudioBufferSourceNode, () => void>();

  constructor(private readonly context: AudioContext) {}

  play(bytes: Uint8Array): void {
    const totalBytes = this.remainder.length + bytes.length;
    const completeBytes = totalBytes - (totalBytes % FRAME_BYTES);
    // Preserve at most three bytes, including half of a stereo frame. Trimming
    // happens at a frame boundary so left and right never swap after a split.
    const byteAt = (index: number) =>
      index < this.remainder.length
        ? this.remainder[index]!
        : bytes[index - this.remainder.length]!;
    const tail = new Uint8Array(totalBytes - completeBytes);
    for (let i = 0; i < tail.length; i += 1) {
      tail[i] = byteAt(completeBytes + i);
    }
    const frameCount = Math.min(completeBytes / FRAME_BYTES, MAX_FRAMES);
    if (frameCount === 0) {
      this.remainder = tail;
      return;
    }
    const data = new Uint8Array(frameCount * FRAME_BYTES);
    const offset = completeBytes - data.length;
    for (let i = 0; i < data.length; i += 1) {
      data[i] = byteAt(offset + i);
    }
    this.remainder = tail;
    const now = this.context.currentTime;
    const duration = frameCount / SAMPLE_RATE;
    if (Math.max(now, this.playhead) + duration - now > 0.25 || this.sources.size >= MAX_SOURCES) {
      this.clearSources();
    }
    const buffer = this.context.createBuffer(2, frameCount, SAMPLE_RATE);
    const view = new DataView(data.buffer);
    for (let channel = 0; channel < 2; channel += 1) {
      const output = buffer.getChannelData(channel);
      for (let frame = 0; frame < frameCount; frame += 1) {
        output[frame] = view.getInt16(frame * FRAME_BYTES + channel * 2, true) / 0x8000;
      }
    }
    const source = this.context.createBufferSource();
    const ended = () => {
      if (!this.sources.delete(source)) {
        return;
      }
      source.removeEventListener("ended", ended);
      source.disconnect();
    };
    this.sources.set(source, ended);
    source.addEventListener("ended", ended);
    source.buffer = buffer;
    source.connect(this.context.destination);
    const start = Math.max(now, this.playhead);
    source.start(start);
    this.playhead = start + duration;
  }

  stop(): void {
    this.remainder = new Uint8Array(0);
    this.clearSources();
  }

  private clearSources(): void {
    const sources = [...this.sources];
    this.sources.clear();
    this.playhead = this.context.currentTime;
    for (const [source, ended] of sources) {
      source.removeEventListener("ended", ended);
      try {
        source.stop();
      } catch {
        // A source may have finished before its ended callback was delivered.
      }
      source.disconnect();
    }
  }
}
