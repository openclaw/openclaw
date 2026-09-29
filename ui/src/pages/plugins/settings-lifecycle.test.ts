/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { createInspectResult, createPlugin, createResult } from "./plugins-page.test-support.ts";
import type { PluginSettingsEditor } from "./settings-editor.ts";
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

it("keeps observed blockers actionable for a read-only operator", () => {
  const onReviewPermissions = vi.fn();
  const configPath = "plugins.entries.workboard.hooks.allowConversationAccess";
  const container = mount({
    onReviewPermissions,
    canEditConfig: false,
    mutationBlockedReason: "Plugin changes require operator.admin access.",
    result: createResult(
      createPlugin({
        enabled: true,
        state: "enabled",
        runtime: {
          state: "active",
          blockedHooks: [
            {
              pluginId: "workboard",
              pluginName: "Workboard",
              hookName: "before_prompt_build",
              configPath,
              reason: "conversation-access-missing",
              severity: "warn",
              message: "Host refused registration",
            },
          ],
        },
      }),
    ),
  });
  expect(container.textContent).toContain("Limited functionality");
  expect(container.textContent).toContain("before_prompt_build");
  expect(container.textContent).toContain(configPath);
  expect(container.textContent).toContain("operator.admin");
  const review = Array.from(container.querySelectorAll("button")).find((button) =>
    button.textContent?.includes("Review permissions"),
  );
  expect(review?.disabled).toBe(false);
  review!.click();
  expect(onReviewPermissions).toHaveBeenCalledExactlyOnceWith("workboard", configPath);
});

it.each([
  {
    configSaveStatus: "saving" as const,
    configNeedsApply: true,
    configRevisionApplied: false,
    expected: "applying",
  },
  {
    configSaveStatus: "idle" as const,
    configNeedsApply: false,
    configRevisionApplied: true,
    expected: "applied",
  },
  {
    configSaveStatus: "error" as const,
    configApplying: true,
    expected: "applying",
  },
  {
    configSaveStatus: "saved" as const,
    configNeedsApply: true,
    configRevisionApplied: false,
    expected: "saved",
  },
  {
    configSaveStatus: "saved" as const,
    configNeedsApply: false,
    configRevisionApplied: false,
    expected: "saved",
  },
  {
    configSaveStatus: "error" as const,
    configNeedsApply: true,
    configRevisionApplied: false,
    expected: "failed",
  },
  {
    configSaveStatus: "conflict" as const,
    configNeedsApply: false,
    configRevisionApplied: true,
    expected: "failed",
  },
  {
    configSaveStatus: "saved" as const,
    configNeedsApply: false,
    configRevisionApplied: true,
    expected: "applied",
  },
  {
    configSaveStatus: "saved" as const,
    configNeedsApply: false,
    configRevisionApplied: true,
    configDirty: true,
    expected: "saved",
  },
])(
  "does not confuse persistence or supersession with application: $expected $configSaveStatus",
  async ({ expected, ...state }) => {
    const container = mount({ tab: "configuration", inspection: createInspectResult(), ...state });
    const editor = container.querySelector<PluginSettingsEditor>(
      "openclaw-plugin-settings-editor",
    )!;
    await editor.updateComplete;
    expect(editor.querySelector("[data-apply-state]")?.getAttribute("data-apply-state")).toBe(
      expected,
    );
  },
);

it.each([
  { name: "saved failure", props: {}, enabled: true },
  { name: "read-only", props: { canApplyConfig: false }, enabled: false },
  { name: "applying", props: { configBusy: true }, enabled: false },
])(
  "uses explicit application rather than replaying a saved patch: $name",
  async ({ props, enabled }) => {
    const onConfigApply = vi.fn();
    const onConfigWriteRetry = vi.fn();
    const container = mount({
      tab: "configuration",
      inspection: createInspectResult(),
      configError: "The permission was saved, but plugin activation failed.",
      configSaveStatus: "error",
      configNeedsApply: true,
      configDirty: false,
      canApplyConfig: true,
      onConfigApply,
      onConfigWriteRetry,
      ...props,
    });
    const editor = container.querySelector<PluginSettingsEditor>(
      "openclaw-plugin-settings-editor",
    )!;
    await editor.updateComplete;
    const button = editor.querySelector<HTMLButtonElement>('[role="alert"] button')!;
    expect(button.textContent).toBe("Apply saved settings");
    expect(button.disabled).toBe(!enabled);
    button.click();
    expect(onConfigApply).toHaveBeenCalledTimes(enabled ? 1 : 0);
    expect(onConfigWriteRetry).not.toHaveBeenCalled();
  },
);

it("does not describe a policy inspection as the applied runtime after a saved failure", async () => {
  const inspection = createInspectResult();
  inspection.grants.hooks.allowConversationAccess.effective = false;
  const container = mount({
    tab: "configuration",
    inspection,
    configValue: {
      plugins: { entries: { workboard: { hooks: { allowConversationAccess: true } } } },
    },
    hostControlsSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        hooks: {
          type: "object",
          additionalProperties: false,
          properties: { allowConversationAccess: { type: "boolean" } },
        },
      },
    },
    configSaveStatus: "error",
    configNeedsApply: true,
    configError: "Plugin activation failed after saving.",
  });
  const editor = container.querySelector<PluginSettingsEditor>("openclaw-plugin-settings-editor")!;
  await editor.updateComplete;
  expect(editor.textContent).toContain("Configured: Allow");
  expect(editor.textContent).toContain("Last inspected policy: Deny");
  expect(editor.textContent).not.toContain("Active runtime:");
  expect(editor.querySelector('[data-apply-state="failed"]')).not.toBeNull();
});
