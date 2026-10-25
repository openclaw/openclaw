import { beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { ConfigForm as renderConfigForm } from "../../components/config-form.render.tsx";
import type { JsonSchema } from "../../components/config-form.shared.ts";
import { SettingsToggleRow } from "../../components/solid/settings-ui.tsx";
import { warmJson5 } from "../../lib/json5-runtime.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { renderConfigInto, renderConfigView } from "./config-view.test-support.tsx";
import type { ConfigProps } from "./view.tsx";
import "../../styles.css";

function object(properties: Record<string, JsonSchema>, title?: string): JsonSchema {
  return { type: "object", properties, ...(title ? { title } : {}) };
}

describe("config form and navigation", () => {
  // Raw diffs use the already-warmed parser, as in the complete view suite.
  beforeAll(async () => {
    await warmJson5();
  });

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

  function findButtonByText(container: HTMLElement, text: string): HTMLButtonElement {
    const button = findOptionalButtonByText(container, text);
    if (!button) {
      throw new Error(`Expected button with text "${text}"`);
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

  function disclosure(container: HTMLElement) {
    return required(container, "details.config-advanced-disclosure", HTMLDetailsElement);
  }

  function accordionHeader(container: HTMLElement) {
    return required(container, ".config-accordion-group__header", HTMLButtonElement);
  }

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

  it("places a Control UI Browser preference in the same settings group before schema rows", () => {
    const { container } = renderConfigView({
      schema: object({
        browser: object({ enabled: { type: "boolean", title: "Browser Enabled" } }, "Browser"),
      }),
      uiHints: { "browser.enabled": { advanced: false } },
      formValue: { browser: { enabled: true } },
      activeSection: "browser",
      sectionPrelude: (
        <SettingsToggleRow
          title={t("browserLinkPreferences.openInControlUi")}
          checked={false}
          onChange={vi.fn()}
        />
      ),
    });

    const groups = container.querySelectorAll("#config-section-browser .settings-group");
    expect(groups).toHaveLength(1);
    expect(
      [...groups[0]!.querySelectorAll(".settings-row__title")].map((node) =>
        node.textContent?.trim(),
      ),
    ).toEqual(["Open links in Control UI browser", "Browser Enabled"]);
  });

  it("honors advanced disclosure overrides and subsection scope", () => {
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
    for (const overrides of [
      { showAdvancedSettings: true },
      { forceAdvancedSection: "gateway" },
      { forceShowAdvanced: true },
    ]) {
      const { container, props } = renderCase(overrides);
      const expanded = disclosure(container);
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
    mountSolid(
      () =>
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
      { container: nested },
    );
    expect(disclosure(nested).open).toBe(true);
    expect(normalizedText(nested)).toContain("Tuning");
  });

  it("offers the toggle exactly when the active scope can hide advanced fields", () => {
    const schema = object({
      gateway: object({ mode: { type: "string", title: "Mode" } }),
      diagnostics: object({ flags: { type: "string", title: "Flags" } }),
    });

    const unhinted = renderConfigView({
      schema,
      uiHints: {},
      formValue: { diagnostics: { flags: "all" } },
      activeSection: "diagnostics",
    });
    expect(findOptionalButtonByText(unhinted.container, "Show advanced")).toBeUndefined();
    expect(unhinted.container.querySelector("details.config-advanced-disclosure")).not.toBeNull();

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

  it("renders section tabs and switches sections from the sidebar", () => {
    const onSectionChange = vi.fn();
    const { container, props } = renderConfigView({
      onSectionChange,
      schema: object({ gateway: object({}), agents: object({}) }),
    });

    expect(sectionTabLabels(container)).toEqual(["Settings", "Agents", "Gateway", "Theme"]);
    expect(container.querySelector(".hub-tabs")).not.toBeNull();
    expect(container.querySelector(".config-layout")).toBeNull();
    expect(container.querySelector("#config-section-panel")?.getAttribute("role")).toBe("tabpanel");
    expect(container.querySelector("#config-section-panel")?.getAttribute("aria-labelledby")).toBe(
      "config-sections-tab-root",
    );

    selectConfigTab(container, "gateway");
    expect(onSectionChange).toHaveBeenCalledWith("gateway");

    onSectionChange.mockClear();
    const active = container.querySelector('.config-toolbar .hub-tab[aria-selected="true"]');
    expect(active?.textContent?.trim()).toBe("Settings");
    selectConfigTab(container, "agents");
    expect(onSectionChange).toHaveBeenCalledWith("agents");

    renderConfigInto({ ...props, activeSection: "agents" }, container);
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
    const collapsedHeader = accordionHeader(collapsed.container);
    const controlledPanelId = collapsedHeader.getAttribute("aria-controls");
    const collapsedPanel = required(collapsed.container, `#${controlledPanelId}`, HTMLDivElement);

    expect(collapsedHeader.getAttribute("aria-expanded")).toBe("false");
    expect(controlledPanelId).not.toBeNull();
    expect(collapsedPanel.hidden).toBe(true);

    const expanded = renderConfigView({ ...overrides, activeSection: "env" });
    const expandedHeader = accordionHeader(expanded.container);
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
        canManage: true,
        canReadPreferences: true,
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
    renderConfigInto(props, container);
    const enableButton = findButtonByText(container, "Enable notifications");
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
      onTestFinished(() => container.remove());
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
        renderConfigInto(props, container);
      };
      renderConfigInto(props, container);
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
      renderConfigInto({ ...props, formMode: "raw" }, container);
      expect(container.querySelector("select")).toBeNull();
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
      onTestFinished(() => container.remove());
      const content = required(container, ".config-content", HTMLElement);
      content.scrollTop = 280;
      content.scrollLeft = 24;
      const scrollTo = vi.fn((options?: ScrollToOptions | number, y?: number) => {
        const target = typeof options === "number" ? { top: y, left: options } : options;
        content.scrollTop = target?.top ?? content.scrollTop;
        content.scrollLeft = target?.left ?? content.scrollLeft;
      });
      content.scrollTo = scrollTo;
      if (trigger === "section") {
        selectConfigTab(container, "messages");
      } else {
        renderConfigInto({ ...props, formMode: "raw" }, container);
      }
      await Promise.resolve();
      expect(scrollTo).toHaveBeenCalledOnce();
      expect(scrollTo).toHaveBeenCalledWith({ top: 0, left: 0, behavior: "auto" });
      expect(content.scrollTop).toBe(0);
      expect(content.scrollLeft).toBe(0);
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
});
