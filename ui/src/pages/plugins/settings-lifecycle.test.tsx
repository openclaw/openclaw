import { createSignal, flush } from "solid-js";
import { beforeEach, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import type { JsonSchema } from "../../lib/config-form-utils.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { queryWithin } from "./plugins-page.lifecycle-test-support.ts";
import {
  createDiscoveryDetail,
  createInspectResult,
  createPlugin,
  createPluginSettingsDetailProps,
  createResult,
} from "./plugins-page.test-support.ts";
import {
  renderPluginSettingsDetail as PluginSettingsDetail,
  type DetailProps,
} from "./settings-view.tsx";

beforeEach(() => i18n.setLocale("en"));

function objectSchema(properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", additionalProperties: false, properties };
}

function pluginRootSchema(properties: Record<string, JsonSchema>): JsonSchema {
  return objectSchema({
    plugins: objectSchema({ entries: objectSchema({ workboard: objectSchema(properties) }) }),
  });
}

function setting(container: ParentNode, key: string) {
  return container.querySelector(`[data-setting="${key}"]`)!;
}

function mount(overrides: Partial<DetailProps>, setup?: (props: DetailProps) => void) {
  const props: DetailProps = createPluginSettingsDetailProps(createResult(), overrides);
  const [currentProps, setProps] = createSignal(props);
  const { container } = mountSolid(() => {
    setup?.(props);
    return <PluginSettingsDetail {...currentProps()} />;
  });
  flush();
  return {
    container,
    find: queryWithin(container),
    props,
    update: (next: Partial<DetailProps>) => {
      setProps((previous) => ({ ...previous, ...next }));
      flush();
    },
  };
}

async function selectSettingAction(row: Element, value: "ask" | "reset") {
  // JSDOM has no layout; browser suites own menu scrolling and focus.
  for (const item of row.querySelectorAll<HTMLElement>('[role="menuitem"]')) {
    item.scrollIntoView = vi.fn();
  }
  const trigger = row.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
  trigger.click();
  await waitForSolid(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
  row.querySelector<HTMLButtonElement>(`[role="menuitem"][data-value="${value}"]`)!.click();
  await Promise.resolve();
  flush();
}

it.each(["multiple-servers", "mixed-capabilities", "missing-description", "disabled"] as const)(
  "retains server-specific setup for %s instead of misattributing the plugin summary",
  (scenario) => {
    const plugin = createPlugin({
      enabled: scenario !== "disabled",
      state: scenario === "disabled" ? "disabled" : "enabled",
      description: scenario === "missing-description" ? "" : "Manage workspace records.",
    });
    const catalog = createDiscoveryDetail(plugin);
    catalog.plugin.catalog.family = "bundle-plugin";
    catalog.plugin.catalog.summary = plugin.description;
    catalog.detail.mcpServers = ["workspace"];
    catalog.detail.mcpServerDetails = [
      { name: "workspace", setup: "Connect the workspace account." },
    ];
    const inspection = createInspectResult();
    inspection.components.mapped = ["mcpServers"];
    inspection.components.mcpServers = ["workspace"];
    inspection.declared.mcpServers = ["workspace"];
    if (scenario === "multiple-servers") {
      inspection.components.mcpServers.push("other");
      inspection.declared.mcpServers.push("other");
    } else if (scenario === "mixed-capabilities") {
      inspection.declared.tools = ["workspace_sync"];
    }
    const { container } = mount({ result: createResult(plugin), catalog, inspection });
    const details = container.querySelector(".plugin-capability__details")!;
    expect(details.textContent).toContain("Connect the workspace account.");
    expect(details.textContent).not.toContain("What this server does");
  },
);

it("omits SDK notices from plugin details while retaining actionable errors and warnings", () => {
  const plugin = createPlugin({
    error: "Plugin could not load.",
    compatibilityNotices: [
      {
        code: "deprecated-sdk-api",
        severity: "info",
        message: "Uses older OpenClaw APIs.",
        migrationGuideUrl: "https://docs.openclaw.ai/plugins/sdk-migration",
        apis: [],
      },
    ],
  });
  const { container } = mount({
    result: createResult(plugin),
    error: "Could not refresh plugins.",
    messages: { "plugin:workboard": { kind: "warning", text: "Plugin action needs attention." } },
  });
  expect(container.textContent).not.toContain("Uses older OpenClaw APIs");
  expect(container.textContent).toContain("Plugin could not load.");
  expect(container.textContent).toContain("Could not refresh plugins.");
  expect(container.textContent).toContain("Plugin action needs attention.");
});

it("does not offer enablement or Settings for an uninstalled plugin", () => {
  const { find } = mount({
    result: createResult(createPlugin({ installed: false, state: "not-installed" })),
  });
  expect(find('[role="switch"][aria-label="Workboard"], [aria-label="Settings"]')).toBeNull();
});

it("retains inspection retry focus and uses the current error and callback", async () => {
  const firstRetry = vi.fn();
  const nextRetry = vi.fn();
  let replace!: () => void;
  const { container } = mount({}, (props) => {
    const [failure, setFailure] = createSignal(new Error("Inspection unavailable"));
    const [retry, setRetry] = createSignal<() => void>(() => firstRetry);
    props.inspectionRead = {
      receipt: () => null,
      value: () => {
        throw failure();
      },
    };
    Object.defineProperty(props, "onRetryInspection", { get: retry });
    replace = () => {
      setFailure(new Error("Inspection still unavailable"));
      setRetry(() => nextRetry);
    };
  });
  const alert = container.querySelector('[role="alert"]')!;
  const button = alert.querySelector("button")!;
  expect(alert.textContent).toContain("Inspection unavailable");
  button.focus();
  replace();
  await waitForSolid(() => expect(alert.textContent).toContain("Inspection still unavailable"));
  expect(alert.querySelector("button")).toBe(button);
  expect(document.activeElement).toBe(button);
  button.click();
  expect(firstRetry).not.toHaveBeenCalled();
  expect(nextRetry).toHaveBeenCalledOnce();
});

it.each(["needs-setup", "disconnected"])("does not dispatch enablement when %s", (reason) => {
  const disconnected = reason === "disconnected";
  const { container, find, props } = mount(
    disconnected
      ? { connected: false, canMutate: false }
      : { result: createResult(createPlugin({ state: "needs-setup" })) },
  );
  if (disconnected) {
    expect(container.textContent).toContain("Agent work queue and session handoff.");
    expect(find("[inert]")).toBeNull();
  }
  const button = find<HTMLInputElement>('[role="switch"][aria-label="Workboard"]')!;
  expect(button.getAttribute("aria-disabled")).toBe("true");
  button.click();
  expect(props.onSetEnabled).not.toHaveBeenCalled();
});

it("gives inherited host permissions the setting menu and preserves read-only values", async () => {
  const { container, props, update } = mount({
    tab: "configuration",
    inspection: createInspectResult(),
    onAskSetting: vi.fn(),
    rawConfigSchema: pluginRootSchema({
      hooks: objectSchema({
        allowPromptModification: { type: "boolean" },
      }),
    }),
  });
  await Promise.resolve();
  flush();
  const row = setting(container, "hooks.allowPromptModification");
  expect(row.textContent).toContain("add or change the context and instructions sent to the model");
  expect(row.textContent).toContain("Only allow this for plugins you trust.");
  expect(row.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
  expect(row.querySelector('[data-value="reset"]')?.hasAttribute("disabled")).toBe(true);
  await selectSettingAction(row, "ask");
  const hooksPath = ["plugins", "entries", "workboard", "hooks"];
  const path = [...hooksPath, "allowPromptModification"];
  expect(props.onAskSetting).toHaveBeenCalledWith(
    expect.objectContaining({ path, value: true, label: "Modify prompts" }),
  );
  const input = row.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  const currentPatch = vi.fn();
  update({
    configValue: {
      plugins: { entries: { workboard: { hooks: { allowPromptModification: true } } } },
    },
    onConfigPatch: currentPatch,
  });
  expect(setting(container, "hooks.allowPromptModification").querySelector("input")).toBe(input);
  input.click();
  expect(currentPatch).toHaveBeenCalledExactlyOnceWith(path, false);
  expect(props.onConfigPatch).not.toHaveBeenCalled();
  const { container: readOnly } = mount({ ...props, canEditConfig: false });
  await Promise.resolve();
  flush();
  const readOnlyInput = setting(readOnly, "hooks.allowPromptModification").querySelector("input")!;
  expect(readOnlyInput.disabled).toBe(true);
  readOnlyInput.click();
  expect(props.onConfigPatch).not.toHaveBeenCalled();
});

it("shows selected capabilities without a catalog", () => {
  const inspection = createInspectResult();
  inspection.declared = {
    ...inspection.declared,
    tools: ["speech_status"],
    contracts: ["speechProviders: local-speech", "videoGenerationProviders: sibling-video"],
  };
  inspection.overview = {
    capabilities: {
      providers: [],
      channels: [],
      contracts: { speechProviders: ["local-speech", "local-speech-alias"] },
      ui: ["page"],
    },
  };
  const { container } = mount({ inspection });
  const titles = [...container.querySelectorAll(".plugin-capabilities h2")].map(
    (heading) => heading.textContent,
  );
  expect(titles).toEqual(["Capabilities", "Extensions", "Tools"]);
  expect(container.textContent).toContain("Text to speech");
  expect(container.textContent).toContain("Pages");
  expect(container.textContent).not.toMatch(/speechProviders:|sibling-|Video generation/);
});

it.each([false, true])(
  "keeps failed inspection separate from permission loading (cached: %s)",
  async (cached) => {
    const failure = new Error("Plugin inspection unavailable");
    const { container, props } = mount({
      tab: "configuration",
      inspection: cached ? createInspectResult() : null,
      inspectionRead: {
        receipt: () => null,
        value: () => {
          throw failure;
        },
      },
      rawConfigSchema: pluginRootSchema({
        config: objectSchema({ workspaceLabel: { type: "string", title: "Workspace label" } }),
        hooks: objectSchema({ allowPromptModification: { type: "boolean" } }),
      }),
      configValue: {
        plugins: { entries: { workboard: { config: { workspaceLabel: "Planning" } } } },
      },
    });
    await waitForSolid(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(failure.message),
    );
    const input = container.querySelector<HTMLInputElement>('input[type="text"]')!;
    expect(input.value).toBe("Planning");
    expect(input.disabled).toBe(false);
    expect(container.querySelectorAll(".plugin-editor .settings-loading-skeleton")).toHaveLength(0);
    if (cached) {
      expect(
        setting(container, "hooks.allowPromptModification").querySelector<HTMLInputElement>(
          'input[type="checkbox"]',
        )?.checked,
      ).toBe(true);
    } else {
      expect(container.querySelector('[data-setting="hooks.allowPromptModification"]')).toBeNull();
    }
    container.querySelector<HTMLButtonElement>('[role="alert"] button')!.click();
    expect(props.onRetryInspection).toHaveBeenCalledOnce();
    expect(props.onConfigPatch).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "shows empty settings only after permissions are known (%s)",
  async (known) => {
    const { container } = mount({
      tab: "configuration",
      rawConfigSchema: pluginRootSchema({ config: objectSchema({}) }),
      inspection: known ? createInspectResult() : null,
      inspectionRead: {
        receipt: () => null,
        value: () => {
          if (!known) {
            throw new Error("Inspection unavailable");
          }
          return null;
        },
      },
    });
    await waitForSolid(() =>
      expect(container.querySelector("openclaw-plugin-settings-editor")).not.toBeNull(),
    );
    expect(container.textContent?.includes("This plugin has no configurable settings.")).toBe(
      known,
    );
    expect(container.querySelector(".plugin-editor .settings-loading-skeleton")).toBeNull();
  },
);
