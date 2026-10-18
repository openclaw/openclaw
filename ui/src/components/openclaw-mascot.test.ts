/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { resolveThemeBranding } from "../../../packages/gateway-protocol/src/theme.ts";
import { setCurrentThemeBranding } from "../app/theme-branding.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import "./openclaw-mascot.ts";

afterEach(() => {
  document.body.replaceChildren();
  delete document.documentElement.dataset.themeMascot;
  setCurrentThemeBranding(resolveThemeBranding({ mascot: "claw", critters: [] }));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("replaces the animated mascot with a same-size neutral mark and restores it on theme changes", async () => {
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
  expect(requestFrame).toHaveBeenCalledOnce();

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
});

it("pauses for reduced motion and hidden documents, and cancels playback on removal", async () => {
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
});
