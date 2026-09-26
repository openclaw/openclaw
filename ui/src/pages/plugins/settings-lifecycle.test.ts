/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { createInspectResult, createPlugin, createResult } from "./plugins-page.test-support.ts";
import { renderPluginSettingsDetail, type DetailProps } from "./settings-view.ts";

beforeEach(() => i18n.setLocale("en"));
afterEach(() => document.body.replaceChildren());

function mount(overrides: Partial<DetailProps>) {
  const props: DetailProps = {
    connected: true,
    loading: false,
    result: createResult(),
    error: null,
    busy: {},
    messages: {},
    iconUrls: {},
    canMutate: true,
    mutationBlockedReason: null,
    configBusy: false,
    configSchemaLoading: false,
    configError: null,
    canEditConfig: true,
    configValue: {},
    configHints: {},
    configUnsupportedPaths: [],
    pluginId: "workboard",
    inspection: null,
    inspectionError: null,
    configSchema: null,
    hostControlsSchema: null,
    backHref: "/settings/plugins",
    backLabel: "Plugins",
    tab: "readme",
    onBack: vi.fn(),
    onRetryInspection: vi.fn(),
    onTabChange: vi.fn(),
    onIconError: vi.fn(),
    onSetEnabled: vi.fn(),
    onUninstall: vi.fn(),
    onConfigPatch: vi.fn(),
    onConfigRemove: vi.fn(),
    onConfigReload: vi.fn(),
    onConfigReadRetry: vi.fn(),
    onConfigWriteRetry: vi.fn(),
    onRefresh: vi.fn(),
    ...overrides,
  };
  const container = document.createElement("div");
  document.body.append(container);
  render(renderPluginSettingsDetail(props), container);
  return container;
}

it.each([
  { id: "bundled", origin: "bundled", enabled: false },
  { id: "configured", origin: "config", enabled: true },
  { id: "failed", origin: "global", state: "error" as const },
  { id: "offer", installed: false, state: "not-installed" as const },
])("offers enablement and Settings for installed plugins: $id", (overrides) => {
  const plugin = createPlugin(overrides);
  const onSetEnabled = vi.fn();
  const onTabChange = vi.fn();
  const container = mount({
    result: createResult(plugin),
    pluginId: plugin.id,
    onSetEnabled,
    onTabChange,
  });
  const button = container.querySelector<HTMLButtonElement>(
    `[aria-label="${plugin.enabled ? "Disable" : "Enable"} ${plugin.name}"]`,
  );
  expect(Boolean(button)).toBe(plugin.installed);
  button?.click();
  expect(onSetEnabled.mock.calls).toEqual(
    plugin.installed ? [[plugin.id, !plugin.enabled, `plugin:${plugin.id}`]] : [],
  );
  container.querySelector<HTMLAnchorElement>('[aria-label="Settings"]')?.click();
  expect(onTabChange.mock.calls).toEqual(plugin.installed ? [["configuration"]] : []);
  expect(container.querySelector(".plugins-reload")).toBeNull();
});

it.each([
  {
    name: "read-only operator",
    props: {
      canMutate: false,
      mutationBlockedReason: "Plugin changes require operator.admin access.",
    },
  },
  { name: "busy plugin", props: { busy: { "plugin:workboard": "enable" as const } } },
  {
    name: "missing setup",
    props: { result: createResult(createPlugin({ state: "needs-setup" })) },
  },
])("does not dispatch enablement for $name", ({ props }) => {
  const onSetEnabled = vi.fn();
  const container = mount({ ...props, onSetEnabled });
  const button = container.querySelector<HTMLButtonElement>('[aria-label="Enable Workboard"]')!;
  expect(button).not.toBeNull();
  expect(button.disabled || button.getAttribute("aria-disabled") === "true").toBe(true);
  button.click();
  expect(onSetEnabled).not.toHaveBeenCalled();
});

it("keeps disconnected plugin settings from dispatching enablement", () => {
  const onSetEnabled = vi.fn();
  const container = mount({ connected: false, canMutate: false, onSetEnabled });
  expect(container.textContent).toContain("Connect");
  expect(container.querySelector('[aria-label="Enable Workboard"]')).toBeNull();
  expect(onSetEnabled).not.toHaveBeenCalled();
});

