import { beforeAll, expect, it, onTestFinished, vi } from "vitest";
import { userEvent } from "vitest/browser";
import {
  BUILTIN_THEMES,
  type ThemeCatalogEntry,
} from "../../../../packages/gateway-protocol/src/theme.ts";
import { LOBSTER_PET_PALETTES } from "../../components/lobster-pet-palettes.ts";
import { warmJson5 } from "../../lib/json5-runtime.ts";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { updatePickers, openPicker, choosePickerValue } from "../../test-helpers/select-picker.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { renderAppearance, renderConfigInto } from "./config-view.test-support.tsx";
import type { ConfigProps } from "./view.tsx";
import "../../styles.css";
import "../../styles/settings.css";

function dom(container: HTMLElement) {
  const q = <T extends HTMLElement = HTMLElement>(selector: string) =>
    container.querySelector<T>(selector)!;
  const all = <T extends Element = HTMLElement>(selector: string) => [
    ...container.querySelectorAll<T>(selector),
  ];
  const button = (label: string, exact = true) =>
    all<HTMLButtonElement>("button").find((item) =>
      exact ? item.textContent?.trim() === label : item.textContent?.includes(label),
    )!;
  const row = (title: string) =>
    all<HTMLElement>(".settings-row").find(
      (item) => item.querySelector(".settings-row__title")?.textContent?.trim() === title,
    )!;
  return { container, q, all, button, row };
}
function appearance(overrides: Partial<ConfigProps> = {}) {
  const { container, props } = renderAppearance(overrides);
  const query = dom(container);
  const update = (patch: Partial<ConfigProps> = {}) => {
    Object.assign(props, patch);
    renderConfigInto(props, container);
  };
  const importer = <T extends HTMLElement = HTMLElement>(part: string) =>
    query.q<T>(`.settings-theme-import__${part}`);
  const pressed = (label: string) => query.button(label).ariaPressed;
  const attach = () => {
    document.body.append(container);
    onTestFinished(() => container.remove());
  };
  return { ...query, props, update, importer, pressed, attach };
}
const text = (element: HTMLElement) => element.textContent?.replace(/\s+/g, " ").trim() ?? "";
function expectCopy(container: HTMLElement, included: string[], excluded: string[] = []) {
  const copy = text(container);
  for (const phrase of included) {
    expect(copy).toContain(phrase);
  }
  for (const phrase of excluded) {
    expect(copy).not.toContain(phrase);
  }
}
const pickerOption = (picker: Element, value: string) =>
  picker.querySelector(`[role="option"][data-value="${value}"]`);
const mediaDevice = (deviceId: string, label: string) => ({
  devices: [{ deviceId, label }],
  permissionRequired: false,
  selectedDeviceId: deviceId,
  discovery: null,
  error: null,
});
beforeAll(() => warmJson5().then(() => undefined));

it("lets config pages grow with their content instead of creating an inner viewport", async () => {
  const v = appearance({ customThemeImportExpanded: true });
  v.attach();
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
  const content = v.q(".config-content");
  expect(content.scrollHeight - content.clientHeight).toBeLessThanOrEqual(1);
});

it.each([
  { systemLocale: "pt-BR", localeOverride: undefined, label: "Português (Brazilian Portuguese)" },
  { systemLocale: "de", localeOverride: "fr", label: "Deutsch (German)" },
] as const)(
  "renders and changes language with system locale $systemLocale",
  async ({ systemLocale, localeOverride, label }) => {
    const v = appearance({
      systemLocale,
      localeOverride,
      localeOverridden: Boolean(localeOverride),
    });
    await updatePickers(v.container);
    const sections = [...v.all<HTMLElement>(".settings-section")];
    expect(sections[0]?.id).toBe("settings-language");
    expect(sections[0]?.textContent).toContain("Language");
    expect(sections[0]?.textContent).toContain("Synced across your devices through the gateway");
    const select = v.q<HTMLElement>("#settings-language openclaw-select-picker");
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
    expect(v.props.onLocaleChange).toHaveBeenCalledWith("fr");
    expect(v.props.onLocaleChange).toHaveBeenCalledWith(undefined);
  },
);

