/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyMergePatch } from "../../../../src/config/merge-patch.js";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import { invalidateConfigConnection } from "../../lib/config/config-state-model.ts";
import {
  createApplicationContextProvider,
  type ApplicationContextProvider,
} from "../../test-helpers/application-context.ts";
import "./labs-page.ts";

type LabsPageElement = HTMLElement & { updateComplete: Promise<boolean>; requestUpdate(): void };

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
    ensureLoaded: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
    patch: vi.fn(async (_input: { raw: Record<string, unknown>; note: string }) => true),
    subscribe(listener: (state: RuntimeConfigState) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

async function mountPage(sourceConfig: Record<string, unknown>): Promise<{
  page: LabsPageElement;
  provider: ApplicationContextProvider;
  runtimeConfig: ReturnType<typeof createRuntimeConfig>;
  gateway: ReturnType<typeof createGateway>;
}> {
  const runtimeConfig = createRuntimeConfig(sourceConfig);
  const gateway = createGateway();
  const context = {
    basePath: "",
    gateway: gateway.gateway,
    runtimeConfig,
  } as unknown as ApplicationContext;
  const provider = createApplicationContextProvider(context);
  const page = document.createElement("openclaw-labs-page") as LabsPageElement;
  provider.append(page);
  document.body.append(provider);
  await page.updateComplete;
  return { page, provider, runtimeConfig, gateway };
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
  const toggle = labRow(page, title).querySelector<HTMLElement & { checked: boolean }>("wa-switch");
  if (!toggle) {
    throw new Error(`${title} toggle not rendered`);
  }
  return toggle;
}

beforeEach(async () => {
  await i18n.setLocale("en");
});
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("LabsPage", () => {
  it.each([
    {
      config: true,
      checked: true,
      executor: "quickjs",
      patch: { enabled: true, executor: "quickjs" },
    },
    {
      config: "auto",
      checked: true,
      executor: "quickjs",
      patch: { enabled: "auto", executor: "quickjs" },
    },
    {
      config: undefined,
      checked: true,
      executor: "quickjs",
      patch: { enabled: "auto", executor: "quickjs" },
    },
    {
      config: { timeoutMs: 5000 },
      checked: false,
      executor: "quickjs",
      patch: { executor: "quickjs" },
    },
    {
      config: { enabled: "auto", executor: "quickjs", timeoutMs: 5000 },
      checked: true,
      executor: "node",
      patch: { executor: null },
    },
  ])(
    "preserves activation and authored limits when changing executor: $config",
    async ({ config, checked, executor, patch }) => {
      const { page, runtimeConfig } = await mountPage({ tools: { codeMode: config } });
      expect(labToggle(page, "Code Mode").checked).toBe(checked);
      const select = page.querySelector<HTMLSelectElement>(
        'select[aria-label="Code Mode executor"]',
      );
      expect(select).not.toBeNull();
      select!.value = executor;
      select!.dispatchEvent(new Event("change", { bubbles: true }));
      await vi.waitFor(() => expect(runtimeConfig.patch).toHaveBeenCalledOnce());
      expect(runtimeConfig.patch).toHaveBeenCalledWith({
        raw: { tools: { codeMode: patch } },
        note: "labs: update codeModeExecutor",
      });
    },
  );

  it.each<{
    label: string;
    config: Record<string, unknown>;
    enabled: boolean;
    patch: Record<string, unknown>;
    id: string;
    defaultDisabled?: boolean;
  }>([
    {
      label: "Code Mode",
      config: { tools: { codeMode: { enabled: true } } },
      enabled: false,
      patch: { tools: { codeMode: { enabled: null } } },
      id: "codeMode",
      defaultDisabled: true,
    },
    {
      label: "Code Mode",
      config: { tools: { codeMode: { enabled: false, timeoutMs: 5000 } } },
      enabled: true,
      patch: { tools: { codeMode: { enabled: "auto" } } },
      id: "codeMode",
      defaultDisabled: true,
    },
    {
      label: "Code Mode",
      config: { tools: { codeMode: false } },
      enabled: true,
      patch: { tools: { codeMode: null } },
      id: "codeMode",
      defaultDisabled: false,
    },
    {
      label: "Code Mode",
      config: {},
      enabled: false,
      patch: { tools: { codeMode: { enabled: false } } },
      id: "codeMode",
      defaultDisabled: false,
    },
    {
      label: "Custom plugin UI",
      config: { gateway: { controlUi: { experimental: { customPlugins: true } } } },
      enabled: false,
      patch: { gateway: { controlUi: { experimental: { customPlugins: null } } } },
      id: "customPluginUi",
    },
    {
      label: "Custom plugin UI",
      config: {},
      enabled: true,
      patch: { gateway: { controlUi: { experimental: { customPlugins: true } } } },
      id: "customPluginUi",
    },
    {
      label: "Host Desktop",
      config: {
        desktop: {
          host: { enabled: true, managed: false, port: 5908, passwordFile: "/tmp/vnc-password" },
        },
      },
      enabled: false,
      patch: { desktop: { host: { enabled: false } } },
      id: "hostDesktop",
    },
    {
      label: "Host Desktop",
      config: { desktop: { host: { enabled: false } } },
      enabled: true,
      patch: { desktop: { host: { enabled: true } } },
      id: "hostDesktop",
    },
    ...[
      {},
      { tools: { toolSearch: true } },
      { tools: { toolSearch: { mode: "directory" } } },
      { tools: { toolSearch: { enabled: true, maxSearchLimit: 3 } } },
    ].map((config) => ({
      label: "Tool Search for all models",
      config,
      enabled: false,
      patch: { tools: { toolSearch: { enabled: false } } },
      id: "toolSearch",
    })),
    ...[false, {}, { enabled: false, mode: "directory", maxSearchLimit: 3 }].map((toolSearch) => ({
      label: "Tool Search for all models",
      config: { tools: { toolSearch } },
      enabled: true,
      patch: { tools: { toolSearch: null } },
      id: "toolSearch",
    })),
  ])(
    "saves $label=$enabled through the canonical patch flow ($config)",
    async ({ label, config, enabled, patch, id, defaultDisabled }) => {
      const { page, runtimeConfig } = await mountPage(config);
      const toggle = labToggle(page, label);
      expect(toggle.checked).toBe(!enabled);
      expect(runtimeConfig.patch).not.toHaveBeenCalled();
      if (id === "codeMode") {
        expect(labRow(page, label).textContent?.includes("Default: Disabled")).toBe(
          defaultDisabled,
        );
        expect(labRow(page, label).textContent).not.toContain("Using default:");
      }
      toggle.checked = enabled;
      toggle.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      await vi.waitFor(() => expect(runtimeConfig.patch).toHaveBeenCalledOnce());
      expect(runtimeConfig.patch).toHaveBeenCalledWith({ raw: patch, note: `labs: update ${id}` });
      expect(runtimeConfig.refresh).not.toHaveBeenCalled();
      if (id === "toolSearch" && enabled) {
        expect(labRow(page, label).textContent).toContain("Default: Enabled");
      }
    },
  );

  it.each([
    [{ mode: "auto" }, false],
    [true, true],
  ])(
    "reflects saved intent %j independently of model selection",
    async (decisionAssistance, expected) => {
      const { page } = await mountPage({
        agents: { defaults: { experimental: { decisionAssistance } } },
      });
      const row = labRow(page, "Decision assistance");
      expect(labToggle(page, "Decision assistance").checked).toBe(expected);
      expect(row.textContent).toContain(
        "Enable experimental assistance from your configured Decision model",
      );
      expect(row.textContent).toContain("supported uses, setup, and data handling");
      expect(row.textContent?.includes("Preference saved.")).toBe(expected);
    },
  );

  it("saves explicit opt-in without a model, reloads it, and resets only the gate", async () => {
    const initial = {
      agents: {
        defaults: { experimental: { localModelLean: true } },
        entries: { quiet: { decisionModel: "" } },
      },
    };
    const { page, runtimeConfig, provider } = await mountPage(initial);
    runtimeConfig.patch.mockImplementationOnce(async ({ raw }) => {
      const saved = applyMergePatch(initial, raw) as Record<string, unknown>;
      runtimeConfig.state.configSnapshot = { hash: "saved-hash", sourceConfig: saved };
      return true;
    });
    const toggle = labToggle(page, "Decision assistance");
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    await page.updateComplete;
    await page.updateComplete;
    expect(runtimeConfig.patch).toHaveBeenCalledWith({
      raw: { agents: { defaults: { experimental: { decisionAssistance: true } } } },
      note: "labs: update decisionAssistance",
    });
    const saved = runtimeConfig.state.configSnapshot!.sourceConfig;
    provider.remove();
    const reloaded = await mountPage(saved);
    const savedToggle = labToggle(reloaded.page, "Decision assistance");
    expect(savedToggle.checked).toBe(true);
    savedToggle.checked = false;
    savedToggle.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    await reloaded.page.updateComplete;
    expect(reloaded.runtimeConfig.patch).toHaveBeenCalledWith({
      raw: { agents: { defaults: { experimental: { decisionAssistance: null } } } },
      note: "labs: update decisionAssistance",
    });
    const resetRequest = reloaded.runtimeConfig.patch.mock.calls[0]?.[0];
    if (!resetRequest) {
      throw new Error("Expected a reset patch");
    }
    const reset = applyMergePatch(saved, resetRequest.raw) as Record<string, unknown>;
    expect(reset).toEqual(initial);
    reloaded.provider.remove();
    const resetPage = await mountPage(reset);
    expect(labToggle(resetPage.page, "Decision assistance").checked).toBe(false);
  });

  it.each(["failure", "reconnect"])("keeps pending intent scoped through %s", async (outcome) => {
    const pending = deferred<boolean>();
    const { page, runtimeConfig, gateway } = await mountPage({});
    runtimeConfig.patch.mockImplementationOnce(() => pending.promise);
    const toggle = labToggle(page, "Decision assistance");
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    await page.updateComplete;
    expect(toggle.checked).toBe(true);
    expect(toggle.hasAttribute("disabled")).toBe(true);
    expect(labRow(page, "Decision assistance").textContent).not.toContain("Preference saved.");
    if (outcome === "reconnect") {
      gateway.setPhase("reconnecting");
      gateway.setPhase("connected");
    }
    pending.resolve(false);
    await pending.promise;
    await page.updateComplete;
    expect(toggle.checked).toBe(false);
    expect(page.querySelector('[role="alert"]') !== null).toBe(outcome === "failure");
    expect(runtimeConfig.patch).toHaveBeenCalledOnce();
  });

  it.each(["missing", "loading", "read failure", "invalid", "disconnected", "stale"])(
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
      if (state === "invalid") {
        runtimeConfig.state.configSnapshot!.valid = false;
      }
      if (state === "disconnected") {
        runtimeConfig.state.connected = false;
      }
      if (state === "stale") {
        invalidateConfigConnection(runtimeConfig.state);
      }
      page.requestUpdate();
      await page.updateComplete;
      const row = labRow(page, "Decision assistance");
      expect(row.querySelector("wa-switch")).toBeNull();
      expect(row.textContent).toContain(
        state === "loading" ? "Loading setting" : "Couldn’t load this setting",
      );
      expect(row.textContent).not.toContain("Default: Disabled");
      expect(runtimeConfig.patch).not.toHaveBeenCalled();
      if (state === "read failure") {
        row.querySelector<HTMLButtonElement>("button")!.click();
        expect(runtimeConfig.refresh).toHaveBeenCalledOnce();
        runtimeConfig.state.lastError = null;
        page.requestUpdate();
        await page.updateComplete;
        expect(labToggle(page, "Decision assistance").checked).toBe(true);
      }
    },
  );
});
