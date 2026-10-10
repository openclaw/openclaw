/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { CUSTODIAN_PANEL_TOGGLE_EVENT } from "../../components/panel-toggle-contract.ts";
import { createContext } from "../custodian/custodian-page.test-harness.ts";
import { currentPluginHelpReference, takePluginHelpDraft } from "../custodian/plugin-help.ts";
import { PluginHelpController } from "./plugin-help-controller.ts";
import type { PluginsPageViewModel } from "./plugins-page-view.ts";
import { createDiscoveryDetail, createPlugin, createResult } from "./plugins-page.test-support.ts";
import type { PluginSettingsField } from "./settings-editor.ts";

function createController() {
  return new PluginHelpController({
    addController: vi.fn(),
    removeController: vi.fn(),
    requestUpdate: vi.fn(),
    updateComplete: Promise.resolve(true),
  });
}

afterEach(() => {
  window.history.replaceState({}, "", "/");
  vi.restoreAllMocks();
});

it.each(["plugin", "route", "connection", "disconnect"])(
  "ignores a retained setting action after its %s changes",
  async (change) => {
    const { context, setPathname, setGatewayToken } = createContext(vi.fn());
    setPathname("/settings/plugins/first");
    const controller = createController();
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

it.each<{
  id: string;
  name: string;
  local: boolean;
  contracts: Record<string, string[]> | undefined;
  install: boolean;
}>([
  { id: "local-tool", name: "Local tool", local: true, contracts: undefined, install: false },
  {
    id: "video-plugin",
    name: "Video provider",
    local: false,
    contracts: { videoGenerationProviders: ["video"] },
    install: false,
  },
  {
    id: "workboard",
    name: "Workboard",
    local: false,
    contracts: { tools: ["known_tool"] },
    install: true,
  },
])(
  "publishes the catalog identity and bounded declarations for $id",
  ({ id, name, local, contracts, install }) => {
    const { context, setPathname } = createContext(vi.fn());
    setPathname(`/plugins/${id}`);
    const controller = createController();
    const catalog = createDiscoveryDetail(createPlugin({ id, name }));
    catalog.plugin.id = "catalog-workboard";
    catalog.plugin.local.pluginId = local ? id : undefined;
    catalog.detail = {
      ...catalog.detail,
      origin: local ? "local" : "clawhub",
      packageName: local ? undefined : id,
      contracts,
      providers: [],
      channels: [],
      configuration: [{ name: "credential", required: true, sensitive: true }],
      readme: "Do not inject this document.",
    };
    const model: Parameters<PluginHelpController["update"]>[0] = {
      context,
      connected: true,
      result: createResult([]),
      detail: null,
      installedDetailTab: "readme",
      catalogDetail: { result: catalog },
    };
    try {
      controller.update(model);
      expect(currentPluginHelpReference(context)).toEqual({
        id,
        name,
        installed: false,
        declared: {
          providers: [],
          channels: [],
          skills: [],
          mcpServers: [],
          ...(contracts ? { contracts: install ? [] : ["videoGenerationProviders: video"] } : {}),
          ...(install ? { tools: ["known_tool"] } : {}),
        },
      });
      if (install) {
        controller.update({
          ...model,
          result: createResult(createPlugin({ id, name, catalogId: "catalog-workboard" })),
          detail: { pluginId: id, inspection: null },
        });
        expect(currentPluginHelpReference(context)).toMatchObject({
          id,
          installed: true,
          declared: { tools: ["known_tool"] },
        });
      }
    } finally {
      controller.hostDisconnected();
    }
  },
);

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
    const controller = createController();
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
