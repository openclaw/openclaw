/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import { invalidateConfigConnection } from "../../lib/config/config-state-model.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { LabsPage } from "./labs-page.tsx";

type LabsPageElement = HTMLElement;
type RuntimeConfigState = {
  connected: boolean;
  configLoading: boolean;
  configSnapshot: {
    hash: string;
    sourceConfig: Record<string, unknown>;
    valid?: boolean;
  } | null;
  lastError: string | null;
};

function createGateway() {
  const client = {} as GatewayBrowserClient;
  let snapshot = { client, phase: "connected" } as ApplicationGatewaySnapshot;
  const listeners = new Set<(snapshot: ApplicationGatewaySnapshot) => void>();
  return {
    gateway: {
      get snapshot() {
        return snapshot;
      },
      subscribe(listener: (snapshot: ApplicationGatewaySnapshot) => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    } as unknown as ApplicationContext["gateway"],
    setPhase(phase: ApplicationGatewaySnapshot["phase"]) {
      snapshot = { ...snapshot, phase };
      listeners.forEach((listener) => listener(snapshot));
    },
  };
}

function createRuntimeConfig(sourceConfig: Record<string, unknown>) {
  const state: RuntimeConfigState = {
    connected: true,
    configLoading: false,
    configSnapshot: { hash: "config-hash", sourceConfig },
    lastError: null,
  };
  const listeners = new Set<(state: RuntimeConfigState) => void>();
  return {
    state,
    notify: () => {
      for (const listener of listeners) {
        listener(state);
      }
    },
    ensureLoaded: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
    patch: vi.fn(async (_input: { raw: Record<string, unknown>; note: string }) => true),
    subscribe(listener: (state: RuntimeConfigState) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

async function mountPage(
  sourceConfig: Record<string, unknown>,
  basePath = "",
): Promise<{
  page: LabsPageElement;
  unmount: () => void;
  runtimeConfig: ReturnType<typeof createRuntimeConfig>;
  gateway: ReturnType<typeof createGateway>;
  context: { navigate: ReturnType<typeof vi.fn> };
}> {
  const runtimeConfig = createRuntimeConfig(sourceConfig);
  const gateway = createGateway();
  const navigate = vi.fn();
  const context = {
    basePath,
    gateway: gateway.gateway,
    runtimeConfig,
    navigate,
  } as unknown as ApplicationContext;
  const provider = createSolidApplicationContextProvider(context);
  const { container: page, unmount } = mountSolid(() => <LabsPage />, {
    wrapper: provider.wrapper,
  });
  await waitForSolid(() => expect(page.querySelector(".settings-page")).not.toBeNull());
  return { page, unmount, runtimeConfig, gateway, context: { navigate } };
}

function labRow(page: LabsPageElement, title: string) {
  const row = [...page.querySelectorAll<HTMLElement>(".settings-row")].find(
    (candidate) => candidate.querySelector(".settings-row__title")?.textContent?.trim() === title,
  );
  if (!row) {
    throw new Error(`${title} row not rendered`);
  }
  return row;
}

function labToggle(page: LabsPageElement, title: string) {
  const toggle = labRow(page, title).querySelector<HTMLInputElement>('input[role="switch"]');
  if (!toggle) {
    throw new Error(`${title} toggle not rendered`);
  }
  return toggle;
}

function codeModeToggle(page: LabsPageElement) {
  return labToggle(page, "Code Mode");
}

describe("LabsPage", () => {
  it("defaults predictions off with Utility and saves each model without enabling the lab", async () => {
    const { page, runtimeConfig } = await mountPage({});
    const toggle = labToggle(page, "Composer predictions");
    expect(toggle.checked).toBe(false);
    const select = page.querySelector<HTMLSelectElement>('select[aria-label="Prediction model"]')!;
    expect(select.closest(".settings-row--nested")).not.toBeNull();
    expect(select.value).toBe("utility");
    for (const model of ["conversation", "default", "utility"]) {
      runtimeConfig.patch.mockClear();
      select.value = model;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await waitForSolid(() => expect(runtimeConfig.patch).toHaveBeenCalledOnce());
      expect(runtimeConfig.patch).toHaveBeenCalledWith({
        raw: { gateway: { controlUi: { experimental: { composerPredictions: { model } } } } },
        note: "labs: update predictionModel",
      });
      await waitForSolid(() => expect(select.disabled).toBe(false));
      expect(toggle.checked).toBe(false);
    }
    runtimeConfig.patch.mockClear();
    toggle.click();
    await waitForSolid(() =>
      expect(runtimeConfig.patch).toHaveBeenCalledWith({
        raw: {
          gateway: { controlUi: { experimental: { composerPredictions: { enabled: true } } } },
        },
        note: "labs: update composerPredictions",
      }),
    );
  });

  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it.each([
    {
      name: "false shorthand",
      config: false,
      executor: "quickjs",
      expectedPatch: { enabled: false, executor: "quickjs" },
    },
    {
      name: "inherited auto",
      config: undefined,
      executor: "quickjs",
      expectedPatch: { enabled: "auto", executor: "quickjs" },
    },
    {
      name: "explicit auto and limits when restoring Node",
      config: { enabled: "auto", executor: "quickjs", timeoutMs: 5000 },
      executor: "node",
      expectedPatch: { executor: null },
    },
  ])("preserves $name when choosing an executor", async ({ config, executor, expectedPatch }) => {
    const { page, runtimeConfig } = await mountPage({ tools: { codeMode: config } });
    const select = page.querySelector<HTMLSelectElement>('select[aria-label="Code Mode executor"]');
    expect(select).not.toBeNull();
    expect(select?.closest(".settings-row--nested")).not.toBeNull();
    select!.value = executor;
    select!.dispatchEvent(new Event("change", { bubbles: true }));

    await waitForSolid(() => expect(runtimeConfig.patch).toHaveBeenCalledOnce());
    expect(runtimeConfig.patch).toHaveBeenCalledWith({
      raw: { tools: { codeMode: expectedPatch } },
      note: "labs: update codeModeExecutor",
    });
  });

  it.each([
    {
      label: "Code Mode",
      sourceConfig: { tools: { codeMode: { enabled: true } } },
      expectedPatch: { tools: { codeMode: { enabled: null } } },
      note: "labs: update codeMode",
    },
    {
      label: "Custom plugin UI",
      sourceConfig: { gateway: { controlUi: { experimental: { customPlugins: true } } } },
      expectedPatch: { gateway: { controlUi: { experimental: { customPlugins: null } } } },
      note: "labs: update customPluginUi",
    },
    {
      label: "Claws",
      sourceConfig: { gateway: { controlUi: { experimental: { claws: true } } } },
      expectedPatch: { gateway: { controlUi: { experimental: { claws: null } } } },
      note: "labs: update claws",
    },
    {
      label: "Host Desktop",
      sourceConfig: {
        desktop: {
          host: { enabled: true, managed: false, port: 5908, passwordFile: "/tmp/vnc-password" },
        },
      },
      expectedPatch: { desktop: { host: { enabled: false } } },
      note: "labs: update hostDesktop",
    },
    {
      label: "Advisor",
      sourceConfig: {
        plugins: { entries: { advisor: { enabled: true, config: { everyToolCalls: 3 } } } },
      },
      expectedPatch: { plugins: { entries: { advisor: { enabled: null } } } },
      note: "labs: update advisor",
    },
  ])(
    "restores the default through the canonical patch flow when disabling $label",
    async (testCase) => {
      const { page, runtimeConfig } = await mountPage(testCase.sourceConfig);
      const toggle = labToggle(page, testCase.label);
      expect(toggle.checked).toBe(true);

      toggle.checked = false;
      toggle.dispatchEvent(new Event("change", { bubbles: true, composed: true }));

      await waitForSolid(() => expect(runtimeConfig.patch).toHaveBeenCalledOnce());
      expect(runtimeConfig.patch).toHaveBeenCalledWith({
        raw: testCase.expectedPatch,
        note: testCase.note,
      });
      expect(runtimeConfig.refresh).not.toHaveBeenCalled();
    },
  );

  it("does not publish a retired save failure after a same-client reconnect", async () => {
    const pendingPatch = deferred<boolean>();
    const { gateway, page, runtimeConfig } = await mountPage({
      tools: { codeMode: { enabled: false } },
    });
    runtimeConfig.patch.mockImplementationOnce(() => pendingPatch.promise);
    const toggle = codeModeToggle(page);

    toggle.checked = true;
    toggle.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    await waitForSolid(() => expect(runtimeConfig.patch).toHaveBeenCalledOnce());

    gateway.setPhase("reconnecting");
    gateway.setPhase("connected");
    pendingPatch.resolve(false);
    await pendingPatch.promise;
    flush();

    expect(page.querySelector('[role="alert"]')).toBeNull();
    expect(toggle.checked).toBe(false);
  });

  it.each([
    {
      // The on position selects the "auto" tier, never `true`: Labs offers
      // Auto/Off, and force-on stays a config-only power-user state.
      label: "Code Mode",
      sourceConfig: { tools: { codeMode: { enabled: false } } },
      expectedPatch: { tools: { codeMode: { enabled: "auto" } } },
      note: "labs: update codeMode",
    },
    {
      label: "Code Mode",
      sourceConfig: { tools: { codeMode: false } },
      expectedPatch: { tools: { codeMode: null } },
      note: "labs: update codeMode",
    },
    {
      label: "Speech bubbles",
      sourceConfig: {},
      expectedPatch: { gateway: { controlUi: { experimental: { chatBubbles: true } } } },
      note: "labs: update chatBubbles",
    },
    {
      label: "Custom plugin UI",
      sourceConfig: {},
      expectedPatch: { gateway: { controlUi: { experimental: { customPlugins: true } } } },
      note: "labs: update customPluginUi",
    },
    {
      label: "Claws",
      sourceConfig: {},
      expectedPatch: { gateway: { controlUi: { experimental: { claws: true } } } },
      note: "labs: update claws",
    },
    {
      label: "Host Desktop",
      sourceConfig: { desktop: { host: { enabled: false } } },
      expectedPatch: { desktop: { host: { enabled: true } } },
      note: "labs: update hostDesktop",
    },
    {
      label: "Cloud Worker Desktop",
      sourceConfig: { cloudWorkers: { desktop: false } },
      expectedPatch: { cloudWorkers: { desktop: true } },
      note: "labs: update workerDesktop",
    },
    {
      label: "Advisor",
      sourceConfig: {},
      expectedPatch: { plugins: { entries: { advisor: { enabled: true } } } },
      note: "labs: update advisor",
    },
  ])("writes the on value at the registered config path when enabling $label", async (testCase) => {
    const { page, runtimeConfig } = await mountPage(testCase.sourceConfig);
    const toggle = labToggle(page, testCase.label);
    expect(toggle.checked).toBe(false);

    toggle.checked = true;
    toggle.dispatchEvent(new Event("change", { bubbles: true, composed: true }));

    await waitForSolid(() => expect(runtimeConfig.patch).toHaveBeenCalledOnce());
    expect(runtimeConfig.patch).toHaveBeenCalledWith({
      raw: testCase.expectedPatch,
      note: testCase.note,
    });
  });

  it("opens Advisor settings from Configure without toggling the lab", async () => {
    const { page, context, runtimeConfig } = await mountPage({}, "/ui");
    const link = labRow(page, "Advisor").querySelector<HTMLAnchorElement>(
      '.settings-row__control a[aria-label="Configure Advisor"]',
    );
    expect(link?.textContent?.trim()).toBe("Configure");
    expect(link?.getAttribute("href")).toBe("/ui/settings/plugins/advisor?view=settings");

    link!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));

    expect(context.navigate).toHaveBeenCalledExactlyOnceWith("plugin-settings", {
      pathname: "/ui/settings/plugins/advisor",
      search: "?view=settings",
      hash: "",
    });
    // The row toggles on plain clicks; its own links must not flip the switch.
    expect(labToggle(page, "Advisor").checked).toBe(false);
    expect(runtimeConfig.patch).not.toHaveBeenCalled();
  });

  it("shows default provenance", async () => {
    const inherited = await mountPage({});
    expect(labRow(inherited.page, "Code Mode").textContent).not.toContain("Using default:");
    inherited.unmount();

    const overridden = await mountPage({
      tools: {
        codeMode: { enabled: "auto" },
        swarm: { enabled: false },
      },
    });
    expect(labRow(overridden.page, "Code Mode").textContent).toContain("Default: Disabled");
  });
});

describe("LabsPage code mode enablement", () => {
  // An absent global node inherits auto; authored objects remain opt-in.
  it.each([
    ["unset", true, {}],
    ["empty object", false, { tools: { codeMode: {} } }],
    ["object with options", false, { tools: { codeMode: { timeoutMs: 5000 } } }],
    ["explicit true", true, { tools: { codeMode: { enabled: true } } }],
    ["explicit disabled", false, { tools: { codeMode: { enabled: false } } }],
    ["boolean shorthand false", false, { tools: { codeMode: false } }],
    ["auto shorthand", true, { tools: { codeMode: "auto" } }],
  ])("reads %s as %s", async (_label, expected, config) => {
    const { page, unmount } = await mountPage(config);

    expect(codeModeToggle(page).checked).toBe(expected);
    unmount();
  });

  it("writes explicit false when disabling the automatic default", async () => {
    const { page, runtimeConfig } = await mountPage({});
    const toggle = codeModeToggle(page);

    expect(toggle.checked).toBe(true);
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change", { bubbles: true, composed: true }));

    await waitForSolid(() => expect(runtimeConfig.patch).toHaveBeenCalledOnce());
    expect(runtimeConfig.patch).toHaveBeenCalledWith({
      raw: { tools: { codeMode: { enabled: false } } },
      note: "labs: update codeMode",
    });
  });

  it("writes the auto tier when re-enabling an option-bearing object", async () => {
    const { page, runtimeConfig } = await mountPage({
      tools: { codeMode: { enabled: false, timeoutMs: 5000 } },
    });
    const toggle = codeModeToggle(page);

    toggle.checked = true;
    toggle.dispatchEvent(new Event("change", { bubbles: true, composed: true }));

    await waitForSolid(() => expect(runtimeConfig.patch).toHaveBeenCalledOnce());
    expect(runtimeConfig.patch).toHaveBeenCalledWith({
      raw: { tools: { codeMode: { enabled: "auto" } } },
      note: "labs: update codeMode",
    });
  });
});

describe("LabsPage tool search enablement", () => {
  it.each([
    ["mode-only override", { tools: { toolSearch: { mode: "directory" } } }],
    ["option-bearing override", { tools: { toolSearch: { enabled: true, maxSearchLimit: 3 } } }],
  ])("disables %s without replacing authored modes or options", async (_label, config) => {
    const { page, runtimeConfig } = await mountPage(config);
    const toggle = labToggle(page, "Tool Search for all models");

    expect(toggle.checked).toBe(true);
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change", { bubbles: true, composed: true }));

    await waitForSolid(() => expect(runtimeConfig.patch).toHaveBeenCalledOnce());
    expect(runtimeConfig.patch).toHaveBeenCalledWith({
      raw: { tools: { toolSearch: { enabled: false } } },
      note: "labs: update toolSearch",
    });
  });
});

describe("LabsPage Decision assistance", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("keeps pending intent scoped through failure", async () => {
    const pending = deferred<boolean>();
    const { page, runtimeConfig } = await mountPage({});
    runtimeConfig.patch.mockImplementationOnce(() => pending.promise);
    const toggle = labToggle(page, "Decision assistance");
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    flush();
    expect(toggle.checked).toBe(true);
    expect(toggle.hasAttribute("disabled")).toBe(true);
    expect(labRow(page, "Decision assistance").textContent).not.toContain("Preference saved.");
    pending.resolve(false);
    await pending.promise;
    flush();
    expect(toggle.checked).toBe(false);
    expect(page.querySelector('[role="alert"]')).not.toBeNull();
    expect(runtimeConfig.patch).toHaveBeenCalledOnce();
  });

  it.each(["missing", "loading", "read failure", "stale"])(
    "does not present %s configuration as an observed opt-out",
    async (state) => {
      const { page, runtimeConfig } = await mountPage({
        agents: { defaults: { experimental: { decisionAssistance: true } } },
      });
      if (state === "missing") {
        runtimeConfig.state.configSnapshot = null;
      }
      if (state === "loading") {
        runtimeConfig.state.configLoading = true;
      }
      if (state === "read failure") {
        runtimeConfig.state.lastError = "Configuration read failed";
      }
      if (state === "stale") {
        invalidateConfigConnection(runtimeConfig.state);
      }
      runtimeConfig.notify();
      flush();
      const row = labRow(page, "Decision assistance");
      expect(row.querySelector('input[role="switch"]')).toBeNull();
      expect(row.textContent).toContain(
        state === "loading" ? "Loading setting" : "Couldn’t load this setting",
      );
      expect(row.textContent).not.toContain("Default: Disabled");
      expect(runtimeConfig.patch).not.toHaveBeenCalled();
      if (state === "read failure") {
        row.querySelector<HTMLButtonElement>("button")!.click();
        expect(runtimeConfig.refresh).toHaveBeenCalledOnce();
        runtimeConfig.state.lastError = null;
        runtimeConfig.notify();
        flush();
        expect(labToggle(page, "Decision assistance").checked).toBe(true);
      }
    },
  );
});
