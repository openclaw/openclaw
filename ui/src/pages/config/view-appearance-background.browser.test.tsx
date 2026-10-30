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
const button = (selector: string) => host.querySelector<HTMLButtonElement>(selector)!;
const buttons = (selector: string) => [...host.querySelectorAll<HTMLButtonElement>(selector)];
const source = (kind: string) => button(`[data-background-source="${kind}"]`);
const mode = (kind: string) => button(`[data-test-id="background-presentation-${kind}"]`);
const range = () => host.querySelector<HTMLInputElement>('input[type="range"]')!;
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
  it("keeps source selection separate from both placement preferences", () => {
    const props = fixture();
    renderBackground(props);
    source("none").click();
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
    const faded = mode("faded");
    const fullBleed = mode("full-bleed");
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
    expect(range().disabled).toBe(false);
    renderBackground(fixture({ preference: { ...DEFAULT_BACKGROUND_PREFERENCE, visibility: 0 } }));
    expect(host.textContent).toContain("At 0%, the artwork is hidden");
  });

  it("retains removal access when None is selected without silently deleting the image", () => {
    const props = fixture({
      preference: {
        ...DEFAULT_BACKGROUND_PREFERENCE,
        source: { kind: "none" },
        presentation: "full-bleed",
      },
      hasImage: true,
    });
    renderBackground(props);
    expect(source("none").getAttribute("aria-pressed")).toBe("true");
    const switches = [...host.querySelectorAll<HTMLInputElement>(".settings-toggle__input")];
    expect(switches).toHaveLength(2);
    expect(switches.every((input) => input.disabled)).toBe(true);
    expect(range().disabled).toBe(true);
    expect(
      buttons('[data-test-id^="background-presentation-"]').every((control) => control.disabled),
    ).toBe(true);
    expect(mode("full-bleed").getAttribute("aria-pressed")).toBe("true");
    expect(host.textContent).toContain("without removing your saved image or choices");
    expect(props.onRemoveImage).not.toHaveBeenCalled();
    button("[data-background-remove]").click();
    expect(props.onRemoveImage).toHaveBeenCalledOnce();
  });

  it("leaves the plain choices available when custom uploads are unavailable", () => {
    renderBackground(fixture({ uploadAllowed: false }));
    expect([source("none").disabled, source("theme").disabled]).toEqual([false, false]);
    expect([source("custom").disabled, button("[data-background-upload]").disabled]).toEqual([
      true,
      true,
    ]);
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
    expect(buttons("button").every((control) => control.disabled)).toBe(true);
  });
});
