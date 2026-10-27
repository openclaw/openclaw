import { beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import type { SelectPicker } from "../../components/select-picker.ts";
import { warmJson5 } from "../../lib/json5-runtime.ts";
import { createFrameClock } from "../../test-helpers/animation-frame-clock.ts";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { updatePickers, openPicker } from "../../test-helpers/select-picker.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import "../../styles.css";
import {
  renderAppearance,
  renderConfigInto,
  requiredConfigElement as required,
} from "./config-view.test-support.tsx";

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

  it("labels a regional system locale", async () => {
    const { container } = renderAppearance({ systemLocale: "pt-BR" });
    await updatePickers(container);
    const select = container.querySelector<SelectPicker>(
      "#settings-language openclaw-select-picker",
    )!;
    await openPicker(select);
    expect(pickerOption(select, "system")?.textContent).toContain(
      "System (Português (Brazilian Portuguese))",
    );
  });

  it("identifies profile-owned typography", async () => {
    const { container } = renderAppearance({ fontUiProvenance: "profile" });
    await updatePickers(container);
    expect(
      required(container, "#settings-font-ui", HTMLElement).closest(".settings-row")?.textContent,
    ).toContain("Saved to your profile");
  });

  it("uses dark ink on a light custom accent swatch", () => {
    const custom = renderAppearance({
      accent: "#c3cfdb",
      accentProvenance: "device-local",
    });
    expect(
      custom.container
        .querySelector<HTMLElement>(".settings-accent-swatch--custom")
        ?.style.getPropertyValue("--settings-accent-swatch-ink"),
    ).toBe("#000000");
  });

  it("gates empty theme imports and exposes replace and clear actions", () => {
    const onOpenCustomThemeImport = vi.fn();
    const { container, props } = renderAppearance({
      onOpenCustomThemeImport,
    });

    const customButton = findButtonByText(container, "Import");

    expect(customButton.hasAttribute("aria-pressed")).toBe(false);

    customButton.click();

    expect(onOpenCustomThemeImport).toHaveBeenCalledTimes(1);
    props.customThemeImportExpanded = true;
    renderConfigInto(props, container);
    const importButton = findButtonByText(container, "Import theme", false);

    expect(importButton.disabled).toBe(true);
    required(container, ".settings-theme-import__input", HTMLInputElement);
    props.hasCustomTheme = true;
    props.customThemeLabel = "Light Green";
    props.customThemeSourceUrl = "https://tweakcn.com/themes/cmlhfpjhw000004l4f4ax3m7z";
    props.customThemeImportUrl = props.customThemeSourceUrl;
    renderConfigInto(props, container);
    const importedButton = findButtonByText(container, "Light Green");
    importedButton.click();
    expect(props.setTheme).toHaveBeenCalledWith("custom");

    findButtonByText(container, "Replace Light Green", false).click();
    findButtonByText(container, "Clear Light Green", false).click();

    expect(props.onImportCustomTheme).toHaveBeenCalledTimes(1);
    expect(props.onClearCustomTheme).toHaveBeenCalledTimes(1);

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

  it("shows the browser-local locale and its inherited default", async () => {
    const { container } = renderAppearance({
      localeOverride: "fr",
      localeOverridden: true,
      localeProvenance: "device-local",
      localeResetValue: "de",
    });
    await updatePickers(container);
    const languageRow = required(container, "#settings-language .settings-row", HTMLElement);

    expect(languageRow.textContent).toContain("Default: Deutsch (German)");
    expect(languageRow.textContent).toContain("Stored in this browser only");
    expect(languageRow.textContent).not.toContain("Synced across your devices");
    await openPicker(languageRow.querySelector("openclaw-select-picker")!);
    expect(pickerOption(languageRow, "fr")?.getAttribute("aria-selected")).toBe("true");
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

    const soundSwitch = (container: HTMLElement) =>
      required(
        settingsRow(container, "Lobster sounds"),
        ".settings-toggle__input",
        HTMLInputElement,
      );

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

  it("defers offscreen Lobsterdex artwork and keeps it after the first reveal", async () => {
    const { container } = renderAppearance();
    container.style.cssText = "position:fixed;top:0;left:0;width:390px;height:200px;overflow:auto";
    document.body.append(container);
    onTestFinished(() => container.remove());
    const gallery = required(container, ".lobsterdex", HTMLElement);
    const thumbnails = gallery.querySelectorAll(".lobsterdex__mini");
    expect(thumbnails.length).toBeGreaterThan(0);
    expect(gallery.querySelectorAll(".lobster-pet__svg")).toHaveLength(0);

    gallery.scrollIntoView({ block: "center" });
    await waitForSolid(() => {
      expect(gallery.querySelectorAll(".lobster-pet__svg")).toHaveLength(thumbnails.length);
    });
    const artwork = gallery.querySelector(".lobster-pet__svg");
    container.style.top = "2000px";
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    expect(gallery.querySelector(".lobster-pet__svg")).toBe(artwork);
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
