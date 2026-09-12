/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { createPlugin, createResult } from "./plugins-page.test-support.ts";
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
    pageNotice: null,
    iconUrls: {},
    canMutate: true,
    reloadBlockedReason: null,
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
    tab: "lifecycle",
    onBack: vi.fn(),
    onRetryInspection: vi.fn(),
    onTabChange: vi.fn(),
    onIconError: vi.fn(),
    onSetEnabled: vi.fn(),
    onUninstall: vi.fn(),
    onReload: vi.fn(),
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
])("offers backend Reload only for installed settings: $id", (overrides) => {
  const plugin = createPlugin(overrides);
  const onReload = vi.fn();
  const container = mount({ result: createResult(plugin), pluginId: plugin.id, onReload });
  const button = container.querySelector<HTMLButtonElement>(".plugins-reload");
  expect(Boolean(button)).toBe(plugin.installed);
  button?.click();
  expect(onReload.mock.calls).toEqual(plugin.installed ? [[plugin.id, `plugin:${plugin.id}`]] : []);
});

it.each([
  {
    name: "current capability unavailable",
    props: { reloadBlockedReason: "Reload is unavailable in the current Gateway runtime." },
  },
  {
    name: "read-only operator",
    props: {
      canMutate: false,
      reloadBlockedReason: "Plugin changes require operator.admin access.",
      mutationBlockedReason: "Plugin changes require operator.admin access.",
    },
  },
  { name: "busy plugin", props: { busy: { "plugin:workboard": true } } },
])("does not dispatch backend Reload for $name", ({ props }) => {
  const onReload = vi.fn();
  const container = mount({ ...props, onReload });
  const button = container.querySelector<HTMLButtonElement>(".plugins-reload")!;
  expect(button).not.toBeNull();
  expect(button.disabled || button.getAttribute("aria-disabled") === "true").toBe(true);
  button.click();
  expect(onReload).not.toHaveBeenCalled();
});

it("keeps disconnected plugin settings from dispatching Reload", () => {
  const onReload = vi.fn();
  const container = mount({ connected: false, canMutate: false, onReload });
  expect(container.textContent).toContain("Connect");
  expect(container.querySelector(".plugins-reload")).toBeNull();
  expect(onReload).not.toHaveBeenCalled();
});
