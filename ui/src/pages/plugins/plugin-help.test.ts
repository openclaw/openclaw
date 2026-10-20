/* @vitest-environment jsdom */
import { createRoot } from "solid-js";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { CUSTODIAN_PANEL_TOGGLE_EVENT } from "../../components/panel-toggle-contract.ts";
import { createContext } from "../custodian/custodian-page.test-harness.ts";
import { currentPluginHelpReference, takePluginHelpDraft } from "../custodian/plugin-help.ts";
import { createPluginHelp } from "./plugin-help.ts";
import { createDiscoveryDetail, createPlugin, createResult } from "./plugins-page.test-support.ts";
import type { PluginSettingsField } from "./settings-editor.tsx";

function createHelp(pathname: string) {
  const harness = createContext(vi.fn());
  harness.setPathname(pathname);
  return createRoot((dispose) => {
    onTestFinished(dispose);
    return { ...harness, help: createPluginHelp(harness.context), dispose };
  });
}
function installedModel(id: string): Parameters<ReturnType<typeof createPluginHelp>["update"]>[0] {
  return {
    connected: true,
    result: createResult(createPlugin({ id, name: id })),
    detail: { pluginId: id },
    catalogDetail: null,
    installedDetailTab: "configuration",
  };
}

afterEach(() => {
  window.history.replaceState({}, "", "/");
  vi.restoreAllMocks();
});

it.each(["plugin", "route", "connection", "disconnect"])(
  "ignores a retained setting action after its %s changes",
  async (change) => {
    const { context, setPathname, setGatewayToken, help, dispose } =
      createHelp("/settings/plugins/first");
    help.update(installedModel("first"));
    const ask = help.ask;
    if (change === "plugin") {
      help.update(installedModel("second"));
    } else if (change === "route") {
      setPathname("/agents");
    } else if (change === "connection") {
      setGatewayToken("replacement-operator");
      help.update(installedModel("first"));
    } else {
      dispose();
    }
    const toggled = vi.fn();
    window.addEventListener(CUSTODIAN_PANEL_TOGGLE_EVENT, toggled);
    onTestFinished(() => window.removeEventListener(CUSTODIAN_PANEL_TOGGLE_EVENT, toggled));
    await ask({
      path: ["plugins", "entries", "first", "config", "limit"],
      label: "Limit",
      value: 5,
      schema: { type: "number" },
      hints: {},
    } as PluginSettingsField);
    expect(toggled).not.toHaveBeenCalled();
    expect(takePluginHelpDraft(context)).toBe("");
  },
);

it.each<[string, string, Record<string, string[]> | undefined]>([
  ["local-tool", "Local tool", undefined],
  ["video-plugin", "Video provider", { videoGenerationProviders: ["video"] }],
  ["workboard", "Workboard", { tools: ["known_tool"] }],
])("publishes the catalog identity and bounded declarations for %s", (id, name, contracts) => {
  const { context, help } = createHelp(`/plugins/${id}`);
  const local = !contracts;
  const install = Boolean(contracts?.tools);
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
});

it.each<[string[], string, boolean | string[], string, boolean]>([
  [["hooks", "allowPromptInjection"], "Add context to prompts", true, "true", false],
  [["llm", "allowedModels"], "Allowed models", ["synthetic-sensitive-value"], "<redacted>", true],
])(
  "keeps host setting paths intact and redacts sensitive Ask values: %s",
  async (suffix, label, value, expected, sensitive) => {
    const path = ["plugins", "entries", "workboard", ...suffix];
    const { context, help } = createHelp("/settings/plugins/workboard");
    help.update(installedModel("workboard"));
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
  },
);
