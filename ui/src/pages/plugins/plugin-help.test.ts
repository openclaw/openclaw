/* @vitest-environment jsdom */
import { createRoot } from "solid-js";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { CUSTODIAN_PANEL_TOGGLE_EVENT } from "../../components/panel-toggle-contract.ts";
import { createContext } from "../custodian/custodian-page.test-harness.ts";
import { currentPluginHelpReference, takePluginHelpDraft } from "../custodian/plugin-help.ts";
import { createPluginHelp } from "./plugin-help.ts";
import { createDiscoveryDetail, createPlugin, createResult } from "./plugins-page.test-support.ts";
import type { PluginSettingsField } from "./settings-editor.tsx";

function createHelp(context: Parameters<typeof createPluginHelp>[0]) {
  return createRoot((dispose) => {
    onTestFinished(dispose);
    return { help: createPluginHelp(context), dispose };
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
    const { help, dispose } = createHelp(context);
    const model = (id: string) =>
      ({
        connected: true,
        result: { plugins: [{ id, name: id, installed: true }] },
        detail: { pluginId: id },
        installedDetailTab: "configuration",
      }) as unknown as Parameters<ReturnType<typeof createPluginHelp>["update"]>[0];
    help.update(model("first"));
    const ask = help.ask;
    if (change === "plugin") {
      help.update(model("second"));
    } else if (change === "route") {
      setPathname("/agents");
    } else if (change === "connection") {
      setGatewayToken("replacement-operator");
      help.update(model("first"));
    } else {
      dispose();
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
      dispose();
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
    const { help, dispose } = createHelp(context);
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
    const model: Parameters<ReturnType<typeof createPluginHelp>["update"]>[0] = {
      connected: true,
      result: createResult([]),
      detail: null,
      installedDetailTab: "readme",
      catalogDetail: { result: catalog },
    };
    try {
      help.update(model);
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
        help.update({
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
      dispose();
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
    const { help, dispose } = createHelp(context);
    help.update({
      connected: true,
      result: { plugins: [{ id: "workboard", name: "Workboard", installed: true }] },
      detail: { pluginId: "workboard" },
      installedDetailTab: "configuration",
    } as unknown as Parameters<ReturnType<typeof createPluginHelp>["update"]>[0]);
    try {
      await help.ask({
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
      dispose();
    }
  },
);
