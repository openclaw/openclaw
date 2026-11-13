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
});

describe("remounts", () => {
  it("counts only repeat mounts of the same row", () => {
    const mount = (t: number, k: string) => ({ t, e: "mount", k });
    expect(
      remounts([
        mount(1, "user/a"),
        mount(2, "assistant/b"),
        mount(3, "user/a"),
        mount(4, "composer"),
      ]),
    ).toBe(1);
  });
});
