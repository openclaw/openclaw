import { createComponent } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSelectElement } from "../../components/agent-select.ts";
import "../../components/agent-select-registration.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import "../../components/web-awesome.ts";
import "../../test-helpers/load-styles.ts";
import "../../styles/model-setup.css";
import { duringElementAnimation } from "../../test-helpers/web-awesome-animation.ts";
import { ManualProviderPicker } from "./provider-picker.tsx";
import "@awesome.me/webawesome/dist/styles/themes/default.css";

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
      const dropdown = host.querySelector("wa-dropdown")!;
      await dropdown.updateComplete;
      const items = Array.from(dropdown.querySelectorAll("wa-dropdown-item"));
      await Promise.all(items.map((item) => item.updateComplete));
      const menu = dropdown.shadowRoot!.querySelector<HTMLElement>('[part="menu"]')!;
      menu.style.maxHeight = "160px";
      menu.style.overflow = "auto";
      const trigger = dropdown.querySelector<HTMLButtonElement>('[slot="trigger"]')!;
      const shown = new Promise<void>((resolve) => {
        dropdown.addEventListener("wa-after-show", () => resolve(), { once: true });
      });
      await duringElementAnimation(
        menu,
        "show",
        () => page.elementLocator(trigger).click(),
        async () => {
          expect.soft(document.activeElement).toBe(items[28]);
          const selectedBounds = items[28]!.getBoundingClientRect();
          const menuBounds = menu.getBoundingClientRect();
          expect.soft(selectedBounds.top).toBeGreaterThanOrEqual(menuBounds.top);
          expect.soft(selectedBounds.bottom).toBeLessThanOrEqual(menuBounds.bottom);
          await userEvent.keyboard("{End}");
          expect(document.activeElement).toBe(items[29]);
        },
      );
      await shown;
      expect.soft(document.activeElement).toBe(items[29]);
      await userEvent.keyboard("{Enter}");
      expect(selected).toHaveBeenCalledExactlyOnceWith("last");
    },
  );
});
