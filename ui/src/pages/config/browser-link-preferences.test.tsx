/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { BrowserLinkPreferencesRow } from "./browser-link-preferences.tsx";

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
    const view = mountSolid(() => (
      <BrowserLinkPreferencesRow enabled={false} onChange={onChange} />
    ));
    const { container } = view;

    expect(container.querySelector(".settings-row__title")?.textContent?.trim()).toBe(
      "Open links in Control UI browser",
    );
    const toggle = view.getByRole("switch", { name: "Open links in Control UI browser" });
    if (!(toggle instanceof HTMLInputElement)) {
      throw new Error("missing Control UI browser link preference toggle");
    }
    expect(toggle.checked).toBe(false);
    toggle.click();
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
