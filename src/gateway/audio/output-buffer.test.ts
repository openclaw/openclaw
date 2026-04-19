import { describe, expect, it } from "vitest";
import { RealtimeOutputBuffer } from "./output-buffer.js";

describe("RealtimeOutputBuffer: enqueue & timeline", () => {
  it("starts empty", () => {
    const out = new RealtimeOutputBuffer();
    expect(out.getQueueLength()).toBe(0);
    expect(out.getTotalEnqueuedMs()).toBe(0);
    expect(out.getPlaybackPosition()).toBe(0);
  });

  it("assigns sequential start/end timestamps", () => {
    const out = new RealtimeOutputBuffer();
    const a = out.enqueueChunk("AAA", 250);
    const b = out.enqueueChunk("BBB", 500);
    expect(a).toMatchObject({ startMs: 0, endMs: 250, durationMs: 250 });
    expect(b).toMatchObject({ startMs: 250, endMs: 750, durationMs: 500 });
    expect(out.getTotalEnqueuedMs()).toBe(750);
    expect(out.getQueueLength()).toBe(2);
  });

  it("rejects negative or non-finite durations", () => {
    const out = new RealtimeOutputBuffer();
    expect(() => out.enqueueChunk("x", -1)).toThrow(RangeError);
    expect(() => out.enqueueChunk("x", Number.NaN)).toThrow(RangeError);
    expect(() => out.enqueueChunk("x", Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it("supports zero-duration chunks (e.g. metadata frames)", () => {
    const out = new RealtimeOutputBuffer();
    const c = out.enqueueChunk("meta", 0);
    expect(c.endMs).toBe(0);
    expect(out.getQueueLength()).toBe(1);
  });

  it("supports Buffer payloads", () => {
    const out = new RealtimeOutputBuffer();
    const c = out.enqueueChunk(Buffer.from([1, 2, 3]), 10);
    expect(Buffer.isBuffer(c.payload)).toBe(true);
  });
});

describe("RealtimeOutputBuffer: playback position", () => {
  it("uses injected clock and caps at total enqueued", () => {
    let now = 1000;
    const out = new RealtimeOutputBuffer({ now: () => now });
    out.enqueueChunk("a", 100);
    expect(out.getPlaybackPosition()).toBe(0);
    now = 1050;
    expect(out.getPlaybackPosition()).toBe(50);
    now = 5000;
    expect(out.getPlaybackPosition()).toBe(100); // capped
  });

  it("returns 0 before the first chunk is enqueued", () => {
    const out = new RealtimeOutputBuffer({ now: () => 9999 });
    expect(out.getPlaybackPosition()).toBe(0);
  });
});

describe("RealtimeOutputBuffer: flush", () => {
  it("drains all queued chunks in order without changing the timeline", () => {
    const out = new RealtimeOutputBuffer();
    out.enqueueChunk("a", 100);
    out.enqueueChunk("b", 200);
    const drained = out.flush();
    expect(drained.map((c) => c.payload)).toEqual(["a", "b"]);
    expect(out.getQueueLength()).toBe(0);
    // Flush does not reset the monotonic enqueue counter.
    expect(out.getTotalEnqueuedMs()).toBe(300);
  });

  it("returns empty array when nothing queued", () => {
    expect(new RealtimeOutputBuffer().flush()).toEqual([]);
  });
});

describe("RealtimeOutputBuffer: truncate", () => {
  it("drops trailing chunks whose start exceeds cutoff", () => {
    const out = new RealtimeOutputBuffer();
    out.enqueueChunk("a", 100); // 0..100
    out.enqueueChunk("b", 100); // 100..200
    out.enqueueChunk("c", 100); // 200..300
    const r = out.truncate(150);
    expect(r.audioEndMs).toBe(150);
    expect(r.chunksDropped).toBe(1);
    expect(r.msDropped).toBe(150); // partial-tail of b (50) + entire c (100)
    const queue = out.peekQueue();
    expect(queue.length).toBe(2);
    expect(queue[1]).toMatchObject({ startMs: 100, endMs: 150, durationMs: 50, payload: "b" });
  });

  it("trims a partial chunk tail at the boundary", () => {
    const out = new RealtimeOutputBuffer();
    out.enqueueChunk("solo", 1000);
    const r = out.truncate(400);
    expect(r.audioEndMs).toBe(400);
    expect(r.msDropped).toBe(600);
    expect(r.chunksDropped).toBe(0);
    expect(out.peekQueue()[0]).toMatchObject({ durationMs: 400, endMs: 400 });
    expect(out.getTotalEnqueuedMs()).toBe(400);
  });

  it("clamps cutoff to total enqueued (cannot grow timeline)", () => {
    const out = new RealtimeOutputBuffer();
    out.enqueueChunk("a", 100);
    const r = out.truncate(9999);
    expect(r.audioEndMs).toBe(100);
    expect(r.chunksDropped).toBe(0);
    expect(r.msDropped).toBe(0);
  });

  it("truncate(0) drops everything", () => {
    const out = new RealtimeOutputBuffer();
    out.enqueueChunk("a", 100);
    out.enqueueChunk("b", 200);
    const r = out.truncate(0);
    expect(r.chunksDropped).toBe(2);
    expect(r.msDropped).toBe(300);
    expect(out.peekQueue().length).toBe(0);
    expect(out.getTotalEnqueuedMs()).toBe(0);
  });

  it("rejects negative or non-finite cutoff", () => {
    const out = new RealtimeOutputBuffer();
    expect(() => out.truncate(-1)).toThrow(RangeError);
    expect(() => out.truncate(Number.NaN)).toThrow(RangeError);
  });

  it("truncate pins playback position regardless of clock", () => {
    let now = 0;
    const out = new RealtimeOutputBuffer({ now: () => now });
    out.enqueueChunk("a", 1000);
    now = 800;
    expect(out.getPlaybackPosition()).toBe(800);
    out.truncate(500);
    now = 5000;
    expect(out.getPlaybackPosition()).toBe(500);
  });

  it("matches the truncate accuracy target (±50 ms cutoff alignment)", () => {
    // Phase B exit criterion is ±50ms; A.2 just needs to expose the data.
    const out = new RealtimeOutputBuffer();
    out.enqueueChunk("a", 230);
    out.enqueueChunk("b", 480);
    const r = out.truncate(412);
    expect(Math.abs(r.audioEndMs - 412)).toBeLessThanOrEqual(50);
    expect(out.peekQueue()[1]).toMatchObject({ startMs: 230, endMs: 412 });
  });
});

describe("RealtimeOutputBuffer: reset", () => {
  it("clears chunks, timeline, override, and start time", () => {
    let now = 0;
    const out = new RealtimeOutputBuffer({ now: () => now });
    out.enqueueChunk("a", 100);
    out.truncate(50);
    out.reset();
    expect(out.getQueueLength()).toBe(0);
    expect(out.getTotalEnqueuedMs()).toBe(0);
    expect(out.getPlaybackPosition()).toBe(0);

    now = 100;
    out.enqueueChunk("b", 200); // playback start = 100
    now = 250;
    expect(out.getPlaybackPosition()).toBe(150);
  });
});
