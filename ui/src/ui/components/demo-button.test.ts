/* @vitest-environment jsdom */

import { html, nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "./demo-button.ts";

let container: HTMLDivElement;

describe("openclaw-demo-button", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(() => {
    render(nothing, container);
    container.remove();
  });

  it("increments its visible count when clicked", async () => {
    render(html`<openclaw-demo-button></openclaw-demo-button>`, container);
    await Promise.resolve();

    const button = container.querySelector("openclaw-demo-button button");
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error("Expected demo button");
    }

    expect(button.getAttribute("aria-label")).toBe("Increment demo counter");
    expect(button.textContent?.trim()).toBe("Demo count: 0");

    button.click();
    await Promise.resolve();

    expect(button.textContent?.trim()).toBe("Demo count: 1");
  });
});