it("describes the custom accent source and selected state through the native input", () => {
  const inherited = appearance();
  const inheritedInput = inherited.q<HTMLInputElement>("[data-accent-custom]");
  expect(inherited.q("#settings-accent-status")?.textContent).not.toContain(
    "Using inherited accent",
  );
  expect(inheritedInput?.getAttribute("aria-describedby")).toBe("settings-accent-status");

  const custom = appearance({
    accent: "#c3cfdb",
    accentProvenance: "device-local",
  });
  expect(custom.q("#settings-accent-status")?.textContent).toContain("Using Custom color");
  expect(
    custom.container
      .querySelector<HTMLElement>(".settings-accent-swatch--custom")
      ?.style.getPropertyValue("--settings-accent-swatch-ink"),
  ).toBe("#000000");
});

it("keeps imports disabled until supplied and selects the saved imported theme", () => {
  const v = appearance({ customThemeImportExpanded: true });
  expect(v.button("Import theme", false).disabled).toBe(true);
  expect(v.importer<HTMLAnchorElement>("external").href).toBe("https://tweakcn.com/editor/theme");
  const source = "https://tweakcn.com/themes/cmlhfpjhw000004l4f4ax3m7z";
  v.update({
    hasCustomTheme: true,
    customThemeLabel: "Light Green",
    customThemeSourceUrl: source,
    customThemeImportUrl: source,
  });
  const imported = v.button("Light Green");
  expect(imported.disabled).toBe(false);
  imported.click();
  expect(v.props.setTheme).toHaveBeenCalledWith("custom");
  expect(text(v.importer("meta-label"))).toBe("Loaded");
  expect(text(v.importer("meta-value"))).toBe(`Light Green · ${source}`);
  v.update({ theme: "custom" });
  expect(v.pressed("Light Green")).toBe("true");
  expect(v.pressed("Claw")).toBe("false");
});

it("focuses its own importer through unrelated updates and retires pending focus on disposal", () => {
  const otherInput = document.createElement("input");
  otherInput.setAttribute("data-custom-theme-import-input", "");
  document.body.append(otherInput);
  const v = appearance({ customThemeImportUrl: "amethyst-haze" });
  document.body.append(v.container);
  v.props.onOpenCustomThemeImport = vi.fn(() => {
    v.props.customThemeImportExpanded = true;
    v.update();
  });
  v.update();
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
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
    v.container.remove();
  });

  const open = v.button("Import");
  expect(open.disabled).toBe(false);
  expect(open.hasAttribute("aria-pressed")).toBe(false);
  open.click();
  expect(v.props.onOpenCustomThemeImport).toHaveBeenCalledOnce();
  v.update();
  v.update({ textScale: 110 });
  const input = v.q<HTMLInputElement>(".settings-theme-import__input");
  const pending = [...frames.values()];
  frames.clear();
  for (const frame of pending) {
    frame(0);
  }
  expect(document.activeElement).toBe(input);
  expect(input).toMatchObject({ selectionStart: 0, selectionEnd: "amethyst-haze".length });

  v.button("Import").click();
  v.update();
  expect(frames.size).toBe(1);
  cleanupSolid();
  expect(frames.size).toBe(0);
});

it("keeps authored visual defaults direct", () => {
  const v = appearance({
    themeOverridden: true,
    themeProvenance: "synced",
    themeModeOverridden: true,
    themeModeProvenance: "synced",
    chatSendShortcutOverridden: true,
    chatSendShortcutProvenance: "synced",
  });
  const themeSection = v.q<HTMLElement>("#settings-appearance-theme");
  const shortcutRow = v.row("Send shortcut");

  expectCopy(themeSection, ["Default: Claw", "Default: System"]);
  expect(shortcutRow?.textContent).toContain("Default: Enter");
  v.button("Claw").click();
  themeSection
    .querySelector<HTMLInputElement>('.settings-segmented__input[value="system"]')
    ?.click();

  expect(v.props.setTheme).toHaveBeenCalledWith("claw");
  expect(v.props.setThemeMode).toHaveBeenCalledWith("system");
});

