/* @vitest-environment jsdom */

import { createSignal, flush } from "solid-js";
import { beforeEach, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import type { JsonSchema } from "../../lib/config-form-utils.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { queryWithin } from "./plugins-page.lifecycle-test-support.ts";
import { createInspectResult, createPlugin, createResult } from "./plugins-page.test-support.ts";
import { renderPluginSettingsDetail, type DetailProps } from "./settings-view.tsx";

beforeEach(() => i18n.setLocale("en"));

function objectSchema(properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", additionalProperties: false, properties };
}

function setting(container: ParentNode, key: string) {
  return container.querySelector(`[data-setting="${key}"]`)!;
}

function mount(overrides: Partial<DetailProps>, setup?: (props: DetailProps) => void) {
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
    configRead: undefined,
    configSchemaRead: undefined,
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
  const { container } = mountSolid(() => {
    setup?.(props);
    return renderPluginSettingsDetail(props);
  });
  flush();
  return { container, find: queryWithin(container), props };
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

it("does not offer enablement or Settings for an uninstalled plugin", () => {
  const { find } = mount({
    result: createResult(createPlugin({ installed: false, state: "not-installed" })),
  });
  expect(find('[aria-label="Enable Workboard"], [aria-label="Settings"]')).toBeNull();
});

it("retains the focused Uninstall button when inspection arrives", () => {
  let publishInspection!: () => void;
  const { find } = mount({ result: createResult(createPlugin({ removable: true })) }, (props) => {
    const [inspection, setInspection] = createSignal<DetailProps["inspection"]>(null);
    Object.defineProperty(props, "inspection", { get: inspection });
    publishInspection = () => setInspection(createInspectResult());
  });
  const button = find<HTMLButtonElement>('[aria-label="Uninstall Workboard"]')!;
  button.focus();
  expect(document.activeElement).toBe(button);
  publishInspection();
  flush();
  expect(find('[aria-label="Uninstall Workboard"]')).toBe(button);
  expect(button.isConnected).toBe(true);
  expect(document.activeElement).toBe(button);
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

it("does not dispatch enablement when setup is missing", () => {
  const { find, props } = mount({
    result: createResult(createPlugin({ state: "needs-setup" })),
  });
  const button = find<HTMLButtonElement>('[aria-label="Enable Workboard"]')!;
  expect(button.disabled || button.getAttribute("aria-disabled") === "true").toBe(true);
  button.click();
  expect(props.onSetEnabled).not.toHaveBeenCalled();
});

it("retains disconnected plugin details without dispatching enablement", () => {
  const { container, find, props } = mount({ connected: false, canMutate: false });
  expect(container.textContent).toContain("Agent work queue and session handoff.");
  expect(find("[inert]")).toBeNull();
  const button = find<HTMLButtonElement>('[aria-label="Enable Workboard"]')!;
  expect(button.disabled).toBe(true);
  button.click();
  expect(props.onSetEnabled).not.toHaveBeenCalled();
});

it("gives host permissions the setting menu and preserves configured, inherited, and read-only values", async () => {
  const { container, props } = mount({
    tab: "configuration",
    inspection: createInspectResult(),
    onAskSetting: vi.fn(),
    configValue: { plugins: { entries: { workboard: { hooks: { timeoutMs: 5000 } } } } },
    hostControlsSchema: objectSchema({
      hooks: objectSchema({
        allowPromptInjection: { type: "boolean" },
        allowConversationAccess: { type: "boolean" },
        timeoutMs: { type: "integer" },
      }),
      llm: objectSchema({
        allowedModels: { type: "array", items: { type: "string" } },
      }),
    }),
  });
  await Promise.resolve();
  flush();
  const row = setting(container, "hooks.allowPromptInjection");
  expect(row.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
  expect(row.querySelector('[data-value="reset"]')?.hasAttribute("disabled")).toBe(true);
  await selectSettingAction(row, "ask");
  const hooksPath = ["plugins", "entries", "workboard", "hooks"];
  const path = [...hooksPath, "allowPromptInjection"];
  expect(props.onAskSetting).toHaveBeenCalledWith(
    expect.objectContaining({
      path,
      value: true,
      label: "Add context to prompts",
    }),
  );
  row.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
  expect(props.onConfigPatch).toHaveBeenCalledWith(path, false);
  await selectSettingAction(setting(container, "hooks.timeoutMs"), "reset");
  expect(props.onConfigRemove).toHaveBeenCalledWith([...hooksPath, "timeoutMs"]);
  expect(setting(container, "llm.allowedModels").querySelector(".oc-menu-trigger")).not.toBeNull();
  expect(container.textContent).not.toMatch(/Declared capabilities|Your grants/);
  vi.mocked(props.onConfigPatch).mockClear();
  const { container: readOnly } = mount({ ...props, canEditConfig: false });
  await Promise.resolve();
  flush();
  const readOnlyInput = setting(readOnly, "hooks.allowPromptInjection").querySelector("input")!;
  expect(readOnlyInput.disabled).toBe(true);
  readOnlyInput.click();
  expect(props.onConfigPatch).not.toHaveBeenCalled();
});

it("shows selected capabilities without a catalog", () => {
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
  const { container } = mount({ inspection });
  const titles = [...container.querySelectorAll(".plugin-capabilities h2")].map(
    (heading) => heading.textContent,
  );
  expect(titles).toEqual(["Capabilities2", "Tools1"]);
  expect(container.textContent).toContain("Text to speech");
  expect(container.textContent).toContain("Pages");
  expect(container.textContent).not.toMatch(/speechProviders:|sibling-|Video generation/);
});
