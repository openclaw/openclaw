/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { CUSTODIAN_PANEL_TOGGLE_EVENT } from "../../components/panel-toggle-contract.ts";
import { createContext } from "../custodian/custodian-page.test-harness.ts";
import { currentPluginHelpReference, pendingPluginHelpDraft } from "../custodian/plugin-help.ts";
import { PluginHelpController } from "./plugin-help-controller.ts";
import type { PluginsPageViewModel } from "./plugins-page-view.ts";
import type { PluginSettingsField } from "./settings-editor.ts";

afterEach(() => {
  window.history.replaceState({}, "", "/");
  vi.restoreAllMocks();
});

it.each(["plugin", "route", "connection", "disconnect"])(
  "ignores a retained setting action after its %s changes",
  async (change) => {
    const { context, setPathname, setGatewayToken } = createContext(vi.fn());
    setPathname("/settings/plugins/first");
    const controller = new PluginHelpController({
      addController: vi.fn(),
      removeController: vi.fn(),
      requestUpdate: vi.fn(),
      updateComplete: Promise.resolve(true),
    });
    const model = (id: string) =>
      ({
        context,
        connected: true,
        result: { plugins: [{ id, name: id, installed: true }] },
        detail: { pluginId: id },
        installedDetailTab: "configuration",
      }) as unknown as PluginsPageViewModel;
    controller.update(model("first"));
    const ask = controller.ask.bind(controller);
    if (change === "plugin") {
      controller.update(model("second"));
    } else if (change === "route") {
      setPathname("/agents");
    } else if (change === "connection") {
      setGatewayToken("replacement-operator");
      controller.update(model("first"));
    } else {
      controller.hostDisconnected();
    }
    const toggled = vi.fn();
    window.addEventListener(CUSTODIAN_PANEL_TOGGLE_EVENT, toggled);
    try {
      await ask({
        path: ["plugins", "entries", "first", "config", "limit"],
        label: "Limit",
        value: 5,
        schema: { type: "number" },
        hints: {},
      } as PluginSettingsField);
      expect(toggled).not.toHaveBeenCalled();
      expect(pendingPluginHelpDraft(context)).toBe(false);
    } finally {
      window.removeEventListener(CUSTODIAN_PANEL_TOGGLE_EVENT, toggled);
      controller.hostDisconnected();
    }
  },
);

it("publishes the local plugin identity when its catalog entry has no package name", () => {
  const { context, setPathname } = createContext(vi.fn());
  setPathname("/plugins/local-entry");
  const controller = new PluginHelpController({
    addController: vi.fn(),
    removeController: vi.fn(),
    requestUpdate: vi.fn(),
    updateComplete: Promise.resolve(true),
  });
  controller.update({
    context,
    connected: true,
    catalogDetail: {
      result: {
        plugin: { local: { pluginId: "local-tool" }, catalog: { name: "Local tool" } },
        detail: { origin: "local" },
      },
    },
  } as unknown as PluginsPageViewModel);
  expect(currentPluginHelpReference(context)).toMatchObject({
    id: "local-tool",
    name: "Local tool",
  });
  controller.hostDisconnected();
});
