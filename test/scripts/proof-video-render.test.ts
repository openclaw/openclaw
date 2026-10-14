import { describe, expect, it } from "vitest";
import {
  planProofVideoRender,
  type ProofVideoCue,
  type ProofVideoCues,
} from "../../scripts/lib/proof-video-render.ts";

const document = (cues: ProofVideoCue[]): ProofVideoCues => ({
  version: 1,
  video: "raw.webm",
  viewport: { width: 1280, height: 800 },
  scale: 2,
  captionHeight: 120,
  cues,
});
const caption = {
  kind: "caption",
  start: 3,
  end: 9,
  text: "A caption",
  image: "captions/0.png",
} as const;
const zoom = {
  kind: "zoom",
  start: 2,
  end: 10,
  factor: 2,
  ease: 2,
  rect: { x: 1100, y: 680, width: 100, height: 80 },
} as const;
const options = { durationSeconds: 12, fps: 25 };

describe("planProofVideoRender", () => {
  it("remaps captions spanning a speed segment and preserves the remaining timeline", () => {
    const plan = planProofVideoRender(
      document([caption, { kind: "speed", start: 4, end: 8, factor: 4 }]),
      options,
    );
    expect(plan.durationSeconds).toBe(9);
    expect(plan.inputs).toEqual(["captions/0.png"]);
    expect(plan.filterComplex).toContain("gte(t,3)*lt(t,6)");
    expect(plan.filterComplex).toContain("trim=start=4:end=8,setpts=(PTS-STARTPTS)/4");
    expect(plan.filterComplex).toContain("concat=n=3:v=1:a=0,fps=25");
  });

  it("uses per-frame eased zoom with raw-resolution centers clamped to the frame", () => {
    const { filterComplex } = planProofVideoRender(document([zoom]), options);
    expect(filterComplex).toContain("zoompan=z='");
    expect(filterComplex).toContain("(in/25)");
    expect(filterComplex).toContain("cos(PI*");
    expect(filterComplex).toContain("2300"); // CSS target center 1150 at scale 2.
    expect(filterComplex).toContain("1440");
    expect(filterComplex).toContain("-iw/zoom/2,0,iw-iw/zoom)");
    expect(filterComplex).toContain("-ih/zoom/2,0,ih-ih/zoom)");
    expect(filterComplex).toContain(":d=1:s=1280x800:fps=25");
  });

  it("remaps ease boundaries when a zoom crosses a speed change", () => {
    const plan = planProofVideoRender(
      document([zoom, { kind: "speed", start: 3, end: 9, factor: 2 }]),
      options,
    );
    expect(plan.durationSeconds).toBe(9);
    // Raw [2,4,8,10] becomes [2,3.5,5.5,7], including both easing knees.
    expect(plan.filterComplex).toContain("gte((in/25),2)*lt((in/25),7)");
    expect(plan.filterComplex).toContain("lt((in/25),3.5)");
    expect(plan.filterComplex).toContain("((in/25)-2)/1.5");
    expect(plan.filterComplex).toContain("lt((in/25),5.5)");
    expect(plan.filterComplex).toContain("(7-(in/25))/1.5");
  });

  it.each(["zoom", "speed"] as const)(
    "rejects overlapping %s cues but accepts adjacent ones",
    (kind) => {
      const first = kind === "zoom" ? zoom : { kind, start: 2, end: 10, factor: 2 };
      expect(() =>
        planProofVideoRender(document([first, { ...first, start: 9, end: 11 }]), options),
      ).toThrow(`${kind} cues must not overlap`);
      expect(() =>
        planProofVideoRender(document([first, { ...first, start: 10, end: 11 }]), options),
      ).not.toThrow();
    },
  );

  it.each([
    { ...caption, image: "../outside.png" },
    { ...caption, end: 13 },
    { ...zoom, factor: Number.NaN },
    { ...zoom, rect: { x: 1270, y: 0, width: 20, height: 10 } },
  ])("rejects invalid authored cues: %j", (cue) => {
    expect(() => planProofVideoRender(document([cue]), options)).toThrow(
      "Invalid proof-video cues:",
    );
  });
});
