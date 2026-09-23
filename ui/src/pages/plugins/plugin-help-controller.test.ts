/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { CUSTODIAN_PANEL_TOGGLE_EVENT } from "../../components/panel-toggle-contract.ts";
import { createContext } from "../custodian/custodian-page.test-harness.ts";
import { currentPluginHelpReference, takePluginHelpDraft } from "../custodian/plugin-help.ts";
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
      expect(takePluginHelpDraft(context)).toBe("");
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
        detail: { origin: "local", skills: [], mcpServers: [] },
      },
    },
  } as unknown as PluginsPageViewModel);
  expect(currentPluginHelpReference(context)).toMatchObject({
    id: "local-tool",
    name: "Local tool",
  });
  controller.hostDisconnected();
});

it("publishes catalog declarations without turning a provider into a tool", () => {
  const { context, setPathname } = createContext(vi.fn());
  setPathname("/plugins/video");
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
        plugin: { local: {}, catalog: { name: "Video provider" } },
        detail: {
          packageName: "video-plugin",
          contracts: { videoGenerationProviders: ["video"] },
          providers: [],
          channels: [],
          skills: [],
          mcpServers: [],
          configuration: [{ name: "credential", sensitive: true }],
          readme: "Do not inject this document.",
        },
      },
    },
  } as unknown as PluginsPageViewModel);
  expect(currentPluginHelpReference(context)).toEqual({
    id: "video-plugin",
    name: "Video provider",
    installed: false,
    declared: {
      providers: [],
      channels: [],
      contracts: ["videoGenerationProviders: video"],
      skills: [],
      mcpServers: [],
    },
  });
  controller.hostDisconnected();
});

it.each([
  {
    path: ["plugins", "entries", "workboard", "hooks", "allowPromptInjection"],
    label: "Add context to prompts",
    value: true,
    expected: "true",
    sensitive: false,
  },
  {
    path: ["plugins", "entries", "workboard", "llm", "allowedModels"],
    label: "Allowed models",
    value: ["synthetic-sensitive-value"],
    expected: "<redacted>",
    sensitive: true,
  },
])(
  "keeps host setting paths intact and redacts sensitive Ask values: $label",
  async ({ path, label, value, expected, sensitive }) => {
    const { context, setPathname } = createContext(vi.fn());
    setPathname("/settings/plugins/workboard");
    const controller = new PluginHelpController({
      addController: vi.fn(),
      removeController: vi.fn(),
      requestUpdate: vi.fn(),
      updateComplete: Promise.resolve(true),
    });
    controller.update({
      context,
      connected: true,
      result: { plugins: [{ id: "workboard", name: "Workboard", installed: true }] },
      detail: { pluginId: "workboard" },
      installedDetailTab: "configuration",
    } as unknown as PluginsPageViewModel);
    try {
      await controller.ask({
        path,
        label,
        value,
        schema: {},
        hints: sensitive ? { [path.join(".")]: { sensitive: true } } : {},
      } as PluginSettingsField);
      expect(currentPluginHelpReference(context)?.setting?.path).toEqual(path);
      const draft = takePluginHelpDraft(context);
      expect(draft).toBe(`Explain ${label}\n\nCurrent value: ${expected}`);
      expect(draft).not.toContain("synthetic-sensitive-value");
    } finally {
      controller.hostDisconnected();
    }
  },
);

it("keeps catalog declarations while the installed inspection is pending", () => {
  const { context, setPathname } = createContext(vi.fn());
  setPathname("/plugins/workboard");
  const controller = new PluginHelpController({
    addController: vi.fn(),
    removeController: vi.fn(),
    requestUpdate: vi.fn(),
    updateComplete: Promise.resolve(true),
  });
  const model = {
    context,
    connected: true,
    result: { plugins: [] },
    detail: null,
    installedDetailTab: "readme",
    catalogDetail: {
      result: {
        plugin: { id: "catalog-workboard", local: {}, catalog: { name: "Workboard" } },
        detail: {
          packageName: "workboard",
          contracts: { tools: ["known_tool"] },
          skills: [],
          mcpServers: [],
        },
      },
    },
  } as unknown as PluginsPageViewModel;
  controller.update(model);
  expect(currentPluginHelpReference(context)?.declared?.tools).toEqual(["known_tool"]);
  controller.update({
    ...model,
    result: {
      plugins: [
        { id: "workboard", name: "Workboard", installed: true, catalogId: "catalog-workboard" },
      ],
    } as PluginsPageViewModel["result"],
    detail: { pluginId: "workboard", inspection: null },
  });
  expect(currentPluginHelpReference(context)).toMatchObject({
    id: "workboard",
    installed: true,
    declared: { tools: ["known_tool"] },
  });
  controller.hostDisconnected();
});
