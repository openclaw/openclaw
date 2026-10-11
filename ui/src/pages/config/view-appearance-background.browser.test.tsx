import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BACKGROUND_PREFERENCE } from "../../../../packages/gateway-protocol/src/schema/background-preferences.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import {
  AppearanceBackground,
  type AppearanceBackgroundView,
} from "./view-appearance-background.tsx";

registerEnglishCatalog(registerSettingsEnglish);
let host: HTMLDivElement;
let update: ((props: AppearanceBackgroundView) => void) | undefined;
function renderBackground(props: AppearanceBackgroundView) {
  if (!update) {
    const [current, setCurrent] = createSignal({ ...props });
    update = setCurrent;
    mountSolid(() => <AppearanceBackground {...current()} />, { container: host });
  } else {
    update({ ...props });
  }
  flush();
}
function fixture(overrides: Partial<AppearanceBackgroundView> = {}): AppearanceBackgroundView {
  return {
    preference: { ...DEFAULT_BACKGROUND_PREFERENCE, source: { kind: "theme" } },
    imageUrl: null,
    hasImage: false,
    busy: false,
    uploadAllowed: true,
    scopeHint: "Personal preference",
    message: null,
    onSource: vi.fn(),
    onChange: vi.fn(),
    onChooseImage: vi.fn(),
    onRemoveImage: vi.fn(),
    onFile: vi.fn(),
    onPreviewStart: vi.fn(),
    onPreviewInput: vi.fn(),
    onPreviewEnd: vi.fn(),
    onPreviewKey: vi.fn(),
    onPreviewCancel: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
});
afterEach(() => {
  update = undefined;
  host.remove();
});