it("shows pending synced preferences without claiming they already synced", () => {
  const v = appearance({
    themeProvenance: "pending",
    chatFollowUpMode: "queue",
    chatFollowUpModeOverridden: true,
    chatFollowUpModeProvenance: "pending",
  });
  const themeSection = v.q<HTMLElement>("#settings-appearance-theme");
  const themeDescription = themeSection.querySelector<HTMLElement>(
    ":scope > .settings-section__desc",
  )!;
  const followUpRow = v.row("Follow-ups while the agent is working");

  for (const region of [themeDescription, followUpRow]) {
    expectCopy(region, ["Waiting to sync through the gateway"], ["Synced across your devices"]);
  }
});

it("names the chat preference selects for assistive tech", () => {
  const onMicrophoneRefresh = vi.fn();
  const onCameraRefresh = vi.fn();
  const v = appearance({
    microphone: mediaDevice("mic-1", "Desk Mic"),
    onMicrophoneSelect: vi.fn(),
    onMicrophoneRefresh,
    camera: mediaDevice("camera-1", "Desk Camera"),
    onCameraSelect: vi.fn(),
    onCameraRefresh,
  });

  const shortcutSelect = v.q<HTMLSelectElement>("[data-settings-send-shortcut]");
  expect(shortcutSelect.getAttribute("aria-label")).toBe("Send shortcut");
  const followUpSelect = v.q<HTMLSelectElement>("[data-settings-follow-up-mode]");
  expect(followUpSelect.getAttribute("aria-label")).toBe("Follow-ups while the agent is working");
  expect(followUpSelect.value).toBe("server");
  expect(Array.from(followUpSelect.options, (option) => option.value)).toEqual([
    "server",
    "steer",
    "queue",
  ]);
  expect(v.container.textContent).not.toContain("Using server default");
  expect(followUpSelect.selectedOptions[0]?.textContent?.trim()).toBe("Server default (steer)");
  const microphoneSelect = v.q<HTMLSelectElement>("[data-settings-microphone]");
  const cameraSelect = v.q<HTMLSelectElement>("[data-settings-camera]");
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
  expect(v.container.textContent).toContain("Hold microphone button to start dictation");

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
    const v = appearance(
      device === "camera"
        ? { camera: state, onCameraSelect: vi.fn(), onCameraRefresh: onRefresh }
        : { microphone: state, onMicrophoneSelect: vi.fn(), onMicrophoneRefresh: onRefresh },
    );
    const select = v.q<HTMLSelectElement>(`[data-settings-${device}]`);
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

  const v = appearance();
  v.attach();
  const disabledSwitch = v
    .row("Lobster sounds")
    .querySelector<HTMLInputElement>(".settings-toggle__input")!;

  expect(audioContextCtor).not.toHaveBeenCalled();
  disabledSwitch.click();
  expect(audioContextCtor).toHaveBeenCalledTimes(1);
  expect(v.props.onAppearanceChange).toHaveBeenCalledWith({ lobsterPetSounds: true });

  v.update({ lobsterPetSounds: true });
  const enabledSwitch = v
    .row("Lobster sounds")
    .querySelector<HTMLInputElement>(".settings-toggle__input")!;

  const noOpKey = new KeyboardEvent("keydown", {
    key: "ArrowRight",
    bubbles: true,
    composed: true,
  });
  enabledSwitch.dispatchEvent(noOpKey);
  expect(audioContextCtor).toHaveBeenCalledTimes(1);

  enabledSwitch.click();
  expect(audioContextCtor).toHaveBeenCalledTimes(1);
  expect(v.props.onAppearanceChange).toHaveBeenLastCalledWith({ lobsterPetSounds: false });
});

