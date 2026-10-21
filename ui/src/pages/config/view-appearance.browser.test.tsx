import { beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import type { SelectPicker } from "../../components/select-picker.ts";
import { warmJson5 } from "../../lib/json5-runtime.ts";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { updatePickers, openPicker, choosePickerValue } from "../../test-helpers/select-picker.ts";
import { renderAppearance, renderConfigInto } from "./config-view.test-support.tsx";
import "../../styles.css";

function row(container: HTMLElement, title: string) {
  const found = [...container.querySelectorAll<HTMLElement>(".settings-row")].find(
    (candidate) => candidate.querySelector(".settings-row__title")?.textContent?.trim() === title,
  );
  if (!found) {
    throw new Error(`Missing settings row: ${title}`);
  }
  return found;
}

describe("config appearance preferences", () => {
  beforeAll(async () => {
    await warmJson5();
  });

  function text(container: HTMLElement): string {
    return container.textContent?.replace(/\s+/g, " ").trim() ?? "";
  }

  function expectCopy(container: HTMLElement, included: string[], excluded: string[] = []) {
    const copy = text(container);
    for (const phrase of included) {
      expect(copy).toContain(phrase);
    }
    for (const phrase of excluded) {
      expect(copy).not.toContain(phrase);
    }
  }
  const importer = <T extends HTMLElement = HTMLElement>(container: HTMLElement, part: string) =>
    container.querySelector<T>(`.settings-theme-import__${part}`)!;

  function button(container: HTMLElement, label: string, exact = true): HTMLButtonElement {
    const found = Array.from(container.querySelectorAll("button")).find((btn) =>
      exact ? btn.textContent?.trim() === label : btn.textContent?.includes(label),
    );
    if (!found) {
      throw new Error(`Expected button with text "${label}"`);
    }
    return found;
  }

  function get<T extends Element>(
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
    return button(container, label).getAttribute("aria-pressed");
  }

  function mediaDevice(deviceId: string, label: string) {
    return {
      devices: [{ deviceId, label }],
      permissionRequired: false,
      selectedDeviceId: deviceId,
      discovery: null,
      error: null,
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

      const content = get(container, ".config-content", HTMLElement);
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
      const select = get(container, "#settings-language openclaw-select-picker", HTMLElement);
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
    const ui = get(container, "#settings-font-ui", HTMLElement).closest<SelectPicker>(
      "openclaw-select-picker",
    )!;
    const chat = get(container, "#settings-font-chat", HTMLElement).closest<SelectPicker>(
      "openclaw-select-picker",
    )!;
    await openPicker(ui);
    expect(pickerOption(ui, "theme")?.textContent).toContain("Dash · DM Sans");
    await openPicker(chat);
    expect(pickerOption(chat, "theme")?.textContent).toContain("Dash · Fraunces");
    expect(ui.closest(".settings-row")?.textContent).toContain("Saved to your profile");
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

    const customButton = button(container, "Import");

    expect(customButton.disabled).toBe(false);
    expect(customButton.hasAttribute("aria-pressed")).toBe(false);

    customButton.click();

    expect(onOpenCustomThemeImport).toHaveBeenCalledTimes(1);
    props.customThemeImportExpanded = true;
    renderConfigInto(props, container);
    const importButton = button(container, "Import theme", false);

    expect(importButton.disabled).toBe(true);
    get(container, ".settings-theme-import__input", HTMLInputElement);
    expect(importer<HTMLAnchorElement>(container, "external").href).toBe(
      "https://tweakcn.com/editor/theme",
    );
    const source = "https://tweakcn.com/themes/cmlhfpjhw000004l4f4ax3m7z";
    Object.assign(props, {
      hasCustomTheme: true,
      customThemeLabel: "Light Green",
      customThemeSourceUrl: source,
      customThemeImportUrl: source,
    });
    renderConfigInto(props, container);
    const importedButton = button(container, "Light Green");
    expect(importedButton.disabled).toBe(false);
    importedButton.click();
    expect(props.setTheme).toHaveBeenCalledWith("custom");

    button(container, "Replace Light Green", false).click();
    button(container, "Clear Light Green", false).click();

    expect(props.onImportCustomTheme).toHaveBeenCalledTimes(1);
    expect(props.onClearCustomTheme).toHaveBeenCalledTimes(1);
    expect(text(importer(container, "meta-label"))).toBe("Loaded");
    expect(text(importer(container, "meta-value"))).toBe(`Light Green · ${source}`);

    const input = importer<HTMLInputElement>(container, "input");
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
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    const requestFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        frames.set(++frameId, callback);
        return frameId;
      });
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      frames.delete(id);
    });
    onTestFinished(() => {
      cleanupSolid();
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
      otherInput.remove();
      container.remove();
    });

    button(container, "Import").click();
    renderConfigInto(props, container);
    props.textScale = 110;
    renderConfigInto(props, container);
    const input = get(container, ".settings-theme-import__input", HTMLInputElement);
    const pending = [...frames.values()];
    frames.clear();
    for (const frame of pending) {
      frame(0);
    }
    expect(document.activeElement).toBe(input);
    expect(input).toMatchObject({ selectionStart: 0, selectionEnd: "amethyst-haze".length });

    button(container, "Import").click();
    renderConfigInto(props, container);
    expect(frames.size).toBe(1);
    cleanupSolid();
    expect(frames.size).toBe(0);
  });

  it("keeps authored visual defaults direct", () => {
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
    const themeSection = get(container, "#settings-appearance-theme", HTMLElement);
    const shortcutRow = row(container, "Send shortcut");

    expectCopy(themeSection, ["Default: Claw", "Default: System"]);
    expect(shortcutRow?.textContent).toContain("Default: Enter");
    button(themeSection, "Claw").click();
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
    const languageRow = get(container, "#settings-language .settings-row", HTMLElement);
    const themeSection = get(container, "#settings-appearance-theme", HTMLElement);
    const themeDescription = get(themeSection, ":scope > .settings-section__desc", HTMLElement);

    expectCopy(
      languageRow,
      ["Default: Deutsch (German)", "Stored in this browser only"],
      ["Synced across your devices"],
    );
    await openPicker(languageRow.querySelector("openclaw-select-picker")!);
    expect(pickerOption(languageRow, "fr")?.getAttribute("aria-selected")).toBe("true");
    expectCopy(
      themeDescription,
      ["Default: Claw", "Stored in this browser only"],
      ["Synced across your devices"],
    );
    expect(
      themeSection.querySelector(".settings-theme-card--knot")?.getAttribute("aria-pressed"),
    ).toBe("true");

    button(themeSection, "Claw").click();

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
    const themeSection = get(container, "#settings-appearance-theme", HTMLElement);
    const themeDescription = get(themeSection, ":scope > .settings-section__desc", HTMLElement);
    const followUpRow = row(container, "Follow-ups while the agent is working");

    for (const region of [themeDescription, followUpRow]) {
      expectCopy(region, ["Waiting to sync through the gateway"], ["Synced across your devices"]);
    }
  });

  it("names the chat preference selects for assistive tech", () => {
    const onMicrophoneRefresh = vi.fn();
    const onCameraRefresh = vi.fn();
    const { container } = renderAppearance({
      microphone: mediaDevice("mic-1", "Desk Mic"),
      onMicrophoneSelect: vi.fn(),
      onMicrophoneRefresh,
      camera: mediaDevice("camera-1", "Desk Camera"),
      onCameraSelect: vi.fn(),
      onCameraRefresh,
      composerHoldToRecord: true,
    });

    const shortcutSelect = get(container, "[data-settings-send-shortcut]", HTMLSelectElement);
    expect(shortcutSelect.getAttribute("aria-label")).toBe("Send shortcut");
    const followUpSelect = get(container, "[data-settings-follow-up-mode]", HTMLSelectElement);
    expect(followUpSelect.getAttribute("aria-label")).toBe("Follow-ups while the agent is working");
    expect(followUpSelect.value).toBe("server");
    expect(Array.from(followUpSelect.options, (option) => option.value)).toEqual([
      "server",
      "steer",
      "queue",
    ]);
    expect(container.textContent).not.toContain("Using server default");
    expect(followUpSelect.selectedOptions[0]?.textContent?.trim()).toBe("Server default (steer)");
    const microphoneSelect = get(container, "[data-settings-microphone]", HTMLSelectElement);
    const cameraSelect = get(container, "[data-settings-camera]", HTMLSelectElement);
    expect(Array.from(cameraSelect.options, (option) => option.textContent?.trim())).toEqual([
      "System default",
      "Desk Camera",
    ]);
    for (const [select, label] of [
      [microphoneSelect, "Microphone input"],
      [cameraSelect, "Camera"],
    ] as const) {
      expect(select.ariaLabel).toBe(label);
      expect(select.classList.contains("settings-select--media-device")).toBe(true);
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
        error: null,
      };
      const { container } = renderAppearance(
        device === "camera"
          ? { camera: state, onCameraSelect: vi.fn(), onCameraRefresh: onRefresh }
          : { microphone: state, onMicrophoneSelect: vi.fn(), onMicrophoneRefresh: onRefresh },
      );
      const select = get(container, `[data-settings-${device}]`, HTMLSelectElement);
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

    const soundSwitch = (container: HTMLElement) =>
      get(row(container, "Lobster sounds"), ".settings-toggle__input", HTMLInputElement);

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
    const labeledRow = row(container, "Claude Code");
    const fallbackRow = row(container, "offline-catalog");
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