it("gives host permissions the setting menu and preserves configured, inherited, and read-only values", async () => {
  const onPatch = vi.fn();
  const onRemove = vi.fn();
  const onAsk = vi.fn();
  const props: Partial<DetailProps> = {
    tab: "configuration",
    inspection: createInspectResult(),
    configValue: { plugins: { entries: { workboard: { hooks: { timeoutMs: 5000 } } } } },
    hostControlsSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        hooks: {
          type: "object",
          additionalProperties: false,
          properties: {
            allowPromptInjection: { type: "boolean" },
            allowConversationAccess: { type: "boolean" },
            timeoutMs: { type: "integer", title: "Timeout", minimum: 1 },
          },
        },
        llm: {
          type: "object",
          additionalProperties: false,
          properties: {
            allowedModels: { type: "array", title: "Allowed models", items: { type: "string" } },
          },
        },
      },
    },
    onConfigPatch: onPatch,
    onConfigRemove: onRemove,
    onAskSetting: onAsk,
  };
  const container = mount(props);
  const editor = container.querySelector("openclaw-plugin-settings-editor") as HTMLElement & {
    updateComplete: Promise<unknown>;
  };
  await editor.updateComplete;
  const row = container.querySelector('[data-setting="hooks.allowPromptInjection"]')!;
  expect(row).not.toBeNull();
  expect(row.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
  expect(row.querySelector("wa-dropdown-item[value=reset]")?.hasAttribute("disabled")).toBe(true);
  row
    .querySelector("wa-dropdown")!
    .dispatchEvent(new CustomEvent("wa-select", { detail: { item: { value: "ask" } } }));
  expect(onAsk).toHaveBeenCalledWith(
    expect.objectContaining({
      path: ["plugins", "entries", "workboard", "hooks", "allowPromptInjection"],
      value: true,
      label: "Add context to prompts",
    }),
  );
  row.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
  expect(onPatch).toHaveBeenCalledWith(
    ["plugins", "entries", "workboard", "hooks", "allowPromptInjection"],
    false,
  );
  const timeout = container.querySelector('[data-setting="hooks.timeoutMs"] wa-dropdown')!;
  timeout.dispatchEvent(new CustomEvent("wa-select", { detail: { item: { value: "reset" } } }));
  expect(onRemove).toHaveBeenCalledWith(["plugins", "entries", "workboard", "hooks", "timeoutMs"]);
  expect(container.querySelector('[data-setting="llm.allowedModels"] wa-dropdown')).not.toBeNull();
  expect(container.textContent).not.toContain("Declared capabilities");
  expect(container.textContent).not.toContain("Your grants");
  onPatch.mockClear();
  const readOnly = mount({ ...props, canEditConfig: false });
  await (readOnly.querySelector("openclaw-plugin-settings-editor") as typeof editor).updateComplete;
  const readOnlyInput = readOnly.querySelector<HTMLInputElement>(
    '[data-setting="hooks.allowPromptInjection"] input',
  )!;
  expect(readOnlyInput.disabled).toBe(true);
  readOnlyInput.click();
  expect(onPatch).not.toHaveBeenCalled();
});

it.each([false, true])(
  "shows selected capabilities without a catalog while enabled=%s",
  (enabled) => {
    const inspection = createInspectResult();
    inspection.declared = {
      ...inspection.declared,
      tools: ["speech_status"],
      providers: ["local-model", "sibling-model"],
      channels: ["local-channel", "sibling-channel"],
      contracts: ["speechProviders: local-speech", "videoGenerationProviders: sibling-video"],
    };
    inspection.overview = {
      capabilities: {
        providers: ["local-model"],
        channels: ["local-channel"],
        contracts: { speechProviders: ["local-speech", "local-speech-alias"] },
        ui: ["page"],
      },
    };
    const container = mount({ inspection, result: createResult(createPlugin({ enabled })) });
    const titles = [...container.querySelectorAll(".plugin-capabilities h2")].map(
      (heading) => heading.textContent,
    );
    expect(titles).toEqual(["Capabilities2", "Tools1"]);
    expect(container.textContent).toContain("Text to speech");
    expect(container.textContent).toContain("Pages");
    expect(container.textContent).not.toContain("speechProviders:");
    expect(container.textContent).not.toContain("sibling-");
    expect(container.textContent).not.toContain("Video generation");
  },
);