it("labels hidden session sections from the catalog and keeps ids as the fallback", () => {
  const v = appearance({
    hiddenSessionCatalogIds: new Set(["claude", "offline-catalog"]),
    hiddenSessionCatalogLabels: {
      read: () => new Map([["claude", "Claude Code"]]),
      scope: null,
    },
  });

  const heading = Array.from(v.all("h3")).find(
    (candidate) => candidate.textContent?.trim() === "Hidden session sections",
  );
  const labeledRow = v.row("Claude Code");
  const fallbackRow = v.row("offline-catalog");
  expect(heading).toBeDefined();
  expect(labeledRow).toBeDefined();
  expect(fallbackRow).toBeDefined();
  labeledRow?.querySelector<HTMLButtonElement>("button")?.click();
  expect(v.props.setSessionCatalogHidden).toHaveBeenCalledWith("claude", false);
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
    const v = appearance({
      lobsterPetVisits: true,
      lobsterPetSounds: true,
      lobsterdexHref: "/settings/lobsterdex",
      onOpenLobsterdex,
    });

    const seen = v.q(".lobster-pet--palette-crimson");
    const seenTooltip = seen?.closest("openclaw-tooltip");
    expect(seen?.hasAttribute("title")).toBe(false);
    expect(seen?.getAttribute("aria-label")).toContain("Ruby ✦");
    expect(seenTooltip?.querySelector('[slot="content"]')?.textContent).toContain(
      "The classic red, first in every tide pool.",
    );
    expect(seenTooltip?.querySelector('[slot="content"]')?.textContent).toContain(
      new Date(firstSeenAt).toLocaleDateString(),
    );

    const unseen = v.q(".lobster-pet--palette-watermelon");
    expect(unseen?.getAttribute("aria-label")).toContain("Ripe when thumped.");
    expect(
      unseen?.closest("openclaw-tooltip")?.querySelector('[slot="content"]')?.textContent,
    ).toContain("Ripe when thumped.");

    const openLink = v.q<HTMLAnchorElement>(".lobsterdex__open");
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

const catalog = (...themes: ThemeCatalogEntry[]) => ({ error: null, themes });
const theme = (
  id: ThemeCatalogEntry["id"],
  name: string,
  overrides: Partial<ThemeCatalogEntry> = {},
): ThemeCatalogEntry => ({
  id,
  name,
  description: "Test theme",
  source: "user",
  modes: ["dark"],
  ...overrides,
});
const themeButton = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLButtonElement>(`[data-theme-id="${id}"]`);

it("hides the collection and visit controls without changing their saved preferences", () => {
  const { container, props } = renderAppearance({
    theme: "user/quiet",
    themeCatalog: catalog(theme("user/quiet", "Quiet", { lobsterdex: false })),
    lobsterPetVisits: true,
    lobsterPetSounds: true,
    lobsterdexHref: "/settings/lobsterdex",
  });
  expect(container.querySelector(".lobsterdex__gallery, .lobsterdex__open")).toBeNull();
  expect(container.textContent).not.toContain("Lobster visits");
  expect(container.textContent).not.toContain("Lobster sounds");
  expect(props).toMatchObject({ lobsterPetVisits: true, lobsterPetSounds: true });
  expect(props.onAppearanceChange).not.toHaveBeenCalled();
});

it("offers plugin and personal themes from the shared catalog with their descriptions", () => {
  const setTheme = vi.fn();
  const { container } = renderAppearance({
    setTheme,
    themeCatalog: catalog(
      ...BUILTIN_THEMES,
      theme("space-pack/xenovessel", "Xenovessel", {
        description: "Alien theme",
        source: "plugin",
        pluginId: "space-pack",
      }),
      theme("user/candlelight", "Candlelight", {
        modes: ["light"],
      }),
    ),
  });
  const pluginTheme = themeButton(container, "space-pack/xenovessel");
  expect(pluginTheme?.title).toBe("Alien theme");
  pluginTheme?.click();
  expect(setTheme).toHaveBeenCalledWith("space-pack/xenovessel");
  expect(themeButton(container, "user/candlelight")?.textContent).toContain("Candlelight");
});

it.each(["profile", "device-local"] as const)(
  "shows Claw presentation while preserving an unavailable %s plugin selection",
  async (provenance) => {
    const missingTheme = "space-pack/xenovessel";
    const { container, props } = renderAppearance({
      theme: missingTheme,
      fontUiProvenance: "profile",
      themeOverridden: true,
      themeProvenance: provenance,
      themeCatalog: {
        ...catalog(...BUILTIN_THEMES),
        ...(provenance === "profile" ? { unavailableId: missingTheme } : {}),
      },
    });
    await updatePickers(container);
    expect(
      container.querySelector("#settings-font-ui")?.closest(".settings-row")?.textContent,
    ).toContain("Saved to your profile");
    expect(container.textContent).toContain(
      `${missingTheme} is unavailable. Using Claw until the theme becomes available again.`,
    );
    const claw = themeButton(container, "claw");
    expect(claw?.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector('[data-accent-preset="default"]')?.classList).toContain(
      "settings-accent-theme--claw",
    );
    for (const slot of ["ui", "chat"]) {
      const picker = await openPicker(container.querySelector(`#settings-font-${slot}`)!);
      expect(picker?.querySelector('[role="option"][data-value="theme"]')?.textContent).toContain(
        "Claw · Instrument Sans",
      );
    }
    expect(props.theme).toBe(missingTheme);
    claw?.click();
    expect(props.setTheme).toHaveBeenCalledWith("claw");
  },
);

it("offers an explicit retry when the theme catalog cannot load", () => {
  const onRetryThemeCatalog = vi.fn();
  const { container } = renderAppearance({
    themeCatalog: { themes: [...BUILTIN_THEMES], error: "Theme palette temporarily unavailable" },
    onRetryThemeCatalog,
  });
  const error = container.querySelector('[role="alert"]');
  expect(error?.textContent).toContain("Theme palette temporarily unavailable");
  const retry = error?.querySelector<HTMLButtonElement>("button");
  expect(retry?.textContent?.trim()).toBe("Retry");
  retry?.click();
  expect(onRetryThemeCatalog).toHaveBeenCalledOnce();
});

function setupTabIcon(overrides: Partial<ConfigProps> = {}) {
  const v = appearance({ tabIcon: "default", ...overrides });
  const query = dom(v.q(".settings-tab-icon"));
  if (!overrides.setTabIconMode) {
    v.props.setTabIconMode = (tabIcon) => v.update({ tabIcon });
    v.update();
  }
  const radio = (value: string) =>
    query.q<HTMLInputElement>(`.settings-segmented__input[value="${value}"]`);
  const button = (label: string) => query.q<HTMLButtonElement>(`button[aria-label="${label}"]`);
  const selected = () => query.q<HTMLInputElement>(".settings-segmented__input:checked")?.value;
  const choices = (expected: string[]) =>
    expect(query.all(".settings-tab-icon__pick").map((item) => item.ariaPressed)).toEqual(expected);
  const preview = (mode: string) =>
    radio(mode)
      ?.closest("label")
      ?.querySelector(".identity-avatar--agent.settings-tab-icon__preview");
  return { ...v, ...query, radio, button, selected, choices, preview };
}
const palettes = (...ids: string[]) =>
  LOBSTER_PET_PALETTES.filter((palette) => ids.includes(palette.id));

it("selects the first unlock on entry and exposes pressed, keyboard-selectable lobster choices", async () => {
  const v = setupTabIcon({
    tabIconLobsters: palettes("crimson", "pixel"),
  });
  await userEvent.click(v.radio("lobster")!);
  expect(v.props.tabIcon).toBe("lobster:crimson");
  v.choices(["true", "false"]);
  const pixel = v.button("Sprite");
  pixel.focus();
  await userEvent.keyboard("{Enter}");
  expect(v.props.tabIcon).toBe("lobster:pixel");
  v.choices(["false", "true"]);
  await waitForSolid(() => expect(pixel.querySelector(".lob-pixel-frame")).not.toBeNull());
  expect(pixel.getAnimations({ subtree: true })).toHaveLength(0);
});

it("hides collected artwork without changing the saved preference and restores it when enabled", () => {
  const v = setupTabIcon({
    tabIcon: "lobster:crimson",
    lobsterdexEnabled: false,
    tabIconLobsters: palettes("crimson"),
    setTabIconMode: vi.fn(),
  });
  expect(v.radio("lobster")).toBeNull();
  expect(v.q(".settings-tab-icon__lobsters")).toBeNull();
  expect(v.container.textContent).not.toContain("Lobsterdex");
  expect(v.selected()).toBe("default");
  expect(v.props.tabIcon).toBe("lobster:crimson");
  expect(v.props.setTabIconMode).not.toHaveBeenCalled();

  v.update({ lobsterdexEnabled: true });
  expect(v.radio("lobster")).not.toBeNull();
  expect(v.selected()).toBe("lobster");
  expect(v.q('.settings-tab-icon__pick[aria-pressed="true"]')).not.toBeNull();
});

it("shows avatar shapes only for agent artwork and supports keyboard selection", async () => {
  const v = setupTabIcon({ tabIcon: "agent" });
  const agentPreview = v.preview("agent");
  expect(agentPreview).not.toBeNull();
  v.choices(["true", "false", "false"]);
  const circle = v.button("Circle");
  circle.focus();
  await userEvent.keyboard("{Enter}");
  expect(v.props.tabIcon).toBe("agent:circle");
  expect(v.button("Circle")).toBe(circle);
  expect(v.preview("agent")).toBe(agentPreview);
  v.choices(["false", "false", "true"]);
  expect(v.selected()).toBe("agent");
  await userEvent.click(v.button("Rounded corners"));
  expect(v.props.tabIcon).toBe("agent:rounded");
  v.props.setTabIconMode("default");
  expect(v.q(".settings-tab-icon__shapes")).toBeNull();
  v.props.setTabIconMode("lobster:crimson");
  expect(v.q(".settings-tab-icon__shapes")).toBeNull();
});

it("keeps unavailable saved choices and makes an empty collection quietly unavailable", () => {
  const v = setupTabIcon({
    tabIcon: "lobster:gold",
    setTabIconMode: vi.fn(),
  });
  expect(v.container.textContent).toContain("not unlocked in this browser");
  expect(v.all(".settings-tab-icon__pick")).toHaveLength(0);
  expect(v.selected()).toBe("lobster");
  expect(v.props.setTabIconMode).not.toHaveBeenCalled();
  v.update({ tabIcon: "default" });
  expect(v.container.textContent).toContain("No lobsters unlocked");
  expect(v.radio("lobster")?.disabled).toBe(true);
});

it("selects personal artwork while preserving its uncropped preview", async () => {
  const source = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32"><rect width="64" height="32" fill="blue"/></svg>')}`;
  const setTabIconMode = vi.fn();
  const v = setupTabIcon({ tabIconAgentAvatar: source, setTabIconMode });
  const agentRadio = v.radio("agent")!;
  const agent = agentRadio.closest("label")!;
  await userEvent.click(agentRadio);
  expect(setTabIconMode).toHaveBeenLastCalledWith("agent");
  await waitForSolid(() => expect(agent.querySelector(".identity-avatar__image")).not.toBeNull());
  const image = agent.querySelector<HTMLImageElement>(".identity-avatar__image")!;
  expect(image.getAttribute("src")).toBe(source);
  expect(getComputedStyle(image).objectFit).toBe("contain");
  expect(v.radio("default")?.closest("label")?.querySelector("img")?.getAttribute("src")).toContain(
    "favicon.svg",
  );
  v.update({ tabIcon: "agent", tabIconAgentAvatar: null });
  expect(v.selected()).toBe("agent");
  await waitForSolid(() => expect(agent.querySelector(".identity-avatar__image")).toBeNull());
  expect(agent.querySelector(".identity-avatar__fallback img")).not.toBeNull();
});
