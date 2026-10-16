/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import { createPet, type LobsterPetElement } from "./lobster-pet.test-support.ts";

async function advancePetFrame(element: LobsterPetElement): Promise<void> {
  vi.advanceTimersToNextFrame();
  await element.updateComplete;
}

afterEach(async () => {
  document.body.replaceChildren();
  await Promise.resolve();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

it("batches composer geometry reads before paint and retires detached work", async () => {
  vi.useFakeTimers();
  const element = createPet(42, "offline");
  await element.updateComplete;
  await advancePetFrame(element);
  const composer = element.parentElement!;
  const footer = composer.querySelector(".agent-chat__composer-footer")!;
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
  try {
    composer.getBoundingClientRect().width = 0;
    // Lit/custom-element commits can span several microtasks before one paint.
    for (let index = 0; index < 3; index++) {
      footer.append(document.createElement("span"));
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(readStyle).not.toHaveBeenCalled();
    await advancePetFrame(element);
    expect(readStyle.mock.calls.length).toBeLessThanOrEqual(1);
    expect(element.hasAttribute("data-scene-ready")).toBe(false);
    expect(readPopupBox).not.toHaveBeenCalled();
    readStyle.mockClear();
    const retiredChoice = popup.firstElementChild!;
    retiredChoice.textContent = "Refreshed hidden choice";
    retiredChoice.replaceWith(document.createElement("button"));
    await vi.advanceTimersByTimeAsync(0);
    await advancePetFrame(element);
    expect(readStyle).not.toHaveBeenCalled();
    footer.append(document.createElement("span"));
    await vi.advanceTimersByTimeAsync(0);
    element.remove();
    await advancePetFrame(element);
    expect(readStyle).not.toHaveBeenCalled();
    composer.getBoundingClientRect().width = 720;
    composer.prepend(element);
    await element.updateComplete;
    await advancePetFrame(element);
    expect(readStyle.mock.calls.length).toBeLessThanOrEqual(1);
    expect(element.hasAttribute("data-scene-ready")).toBe(true);
  } finally {
    readStyle.mockRestore();
  }
});
