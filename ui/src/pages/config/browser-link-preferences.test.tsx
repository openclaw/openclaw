/* @vitest-environment jsdom */

import { render, type JSX } from "@solidjs/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import { BrowserLinkPreferencesRow } from "./browser-link-preferences.tsx";

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) {
    dispose();
  }
});
function mountSolid(view: () => JSX.Element, container: HTMLElement) {
  disposers.push(render(view, container));
}

describe("Control UI browser link preferences row", () => {
  afterEach(() => patchSettings({ openLinksInControlUiBrowser: false }));

  it("persists an explicit browser-local opt-in and defaults off", () => {
    expect(loadSettings().openLinksInControlUiBrowser).not.toBe(true);
    patchSettings({ openLinksInControlUiBrowser: true });
    expect(loadSettings().openLinksInControlUiBrowser).toBe(true);
    patchSettings({ openLinksInControlUiBrowser: false });
    expect(loadSettings().openLinksInControlUiBrowser).not.toBe(true);
  });

  it("renders an accessible default-off toggle and publishes changes", () => {
    const onChange = vi.fn();
    const container = document.createElement("div");

    mountSolid(() => <BrowserLinkPreferencesRow enabled={false} onChange={onChange} />, container);

    expect(container.querySelector(".settings-row__title")?.textContent?.trim()).toBe(
      "Open links in Control UI browser",
    );
    const toggle = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(toggle?.checked).toBe(false);
    expect(toggle?.getAttribute("aria-label")).toBe("Open links in Control UI browser");

    if (!toggle) {
      throw new Error("missing Control UI browser link preference toggle");
    }
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
