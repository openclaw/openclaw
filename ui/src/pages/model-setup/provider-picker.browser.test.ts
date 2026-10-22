import { createComponent } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSelectElement } from "../../components/agent-select.tsx";
import "../../components/agent-select-registration.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import "../../test-helpers/load-styles.ts";
import "../../styles/model-setup.css";
import { ManualProviderPicker } from "./provider-picker.tsx";

const disposals: (() => void)[] = [];

afterEach(() => {
  for (const dispose of disposals.splice(0)) {
    dispose();
  }
  document.body.replaceChildren();
});

describe.runIf("__vitest_browser__" in globalThis)("selected dropdown opening", () => {
  it.each(["provider", "agent"] as const)(
    "focuses the selected %s immediately and keeps navigation made during opening",
    async (kind) => {
      const { page, userEvent } = await import("vitest/browser");
      const host = document.createElement("div");
      const selected = vi.fn();
      const options = Array.from({ length: 30 }, (_, index) => ({
        value: index === 28 ? "selected" : index === 29 ? "last" : `option-${index}`,
        label: `${String(index).padStart(2, "0")} option`,
      }));
      if (kind === "provider") {
        const providers = options.map(({ value, label }) => ({ id: value, label }));
        disposals.push(
          mountSolid(
            () =>
              createComponent(ManualProviderPicker, {
                manualProviderId: "selected",
                actionsDisabled: false,
                iconUrls: {},
                onIconError: vi.fn(),
                onManualProviderChange: selected,
                result: { manualProviders: providers },
                provider: providers[28],
              }),
            { container: host },
          ).unmount,
        );
      } else {
        const picker = document.createElement("openclaw-agent-select");
        picker.options = options;
        picker.value = "selected";
        picker.onSelect = selected;
        host.append(picker);
      }
      document.body.append(host);
      const agentPicker = host.querySelector<AgentSelectElement>("openclaw-agent-select");
      await agentPicker?.updateComplete;
      if (kind === "agent") {
        const trigger = host.querySelector<HTMLButtonElement>(".agent-select__trigger")!;
        const items = [...host.querySelectorAll<HTMLElement>("[data-agent-option]")];
        await page.elementLocator(trigger).click();
        await expect.poll(() => document.activeElement).toBe(items[28]);
        await userEvent.keyboard("{End}");
        expect(document.activeElement).toBe(items[29]);
        await userEvent.keyboard("{Enter}");
        expect(selected).toHaveBeenCalledExactlyOnceWith("last");
        return;
      }
      const items = [...host.querySelectorAll<HTMLElement>("[data-manual-provider]")];
      const menu = host.querySelector<HTMLElement>('[role="menu"]')!;
      menu.style.maxHeight = "160px";
      menu.style.overflow = "auto";
      const trigger = host.querySelector<HTMLButtonElement>(
        ".model-setup-provider-select__trigger",
      )!;
      const shown = new Promise<void>((resolve) => {
        menu.addEventListener("overlay-after-show", () => resolve(), { once: true });
      });
      const pageScroll = { x: scrollX, y: scrollY };
      const navigateDuringOpening = async () => {
        expect.soft(document.activeElement).toBe(items[28]);
        const selectedBounds = items[28]!.getBoundingClientRect();
        const menuBounds = menu.getBoundingClientRect();
        expect.soft(selectedBounds.top).toBeGreaterThanOrEqual(menuBounds.top);
        expect.soft(selectedBounds.bottom).toBeLessThanOrEqual(menuBounds.bottom);
        expect({ x: scrollX, y: scrollY }).toEqual(pageScroll);
        await userEvent.keyboard("{End}");
        expect(document.activeElement).toBe(items[29]);
      };
      menu.style.setProperty("--oc-overlay-show-duration", "30s");
      await page.elementLocator(trigger).click();
      await expect.poll(() => menu.getAnimations().length).toBeGreaterThan(0);
      const animations = menu.getAnimations();
      for (const animation of animations) {
        animation.pause();
      }
      expect(menu.dataset.phase).toBe("opening");
      await navigateDuringOpening();
      for (const animation of animations) {
        animation.finish();
      }
      await shown;
      expect.soft(document.activeElement).toBe(items[29]);
      await userEvent.keyboard("{Enter}");
      await waitForSolid(() => expect(selected).toHaveBeenCalledExactlyOnceWith("last"));
    },
  );
});
