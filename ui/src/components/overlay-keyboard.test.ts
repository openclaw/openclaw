/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import { createOverlay } from "./overlay-lifecycle.ts";

it("consumes nested Escape at the overlay boundary before app shortcuts", () => {
  const app = document.createElement("section");
  const parentSurface = document.createElement("div");
  const childSurface = document.createElement("div");
  parentSurface.setAttribute("popover", "manual");
  childSurface.setAttribute("popover", "manual");
  const parentButton = document.createElement("button");
  const childButton = document.createElement("button");
  childSurface.append(childButton);
  parentSurface.append(parentButton, childSurface);
  app.append(parentSurface);
  document.body.append(app);
  const parent = createOverlay("keyboard-parent");
  const child = createOverlay("keyboard-child", parent);
  const shortcut = vi.fn();
  app.addEventListener("keydown", shortcut);
  try {
    parent.bindSurface(parentSurface);
    child.bindSurface(childSurface);
    expect(parent.request(true)).toBe(true);
    expect(child.request(true)).toBe(true);

    const childEscape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    childButton.dispatchEvent(childEscape);
    expect(childEscape.defaultPrevented).toBe(true);
    expect(child.open).toBe(false);
    expect(parent.open).toBe(true);
    expect(shortcut).not.toHaveBeenCalled();

    const parentEscape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    parentButton.dispatchEvent(parentEscape);
    expect(parentEscape.defaultPrevented).toBe(true);
    expect(parent.open).toBe(false);
    expect(shortcut).not.toHaveBeenCalled();
  } finally {
    child.dispose();
    parent.dispose();
    app.remove();
  }
});
