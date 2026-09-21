/* @vitest-environment jsdom */

import type { LitElement } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import "./openclaw-mascot.ts";

afterEach(() => {
  document.body.replaceChildren();
  delete document.documentElement.dataset.themeMascot;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("replaces the animated mascot with a same-size neutral mark and restores it on theme changes", async () => {
  delete document.documentElement.dataset.themeMascot;
  const requestFrame = vi.fn(() => 1);
  const cancelFrame = vi.fn();
  vi.stubGlobal("requestAnimationFrame", requestFrame);
  vi.stubGlobal("cancelAnimationFrame", cancelFrame);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const mascot = document.createElement("openclaw-mascot") as LitElement & { size: number };
  mascot.size = 48;
  document.body.append(mascot);
  await mascot.updateComplete;
  expect(mascot.shadowRoot?.querySelector("canvas")).not.toBeNull();
  expect(requestFrame).toHaveBeenCalledOnce();

  document.documentElement.dataset.themeMascot = "none";
  await Promise.resolve();
  await mascot.updateComplete;
  expect(mascot.shadowRoot?.querySelector("canvas")).toBeNull();
  expect(mascot.shadowRoot?.querySelector(".openclaw-mascot--neutral svg")).not.toBeNull();
  expect(mascot.style.getPropertyValue("--openclaw-mascot-size")).toBe("48px");
  expect(cancelFrame).toHaveBeenCalledWith(1);

  document.documentElement.dataset.themeMascot = "claw";
  await Promise.resolve();
  await mascot.updateComplete;
  expect(mascot.shadowRoot?.querySelector("canvas")).not.toBeNull();
  expect(mascot.shadowRoot?.querySelector(".openclaw-mascot--neutral")).toBeNull();
  expect(requestFrame).toHaveBeenCalledTimes(2);
});
