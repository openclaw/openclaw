/* @vitest-environment jsdom */

import { createComponent, createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { t } from "../i18n/index.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import { SensitiveInput } from "./sensitive-input.tsx";

function fixture(overrides: Partial<Parameters<typeof SensitiveInput>[0]> = {}) {
  const props = {
    id: "secret",
    value: "secret",
    revealed: false,
    onInput: vi.fn(),
    onToggle: vi.fn(),
    ...overrides,
  };
  const { container } = mountSolid(() => createComponent(SensitiveInput, props));
  return {
    ...props,
    input: container.querySelector<HTMLInputElement>("[data-sensitive-value]")!,
    mask: container.querySelector<HTMLElement>(".oc-sensitive-mask[data-sensitive-mask]")!,
    maskText: container.querySelector<HTMLElement>("[data-sensitive-mask-text]")!,
    toggle: container.querySelector<HTMLButtonElement>(".oc-sensitive-toggle")!,
  };
}

describe("renderSensitiveInput", () => {
  it("conceals the value and keeps the Carapace mask in sync", () => {
    const { input, mask, maskText, toggle, onInput } = fixture();
    expect(input?.type).toBe("password");
    expect(mask?.hidden).toBe(false);
    expect(maskText?.textContent).toBe("******");
    expect(toggle?.dataset.sensitiveIcon).toBe("eye");
    expect(toggle?.getAttribute("aria-label")).toBe(t("configForm.revealValue"));
    expect(toggle?.getAttribute("aria-pressed")).toBe("false");

    input.value = "longer-key";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.scrollLeft = 12;
    input.dispatchEvent(new Event("scroll"));
    expect(onInput).toHaveBeenCalledWith("longer-key");
    expect(maskText?.textContent).toBe("**********");
    expect(maskText?.style.transform).toBe("translateX(-12px)");

    input.value = "👨‍👩‍👧‍👦x";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(maskText?.textContent).toBe("**");
  });

  it("reveals the value and presents the hide action", () => {
    const { input, mask, toggle, onToggle } = fixture({ revealed: true, disabled: false });
    expect(input?.type).toBe("text");
    expect(input?.value).toBe("secret");
    expect(mask?.hidden).toBe(true);
    expect(toggle?.dataset.sensitiveIcon).toBe("eye-off");
    expect(toggle?.getAttribute("aria-label")).toBe(t("configForm.hideValue"));
    expect(toggle?.getAttribute("aria-pressed")).toBe("true");

    toggle?.click();
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("keeps a controlled concealed value usable after clearing and restoring it", () => {
    let restore!: (value: string) => void;
    const { container } = mountSolid(() => {
      const [value, setValue] = createSignal("secret", { ownedWrite: true });
      restore = setValue;
      return createComponent(SensitiveInput, {
        id: "controlled-secret",
        get value() {
          return value();
        },
        revealed: false,
        onInput: setValue,
        onToggle: vi.fn(),
      });
    });
    const input = container.querySelector<HTMLInputElement>("[data-sensitive-value]")!;
    const mask = container.querySelector<HTMLElement>("[data-sensitive-mask-text]")!;
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    expect(mask.textContent).toBe("");
    restore("restored");
    flush();
    expect(input.value).toBe("restored");
    expect(mask.textContent).toBe("********");
  });
});
