import { beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import type { SelectPicker } from "../../components/select-picker.ts";
import { warmJson5 } from "../../lib/json5-runtime.ts";
import { createFrameClock } from "../../test-helpers/animation-frame-clock.ts";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { updatePickers, openPicker, choosePickerValue } from "../../test-helpers/select-picker.ts";
import "../../styles.css";
import { renderAppearance, renderConfigInto } from "./config-view.test-support.tsx";

function settingsRow(container: HTMLElement, title: string) {
  const row = [...container.querySelectorAll<HTMLElement>(".settings-row")].find(
    (candidate) => candidate.querySelector(".settings-row__title")?.textContent?.trim() === title,
  );
  if (!row) {
    throw new Error(`Missing settings row: ${title}`);
  }
  return row;
}

describe("config appearance preferences", () => {
  beforeAll(async () => {
    await warmJson5();
  });

  function normalizedText(container: HTMLElement): string {
    return container.textContent?.replace(/\s+/g, " ").trim() ?? "";
  }

  function findButtonByText(container: HTMLElement, text: string, exact = true): HTMLButtonElement {
    const button = Array.from(container.querySelectorAll("button")).find((btn) =>
      exact ? btn.textContent?.trim() === text : btn.textContent?.includes(text),
    );
    if (!button) {
      throw new Error(`Expected button with text "${text}"`);
    }
    return button;
  }

  function required<T extends Element>(
    container: HTMLElement,
    selector: string,
    constructor: new () => T,
  ): T {
    const element = container.querySelector(selector);
    expect(element).toBeInstanceOf(constructor);
    if (!(element instanceof constructor)) {
      throw new Error(`Expected element matching "${selector}"`);
    }
    return element;
  }

  function pickerOption(picker: Element, value: string) {
    return picker.querySelector(`[role="option"][data-value="${value}"]`);
  }

  function pressed(container: HTMLElement, label: string) {
    return findButtonByText(container, label).getAttribute("aria-pressed");
  }

  function mediaDevice(deviceId: string, label: string) {
    return {
      devices: [{ deviceId, label }],
      permissionRequired: false,
      selectedDeviceId: deviceId,
      discovery: null,
      selection: null,
    };
  }

  it("lets config pages grow with their content instead of creating an inner viewport", async () => {
    const { container } = renderAppearance({
      customThemeImportExpanded: true,
    });
    document.body.append(container);

    try {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });

      const content = required(container, ".config-content", HTMLElement);
      expect(content.scrollHeight - content.clientHeight).toBeLessThanOrEqual(1);
    } finally {
      container.remove();
    }
  });

  it.each([
    { systemLocale: "pt-BR", localeOverride: undefined, label: "Português (Brazilian Portuguese)" },
    { systemLocale: "de", localeOverride: "fr", label: "Deutsch (German)" },
  ] as const)(
    "renders and changes language with system locale $systemLocale",
    async ({ systemLocale, localeOverride, label }) => {
      const { container, props } = renderAppearance({
        systemLocale,
        localeOverride,
        localeOverridden: Boolean(localeOverride),
      });
      await updatePickers(container);
      const sections = [...container.querySelectorAll<HTMLElement>(".settings-section")];
      expect(sections[0]?.id).toBe("settings-language");
      expect(sections[0]?.textContent).toContain("Language");
      expect(sections[0]?.textContent).toContain("Synced across your devices through the gateway");
      const select = container.querySelector<SelectPicker>(
        "#settings-language openclaw-select-picker",
      );
      expect(select).not.toBeNull();
      if (!select) {
        throw new Error("Missing language select");
      }
      await openPicker(select);
      if (localeOverride) {
        expect(pickerOption(select, "fr")?.getAttribute("aria-selected")).toBe("true");
      } else {
        expect(
          select.querySelector('[role="option"][aria-selected="true"]')?.getAttribute("data-value"),
        ).toBe("system");
      }
      expect(pickerOption(select, "system")?.textContent).toContain(`System (${label})`);
      for (const value of ["fr", "system"]) {
        await choosePickerValue(select, value);
      }
      expect(props.onLocaleChange).toHaveBeenCalledWith("fr");
      expect(props.onLocaleChange).toHaveBeenCalledWith(undefined);
    },
  );

  it("names the theme's chat face and maps typography sentinels back to unset overrides", async () => {
    const { container, props } = renderAppearance({
      theme: "dash",
      fontUi: "geist",
      fontChat: "system",
      fontUiProvenance: "profile",
    });
    await updatePickers(container);
    const ui = required(container, "#settings-font-ui", HTMLElement).closest<SelectPicker>(
      "openclaw-select-picker",
    )!;
    const chat = required(container, "#settings-font-chat", HTMLElement).closest<SelectPicker>(
      "openclaw-select-picker",
    )!;
    await openPicker(ui);
    expect(pickerOption(ui, "theme")?.textContent).toContain("Dash · DM Sans");
    expect(ui.querySelectorAll('[role="option"]')).toHaveLength(11);
    await openPicker(chat);
    expect(pickerOption(chat, "theme")?.textContent).toContain("Dash · Fraunces");
    expect(ui.closest(".settings-row")?.textContent).toContain("Saved to your profile");
    expect(chat.querySelectorAll('[role="option"]')).toHaveLength(11);
    await choosePickerValue(ui, "lora");
    expect(props.setFontUi).toHaveBeenLastCalledWith("lora");
    await choosePickerValue(ui, "theme");
    expect(props.setFontUi).toHaveBeenLastCalledWith(undefined);
    await choosePickerValue(chat, "theme");
    expect(props.setFontChat).toHaveBeenLastCalledWith(undefined);
  });

  it("describes the custom accent source and selected state through the native input", () => {
    const inherited = renderAppearance({
      accent: undefined,
      accentProvenance: "default",
    });
    const inheritedInput =
      inherited.container.querySelector<HTMLInputElement>("[data-accent-custom]");
    expect(inherited.container.querySelector("#settings-accent-status")?.textContent).not.toContain(
      "Using inherited accent",
    );
    expect(inheritedInput?.getAttribute("aria-describedby")).toBe("settings-accent-status");

    const custom = renderAppearance({
      accent: "#c3cfdb",
      accentProvenance: "device-local",
    });
    expect(custom.container.querySelector("#settings-accent-status")?.textContent).toContain(
      "Using Custom color",
    );
    expect(
      custom.container
        .querySelector<HTMLElement>(".settings-accent-swatch--custom")
        ?.style.getPropertyValue("--settings-accent-swatch-ink"),
    ).toBe("#000000");
  });

  it("opens the theme importer, applies an import, and exposes replace and clear actions", () => {
    const onOpenCustomThemeImport = vi.fn();
    const { container, props } = renderAppearance({
      onOpenCustomThemeImport,
    });

    const customButton = findButtonByText(container, "Import");

    expect(customButton.disabled).toBe(false);
    expect(customButton.hasAttribute("aria-pressed")).toBe(false);
    expect(
      normalizedText(
        required(container, ".settings-theme-import__inline-hint", HTMLParagraphElement),
      ),
    ).toBe(
      "Click Import to add one browser-local tweakcn theme. In tweakcn, use Share and paste the copied link here.",
    );

    customButton.click();

    expect(onOpenCustomThemeImport).toHaveBeenCalledTimes(1);
    props.customThemeImportExpanded = true;
    renderConfigInto(props, container);
    const importButton = findButtonByText(container, "Import theme", false);

    expect(importButton.disabled).toBe(true);
    required(container, ".settings-theme-import__input", HTMLInputElement);
    expect(
      container.querySelector<HTMLAnchorElement>(".settings-theme-import__external")?.href,
    ).toBe("https://tweakcn.com/editor/theme");
    expect(
      normalizedText(required(container, ".settings-theme-import__hint", HTMLParagraphElement)),
    ).toBe(
      "Open tweakcn.com, choose or create a theme, click Share, then paste the copied theme link here. Share links, editor URLs, registry URLs, theme IDs, and default theme names like amethyst-haze are accepted.",
    );
    props.hasCustomTheme = true;
    props.customThemeLabel = "Light Green";
    props.customThemeSourceUrl = "https://tweakcn.com/themes/cmlhfpjhw000004l4f4ax3m7z";
    props.customThemeImportUrl = props.customThemeSourceUrl;
    renderConfigInto(props, container);
    const importedButton = findButtonByText(container, "Light Green");
    expect(importedButton.disabled).toBe(false);
    importedButton.click();
    expect(props.setTheme).toHaveBeenCalledWith("custom");

    const replaceButton = findButtonByText(container, "Replace Light Green", false);
    const clearButton = findButtonByText(container, "Clear Light Green", false);
    replaceButton.click();
    clearButton.click();

    expect(props.onImportCustomTheme).toHaveBeenCalledTimes(1);
    expect(props.onClearCustomTheme).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".settings-theme-import__meta-label")?.textContent?.trim()).toBe(
      "Loaded",
    );
    expect(container.querySelector(".settings-theme-import__meta-value")?.textContent?.trim()).toBe(
      "Light Green \u00b7 https://tweakcn.com/themes/cmlhfpjhw000004l4f4ax3m7z",
    );

    const input = container.querySelector(".settings-theme-import__input") as HTMLInputElement;
    input.value = "/r/themes/cmlhfpjhw000004l4f4ax3m7z";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(props.onCustomThemeImportUrlChange).toHaveBeenCalledWith(
      "/r/themes/cmlhfpjhw000004l4f4ax3m7z",
    );
    props.theme = "custom";
    renderConfigInto(props, container);
    expect(pressed(container, "Light Green")).toBe("true");
    expect(pressed(container, "Claw")).toBe("false");
  });

  it("focuses its own importer through unrelated updates and retires pending focus on disposal", () => {
    const otherInput = document.createElement("input");
    otherInput.setAttribute("data-custom-theme-import-input", "");
    document.body.append(otherInput);
    const { container, props } = renderAppearance({ customThemeImportUrl: "amethyst-haze" });
    document.body.append(container);
    props.onOpenCustomThemeImport = () => {
      props.customThemeImportExpanded = true;
      renderConfigInto(props, container);
    };
    renderConfigInto(props, container);
    const framesClock = createFrameClock();
    const frames = framesClock.frames;

    const requestFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation(framesClock.request);
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      framesClock.cancel(id);
    });
    onTestFinished(() => {
      cleanupSolid();
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
      otherInput.remove();
      container.remove();
    });

    findButtonByText(container, "Import").click();
    renderConfigInto(props, container);
    props.textScale = 110;
    renderConfigInto(props, container);
    const input = required(container, ".settings-theme-import__input", HTMLInputElement);
    framesClock.flush(0);
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("amethyst-haze".length);

    findButtonByText(container, "Import").click();
    renderConfigInto(props, container);
    expect(frames.size).toBe(1);
    cleanupSolid();
    expect(frames.size).toBe(0);
  });

  it("keeps direct Appearance default selections independent", () => {
    const { container, props } = renderAppearance({
      theme: "knot",
      themeOverridden: true,
      themeMode: "dark",
      themeModeOverridden: true,
      accent: "#52c99a",
      textScale: 110,
      textScaleOverridden: true,
    });
    document.body.append(container);
    onTestFinished(() => container.remove());
    const row = (title: string) => settingsRow(container, title);

    expect(pressed(container, "Knot")).toBe("true");
    expect(pressed(container, "Claw")).toBe("false");
    const textScaleButtons = [
      ...container.querySelectorAll<HTMLButtonElement>(".settings-text-scale__btn"),
    ];
    expect(
      textScaleButtons
        .find((button) => button.textContent?.includes("110%"))
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      textScaleButtons
        .find((button) => button.textContent?.includes("100%"))
        ?.getAttribute("aria-pressed"),
    ).toBe("false");

    findButtonByText(container, "Claw").click();
    const colorMode = row("Color mode")?.querySelector<HTMLInputElement>(
      '.settings-segmented__input[value="system"]',
    );
    expect(colorMode).toBeDefined();
    colorMode?.click();
    container.querySelector<HTMLButtonElement>('[data-accent-preset="default"]')?.click();
    Array.from(container.querySelectorAll<HTMLButtonElement>(".settings-text-scale__btn"))
      .find((button) => button.textContent?.includes("100%"))
      ?.click();

    expect(props.setTheme).toHaveBeenCalledWith("claw");
    expect(props.setThemeMode).toHaveBeenCalledWith("system");
    expect(props.setAccent).toHaveBeenCalledWith(undefined);
    expect(props.setTextScale).toHaveBeenCalledWith(100);
  });

  it.each(["iPhone", "Windows"])("keeps authored defaults editable on %s", (userAgent) => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
    onTestFinished(() => {
      vi.restoreAllMocks();
    });
    const { container, props } = renderAppearance({
      theme: "claw",
      themeOverridden: true,
      themeProvenance: "synced",
      themeMode: "system",
      themeModeOverridden: true,
      themeModeProvenance: "synced",
      chatSendShortcut: "enter",
      chatSendShortcutOverridden: true,
      chatSendShortcutProvenance: "synced",
    });
    const themeSection = required(container, "#settings-appearance-theme", HTMLElement);
    const shortcutRow = settingsRow(container, "Send shortcut");

    expect(normalizedText(themeSection)).toContain("Default: Claw");
    expect(normalizedText(themeSection)).toContain("Default: System");
    expect(shortcutRow.textContent).toContain("Default: Enter");
    expect(shortcutRow.textContent).toContain(
      "Desktop only. On mobile, Enter adds a new line; use the Send button to send.",
    );
    const shortcut = required(shortcutRow, "select", HTMLSelectElement);
    expect(shortcut.value).toBe("enter");
    expect(shortcut.disabled).toBe(false);
    expect(props.onAppearanceChange).not.toHaveBeenCalled();
    shortcut.value = "modifier-enter";
    shortcut.dispatchEvent(new Event("change", { bubbles: true }));
    expect(props.onAppearanceChange).toHaveBeenCalledExactlyOnceWith({
      chatSendShortcut: "modifier-enter",
    });
    findButtonByText(themeSection, "Claw").click();
    themeSection
      .querySelector<HTMLInputElement>('.settings-segmented__input[value="system"]')
      ?.click();

    expect(props.setTheme).toHaveBeenCalledWith("claw");
    expect(props.setThemeMode).toHaveBeenCalledWith("system");
  });

  it("renders rejected theme and locale edits as browser-only fallbacks", async () => {
    const { container, props } = renderAppearance({
      localeOverride: "fr",
      localeOverridden: true,
      localeProvenance: "device-local",
      localeResetValue: "de",
      theme: "knot",
      themeOverridden: true,
      themeProvenance: "device-local",
      themeResetValue: "claw",
    });
    await updatePickers(container);
    const languageRow = required(container, "#settings-language .settings-row", HTMLElement);
    const themeSection = required(container, "#settings-appearance-theme", HTMLElement);
    const themeDescription = required(
      themeSection,
      ":scope > .settings-section__desc",
      HTMLElement,
    );

    expect(languageRow.textContent).toContain("Default: Deutsch (German)");
    expect(languageRow.textContent).toContain("Stored in this browser only");
    expect(languageRow.textContent).not.toContain("Synced across your devices");
    await openPicker(languageRow.querySelector("openclaw-select-picker")!);
    expect(pickerOption(languageRow, "fr")?.getAttribute("aria-selected")).toBe("true");
    expect(themeDescription.textContent).toContain("Default: Claw");
    expect(themeDescription.textContent).toContain("Stored in this browser only");
    expect(themeDescription.textContent).not.toContain("Synced across your devices");
    expect(
      themeSection.querySelector(".settings-theme-card--knot")?.getAttribute("aria-pressed"),
    ).toBe("true");

    findButtonByText(themeSection, "Claw").click();

    expect(props.setTheme).toHaveBeenCalledWith("claw");
  });

  it("shows pending synced preferences without claiming they already synced", () => {
    const { container } = renderAppearance({
      theme: "claw",
      themeOverridden: false,
      themeProvenance: "pending",
      chatFollowUpMode: "queue",
      chatFollowUpModeOverridden: true,
      chatFollowUpModeProvenance: "pending",
    });
    const themeSection = required(container, "#settings-appearance-theme", HTMLElement);
    const themeDescription = required(
      themeSection,
      ":scope > .settings-section__desc",
      HTMLElement,
    );
    const followUpRow = settingsRow(container, "Follow-ups while the agent is working");

    expect(themeDescription.textContent).toContain("Waiting to sync through the gateway");
    expect(themeDescription.textContent).not.toContain("Synced across your devices");
    expect(followUpRow?.textContent).toContain("Waiting to sync through the gateway");
    expect(followUpRow?.textContent).not.toContain("Synced across your devices");
  });

  it("names the chat preference selects for assistive tech", () => {
    const onMicrophoneRefresh = vi.fn();
    const onCameraRefresh = vi.fn();
    const { container } = renderAppearance({
      microphone: mediaDevice("mic-1", "Desk Mic"),
      onMicrophoneSelect: vi.fn(),
      onMicrophoneRefresh,
      camera: mediaDevice("camera-1", "Desk Camera"),
      onCameraSelect: vi.fn().mockResolvedValue(undefined),
      onCameraRefresh,
      composerHoldToRecord: true,
    });

    const shortcutSelect = required(container, "[data-settings-send-shortcut]", HTMLSelectElement);
    expect(shortcutSelect.getAttribute("aria-label")).toBe("Send shortcut");
    const followUpSelect = required(container, "[data-settings-follow-up-mode]", HTMLSelectElement);
    expect(followUpSelect.getAttribute("aria-label")).toBe("Follow-ups while the agent is working");
    expect(followUpSelect.value).toBe("server");
    expect(Array.from(followUpSelect.options, (option) => option.value)).toEqual([
      "server",
      "steer",
      "queue",
    ]);
    expect(container.textContent).not.toContain("Using server default");
    expect(followUpSelect.selectedOptions[0]?.textContent?.trim()).toBe("Server default (steer)");
    const microphoneSelect = required(container, "[data-settings-microphone]", HTMLSelectElement);
    expect(microphoneSelect.getAttribute("aria-label")).toBe("Microphone input");
    expect(microphoneSelect.classList.contains("settings-select--media-device")).toBe(true);
    const cameraSelect = required(container, "[data-settings-camera]", HTMLSelectElement);
    expect(cameraSelect.getAttribute("aria-label")).toBe("Camera");
    expect(cameraSelect.classList.contains("settings-select--media-device")).toBe(true);
    expect(Array.from(cameraSelect.options, (option) => option.textContent?.trim())).toEqual([
      "System default",
      "Desk Camera",
    ]);
    for (const select of [microphoneSelect, cameraSelect]) {
      expect(select.closest(".settings-row")?.querySelector("button")).toBeNull();
    }
    expect(container.textContent).toContain("Hold microphone button to start dictation");

    microphoneSelect.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    cameraSelect.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    expect(onMicrophoneRefresh).not.toHaveBeenCalled();
    expect(onCameraRefresh).not.toHaveBeenCalled();
  });

  it.each([
    {
      device: "microphone",
      loading: false,
      devices: [{ deviceId: "anonymous", label: "Microphone 1" }],
      key: null,
    },
    { device: "microphone", loading: false, devices: [], key: "ArrowDown" },
    { device: "camera", loading: true, devices: [], key: null },
  ] as const)(
    "requests $device access once for $key while loading=$loading",
    ({ device, loading, devices, key }) => {
      const onRefresh = vi.fn();
      const state = {
        devices: [...devices],
        discovery: loading ? new Promise<string | null>(() => {}) : null,
        permissionRequired: true,
        selectedDeviceId: "",
        selection: null,
      };
      const { container } = renderAppearance(
        device === "camera"
          ? {
              camera: state,
              onCameraSelect: vi.fn().mockResolvedValue(undefined),
              onCameraRefresh: onRefresh,
            }
          : { microphone: state, onMicrophoneSelect: vi.fn(), onMicrophoneRefresh: onRefresh },
      );
      const select = required(container, `[data-settings-${device}]`, HTMLSelectElement);
      select.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 2 }));
      expect(onRefresh).not.toHaveBeenCalled();
      select.dispatchEvent(
        key
          ? new KeyboardEvent("keydown", { key, bubbles: true })
          : new MouseEvent("pointerdown", { bubbles: true, button: 0 }),
      );
      expect(onRefresh).toHaveBeenCalledOnce();
      select.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      select.dispatchEvent(new KeyboardEvent("keydown", { key: "F4", bubbles: true }));
      expect(onRefresh).toHaveBeenCalledOnce();
    },
  );

  it("previews lobster sounds only when the user enables them", () => {
    const param = () => ({
      setValueAtTime: vi.fn(),
      exponentialRampToValueAtTime: vi.fn(),
    });
    const audioContextCtor = vi.fn(function MockAudioContext() {
      return {
        state: "running",
        currentTime: 0,
        destination: {},
        resume: vi.fn(),
        close: vi.fn(() => Promise.resolve()),
        createOscillator: vi.fn(() => ({
          type: "sine",
          frequency: param(),
          connect: (node: unknown) => node,
          start: vi.fn(),
          stop: vi.fn(),
        })),
        createGain: vi.fn(() => ({ gain: param(), connect: vi.fn() })),
      };
    });
    vi.stubGlobal("AudioContext", audioContextCtor);

    const soundSwitch = (container: HTMLElement) => {
      const control = settingsRow(container, "Lobster sounds").querySelector<HTMLInputElement>(
        ".settings-toggle__input",
      );
      expect(control).toBeDefined();
      if (!control) {
        throw new Error("Missing lobster sounds switch");
      }
      return control;
    };

    const { container, props } = renderAppearance();
    document.body.append(container);
    onTestFinished(() => container.remove());
    const disabledSwitch = soundSwitch(container);

    expect(audioContextCtor).not.toHaveBeenCalled();
    disabledSwitch.click();
    expect(audioContextCtor).toHaveBeenCalledTimes(1);
    expect(props.onAppearanceChange).toHaveBeenCalledWith({ lobsterPetSounds: true });

    props.lobsterPetSounds = true;
    renderConfigInto(props, container);
    const enabledSwitch = soundSwitch(container);

    const noOpKey = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      composed: true,
    });
    enabledSwitch.dispatchEvent(noOpKey);
    expect(audioContextCtor).toHaveBeenCalledTimes(1);

    enabledSwitch.click();
    expect(audioContextCtor).toHaveBeenCalledTimes(1);
    expect(props.onAppearanceChange).toHaveBeenLastCalledWith({ lobsterPetSounds: false });
  });

  it("labels hidden session sections from the catalog and keeps ids as the fallback", () => {
    const { container, props } = renderAppearance({
      hiddenSessionCatalogIds: new Set(["claude", "offline-catalog"]),
      hiddenSessionCatalogLabels: {
        read: () => new Map([["claude", "Claude Code"]]),
        scope: null,
      },
    });

    const heading = Array.from(container.querySelectorAll("h3")).find(
      (candidate) => candidate.textContent?.trim() === "Hidden session sections",
    );
    const labeledRow = settingsRow(container, "Claude Code");
    const fallbackRow = settingsRow(container, "offline-catalog");
    expect(heading).toBeDefined();
    expect(labeledRow).toBeDefined();
    expect(fallbackRow).toBeDefined();
    labeledRow?.querySelector<HTMLButtonElement>("button")?.click();
    expect(props.setSessionCatalogHidden).toHaveBeenCalledWith("claude", false);
  });

  it("uses rich Lobsterdex lore tooltips and opens the full collection", () => {
    const firstSeenAt = new Date("2026-07-10T12:00:00.000Z").getTime();
    vi.stubGlobal("localStorage", window.localStorage);
    localStorage.setItem(
      "openclaw.control.lobsterdex.v1",
      JSON.stringify({
        crimson: { firstSeenAt, name: "Ruby", shinySeenAt: firstSeenAt },
      }),
    );
    const onOpenLobsterdex = vi.fn();
    try {
      const { container } = renderAppearance({
        lobsterPetVisits: true,
        lobsterPetSounds: true,
        lobsterdexHref: "/settings/lobsterdex",
        onOpenLobsterdex,
      });

      const seen = container.querySelector(".lobster-pet--palette-crimson");
      const seenTooltip = seen?.closest("openclaw-tooltip");
      expect(seen?.hasAttribute("title")).toBe(false);
      expect(seen?.getAttribute("aria-label")).toContain("Ruby ✦");
      expect(seenTooltip?.querySelector('[slot="content"]')?.textContent).toContain(
        "The classic red, first in every tide pool.",
      );
      expect(seenTooltip?.querySelector('[slot="content"]')?.textContent).toContain(
        new Date(firstSeenAt).toLocaleDateString(),
      );

      const unseen = container.querySelector(".lobster-pet--palette-watermelon");
      expect(unseen?.getAttribute("aria-label")).toContain("Ripe when thumped.");
      expect(
        unseen?.closest("openclaw-tooltip")?.querySelector('[slot="content"]')?.textContent,
      ).toContain("Ripe when thumped.");

      const openLink = container.querySelector<HTMLAnchorElement>(".lobsterdex__open");
      openLink?.addEventListener("click", (event) => event.preventDefault(), {
        capture: true,
        once: true,
      });
      openLink?.click();
      expect(onOpenLobsterdex).not.toHaveBeenCalled();

      openLink?.click();
      expect(onOpenLobsterdex).toHaveBeenCalledOnce();
    } finally {
      localStorage.removeItem("openclaw.control.lobsterdex.v1");
      vi.unstubAllGlobals();
    }
  });
});
