import { describe, expect, it } from "vitest";
import { resolveMobileSheetRelease, type MobileSheetDrag } from "./chat-mobile-host-release.ts";

const dock: MobileSheetDrag = {
  height: 420,
  start: 420,
  minimum: 220,
  maximum: 780,
  dock: 420,
  expanded: 700,
  independent: false,
};

describe("resolveMobileSheetRelease", () => {
  it("keeps the exact height of a slow release and magnets onto the dock detent", () => {
    expect(resolveMobileSheetRelease({ ...dock, height: 560 }, 50)).toEqual({
      kind: "rest",
      height: 560,
      mode: "expanded",
    });
    expect(resolveMobileSheetRelease({ ...dock, height: 400 }, 0)).toEqual({
      kind: "rest",
      height: 420,
      mode: "dock",
    });
    expect(resolveMobileSheetRelease({ ...dock, height: 300 }, -100)).toEqual({
      kind: "rest",
      height: 300,
      mode: "dock",
    });
  });

  it("steps a flick to the next detent in its direction", () => {
    expect(resolveMobileSheetRelease(dock, 900)).toEqual({
      kind: "rest",
      height: 700,
      mode: "expanded",
    });
    expect(resolveMobileSheetRelease({ ...dock, height: 700 }, 900)).toEqual({
      kind: "rest",
      height: 780,
      mode: "expanded",
    });
    expect(resolveMobileSheetRelease({ ...dock, height: 700 }, -900)).toEqual({
      kind: "rest",
      height: 420,
      mode: "dock",
    });
    expect(resolveMobileSheetRelease(dock, -900)).toEqual({ kind: "close" });
    expect(resolveMobileSheetRelease({ ...dock, height: 300 }, 900)).toEqual({
      kind: "rest",
      height: 420,
      mode: "dock",
    });
  });

  it("lets a hard throw skip the dock detent", () => {
    expect(resolveMobileSheetRelease({ ...dock, height: 780 }, -2500)).toEqual({ kind: "close" });
    expect(resolveMobileSheetRelease({ ...dock, height: 250 }, 2500)).toEqual({
      kind: "rest",
      height: 780,
      mode: "expanded",
    });
  });

  it("closes a sheet pulled below its minimum only when momentum carries it past half", () => {
    expect(resolveMobileSheetRelease({ ...dock, height: 180 }, 0)).toEqual({
      kind: "rest",
      height: 220,
      mode: "dock",
    });
    expect(resolveMobileSheetRelease({ ...dock, height: 100 }, 0)).toEqual({ kind: "close" });
    expect(resolveMobileSheetRelease({ ...dock, height: 160 }, -300)).toEqual({ kind: "close" });
  });

  it("uses an independent sheet's natural height instead of the dock detent", () => {
    const sheet = { ...dock, independent: true, height: 300, start: 300, dock: 420 };
    expect(resolveMobileSheetRelease({ ...sheet, height: 410 }, 0)).toEqual({
      kind: "rest",
      height: 410,
      mode: "dock",
    });
    expect(resolveMobileSheetRelease({ ...sheet, height: 650 }, -900)).toEqual({
      kind: "rest",
      height: 300,
      mode: "dock",
    });
    expect(resolveMobileSheetRelease(sheet, -900)).toEqual({ kind: "close" });
  });
});
