import type { LitElement } from "lit";
import { expect, it, onTestFinished } from "vitest";
import { page } from "vitest/browser";
import "../../styles/base.css";
import "../../styles/components.css";
import "../../styles/settings-controls.css";
import "../../styles/settings.css";
import "./memory-memories.ts";

it.each([
  { width: 390, height: 44, stacked: true },
  { width: 560, height: 44, stacked: true },
  { width: 561, height: 44, stacked: false },
  { width: 1440, height: 32, stacked: false },
])(
  "keeps the Memory search input at the shared control height at $width px",
  async ({ width, height, stacked }) => {
    const previousViewport = { width: window.innerWidth, height: window.innerHeight };
    const host = document.createElement("div");
    host.className = "shell--settings";
    host.innerHTML =
      '<section class="memory-page"><div class="memory-page__panel"></div></section>';
    const component = document.createElement("openclaw-memory-memories") as LitElement;
    host.querySelector(".memory-page__panel")!.append(component);
    onTestFinished(async () => {
      host.remove();
      await page.viewport(previousViewport.width, previousViewport.height);
    });
    await page.viewport(width, 844);
    document.body.append(host);
    await component.updateComplete;

    const input = component.querySelector<HTMLInputElement>("#memory-search-input");
    const button = component.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (!input || !button) {
      throw new Error("Missing Memory search controls");
    }
    const inputRect = input.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    const sharedHeight = Number.parseFloat(
      getComputedStyle(input).getPropertyValue("--settings-control-height"),
    );
    expect(sharedHeight).toBe(height);
    expect(inputRect.height).toBe(sharedHeight);
    if (stacked) {
      expect(buttonRect.top).toBeGreaterThanOrEqual(inputRect.bottom);
      expect(buttonRect.width).toBeCloseTo(inputRect.width, 1);
    } else {
      expect(buttonRect.left).toBeGreaterThanOrEqual(inputRect.right);
      expect(buttonRect.top).toBeCloseTo(inputRect.top, 1);
    }
    expect(Math.max(inputRect.right, buttonRect.right)).toBeLessThanOrEqual(width);
  },
);