describe("Appearance backgrounds", () => {
  it("keeps compact artwork labels fully named and shows file guidance only when useful", () => {
    renderBackground(fixture());
    const image = host.querySelector('[data-background-source="custom"]')!;
    expect(image.textContent).toContain("Image");
    expect(image.getAttribute("aria-label")).toBe("Custom image");
    expect(host.querySelector(".settings-background-formats")).not.toBeNull();
    renderBackground(fixture({ hasImage: true }));
    expect(host.querySelector(".settings-background-formats")).toBeNull();
    expect(host.querySelector("[data-background-upload]")?.getAttribute("title")).toContain(
      "8 MiB",
    );
    expect(host.querySelector("[data-background-remove]")).not.toBeNull();
  });

  it("keeps source selection separate from both placement preferences", () => {
    const props = fixture();
    renderBackground(props);
    host.querySelector<HTMLButtonElement>('[data-background-source="none"]')!.click();
    expect(props.onSource).toHaveBeenCalledWith("none");
    expect(props.onChange).not.toHaveBeenCalled();
    const rows = host.querySelectorAll<HTMLElement>(".settings-row--toggle");
    rows[0]!.click();
    expect(props.onChange).toHaveBeenLastCalledWith({ showOnNewSession: false });
    rows[1]!.click();
    expect(props.onChange).toHaveBeenLastCalledWith({ showInSessions: false });
  });

  it("defaults absent presentation to Faded and changes modes without replacing other choices", () => {
    const props = fixture();
    renderBackground(props);
    const faded = host.querySelector<HTMLButtonElement>(
      '[data-test-id="background-presentation-faded"]',
    )!;
    const fullBleed = host.querySelector<HTMLButtonElement>(
      '[data-test-id="background-presentation-full-bleed"]',
    )!;
    expect(faded.getAttribute("aria-pressed")).toBe("true");
    expect(faded.closest(".settings-segmented")).not.toBeNull();
    fullBleed.click();
    expect(props.onChange).toHaveBeenCalledExactlyOnceWith({ presentation: "full-bleed" });
    expect(props.onSource).not.toHaveBeenCalled();
    const changed = fixture({ preference: { ...props.preference, presentation: "full-bleed" } });
    renderBackground(changed);
    expect(fullBleed.getAttribute("aria-pressed")).toBe("true");
    faded.click();
    expect(changed.onChange).toHaveBeenCalledExactlyOnceWith({ presentation: "faded" });
  });

  it("keeps mode controls disabled for None and explains retained choices", () => {
    renderBackground(
      fixture({
        preference: {
          ...DEFAULT_BACKGROUND_PREFERENCE,
          source: { kind: "none" },
          presentation: "full-bleed",
        },
      }),
    );
    const modes = [
      ...host.querySelectorAll<HTMLButtonElement>('[data-test-id^="background-presentation-"]'),
    ];
    expect(modes.every((mode) => mode.disabled)).toBe(true);
    expect(
      host
        .querySelector('[data-test-id="background-presentation-full-bleed"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(host.textContent).toContain("without removing your saved image or choices");
  });

  it("explains disabled placement separately from zero visibility", () => {
    renderBackground(
      fixture({
        preference: {
          ...DEFAULT_BACKGROUND_PREFERENCE,
          showOnNewSession: false,
          showInSessions: false,
        },
      }),
    );
    expect(host.textContent).toContain("Both pages are off");
    expect(host.querySelector<HTMLInputElement>('input[type="range"]')!.disabled).toBe(false);
    renderBackground(
      fixture({
        preference: { ...DEFAULT_BACKGROUND_PREFERENCE, visibility: 0 },
      }),
    );
    expect(host.textContent).toContain("At 0%, the artwork is hidden");
  });

  it("retains removal access when None is selected without silently deleting the image", () => {
    const props = fixture({
      preference: { ...DEFAULT_BACKGROUND_PREFERENCE, source: { kind: "none" } },
      hasImage: true,
    });
    renderBackground(props);
    expect(
      host.querySelector('[data-background-source="none"]')?.getAttribute("aria-pressed"),
    ).toBe("true");
    const switches = [...host.querySelectorAll<HTMLInputElement>(".settings-toggle__input")];
    expect(switches).toHaveLength(2);
    expect(switches.every((input) => input.disabled)).toBe(true);
    expect(host.querySelector<HTMLInputElement>('input[type="range"]')?.disabled).toBe(true);
    expect(props.onRemoveImage).not.toHaveBeenCalled();
    host.querySelector<HTMLButtonElement>("[data-background-remove]")!.click();
    expect(props.onRemoveImage).toHaveBeenCalledOnce();
  });

  it("leaves the plain choices available when custom uploads are unavailable", () => {
    renderBackground(fixture({ uploadAllowed: false }));
    expect(host.querySelector<HTMLButtonElement>('[data-background-source="none"]')?.disabled).toBe(
      false,
    );
    expect(
      host.querySelector<HTMLButtonElement>('[data-background-source="theme"]')?.disabled,
    ).toBe(false);
    expect(
      host.querySelector<HTMLButtonElement>('[data-background-source="custom"]')?.disabled,
    ).toBe(true);
    expect(host.querySelector<HTMLButtonElement>("[data-background-upload]")?.disabled).toBe(true);
  });

  it("emits normalized visibility without changing source or placement", () => {
    const props = fixture();
    renderBackground(props);
    const range = host.querySelector<HTMLInputElement>('input[type="range"]')!;
    range.value = "35";
    range.dispatchEvent(new Event("input", { bubbles: true }));
    expect(props.onChange).toHaveBeenCalledWith({ visibility: 0.35 });
    expect(props.onSource).not.toHaveBeenCalled();
    expect(props.onPreviewInput).toHaveBeenCalledOnce();
    renderBackground({ ...props, preference: { ...props.preference, visibility: 0.35 } });
    expect(host.querySelector('input[type="range"]')).toBe(range);
    expect(range.value).toBe("35");
  });

  it("forwards native range interactions without canceling keyboard or pointer behavior", () => {
    const props = fixture();
    renderBackground(props);
    const range = host.querySelector<HTMLInputElement>('input[type="range"]')!;
    const down = new PointerEvent("pointerdown", {
      pointerId: 1,
      isPrimary: true,
      cancelable: true,
    });
    const up = new PointerEvent("pointerup", { pointerId: 1 });
    const key = new KeyboardEvent("keydown", { key: "ArrowRight", cancelable: true });
    range.dispatchEvent(down);
    range.dispatchEvent(up);
    range.dispatchEvent(key);
    range.dispatchEvent(new Event("blur"));
    expect(props.onPreviewStart).toHaveBeenCalledWith(down);
    expect(props.onPreviewEnd).toHaveBeenCalledWith(up);
    expect(props.onPreviewKey).toHaveBeenCalledWith(key);
    expect(props.onPreviewCancel).toHaveBeenCalledOnce();
    expect(down.defaultPrevented).toBe(false);
    expect(key.defaultPrevented).toBe(false);
  });

  it("delivers the chosen file once and clears the input so it can be selected again", () => {
    const props = fixture();
    renderBackground(props);
    const file = new File(["image fixture"], "background.png", { type: "image/png" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const input = host.querySelector<HTMLInputElement>("[data-background-file]")!;
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(props.onFile).toHaveBeenCalledWith(file);
    expect(input.value).toBe("");
  });

  it("shows failure text safely and locks conflicting controls during upload", () => {
    renderBackground(
      fixture({ busy: true, hasImage: true, message: { kind: "error", text: "Image <failed>" } }),
    );
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Image <failed>");
    expect(host.querySelector("failed")).toBeNull();
    expect(
      [...host.querySelectorAll<HTMLButtonElement>("button")].every((button) => button.disabled),
    ).toBe(true);
  });
});
