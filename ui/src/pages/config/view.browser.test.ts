// Control UI tests cover config behavior.
import { render } from "lit";
import { beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import type { JsonSchema } from "../../components/config-form.shared.ts";
import { renderConfigForm } from "../../components/config-form.ts";
import "../../styles.css";
import type { SelectPicker } from "../../components/select-picker.ts";
import { warmJson5 } from "../../lib/json5-runtime.ts";
import { updatePickers, choosePickerValue } from "../../test-helpers/select-picker.ts";
import { renderBrowserLinkPreferencesRow } from "./browser-link-preferences.ts";
import { baseProps, renderAppearance, renderConfigView } from "./config-view.test-support.ts";
import { renderConfig, type ConfigProps } from "./view.ts";

function object(properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", properties };
}

function settingsRow(container: HTMLElement, title: string) {
  const row = [...container.querySelectorAll<HTMLElement>(".settings-row")].find(
    (candidate) => candidate.querySelector(".settings-row__title")?.textContent?.trim() === title,
  );
  if (!row) {
    throw new Error(`Missing settings row: ${title}`);
  }
  return row;
}

describe("config view", () => {
  // The view module warms the lazy JSON5 parser on load; tests assert the
  // steady state where raw diffs parse synchronously.
  beforeAll(async () => {
    await warmJson5();
  });

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

  it("keeps Setup collapsed on Advanced and edits consent without exposing machine state", () => {
    const wizard = {
      accessMode: "full",
      appRecommendations: true,
      lastRunAt: "2026-08-30T12:00:00Z",
      lastRunVersion: "2026.8.30",
      lastRunCommit: "abc1234",
      lastRunCommand: "onboard",
      lastRunMode: "local",
      securityAcknowledgedAt: "2026-08-29T12:00:00Z",
    };
    const schema = object({
      wizard: object(
        Object.fromEntries(
          Object.entries(wizard).map(([key, value]) => [
            key,
            key === "accessMode"
              ? { type: "string", enum: ["full", "guarded"] }
              : { type: typeof value },
          ]),
        ),
      ),
    });
    const onFormPatch = vi.fn();
    const { container, props } = renderConfigView({
      schema,
      formValue: { wizard },
      forceShowAdvanced: true,
      settingsLayout: "accordion",
      onFormPatch,
    });
    document.body.append(container);
    onTestFinished(() => container.remove());
    const setup = required(container, "#config-section-wizard", HTMLDetailsElement);
    expect(setup.open).toBe(false);
    setup.open = true;
    expect(setup.textContent).toContain(wizard.lastRunVersion);
    expect(setup.textContent).not.toContain(wizard.securityAcknowledgedAt);
    expect(
      setup.querySelectorAll(
        "input:not(.settings-toggle__input):not(.settings-segmented__input), textarea, select",
      ),
    ).toHaveLength(0);
    expect(onFormPatch).not.toHaveBeenCalled();
    setup.querySelector<HTMLInputElement>('.settings-segmented__input[value="1"]')!.click();
    expect(onFormPatch).toHaveBeenCalledWith(["wizard", "accessMode"], "guarded");
    const toggle = setup.querySelector<HTMLInputElement>(".settings-toggle__input")!;
    expect(toggle.checked).toBe(true);
    toggle.click();
    expect(onFormPatch).toHaveBeenLastCalledWith(["wizard", "appRecommendations"], false);
    expect(props.formValue).toEqual({ wizard });

    const defaults = renderConfigView({
      schema,
      formValue: {},
      activeSection: "wizard",
      forceAdvancedSection: "wizard",
      forceShowAdvanced: true,
    });
    expect(required(defaults.container, "#config-section-wizard", HTMLDetailsElement).open).toBe(
      true,
    );
    expect(
      defaults.container.querySelector<HTMLInputElement>(".settings-segmented__input:checked")
        ?.value,
    ).toBe("0");
    expect(
      defaults.container.querySelector<HTMLInputElement>(".settings-toggle__input")?.checked,
    ).toBe(true);
    expect(defaults.props.onFormPatch).not.toHaveBeenCalled();
  });

  it.each([
    { systemLocale: "pt-BR", localeOverride: undefined, label: "Português (Brazilian Portuguese)" },
    { systemLocale: "de", localeOverride: "fr", label: "Deutsch (German)" },
  ] as const)(
    "renders and changes language with system locale $systemLocale",
    ({ systemLocale, localeOverride, label }) => {
      const { container, props } = renderAppearance({
        systemLocale,
        localeOverride,
        localeOverridden: Boolean(localeOverride),
      });
      const sections = [...container.querySelectorAll<HTMLElement>(".settings-section")];
      expect(sections[0]?.id).toBe("settings-language");
      expect(sections[0]?.textContent).toContain("Language");
      expect(sections[0]?.textContent).toContain("Synced across your devices through the gateway");
      const select = container.querySelector<HTMLElement & { value: string }>(
        "#settings-language wa-select",
      );
      expect(select).not.toBeNull();
      if (!select) {
        throw new Error("Missing language select");
      }
      if (localeOverride) {
        expect(
          select.querySelector<HTMLElement & { selected: boolean }>('wa-option[value="fr"]')
            ?.selected,
        ).toBe(true);
      } else {
        expect(select.value).toBe("system");
      }
      expect(select.querySelector('wa-option[value="system"]')?.textContent).toContain(
        `System (${label})`,
      );
      for (const value of ["fr", "system"]) {
        Object.defineProperty(select, "value", { configurable: true, value });
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
      expect(props.onLocaleChange).toHaveBeenCalledWith("fr");
      expect(props.onLocaleChange).toHaveBeenCalledWith(undefined);
    },
  );

  function findOptionalButtonByText(
    container: HTMLElement,
    text: string,
  ): HTMLButtonElement | undefined {
    return Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === text,
    );
  }

  function normalizedText(container: HTMLElement): string {
    return container.textContent?.replace(/\s+/g, " ").trim() ?? "";
  }

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
    expect(ui.querySelector('[role="option"][data-value="theme"]')?.textContent).toContain(
      "Dash · DM Sans",
    );
    expect(chat.querySelector('[role="option"][data-value="theme"]')?.textContent).toContain(
      "Dash · Fraunces",
    );
    expect(ui.closest(".settings-row")?.textContent).toContain("Saved to your profile");
    expect(ui.querySelectorAll('[role="option"]')).toHaveLength(11);
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

  it("places a Control UI Browser preference in the same settings group before schema rows", () => {
    const { container } = renderConfigView({
      schema: object({
        browser: {
          type: "object",
          title: "Browser",
          properties: {
            enabled: { type: "boolean", title: "Browser Enabled" },
          },
        },
      }),
      uiHints: { "browser.enabled": { advanced: false } },
      formValue: { browser: { enabled: true } },
      activeSection: "browser",
      sectionPrelude: renderBrowserLinkPreferencesRow({
        enabled: false,
        onChange: vi.fn(),
      }),
    });

    const groups = container.querySelectorAll("#config-section-browser .settings-group");
    expect(groups).toHaveLength(1);
    expect(
      [...groups[0]!.querySelectorAll(".settings-row__title")].map((node) =>
        node.textContent?.trim(),
      ),
    ).toEqual(["Open links in Control UI browser", "Browser Enabled"]);
  });

  it("routes scalar clears and default selections through config callbacks", () => {
    const { container, props } = renderConfigView({
      schema: object({
        gateway: {
          type: "object",
          title: "Gateway",
          properties: {
            retries: { type: "integer", title: "Retries", default: 3 },
            mode: {
              type: "string",
              title: "Mode",
              default: "balanced",
              enum: ["balanced", "fast", "careful", "safe", "strict", "custom"],
            },
          },
        },
      }),
      uiHints: {
        "gateway.retries": { advanced: false },
        "gateway.mode": { advanced: false },
      },
      formValue: { gateway: { retries: 9, mode: "custom" } },
      activeSection: "gateway",
    });

    const retriesRow = Array.from(container.querySelectorAll<HTMLElement>(".settings-row")).find(
      (row) => row.textContent?.includes("Retries"),
    );
    const retries = required(retriesRow ?? container, "input", HTMLInputElement);
    retries.value = "";
    retries.dispatchEvent(new Event("input", { bubbles: true }));
    expect(props.onFormRemove).toHaveBeenCalledWith(["gateway", "retries"]);
    expect(props.onFormPatch).not.toHaveBeenCalled();

    const modeRow = Array.from(container.querySelectorAll<HTMLElement>(".settings-row")).find(
      (row) => row.textContent?.includes("Mode"),
    );
    const select = required(modeRow ?? container, "select", HTMLSelectElement);
    expect(select.selectedOptions[0]?.textContent?.trim()).toBe("custom");
    select.value = "__unset__";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(props.onFormRemove).toHaveBeenCalledWith(["gateway", "mode"]);
  });

  it("uses one inline advanced disclosure without mutating config fields", () => {
    const schema = object({
      gateway: object({
        port: { type: "integer", title: "Port" },
        reload: { type: "string", title: "Reload mode" },
      }),
    });
    const uiHints = {
      "gateway.port": { advanced: false },
      "gateway.reload": { advanced: true },
    };
    const renderCase = (overrides: Partial<ConfigProps> = {}) =>
      renderConfigView({
        schema,
        uiHints,
        formValue: { gateway: { port: 18789, reload: "hybrid" } },
        activeSection: "gateway",
        ...overrides,
      });
    const collapsed = renderCase();

    const disclosure = required(
      collapsed.container,
      "details.config-advanced-disclosure",
      HTMLDetailsElement,
    );
    expect(disclosure.open).toBe(false);
    expect(required(disclosure, "summary", HTMLElement).textContent?.trim()).toBe(
      "Advanced settings",
    );
    expect(normalizedText(collapsed.container)).not.toContain("Reload mode");
    disclosure.open = true;
    disclosure.dispatchEvent(new Event("toggle"));
    expect(collapsed.props.onAppearanceChange).toHaveBeenCalledWith({ showAdvancedSettings: true });

    for (const overrides of [
      { showAdvancedSettings: true },
      { forceAdvancedSection: "gateway" },
      { forceShowAdvanced: true },
    ]) {
      const { container, props } = renderCase(overrides);
      const expanded = required(
        container,
        "details.config-advanced-disclosure",
        HTMLDetailsElement,
      );
      expect(expanded.open).toBe(true);
      expect(normalizedText(container)).toContain("Reload mode");
      if (overrides.showAdvancedSettings) {
        expanded.open = false;
        expanded.dispatchEvent(new Event("toggle"));
        expect(props.onAppearanceChange).toHaveBeenCalledWith({ showAdvancedSettings: false });
      }
      if (overrides.forceShowAdvanced) {
        expect(findOptionalButtonByText(container, "Show advanced")).toBeUndefined();
      }
    }

    const nested = document.createElement("div");
    render(
      renderConfigForm({
        schema: object({
          agents: object({
            defaults: object({ tuning: { type: "boolean" } }),
          }),
        }),
        uiHints: { "agents.defaults.tuning": { advanced: true } },
        value: { agents: { defaults: { tuning: true } } },
        activeSection: "agents",
        activeSubsection: "defaults",
        forceAdvancedSection: "agents",
        onShowAdvanced: vi.fn(),
        onPatch: vi.fn(),
      }),
      nested,
    );
    expect(required(nested, "details.config-advanced-disclosure", HTMLDetailsElement).open).toBe(
      true,
    );
    expect(normalizedText(nested)).toContain("Tuning");
  });

  it("offers the toggle exactly when the active scope can hide advanced fields", () => {
    const schema = object({
      gateway: object({ mode: { type: "string", title: "Mode" } }),
      diagnostics: object({ flags: { type: "string", title: "Flags" } }),
    });

    // Unhinted leaves default to the advanced tier, so the inline disclosure
    // must remain available even when no hint carries advanced === true.
    const unhinted = renderConfigView({
      schema,
      uiHints: {},
      formValue: { diagnostics: { flags: "all" } },
      activeSection: "diagnostics",
    });
    expect(findOptionalButtonByText(unhinted.container, "Show advanced")).toBeUndefined();
    expect(unhinted.container.querySelector("details.config-advanced-disclosure")).not.toBeNull();

    // An advanced hint in a different top-level section must not surface a
    // no-op toggle on a fully-common active section.
    const offScope = renderConfigView({
      schema,
      uiHints: {
        "gateway.mode": { advanced: false },
        "diagnostics.flags": { advanced: true },
      },
      formValue: { gateway: { mode: "local" } },
      activeSection: "gateway",
    });
    expect(findOptionalButtonByText(offScope.container, "Show advanced")).toBeUndefined();
    expect(offScope.container.querySelector("details.config-advanced-disclosure")).toBeNull();
  });

  it("shows the form-unsafe banner only for populated unsupported paths", () => {
    const schema = object({
      gateway: object({
        opaque: {
          title: "Opaque setting",
          anyOf: [{ type: "string" }, {}],
        },
      }),
      agents: object({
        opaque: { anyOf: [{ type: "string" }, {}] },
      }),
    });

    const empty = renderConfigView({
      schema,
      formValue: { gateway: {}, agents: { opaque: "off-scope" } },
      activeSection: "gateway",
    });
    expect(empty.container.querySelector(".config-content-callout .info")).toBeNull();
    expect(findButtonByText(empty.container, "Form").getAttribute("title")).toBe("");

    const onFormModeChange = vi.fn();
    const populated = renderConfigView({
      schema,
      formValue: {
        gateway: { opaque: "custom" },
        agents: { opaque: "off-scope" },
      },
      activeSection: "gateway",
      onFormModeChange,
    });
    const banner = required(
      populated.container,
      ".config-content-callout .callout.info",
      HTMLElement,
    );
    expect(normalizedText(banner)).toBe(
      "1 setting in this config can only be edited as text: gateway.opaque Open Raw editor",
    );
    expect(banner.querySelector("code")?.textContent).toBe("gateway.opaque");
    expect(findButtonByText(populated.container, "Form").getAttribute("title")).toBe(
      "Form view can't safely edit some fields",
    );
    findButtonByText(banner, "Open Raw editor").click();
    expect(onFormModeChange).toHaveBeenCalledWith("raw");
    render(renderConfig({ ...populated.props, formMode: "raw" }), populated.container);
    expect(normalizedText(populated.container)).not.toContain(
      "1 setting in this config can only be edited as text",
    );
    expect(populated.container.querySelector(".config-raw-field")).not.toBeNull();
  });

  function findButtonByText(container: HTMLElement, text: string): HTMLButtonElement {
    const button = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === text,
    );
    if (!button) {
      throw new Error(`Expected button with text "${text}"`);
    }
    return button;
  }

  function findButtonContainingText(container: HTMLElement, text: string): HTMLButtonElement {
    const button = Array.from(container.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes(text),
    );
    if (!button) {
      throw new Error(`Expected button containing text "${text}"`);
    }
    return button;
  }

  function sectionTabLabels(container: HTMLElement): Array<string | undefined> {
    return Array.from(container.querySelectorAll(".config-toolbar .hub-tab")).map((tab) =>
      tab.textContent?.trim(),
    );
  }

  function selectConfigTab(container: HTMLElement, name: string) {
    const tab = required(container, `#config-sections-tab-${name}`, HTMLElement);
    tab.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
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

  it("keeps explicit open/save/discard controls in raw mode", () => {
    const onSave = vi.fn();
    const onRawDiscard = vi.fn();
    const onOpenFile = vi.fn();
    const { container, props } = renderConfigView({
      formMode: "raw",
      raw: '{\n  gateway: { mode: "remote" }\n}\n',
      originalRaw: '{\n  gateway: { mode: "local" }\n}\n',
      onSave,
      onRawDiscard,
      onOpenFile,
    });

    expect(findButtonByText(container, "Form").getAttribute("aria-pressed")).toBe("false");
    expect(findButtonByText(container, "Raw").getAttribute("aria-pressed")).toBe("true");
    const actions = required(container, ".config-raw-actions", HTMLElement);
    expect(
      [...actions.querySelectorAll("button")].map((button) => button.textContent?.trim()),
    ).toEqual(["Open", "Discard", "Save"]);
    findButtonContainingText(actions, "Open").click();
    findButtonByText(actions, "Discard").click();
    findButtonByText(actions, "Save").click();
    expect(onOpenFile).toHaveBeenCalledTimes(1);
    expect(onRawDiscard).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledTimes(1);
    render(renderConfig({ ...props, formMode: "form" }), container);
    expect(container.querySelector(".config-diff")).toBeNull();
    expect(findButtonByText(container, "Form").getAttribute("aria-pressed")).toBe("true");
    expect(findButtonByText(container, "Raw").getAttribute("aria-pressed")).toBe("false");
    findButtonByText(container, "Raw").click();
    expect(props.onFormModeChange).toHaveBeenCalledWith("raw");
  });

  it("pins the raw editor while an unsaved raw draft is authoritative", () => {
    const { container } = renderConfigView({
      formMode: "form",
      rawDraftPending: true,
      raw: '{\n  "a": 1\n}\n',
      originalRaw: "{\n}\n",
    });

    // The capability refuses form submissions until the raw draft is saved or
    // discarded, so the raw actions stay on screen and Form remains gated.
    expect(container.querySelector(".config-raw-actions")).not.toBeNull();
    const formButton = findButtonByText(container, "Form");
    const rawButton = findButtonByText(container, "Raw");
    expect(formButton.disabled).toBe(true);
    expect(formButton.getAttribute("aria-pressed")).toBe("false");
    expect(rawButton.getAttribute("aria-pressed")).toBe("true");
  });

  it.each(["clean", "saving", "applying"] as const)(
    "locks editor controls while %s",
    (operation) => {
      const { container } = renderConfigView({
        formMode: operation === "applying" ? "form" : "raw",
        raw: operation === "clean" ? "{}" : '{ gateway: { mode: "remote" } }',
        originalRaw: "{}",
        saving: operation === "saving",
        applying: operation === "applying",
        schema: object({ gateway: object({ mode: { type: "string" } }) }),
        uiHints: { "gateway.mode": { advanced: false } },
        formValue: { gateway: { mode: "remote" } },
      });
      if (operation === "applying") {
        expect(container.querySelector(".config-content input")?.hasAttribute("disabled")).toBe(
          true,
        );
      } else if (operation === "clean") {
        expect(findButtonByText(container, "Save").disabled).toBe(true);
        expect(findButtonByText(container, "Discard").disabled).toBe(true);
      } else {
        const button = findButtonContainingText(container, "Saving…");
        expect(button.disabled).toBe(true);
        expect(button.getAttribute("aria-busy")).toBe("true");
        expect(button.querySelectorAll(".config-action-spinner")).toHaveLength(1);
        expect(
          required(container, ".config-raw-field textarea", HTMLTextAreaElement).disabled,
        ).toBe(true);
      }
    },
  );

  it("forces Form mode and disables Raw mode when raw text is unavailable", () => {
    const { container, props } = renderConfigView({
      formMode: "raw",
      rawAvailable: false,
      schema: object({
        gateway: object({
          mode: { type: "string" },
        }),
      }),
      formValue: { gateway: { mode: "local" } },
    });

    const formButton = findButtonByText(container, "Form");
    const rawButton = findButtonByText(container, "Raw");
    expect(formButton.getAttribute("aria-pressed")).toBe("true");
    expect(rawButton.getAttribute("aria-pressed")).toBe("false");
    expect(rawButton.disabled).toBe(true);
    expect(rawButton.getAttribute("title")).toBe("Raw mode unavailable for this snapshot");
    expect(container.querySelector(".config-raw-field")).toBeNull();

    rawButton.click();
    expect(props.onFormModeChange).not.toHaveBeenCalled();
  });

  it("renders section tabs and switches sections from the sidebar", () => {
    const onSectionChange = vi.fn();
    const { container, props } = renderConfigView({
      onSectionChange,
      schema: object({ gateway: object({}), agents: object({}) }),
    });

    expect(sectionTabLabels(container)).toEqual(["Settings", "Agents", "Gateway", "Theme"]);
    expect(container.querySelector("wa-tab-group.hub-tabs")).not.toBeNull();
    expect(container.querySelector(".config-layout")).toBeNull();
    expect(container.querySelector("#config-section-panel")?.getAttribute("role")).toBe("tabpanel");
    expect(container.querySelector("#config-section-panel")?.getAttribute("aria-labelledby")).toBe(
      "config-sections-tab-root",
    );

    selectConfigTab(container, "gateway");
    expect(onSectionChange).toHaveBeenCalledWith("gateway");

    onSectionChange.mockClear();
    const active = container.querySelector(".config-toolbar .hub-tab[active]");
    expect(active?.textContent?.trim()).toBe("Settings");
    selectConfigTab(container, "agents");
    expect(onSectionChange).toHaveBeenCalledWith("agents");

    render(renderConfig({ ...props, activeSection: "agents" }), container);
    onSectionChange.mockClear();
    selectConfigTab(container, "root");
    expect(onSectionChange).toHaveBeenCalledWith(null);
  });

  it("exposes accordion category disclosure state and its controlled panel", () => {
    const overrides: Partial<ConfigProps> = {
      settingsLayout: "accordion",
      includeVirtualSections: false,
      includeSections: ["env"],
      schema: object({
        env: object({}),
      }),
    };
    const collapsed = renderConfigView(overrides);
    const collapsedHeader = required(
      collapsed.container,
      ".config-accordion-group__header",
      HTMLButtonElement,
    );
    const controlledPanelId = collapsedHeader.getAttribute("aria-controls");
    const collapsedPanel = required(collapsed.container, `#${controlledPanelId}`, HTMLDivElement);

    expect(collapsedHeader.getAttribute("aria-expanded")).toBe("false");
    expect(controlledPanelId).not.toBeNull();
    expect(collapsedPanel.hidden).toBe(true);

    const expanded = renderConfigView({ ...overrides, activeSection: "env" });
    const expandedHeader = required(
      expanded.container,
      ".config-accordion-group__header",
      HTMLButtonElement,
    );
    expect(expandedHeader.getAttribute("aria-expanded")).toBe("true");
    expect(expandedHeader.getAttribute("aria-controls")).toBe(controlledPanelId);
    expect(required(expanded.container, `#${controlledPanelId}`, HTMLDivElement).hidden).toBe(
      false,
    );
    expect(
      required(
        expanded.container,
        ".config-accordion-group__item--active",
        HTMLButtonElement,
      ).getAttribute("aria-current"),
    ).toBe("true");
    expect(
      collapsed.container
        .querySelector(".config-accordion-group__item")
        ?.hasAttribute("aria-current"),
    ).toBe(false);
  });

  it("renders the virtual Notifications tab on Notifications settings", () => {
    const onSectionChange = vi.fn();
    const { container, props } = renderConfigView({
      navRootLabel: "Notifications",
      includeSections: ["__notifications__"],
      includeVirtualSections: true,
      onSectionChange,
      schema: object({}),
      formValue: {},
      webPush: {
        supported: true,
        permission: "default",
        subscription: "missing",
        loading: false,
      },
    });

    expect(sectionTabLabels(container)).toContain("Notifications");

    selectConfigTab(container, "__notifications__");
    expect(onSectionChange).toHaveBeenCalledWith("__notifications__");
    const onWebPushSubscribe = vi.fn();
    Object.assign(props, {
      activeSection: "__notifications__",
      showModeToggle: false,
      showRootTab: false,
      onWebPushSubscribe,
    });
    render(renderConfig(props), container);
    const card = required(container, "#settings-communications-notifications", HTMLElement);
    expect(container.querySelector(".config-toolbar")).toBeNull();
    expect(container.textContent).not.toContain("Saved");
    expect(
      card.querySelector(".settings-section__actions .settings-status")?.textContent?.trim(),
    ).toBe("Ready");

    const enableButton = findButtonByText(container, "Enable notifications");
    expect(enableButton.classList.contains("btn")).toBe(true);
    expect(enableButton.classList.contains("primary")).toBe(true);
    expect(container.querySelector(".config-bar__btn")).toBeNull();

    enableButton.click();
    expect(onWebPushSubscribe).toHaveBeenCalledOnce();
  });

  it.each(["tabs", "accordion"] as const)(
    "groups channel settings without changing patch paths (%s)",
    (settingsLayout) => {
      const { container, props } = renderConfigView({
        activeSection: "channels",
        settingsLayout,
        forceShowAdvanced: true,
        schema: object({
          channels: {
            type: "object",
            additionalProperties: true,
            properties: {
              telegram: object({ username: { type: "string", title: "Bot username" } }),
              "custom-chat": {
                anyOf: [object({ room: { type: "string", title: "Room" } }), { type: "null" }],
              },
              defaults: object({ groupPolicy: { type: "string", title: "Group policy" } }),
              modelByChannel: {
                type: "object",
                additionalProperties: {
                  type: "object",
                  additionalProperties: { type: "string" },
                },
              },
            },
          },
        }),
        uiHints: {
          "channels.telegram": { label: "Telegram" },
          "channels.custom-chat": { label: "Custom Chat" },
          "channels.modelByChannel": { label: "Channel Model Overrides" },
        },
        formValue: {
          channels: {
            telegram: { username: "test_bot" },
            "custom-chat": { room: "team" },
            defaults: { groupPolicy: "allowlist" },
            modelByChannel: {},
          },
        },
      });
      document.body.append(container);
      try {
        const picker = required(container, "select", HTMLSelectElement);
        expect(picker.labels?.[0]?.textContent).toContain("Channel settings");
        expect(Array.from(picker.options, (option) => option.textContent?.trim())).toEqual([
          "Custom Chat",
          "Telegram",
          "Other",
        ]);
        expect(picker.selectedOptions[0]?.textContent?.trim()).toBe("Other");
        const content = () => normalizedText(required(container, ".settings-page", HTMLElement));
        expect(content()).toContain("Group policy");
        expect(content()).toContain("Channel Model Overrides");
        expect(content()).not.toContain("Bot username");
        props.onSubsectionChange = (key) => {
          props.activeSubsection = key;
          render(renderConfig(props), container);
        };
        render(renderConfig(props), container);
        const choose = (key: string) => {
          picker.value = key;
          picker.dispatchEvent(new Event("change", { bubbles: true }));
        };
        choose("telegram");
        expect(content()).toContain("Bot username");
        expect(content()).not.toContain("Group policy");
        expect(content()).not.toContain("Room");
        const username = required(container, 'input[type="text"]', HTMLInputElement);
        expect(username.value).toBe("test_bot");
        username.value = "updated_bot";
        username.dispatchEvent(new Event("input", { bubbles: true }));
        expect(props.onFormPatch).toHaveBeenCalledWith(
          ["channels", "telegram", "username"],
          "updated_bot",
        );
        choose("custom-chat");
        expect(content()).toContain("Room");
        expect(content()).not.toContain("Bot username");
        choose("");
        const policy = required(container, 'input[type="text"]', HTMLInputElement);
        policy.value = "open";
        policy.dispatchEvent(new Event("input", { bubbles: true }));
        expect(props.onFormPatch).toHaveBeenCalledWith(
          ["channels", "defaults", "groupPolicy"],
          "open",
        );
        render(renderConfig({ ...props, formMode: "raw" }), container);
        expect(container.querySelector("select")).toBeNull();
      } finally {
        container.remove();
      }
    },
  );

  it.each(["section", "mode"] as const)(
    "resets config content scroll on %s changes",
    async (trigger) => {
      const { container, props } = renderConfigView({
        activeSection: "channels",
        navRootLabel: "Communication",
        includeSections: ["channels", "messages"],
        schema: object({
          channels: object({ telegram: { type: "string" } }),
          messages: object({ inbox: { type: "string" } }),
        }),
        uiHints: { "channels.telegram": { advanced: false } },
        formValue: { channels: { telegram: "on" }, messages: { inbox: "smart" } },
      });
      document.body.append(container);
      try {
        const content = required(container, ".config-content", HTMLElement);
        content.scrollTop = 280;
        content.scrollLeft = 24;
        const scrollTo = vi.fn((options?: ScrollToOptions | number, y?: number) => {
          content.scrollTop =
            typeof options === "number"
              ? (y ?? content.scrollTop)
              : (options?.top ?? content.scrollTop);
          content.scrollLeft =
            typeof options === "number" ? options : (options?.left ?? content.scrollLeft);
        });
        content.scrollTo = scrollTo;
        if (trigger === "section") {
          selectConfigTab(container, "messages");
        } else {
          render(renderConfig({ ...props, formMode: "raw" }), container);
        }
        await Promise.resolve();
        expect(scrollTo).toHaveBeenCalledOnce();
        expect(scrollTo).toHaveBeenCalledWith({ top: 0, left: 0, behavior: "auto" });
        expect(content.scrollTop).toBe(0);
        expect(content.scrollLeft).toBe(0);
      } finally {
        container.remove();
      }
    },
  );

  it("can hide the root tab for scoped settings surfaces", () => {
    const { container } = renderConfigView({
      activeSection: "messages",
      navRootLabel: "Communication",
      showRootTab: false,
      showSectionDocs: false,
      uiHints: { messages: { docsUrl: "https://docs.openclaw.ai/concepts/messages" } },
      includeSections: ["channels", "messages"],
      schema: object({
        channels: object({}),
        messages: object({}),
      }),
    });

    expect(sectionTabLabels(container)).toEqual(["Channels", "Messages"]);
    expect(container.querySelector(".settings-section__help-button")).toBeNull();
  });

  it("does not normalize off-scope schema sections for scoped config tabs", () => {
    const offScopeSchema = { type: "object" } as Record<string, unknown>;
    Object.defineProperty(offScopeSchema, "properties", {
      get() {
        throw new Error("off-scope schema was normalized");
      },
    });

    const { container } = renderConfigView({
      activeSection: "channels",
      navRootLabel: "Communication",
      includeSections: ["channels"],
      schema: object({
        channels: object({
          telegram: { type: "string", title: "Telegram" },
        }),
        models: offScopeSchema,
      }),
      uiHints: { "channels.telegram": { advanced: false } },
      formValue: {
        channels: { telegram: "enabled" },
        models: {},
      },
    });

    expect(
      Array.from(container.querySelectorAll(".settings-row__title")).map((label) =>
        label.textContent?.trim(),
      ),
    ).toEqual(["Telegram"]);
  });

  it.each(["auth", null])("keeps section headings outside groups for %s", (activeSection) => {
    const { container } = renderConfigView({
      activeSection,
      schema: object({
        auth: object({ order: { type: "object" } }),
        gateway: object({}),
      }),
      uiHints: { "auth.order": { advanced: false } },
      formValue: { auth: { order: {} }, gateway: {} },
    });
    const headings = [
      ...container.querySelectorAll(
        ".settings-section > .settings-section__header .settings-section__heading",
      ),
    ].map((heading) => heading.textContent?.trim());
    expect(headings).toEqual(activeSection ? ["Authentication"] : ["Authentication", "Gateway"]);
    expect(container.querySelector("#config-section-auth .settings-group")).not.toBeNull();
    expect(container.querySelector(".settings-group .settings-section__heading")).toBeNull();
  });

  it("keeps sensitive raw config hidden until reveal before editing", () => {
    const onRawChange = vi.fn();
    const { container } = renderConfigView({
      formMode: "raw",
      raw: '{\n  "openai": { "apiKey": "supersecret" }\n}\n',
      originalRaw: '{\n  "openai": { "apiKey": "supersecret" }\n}\n',
      formValue: {
        openai: {
          apiKey: "supersecret",
        },
      },
      onRawChange,
    });

    expect(
      required(container, ".config-raw-field .settings-count", HTMLElement)
        .textContent?.replace(/\s+/g, " ")
        .trim(),
    ).toBe("1 secret redacted");
    expect(
      required(container, ".config-raw-field .callout.info", HTMLElement)
        .textContent?.replace(/\s+/g, " ")
        .trim(),
    ).toBe("1 sensitive value hidden. Use the reveal button above to edit the raw config.");
    expect(container.querySelector("textarea")).toBeNull();

    const revealButton = required(container, ".config-raw-toggle", HTMLButtonElement);
    expect(revealButton.getAttribute("aria-pressed")).toBe("false");
    revealButton.click();

    const textarea = required(container, "textarea", HTMLTextAreaElement);
    expect(textarea.value).toBe('{\n  "openai": { "apiKey": "supersecret" }\n}\n');
    textarea.value = textarea.value.replace("supersecret", "updatedsecret");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onRawChange).toHaveBeenCalledWith(textarea.value);
  });

  it("opens raw pending changes without sending a fake raw edit", () => {
    const container = document.createElement("div");
    const onRawChange = vi.fn();
    let updateCount = 0;
    const props: ConfigProps = {
      ...baseProps(),
      formMode: "raw",
      raw: '{\n  gateway: { mode: "remote" }\n}\n',
      originalRaw: '{\n  gateway: { mode: "local" }\n}\n',
      formValue: {
        gateway: {
          mode: "remote",
        },
      },
      onRawChange,
    };
    const rerender = () =>
      render(
        renderConfig({
          ...props,
          onViewStateChange: () => {
            updateCount += 1;
            rerender();
          },
        }),
        container,
      );
    rerender();

    const details = required(container, ".config-diff", HTMLDetailsElement);
    expect(details.querySelector(".config-diff__summary span")?.textContent?.trim()).toBe(
      "View pending changes",
    );
    expect(details.querySelector(".config-diff__item")?.textContent?.trim()).toBe(
      "Changes detected (JSON diff not available)",
    );
    details.open = true;
    details.dispatchEvent(new Event("toggle"));

    expect(updateCount).toBe(1);
    expect(onRawChange).not.toHaveBeenCalled();
    const item = required(container, ".config-diff__item", HTMLElement);
    expect(item.querySelector(".config-diff__path")?.textContent?.trim()).toBe("gateway.mode");
    expect(item.querySelector(".config-diff__from")?.textContent?.trim()).toBe('"local"');
    expect(item.querySelector(".config-diff__to")?.textContent?.trim()).toBe('"remote"');
    props.raw = props.originalRaw;
    props.formValue = { gateway: { mode: "local" } };
    rerender();
    expect(container.querySelector(".config-diff")).toBeNull();
  });

  it.each([
    {
      path: "channels.discord.token.id",
      hint: "channels.discord.token",
      before: { channels: { discord: { token: { id: "TOKEN_BEFORE" } } } },
      after: { channels: { discord: { token: { id: "TOKEN_AFTER" } } } },
    },
    {
      path: "integrations.foo.bar.credential",
      hint: "integrations.*.credential",
      before: { integrations: { "foo.bar": { credential: "TOKEN_BEFORE" } } },
      after: { integrations: { "foo.bar": { credential: "TOKEN_AFTER" } } },
    },
  ])("redacts pending changes under $hint until revealed", ({ path, hint, before, after }) => {
    const { container } = renderConfigView({
      formMode: "raw",
      raw: JSON.stringify(after),
      originalRaw: JSON.stringify(before),
      uiHints: { [hint]: { sensitive: true, advanced: false } },
      formValue: after,
    });
    const details = required(container, ".config-diff", HTMLDetailsElement);
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    const item = required(container, ".config-diff__item", HTMLElement);
    expect(item.querySelector(".config-diff__path")?.textContent?.trim()).toBe(path);
    for (const selector of [".config-diff__from", ".config-diff__to"]) {
      expect(item.querySelector(selector)?.textContent?.trim()).toBe(
        "[redacted - click reveal to view]",
      );
    }
    required(container, ".config-raw-toggle", HTMLButtonElement).click();
    expect(item.querySelector(".config-diff__from")?.textContent?.trim()).toBe('"TOKEN_BEFORE"');
    expect(item.querySelector(".config-diff__to")?.textContent?.trim()).toBe('"TOKEN_AFTER"');
  });

  it("resets raw reveal state when the config context changes", () => {
    const container = document.createElement("div");
    const props: ConfigProps = {
      ...baseProps(),
      configPath: "/tmp/openclaw-a.json5",
      formMode: "raw",
      raw: '{\n  token: "TOKEN_A_AFTER"\n}\n',
      originalRaw: '{\n  token: "TOKEN_A_BEFORE"\n}\n',
      uiHints: {
        token: { sensitive: true },
      },
      formValue: {
        token: "TOKEN_A_AFTER",
      },
    };
    const rerender = () =>
      render(
        renderConfig({
          ...props,
          onViewStateChange: rerender,
        }),
        container,
      );
    rerender();

    const details = required(container, ".config-diff", HTMLDetailsElement);
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    const revealButton = required(container, ".config-raw-toggle", HTMLButtonElement);
    revealButton.click();
    const revealedItem = required(container, ".config-diff__item", HTMLElement);
    expect(revealedItem.querySelector(".config-diff__path")?.textContent?.trim()).toBe("token");
    expect(revealedItem.querySelector(".config-diff__from")?.textContent?.trim()).toBe(
      '"TOKEN_A_BEFORE"',
    );
    expect(revealedItem.querySelector(".config-diff__to")?.textContent?.trim()).toBe(
      '"TOKEN_A_AFTER"',
    );

    props.configPath = "/tmp/openclaw-b.json5";
    props.raw = '{\n  token: "TOKEN_B_AFTER"\n}\n';
    props.originalRaw = '{\n  token: "TOKEN_B_BEFORE"\n}\n';
    props.formValue = {
      token: "TOKEN_B_AFTER",
    };
    rerender();

    expect(
      required(container, ".config-raw-field .settings-count", HTMLElement)
        .textContent?.replace(/\s+/g, " ")
        .trim(),
    ).toBe("1 secret redacted");
    expect(
      required(container, ".config-raw-field .callout.info", HTMLElement)
        .textContent?.replace(/\s+/g, " ")
        .trim(),
    ).toBe("1 sensitive value hidden. Use the reveal button above to edit the raw config.");
    expect(container.querySelector("textarea")).toBeNull();
    const nextDetails = required(container, ".config-diff", HTMLDetailsElement);
    expect(nextDetails.open).toBe(false);

    nextDetails.open = true;
    nextDetails.dispatchEvent(new Event("toggle"));
    const redactedItem = required(container, ".config-diff__item", HTMLElement);
    expect(redactedItem.querySelector(".config-diff__path")?.textContent?.trim()).toBe("token");
    expect(redactedItem.querySelector(".config-diff__from")?.textContent?.trim()).toBe(
      "[redacted - click reveal to view]",
    );
    expect(redactedItem.querySelector(".config-diff__to")?.textContent?.trim()).toBe(
      "[redacted - click reveal to view]",
    );
  });

  it("renders structured SecretRef values without stringifying", () => {
    const secretRefSchema = object({
      channels: object({
        discord: object({
          token: { type: "string" as const },
        }),
      }),
    });
    const secretRefValue = {
      channels: {
        discord: {
          token: { source: "env", provider: "default", id: "__OPENCLAW_REDACTED__" },
        },
      },
    };
    const { container, props } = renderConfigView({
      schema: secretRefSchema,
      uiHints: {
        "channels.discord.token": { sensitive: true, advanced: false },
      },
      formMode: "form",
      formValue: secretRefValue,
    });

    const input = required(container, ".settings-input", HTMLInputElement);
    expect(input.readOnly).toBe(true);
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("Structured value (SecretRef) - use Raw mode to edit");
    input.value = "[object Object]";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(props.onFormPatch).not.toHaveBeenCalled();

    render(renderConfig({ ...props, rawAvailable: false, formMode: "raw" }), container);

    const rawUnavailableInput = required(container, ".settings-input", HTMLInputElement);
    expect(rawUnavailableInput.placeholder).toBe(
      "Structured value (SecretRef) - edit the config file directly",
    );
  });

  it("keeps malformed non-SecretRef object values editable when raw mode is unavailable", () => {
    const { container, props } = renderConfigView({
      rawAvailable: false,
      formMode: "raw",
      schema: object({
        gateway: object({
          mode: { type: "string" },
        }),
      }),
      uiHints: { "gateway.mode": { advanced: false } },
      formValue: {
        gateway: {
          mode: { malformed: true },
        },
      },
    });

    const input = container.querySelector<HTMLInputElement>(".settings-input");
    expect(input).toBeInstanceOf(HTMLInputElement);
    expect(input?.readOnly).toBe(false);
    expect(input?.value).toBe('{  "malformed": true}');
    expect(input?.value).not.toBe("[object Object]");
    expect(input?.placeholder).toBe("");

    if (!input) {
      return;
    }
    input.value = "local";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(props.onFormPatch).toHaveBeenCalledWith(["gateway", "mode"], "local");
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
    props.customThemeImportFocusToken = 1;
    render(renderConfig(props), container);
    const importButton = findButtonContainingText(container, "Import theme");

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
    render(renderConfig(props), container);
    const importedButton = findButtonByText(container, "Light Green");
    expect(importedButton.disabled).toBe(false);
    importedButton.click();
    expect(props.setTheme).toHaveBeenCalledWith("custom");

    const replaceButton = findButtonContainingText(container, "Replace Light Green");
    const clearButton = findButtonContainingText(container, "Clear Light Green");
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
    input.dispatchEvent(new Event("input"));
    expect(props.onCustomThemeImportUrlChange).toHaveBeenCalledWith(
      "/r/themes/cmlhfpjhw000004l4f4ax3m7z",
    );
    props.theme = "custom";
    render(renderConfig(props), container);
    expect(findButtonByText(container, "Light Green").getAttribute("aria-pressed")).toBe("true");
    expect(findButtonByText(container, "Claw").getAttribute("aria-pressed")).toBe("false");
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

    expect(findButtonByText(container, "Knot").getAttribute("aria-pressed")).toBe("true");
    expect(findButtonByText(container, "Claw").getAttribute("aria-pressed")).toBe("false");
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
    const themeSection = required(container, "#settings-appearance-theme", HTMLElement);
    const shortcutRow = settingsRow(container, "Send shortcut");

    expect(normalizedText(themeSection)).toContain("Default: Claw");
    expect(normalizedText(themeSection)).toContain("Default: System");
    expect(shortcutRow?.textContent).toContain("Default: Enter");
    findButtonByText(themeSection, "Claw").click();
    themeSection
      .querySelector<HTMLInputElement>('.settings-segmented__input[value="system"]')
      ?.click();

    expect(props.setTheme).toHaveBeenCalledWith("claw");
    expect(props.setThemeMode).toHaveBeenCalledWith("system");
  });

  it("renders rejected theme and locale edits as browser-only fallbacks", () => {
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
    expect(
      (
        languageRow.querySelector('wa-option[value="fr"]') as HTMLElement & {
          selected: boolean;
        }
      ).selected,
    ).toBe(true);
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

  it.each([
    {
      title: "Collapse task progress by default on desktop",
      preference: "chatCollapseTaskProgress",
      checked: false,
    },
    {
      title: "Show live agent activity in sidebar",
      preference: "sidebarLiveActivity",
      checked: true,
    },
  ] as const)("changes the browser-local $title toggle", ({ title, preference, checked }) => {
    const { container, props } = renderAppearance();
    document.body.append(container);
    onTestFinished(() => container.remove());
    const row = settingsRow(container, title);
    expect(row.querySelector<HTMLInputElement>(".settings-toggle__input")?.checked).toBe(checked);
    row.click();
    expect(props.onAppearanceChange).toHaveBeenCalledWith({ [preference]: !checked });
    expect(row.textContent).not.toContain("Using default:");
    expect(row.textContent).toContain("Stored in this browser only");
  });

  it("names the chat preference selects for assistive tech", () => {
    const onMicrophoneRefresh = vi.fn();
    const onCameraRefresh = vi.fn();
    const { container } = renderAppearance({
      microphone: {
        devices: [{ deviceId: "mic-1", label: "Desk Mic" }],
        permissionRequired: false,
        selectedDeviceId: "mic-1",
        loading: false,
        error: null,
      },
      onMicrophoneSelect: vi.fn(),
      onMicrophoneRefresh,
      camera: {
        devices: [{ deviceId: "camera-1", label: "Desk Camera" }],
        permissionRequired: false,
        selectedDeviceId: "camera-1",
        loading: false,
        error: null,
      },
      onCameraSelect: vi.fn(),
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
        loading,
        permissionRequired: true,
        selectedDeviceId: "",
        error: null,
      };
      const { container } = renderAppearance(
        device === "camera"
          ? { camera: state, onCameraSelect: vi.fn(), onCameraRefresh: onRefresh }
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
    render(renderConfig(props), container);
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
      hiddenSessionCatalogLabels: new Map([["claude", "Claude Code"]]),
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
