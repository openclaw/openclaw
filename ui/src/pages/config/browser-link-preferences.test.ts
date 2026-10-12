/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import { renderBrowserLinkPreferencesRow } from "./browser-link-preferences.ts";

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
    document.body.append(container);
    onTestFinished(() => container.remove());

    render(
      renderBrowserLinkPreferencesRow({
        enabled: false,
        onChange,
      }),
      container,
    );

    expect(container.querySelector(".settings-row__title")?.textContent?.trim()).toBe(
      "Open links in Control UI browser",
    );
    const toggle = container.querySelector<HTMLInputElement>(".settings-toggle__input");
    expect(toggle?.checked).toBe(false);
    expect(
      container.querySelector(`#${toggle?.getAttribute("aria-labelledby")}`)?.textContent,
    ).toBe("Open links in Control UI browser");

    if (!toggle) {
      throw new Error("missing Control UI browser link preference toggle");
    }
    toggle.click();
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
