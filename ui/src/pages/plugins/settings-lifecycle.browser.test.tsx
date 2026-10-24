import { createSignal, flush, type Setter } from "solid-js";
import { expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { i18n } from "../../i18n/index.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createInspectResult, createPlugin, createResult } from "./plugins-page.test-support.ts";
import {
  renderPluginSettingsDetail as PluginSettingsDetail,
  type DetailProps,
} from "./settings-view.tsx";
import "../../styles.css";
import "../../styles/settings.css";
import "../../styles/plugins.css";

it("retains focused lifecycle controls across settings reads and uses current mutation state", async () => {
  await i18n.setLocale("en");
  await page.viewport(1440, 900);
  const onUninstall = vi.fn();
  const onSetEnabled = vi.fn();
  const initial: DetailProps = {
    connected: true,
    loading: false,
    result: createResult(createPlugin({ removable: true })),
    error: null,
    busy: {},
    messages: {},
    iconUrls: {},
    canMutate: true,
    mutationBlockedReason: null,
    configBusy: false,
    configRead: undefined,
    configSchemaRead: undefined,
    configSchemaLoading: false,
    configError: null,
    canEditConfig: true,
    configValue: {},
    configHints: {},
    configUnsupportedPaths: [],
    pluginId: "workboard",
    inspection: null,
    inspectionRead: { receipt: () => null, value: () => null },
    configSchema: null,
    hostControlsSchema: null,
    backHref: "/settings/plugins",
    backLabel: "Plugins",
    tab: "readme",
    onBack: vi.fn(),
    onRetryInspection: vi.fn(),
    onTabChange: vi.fn(),
    onIconError: vi.fn(),
    onSetEnabled,
    onUninstall: vi.fn(),
    onConfigPatch: vi.fn(),
    onConfigRemove: vi.fn(),
    onConfigReload: vi.fn(),
    onConfigReadRetry: vi.fn(),
    onConfigWriteRetry: vi.fn(),
    onRefresh: vi.fn(),
  };
  let setProps!: Setter<DetailProps>;
  const { container } = mountSolid(() => {
    const [props, update] = createSignal(initial);
    setProps = update;
    return <PluginSettingsDetail {...props()} />;
  });
  flush();
  const uninstall = container.querySelector<HTMLButtonElement>(
    '[aria-label="Uninstall Workboard"]',
  )!;
  const enable = container.querySelector<HTMLButtonElement>('[aria-label="Enable Workboard"]')!;
  uninstall.focus();

  setProps((props) => ({
    ...props,
    inspection: createInspectResult(),
    configValue: { plugins: { entries: { workboard: { config: { label: "Updated" } } } } },
    onUninstall,
  }));
  flush();
  expect(container.querySelector('[aria-label="Uninstall Workboard"]')).toBe(uninstall);
  expect(uninstall.isConnected).toBe(true);
  expect(document.activeElement).toBe(uninstall);
  await userEvent.keyboard("{Enter}");
  expect(onUninstall).toHaveBeenCalledExactlyOnceWith("workboard", "plugin:workboard");
  expect(initial.onUninstall).not.toHaveBeenCalled();

  setProps((props) => ({ ...props, busy: { "plugin:workboard": "uninstall" } }));
  flush();
  expect(uninstall.disabled).toBe(true);
  expect(uninstall.getAttribute("aria-busy")).toBe("true");
  uninstall.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(onUninstall).toHaveBeenCalledTimes(1);

  setProps((props) => ({ ...props, busy: {}, canMutate: false }));
  flush();
  expect(uninstall.disabled).toBe(true);
  expect(uninstall.hasAttribute("aria-busy")).toBe(false);
  uninstall.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(onUninstall).toHaveBeenCalledTimes(1);

  setProps((props) => ({
    ...props,
    canMutate: true,
    result: createResult(createPlugin({ removable: true, enabled: true, state: "enabled" })),
  }));
  flush();
  expect(uninstall.disabled).toBe(false);
  expect(container.querySelector('[aria-label="Disable Workboard"]')).toBe(enable);
  enable.click();
  expect(onSetEnabled).toHaveBeenCalledExactlyOnceWith("workboard", false, "plugin:workboard");
});
