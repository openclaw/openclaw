import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveScrollBehavior } from "./scroll-behavior.ts";

function stubMatchMedia(reduced: boolean) {
  const matchMedia = vi.fn().mockReturnValue({ matches: reduced });
  vi.stubGlobal("matchMedia", matchMedia);
  return matchMedia;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveScrollBehavior", () => {
  it("uses auto for smooth scrolling under reduced motion", () => {
    stubMatchMedia(true);
    expect(resolveScrollBehavior()).toBe("auto");
  });

  it("keeps smooth scrolling without reduced motion", () => {
    const matchMedia = stubMatchMedia(false);
    expect(resolveScrollBehavior("smooth")).toBe("smooth");
    expect(matchMedia).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
  });

  it("keeps smooth scrolling when matchMedia is unavailable", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(resolveScrollBehavior("smooth")).toBe("smooth");
  });

  it("preserves instant scrolling without querying motion", () => {
    const matchMedia = stubMatchMedia(true);
    expect(resolveScrollBehavior("instant")).toBe("instant");
    expect(matchMedia).not.toHaveBeenCalled();
  });
});
