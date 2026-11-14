/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPet, type LobsterPetElement } from "./lobster-pet.test-support.ts";

async function frame(element: LobsterPetElement, pending?: "render" | "mutations") {
  if (pending) {
    await (pending === "render" ? element.updateComplete : vi.advanceTimersByTimeAsync(0));
  }
  vi.advanceTimersToNextFrame();
  await element.updateComplete;
  return element.hasAttribute("data-scene-ready");
}

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  document.body.replaceChildren();
  await Promise.resolve();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

it("keeps the walking gap between supplied controls and releases removed obstacles", async () => {
  const element = createPet(42, "offline");
  const elements = element.composerElements()!;
  const left = document.createElement("span");
  const right = document.createElement("span");
  left.getBoundingClientRect = () => new DOMRect(0, 45, 140, 45);
  right.getBoundingClientRect = () => new DOMRect(560, 45, 160, 45);
  element.composerElements = () => ({
    ...elements,
    obstacles: [left, right].filter((obstacle) => obstacle.isConnected),
  });
  elements.root.prepend(left, right);
  await frame(element, "render");
  const x = () =>
    Number.parseFloat(
      element.querySelector<HTMLElement>(".lobster-pet")!.style.getPropertyValue("--lob-x"),
    );
  const between = x();
  expect(between).toBeGreaterThanOrEqual(178);
  expect(between).toBeLessThanOrEqual(522);
  left.remove();
  await frame(element, "mutations");
  expect(x()).toBeLessThan(between);
});

it("batches geometry reads, retires detached work, and observes the current composer on reconnect", async () => {
  const element = createPet(42, "offline");
  await frame(element, "render");
  const { composer, footer } = element.composerElements()!;
  const readStyle = vi.spyOn(window, "getComputedStyle");
  const popup = document.createElement("div");
  popup.setAttribute("popover", "manual");
  const readPopupBox = vi.fn(() => new DOMRect());
  for (let index = 0; index < 3; index++) {
    const choice = document.createElement("button");
    choice.getBoundingClientRect = readPopupBox;
    popup.append(choice);
  }
  composer.querySelector(".chat-composer-model-control")!.append(popup);
  composer.getBoundingClientRect().width = 0;
  // Lit/custom-element commits can span several microtasks before one paint.
  for (let index = 0; index < 3; index++) {
    footer.append(document.createElement("span"));
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(readStyle).not.toHaveBeenCalled();
  const ready = await frame(element);
  expect(readStyle.mock.calls.length).toBeLessThanOrEqual(1);
  expect(ready).toBe(false);
  expect(readPopupBox).not.toHaveBeenCalled();
  readStyle.mockClear();
  const retiredChoice = popup.firstElementChild!;
  retiredChoice.textContent = "Refreshed hidden choice";
  retiredChoice.replaceWith(document.createElement("button"));
  await frame(element, "mutations");
  expect(readStyle).not.toHaveBeenCalled();
  footer.append(document.createElement("span"));
  await vi.advanceTimersByTimeAsync(0);
  element.remove();
  await frame(element);
  expect(readStyle).not.toHaveBeenCalled();
  composer.getBoundingClientRect().width = 720;
  composer.prepend(element);
  const reconnected = await frame(element, "render");
  expect(readStyle.mock.calls.length).toBeLessThanOrEqual(1);
  expect(reconnected).toBe(true);
  element.remove();
  await Promise.resolve();
  const replacement = createPet(42, "offline");
  await replacement.updateComplete;
  const elements = replacement.composerElements()!;
  replacement.remove();
  await Promise.resolve();
  element.composerElements = () => elements;
  elements.composer.prepend(element);
  expect(await frame(element, "render")).toBe(true);
  elements.composer.getBoundingClientRect().width = 0;
  elements.footer.append(document.createElement("span"));
  expect(await frame(element, "mutations")).toBe(false);
});
