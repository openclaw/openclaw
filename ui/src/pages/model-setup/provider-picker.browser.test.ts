import { createComponent } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import "../../test-helpers/load-styles.ts";
import "../../styles/model-setup.css";
import { ManualProviderPicker } from "./provider-picker.tsx";

afterEach(cleanupSolid);

describe.runIf("__vitest_browser__" in globalThis)("selected dropdown opening", () => {
  it("focuses the selected provider immediately and keeps navigation made during opening", async () => {
    const { page, userEvent } = await import("vitest/browser");
    const selected = vi.fn();
    const providers = Array.from({ length: 30 }, (_, index) => ({
      id: index === 28 ? "selected" : index === 29 ? "last" : `option-${index}`,
      label: `${String(index).padStart(2, "0")} option`,
    }));
    const { container: host } = mountSolid(() =>
      createComponent(ManualProviderPicker, {
        manualProviderId: "selected",
        actionsDisabled: false,
        iconUrls: {},
        onIconError: vi.fn(),
        onManualProviderChange: selected,
        result: { manualProviders: providers },
        provider: providers[28],
      }),
    );
    await waitForSolid(() =>
      expect(host.querySelectorAll("[data-manual-provider]")).toHaveLength(30),
    );
    const items = [...host.querySelectorAll<HTMLElement>("[data-manual-provider]")];
    const menu = host.querySelector<HTMLElement>('[role="menu"]')!;
    Object.assign(menu.style, { maxHeight: "160px", overflow: "auto" });
    const trigger = host.querySelector<HTMLButtonElement>(".model-setup-provider-select__trigger")!;
    const shown = new Promise<void>((resolve) => {
      menu.addEventListener("overlay-after-show", () => resolve(), { once: true });
    });
    menu.style.setProperty("--oc-overlay-show-duration", "30s");
    await page.elementLocator(trigger).click();
    await expect.poll(() => menu.getAnimations().length).toBeGreaterThan(0);
    const animations = menu.getAnimations();
    animations.forEach((animation) => animation.pause());
    expect(menu.dataset.phase).toBe("opening");
    expect.soft(document.activeElement).toBe(items[28]);
    const selectedBounds = items[28]!.getBoundingClientRect();
    const menuBounds = menu.getBoundingClientRect();
    expect.soft(selectedBounds.top).toBeGreaterThanOrEqual(menuBounds.top);
    expect.soft(selectedBounds.bottom).toBeLessThanOrEqual(menuBounds.bottom);
    await userEvent.keyboard("{End}");
    expect(document.activeElement).toBe(items[29]);
    animations.forEach((animation) => animation.finish());
    await shown;
    expect.soft(document.activeElement).toBe(items[29]);
    await userEvent.keyboard("{Enter}");
    await waitForSolid(() => expect(selected).toHaveBeenCalledExactlyOnceWith("last"));
  });
});
