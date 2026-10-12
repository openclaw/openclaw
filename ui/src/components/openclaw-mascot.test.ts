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
