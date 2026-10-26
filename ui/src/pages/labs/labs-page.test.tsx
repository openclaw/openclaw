/* @vitest-environment jsdom */

import { createRouter, definePage } from "@openclaw/uirouter";
import { onSettled } from "solid-js";
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
        return () => listeners.delete(listener);
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
    notify: () => listeners.forEach((listener) => listener(state)),
    ensureLoaded: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
    patch: vi.fn(async (_input: { raw: Record<string, unknown>; note: string }) => true),
    subscribe(listener: (state: RuntimeConfigState) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

async function mountPage(sourceConfig: Record<string, unknown>, basePath = "") {
  const runtimeConfig = createRuntimeConfig(sourceConfig);
  const gateway = createGateway();
  const navigate = vi.fn();
  const router = createRouter({
    routes: [
      definePage({ id: "labs", path: "/labs", component: () => ({}) }),
      definePage({ id: "usage", path: "/usage", component: () => ({}) }),
    ],
  });
  const context = {
    basePath,
    gateway: gateway.gateway,
    runtimeConfig,
    navigate,
    router,
  } as unknown as ApplicationContext;
  const provider = createSolidApplicationContextProvider(context);
  const { container: page, unmount } = mountSolid(
    () => {
      onSettled(() => () => router.stop());
      return <LabsPage />;
    },
    { wrapper: provider.wrapper },
  );
  await waitForSolid(() => expect(page.querySelector(".settings-page")).not.toBeNull());
  return { page, unmount, runtimeConfig, gateway, router, context: { navigate } };
}

function labRow(page: HTMLElement, title: string) {
  const row = [...page.querySelectorAll<HTMLElement>(".settings-row")].find(
    (candidate) => candidate.querySelector(".settings-row__title")?.textContent?.trim() === title,
  );
  if (!row) {
    throw new Error(`${title} row not rendered`);
  }
  return row;
}

function labToggle(page: HTMLElement, title = "Code Mode") {
  const toggle = labRow(page, title).querySelector<HTMLInputElement>('input[role="switch"]');
  if (!toggle) {
    throw new Error(`${title} toggle not rendered`);
  }
  return toggle;
}

function changeToggle(toggle: HTMLInputElement, checked: boolean) {
  toggle.checked = checked;
  toggle.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
}

async function expectPatch(
  runtimeConfig: ReturnType<typeof createRuntimeConfig>,
  raw: Record<string, unknown>,
  feature: string,
) {
  await waitForSolid(() => expect(runtimeConfig.patch).toHaveBeenCalledOnce());
  expect(runtimeConfig.patch).toHaveBeenCalledWith({ raw, note: `labs: update ${feature}` });
}

const experimental = (values: Record<string, unknown>) => ({
  gateway: { controlUi: { experimental: values } },
});
const codeMode = (value: unknown) => ({ tools: { codeMode: value } });
const advisor = (value: Record<string, unknown>) => ({ plugins: { entries: { advisor: value } } });
const hostDesktop = (value: Record<string, unknown>) => ({ desktop: { host: value } });
const workerDesktop = (desktop: boolean) => ({ cloudWorkers: { desktop } });
const customPlugins = (value: boolean | null) => experimental({ customPlugins: value });
const hostEnabled = (enabled: boolean) => hostDesktop({ enabled });

async function startSave(title = "Code Mode", config?: Record<string, unknown>) {
  const mounted = await mountPage(config ?? codeMode({ enabled: false }));
  const pendingPatch = deferred<boolean>();
  mounted.runtimeConfig.patch.mockImplementationOnce(() => pendingPatch.promise);
  const toggle = labToggle(mounted.page, title);
  changeToggle(toggle, true);
  return { ...mounted, pendingPatch, toggle };
}

beforeEach(() => i18n.setLocale("en"));

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

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
      await expectPatch(
        runtimeConfig,
        experimental({ composerPredictions: { model } }),
        "predictionModel",
      );
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

  it.each([
    ["false shorthand", false, "quickjs", { enabled: false, executor: "quickjs" }],
    ["inherited auto", undefined, "quickjs", { enabled: "auto", executor: "quickjs" }],
    [
      "explicit auto and limits when restoring Node",
      { enabled: "auto", executor: "quickjs", timeoutMs: 5000 },
      "node",
      { executor: null },
    ],
  ])("preserves %s when choosing an executor", async (_name, config, executor, expectedPatch) => {
    const { page, runtimeConfig } = await mountPage(codeMode(config));
    const select = page.querySelector<HTMLSelectElement>('select[aria-label="Code Mode executor"]');
    expect(select).not.toBeNull();
    expect(select?.closest(".settings-row--nested")).not.toBeNull();
    select!.value = executor;
    select!.dispatchEvent(new Event("change", { bubbles: true }));

    await expectPatch(runtimeConfig, codeMode(expectedPatch), "codeModeExecutor");
  });

  it.each([
    ["Code Mode", "codeMode", false, codeMode({ enabled: true }), codeMode({ enabled: null })],
    ["Custom plugin UI", "customPluginUi", false, customPlugins(true), customPlugins(null)],
    ["Claws", "claws", false, experimental({ claws: true }), experimental({ claws: null })],
    [
      "Host Desktop",
      "hostDesktop",
      false,
      hostDesktop({ enabled: true, managed: false, port: 5908, passwordFile: "/tmp/vnc-password" }),
      hostEnabled(false),
    ],
    [
      "Advisor",
      "advisor",
      false,
      advisor({ enabled: true, config: { everyToolCalls: 3 } }),
      advisor({ enabled: null }),
    ],
    // Labs offers Auto/Off; force-on stays a config-only power-user state.
    ["Code Mode", "codeMode", true, codeMode({ enabled: false }), codeMode({ enabled: "auto" })],
    ["Code Mode", "codeMode", true, codeMode(false), codeMode(null)],
    ["Speech bubbles", "chatBubbles", true, {}, experimental({ chatBubbles: true })],
    ["Custom plugin UI", "customPluginUi", true, {}, customPlugins(true)],
    ["Claws", "claws", true, {}, experimental({ claws: true })],
    ["Host Desktop", "hostDesktop", true, hostEnabled(false), hostEnabled(true)],
    ["Cloud Worker Desktop", "workerDesktop", true, workerDesktop(false), workerDesktop(true)],
    ["Advisor", "advisor", true, {}, advisor({ enabled: true })],
    ["Code Mode", "codeMode", false, {}, codeMode({ enabled: false })],
    [
      "Code Mode",
      "codeMode",
      true,
      codeMode({ enabled: false, timeoutMs: 5000 }),
      codeMode({ enabled: "auto" }),
    ],
  ])(
    "patches %s (%s) to %s through the canonical config flow: %j",
    async (label, feature, enabled, sourceConfig, expectedPatch) => {
      const { page, runtimeConfig } = await mountPage(sourceConfig);
      const toggle = labToggle(page, label);
      expect(toggle.checked).toBe(!enabled);
      changeToggle(toggle, enabled);
      await expectPatch(runtimeConfig, expectedPatch, feature);
      expect(runtimeConfig.refresh).not.toHaveBeenCalled();
    },
  );

  it("does not publish a retired save failure after a same-client reconnect", async () => {
    const { gateway, page, runtimeConfig, pendingPatch, toggle } = await startSave();
    await waitForSolid(() => expect(runtimeConfig.patch).toHaveBeenCalledOnce());

    await waitForSolid(() => {
      expect(toggle).toMatchObject({ checked: true, disabled: false });
      expect(toggle.hasAttribute("aria-disabled")).toBe(true);
      expect(labToggle(page, "Composer predictions").disabled).toBe(true);
    });
    runtimeConfig.state.configLoading = true;
    runtimeConfig.notify();
    await waitForSolid(() => expect(toggle.disabled).toBe(true));
    runtimeConfig.state.configLoading = false;
    runtimeConfig.notify();
    await waitForSolid(() => expect(toggle.disabled).toBe(false));
    toggle.click();
    expect(runtimeConfig.patch).toHaveBeenCalledOnce();
    gateway.setPhase("reconnecting");
    gateway.setPhase("connected");
    await waitForSolid(() => {
      expect(toggle.checked).toBe(false);
      expect(toggle.hasAttribute("aria-disabled")).toBe(false);
      expect(labToggle(page, "Composer predictions").disabled).toBe(false);
    });
    pendingPatch.resolve(false);
    await pendingPatch.promise;
    flush();

    expect(page.querySelector('[role="alert"]')).toBeNull();
    expect(toggle.checked).toBe(false);
  });

  it("releases optimistic save presentation when navigation leaves Labs", async () => {
    const { page, runtimeConfig, router, pendingPatch, toggle } = await startSave();
    await waitForSolid(() => expect(toggle.checked).toBe(true));
    expect(runtimeConfig.patch).toHaveBeenCalledOnce();
    await router.navigate("usage", {});
    await waitForSolid(() => expect(toggle.checked).toBe(false));
    pendingPatch.reject(new Error("Retired save failed"));
    await waitForSolid(() => expect(page.querySelector('[role="alert"]')).toBeNull());
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
      tools: { codeMode: { enabled: "auto" }, swarm: { enabled: false } },
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
    expect(labToggle(page).checked).toBe(expected);
    unmount();
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
    changeToggle(toggle, false);
    await expectPatch(runtimeConfig, { tools: { toolSearch: { enabled: false } } }, "toolSearch");
  });
});

describe("LabsPage Decision assistance", () => {
  it("keeps pending intent scoped through failure", async () => {
    const { page, runtimeConfig, pendingPatch, toggle } = await startSave(
      "Decision assistance",
      {},
    );
    await waitForSolid(() => {
      expect(toggle.checked).toBe(true);
      expect(toggle.hasAttribute("aria-disabled")).toBe(true);
    });
    expect(labRow(page, "Decision assistance").textContent).not.toContain("Preference saved.");
    pendingPatch.resolve(false);
    await pendingPatch.promise;
    await waitForSolid(() => {
      expect(toggle.checked).toBe(false);
      expect(page.querySelector('[role="alert"]')).not.toBeNull();
    });
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
