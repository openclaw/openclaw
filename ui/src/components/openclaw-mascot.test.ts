/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { resolveThemeBranding } from "../../../packages/gateway-protocol/src/theme.ts";
import { setCurrentThemeBranding } from "../app/theme-branding.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import * as mascotCanvas from "./mascot-canvas.ts";
import "./openclaw-mascot.tsx";

afterEach(() => {
  document.body.replaceChildren();
  delete document.documentElement.dataset.themeMascot;
  setCurrentThemeBranding(resolveThemeBranding({ mascot: "claw", critters: [] }));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("replaces the animated mascot with a same-size neutral mark and restores it on theme changes", async () => {
  const warning = vi.spyOn(console, "warn");
  delete document.documentElement.dataset.themeMascot;
  setCurrentThemeBranding(resolveThemeBranding({ mascot: "claw", critters: [] }));
  const requestFrame = vi.fn(() => 1);
  const cancelFrame = vi.fn();
  vi.stubGlobal("requestAnimationFrame", requestFrame);
  vi.stubGlobal("cancelAnimationFrame", cancelFrame);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const mascot = document.createElement("openclaw-mascot");
  mascot.setAttribute("size", "48");
  document.body.append(mascot);
  await waitForSolid(() => expect(mascot.querySelector("canvas")).not.toBeNull());
  await waitForSolid(() => expect(requestFrame).toHaveBeenCalledOnce());

  setCurrentThemeBranding(resolveThemeBranding({ mascot: "none", critters: [] }));
  document.documentElement.dataset.themeMascot = "none";
  await waitForSolid(() => expect(mascot.querySelector("canvas")).toBeNull());
  expect(mascot.querySelector(".openclaw-mascot--neutral svg")).not.toBeNull();
  expect(mascot.style.getPropertyValue("--openclaw-mascot-size")).toBe("48px");
  expect(cancelFrame).toHaveBeenCalledWith(1);

  setCurrentThemeBranding(resolveThemeBranding({ mascot: "claw", critters: [] }));
  document.documentElement.dataset.themeMascot = "claw";
  await waitForSolid(() => expect(mascot.querySelector("canvas")).not.toBeNull());
  expect(mascot.querySelector(".openclaw-mascot--neutral")).toBeNull();
  expect(requestFrame).toHaveBeenCalledTimes(2);
  expect(warning.mock.calls.flat().join(" ")).not.toContain("STRICT_READ_UNTRACKED");
});

it("pauses for reduced motion and hidden documents, and cancels playback on removal", async () => {
  const warning = vi.spyOn(console, "warn");
  const motionQuery = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal("matchMedia", () => motionQuery);
  const requestFrame = vi.fn(() => 1);
  const cancelFrame = vi.fn();
  vi.stubGlobal("requestAnimationFrame", requestFrame);
  vi.stubGlobal("cancelAnimationFrame", cancelFrame);
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const mascot = document.createElement("openclaw-mascot");
  document.body.append(mascot);
  await waitForSolid(() => expect(requestFrame).toHaveBeenCalledOnce());

  motionQuery.matches = true;
  motionQuery.dispatchEvent(Object.assign(new Event("change"), { matches: true }));
  await waitForSolid(() => expect(cancelFrame).toHaveBeenCalledOnce());
  expect(requestFrame).toHaveBeenCalledOnce();

  motionQuery.matches = false;
  motionQuery.dispatchEvent(Object.assign(new Event("change"), { matches: false }));
  await waitForSolid(() => expect(requestFrame).toHaveBeenCalledTimes(2));

  visibility.mockReturnValue("hidden");
  document.dispatchEvent(new Event("visibilitychange"));
  await waitForSolid(() => expect(cancelFrame).toHaveBeenCalledTimes(2));
  expect(requestFrame).toHaveBeenCalledTimes(2);

  visibility.mockReturnValue("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  await waitForSolid(() => expect(requestFrame).toHaveBeenCalledTimes(3));

  mascot.remove();
  await waitForSolid(() => expect(cancelFrame).toHaveBeenCalledTimes(3));
  document.dispatchEvent(new Event("visibilitychange"));
  motionQuery.dispatchEvent(Object.assign(new Event("change"), { matches: false }));
  expect(requestFrame).toHaveBeenCalledTimes(3);
  expect(warning.mock.calls.flat().join(" ")).not.toContain("STRICT_READ_UNTRACKED");
});

it("draws current size and expression across animation frames and reduced-motion updates", async () => {
  const warning = vi.spyOn(console, "warn");
  const draw = vi.spyOn(mascotCanvas, "drawMascot").mockImplementation(() => {});
  const context: Pick<CanvasRenderingContext2D, "setTransform" | "clearRect"> = {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
  };
  // SAFETY: The vector renderer is stubbed; these are the only context operations used by the host.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as CanvasRenderingContext2D,
  );
  vi.stubGlobal("Path2D", vi.fn());
  vi.stubGlobal("devicePixelRatio", 2);
  vi.spyOn(performance, "now").mockReturnValue(1_000);
  const motionQuery = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal("matchMedia", () => motionQuery);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const requestFrame = vi.fn<(callback: FrameRequestCallback) => number>(() => 1);
  vi.stubGlobal("requestAnimationFrame", requestFrame);
  const cancelFrame = vi.fn();
  vi.stubGlobal("cancelAnimationFrame", cancelFrame);
  const mascot = document.createElement("openclaw-mascot");
  mascot.setAttribute("size", "48");
  mascot.setAttribute("mood", "working");
  mascot.setAttribute("tease", "");
  document.body.append(mascot);
  await waitForSolid(() => expect(mascot.querySelector("canvas")?.width).toBe(96));
  expect(context.setTransform).toHaveBeenLastCalledWith(2, 0, 0, 2, 0, 0);
  expect(context.clearRect).toHaveBeenLastCalledWith(0, 0, 48, 48);
  expect(draw.mock.lastCall?.[0]).toMatchObject({ mouthRound: 0.5, gaze: { x: 0, y: 0.6 } });

  mascot.setAttribute("size", "64");
  mascot.setAttribute("mood", "happy");
  mascot.removeAttribute("tease");
  await waitForSolid(() => expect(mascot.querySelector("canvas")?.width).toBe(128));
  requestFrame.mock.lastCall![0](1_500);
  expect(context.clearRect).toHaveBeenLastCalledWith(0, 0, 64, 64);
  expect(draw.mock.lastCall?.[0]).toMatchObject({ mouthRound: 0 });
  expect(draw.mock.lastCall?.[3]).toBe(64);

  motionQuery.matches = true;
  motionQuery.dispatchEvent(new Event("change"));
  await waitForSolid(() => expect(cancelFrame).toHaveBeenCalledWith(1));
  mascot.setAttribute("size", "-1");
  mascot.setAttribute("mood", "working");
  await waitForSolid(() => expect(mascot.querySelector("canvas")?.width).toBe(240));
  expect(mascot.style.getPropertyValue("--openclaw-mascot-size")).toBe("120px");
  expect(draw.mock.lastCall?.[0]).toMatchObject({ hardHat: 1, rightClawDegrees: -28 });
  expect(warning.mock.calls.flat().join(" ")).not.toContain("STRICT_READ_UNTRACKED");
});

it("draws while hidden and retains the same canvas when motion first starts and resumes", async () => {
  const draw = vi.spyOn(mascotCanvas, "drawMascot").mockImplementation(() => {});
  const context: Pick<CanvasRenderingContext2D, "setTransform" | "clearRect"> = {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
  };
  // SAFETY: The renderer is stubbed; the host only uses these two context methods.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as CanvasRenderingContext2D,
  );
  vi.stubGlobal("Path2D", vi.fn());
  let intersect: IntersectionObserverCallback | undefined;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        intersect = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const requestFrame = vi.fn(() => 1);
  const cancelFrame = vi.fn();
  vi.stubGlobal("requestAnimationFrame", requestFrame);
  vi.stubGlobal("cancelAnimationFrame", cancelFrame);
  const mascot = document.createElement("openclaw-mascot");
  mascot.setAttribute("size", "48");
  document.body.append(mascot);
  await waitForSolid(() => expect(intersect).toBeDefined());
  const canvas = mascot.querySelector("canvas");
  expect(canvas).not.toBeNull();
  expect(mascot.style.getPropertyValue("--openclaw-mascot-size")).toBe("48px");
  expect(requestFrame).not.toHaveBeenCalled();
  expect(draw).toHaveBeenCalled();
  expect(draw.mock.lastCall?.[3]).toBe(48);
  const setVisible = (isIntersecting: boolean) => {
    // SAFETY: The callback reads only the entry's intersection state.
    intersect!([{ isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver);
  };
  setVisible(true);
  await waitForSolid(() => expect(requestFrame).toHaveBeenCalledOnce());
  expect(mascot.querySelector("canvas")).toBe(canvas);
  setVisible(false);
  expect(cancelFrame).toHaveBeenCalledOnce();
  setVisible(true);
  expect(requestFrame).toHaveBeenCalledTimes(2);
  expect(mascot.querySelector("canvas")).toBe(canvas);
});
