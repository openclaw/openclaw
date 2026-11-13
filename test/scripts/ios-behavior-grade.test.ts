import { describe, expect, it } from "vitest";
import {
  type ProbeFrame,
  type ProbeLog,
  motion,
  remounts,
  window,
} from "../../scripts/lib/ios-behavior-grade.mts";

const frame = (t: number, rows: Record<string, number>): ProbeFrame => ({
  t,
  f: Object.fromEntries(Object.entries(rows).map(([key, top]) => [key, [top, top + 40]])),
});

describe("motion", () => {
  it("counts a downward step as backward motion and a >400 pt step as a teleport", () => {
    const result = motion([
      frame(0, { "user/a": 500 }),
      frame(16, { "user/a": 480 }),
      frame(33, { "user/a": 483 }),
      frame(50, { "user/a": 30 }),
    ]);
    expect(result).toMatchObject({ backwardPt: 3, teleports: 1, largestStepPt: 453 });
  });

  it("ignores sub-point layout rounding and the composer", () => {
    const result = motion([
      frame(0, { "user/a": 500, composer: 700 }),
      frame(16, { "user/a": 500.4, composer: 400 }),
    ]);
    expect(result).toMatchObject({ backwardPt: 0, teleports: 0, maxDriftPt: 0.4 });
  });

  it("reads the final row as a continuation of the live bubble it replaces", () => {
    const aliases = { "assistant/b": "live" };
    // Handoff as recorded on iOS: one frame holds both, with the outgoing bubble pushed far down.
    const handoff = [
      frame(0, { live: 258 }),
      frame(16, { live: 5615, "assistant/b": 216 }),
      frame(33, { "assistant/b": 216 }),
    ];
    expect(motion(handoff, { aliases })).toMatchObject({ maxDriftPt: 42, teleports: 0 });
    expect(
      motion([frame(0, { live: 300 }), frame(16, { "assistant/b": 340 })], { aliases }),
    ).toMatchObject({ backwardPt: 40, maxDriftPt: 40 });
  });
});

describe("window", () => {
  it("drops frames during a user drag and its deceleration, keeping later frames", () => {
    const log: ProbeLog = {
      frames: [frame(10, { "user/a": 1 }), frame(20, { "user/a": 2 }), frame(40, { "user/a": 3 })],
      events: [
        { t: 15, e: "phase", v: "interacting" },
        { t: 22, e: "phase", v: "decelerating" },
        { t: 30, e: "phase", v: "idle" },
      ],
    };
    expect(window(log, 0, 100).frames.map((f) => f.t)).toEqual([10, 40]);
  });

  it("measures a jump in the first frame of a window against the layout at its start", () => {
    // Frames are written only on change: the 500 pt layout holds until the jump at t=60.
    const log: ProbeLog = {
      frames: [frame(10, { "user/a": 500 }), frame(60, { "user/a": 30 })],
      events: [],
    };
    expect(motion(window(log, 50, 100).frames)).toMatchObject({ teleports: 1, maxDriftPt: 470 });
  });
});

describe("remounts", () => {
  it("counts repeat mounts in the window, including rows first mounted before it", () => {
    const mount = (t: number, k: string) => ({ t, e: "mount", k });
    const events = [
      mount(1, "user/a"),
      mount(2, "assistant/b"),
      mount(3, "composer"),
      mount(12, "user/a"),
      mount(13, "composer"),
      mount(14, "assistant/c"),
    ];
    expect(remounts(events, 10, 20)).toBe(1);
    expect(remounts(events, 0, 5)).toBe(0);
  });
});
