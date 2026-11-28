import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PluginControlUiDiagnostic } from "../../../../packages/gateway-protocol/src/schema/plugins.js";
import {
  CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS,
  CONTROL_UI_PLUGIN_AUTH_PROBE_MESSAGE,
  CONTROL_UI_PLUGIN_AUTH_PROBE_QUERY,
  CONTROL_UI_PLUGIN_AUTH_PROBE_ORIGIN_QUERY,
} from "../../../../src/gateway/control-ui-plugin-frame-contract.js";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationConfigCapability } from "../../app/config.ts";
import type { ApplicationContext } from "../../app/context.ts";
import * as staleChunkReload from "../../app/stale-chunk-reload.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { logbookStatus, logbookTimeline } from "./logbook.test-support.ts";
import { createPage, pluginConfig as externalPluginConfig } from "./plugin-page.test-support.tsx";

type ApplicationConfig = ApplicationConfigCapability["current"];
const cleanups: Array<() => void> = [];
const probeCalls: string[] = [];
let probeResults: Promise<boolean>[] = [];

async function settle() {
  flush();
  await Promise.resolve();
  flush();
}

function createExternalPluginPage(
  refresh: ApplicationConfigCapability["refresh"] = vi.fn(async () => externalPluginConfig()),
  requiresGatewayAuth = true,
  path = "/plugins/external/panel",
) {
  const fixture = createPage(
    [
      {
        pluginId: "external-plugin",
        id: "panel",
        label: "External panel",
        path,
        requiresGatewayAuth,
      },
    ],
    null,
    () =>
      ({ config: { current: externalPluginConfig([]), refresh } }) as unknown as ApplicationContext,
  );
  cleanups.push(fixture.dispose);
  return fixture;
}

function createHungRenewal() {
  let activeRefreshes = 0;
  let maxActiveRefreshes = 0;
  const refresh = vi
    .fn<ApplicationConfigCapability["refresh"]>((options) => {
      const pending = createDeferred<ApplicationConfig | null>();
      activeRefreshes += 1;
      maxActiveRefreshes = Math.max(maxActiveRefreshes, activeRefreshes);
      options?.signal?.addEventListener(
        "abort",
        () => {
          activeRefreshes -= 1;
          pending.resolve(null);
        },
        { once: true },
      );
      return pending.promise;
    })
    .mockResolvedValueOnce(externalPluginConfig());
  return { refresh, maxActiveRefreshes: () => maxActiveRefreshes };
}

beforeEach(() => {
  vi.stubGlobal("isSecureContext", true);
  probeCalls.length = 0;
  probeResults = [];
  const append = document.body.append.bind(document.body);
  vi.spyOn(document.body, "append").mockImplementation((...nodes) => {
    append(...nodes);
    for (const node of nodes) {
      if (!(node instanceof HTMLIFrameElement)) {
        continue;
      }
      const url = new URL(node.src);
      const nonce = url.searchParams.get(CONTROL_UI_PLUGIN_AUTH_PROBE_QUERY);
      if (!nonce) {
        continue;
      }
      url.searchParams.delete(CONTROL_UI_PLUGIN_AUTH_PROBE_QUERY);
      url.searchParams.delete(CONTROL_UI_PLUGIN_AUTH_PROBE_ORIGIN_QUERY);
      probeCalls.push(url.pathname + url.search + url.hash);
      void (probeResults.shift() ?? Promise.resolve(true)).then((available) => {
        if (available && node.isConnected) {
          window.dispatchEvent(
            new MessageEvent("message", {
              source: node.contentWindow,
              data: { type: CONTROL_UI_PLUGIN_AUTH_PROBE_MESSAGE, nonce },
            }),
          );
        }
      });
    }
  });
});

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.doUnmock("./logbook-view.tsx");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("explains the configured native UI opt-out without mistaking a failure for disablement", async () => {
  const pluginId = "custom-review";
  let loading = true;
  const listeners = new Set<() => void>();
  const diagnostics: PluginControlUiDiagnostic[] = [
    { pluginId, message: "Custom plugin UI is off", code: "custom-plugin-ui-disabled" },
  ];
  const plugins = {
    errors: diagnostics,
    registrations: () => [],
    isLoading: () => loading,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const fixture = createPage([], null, () => ({ plugins }) as unknown as ApplicationContext);
  cleanups.push(fixture.dispose);
  const { page, setProps } = fixture;
  setProps({ pluginId, tabId: "notes" });
  await settle();
  expect(page.querySelector('[aria-label="Loading…"]')).not.toBeNull();
  expect(page.textContent).not.toContain("Open Labs");
  loading = false;
  listeners.forEach((listener) => listener());
  await settle();
  expect(page.textContent).toContain("Custom plugin UI is off");
  expect(page.querySelector('a[href$="/settings/labs"]')).toBeNull();
  expect(page.textContent).toContain("Disabled by the Gateway configuration");
  plugins.errors = [{ pluginId, message: "Custom plugin UI is off" }];
  listeners.forEach((listener) => listener());
  await settle();
  expect(page.textContent).toContain("Plugin panel unavailable");
  expect(page.textContent).toContain("Custom plugin UI is off");
  expect(page.textContent).not.toContain("Open Labs");
  setProps({ pluginId: "other-review", tabId: "details" });
  await settle();
  expect(page.textContent).not.toContain("Custom plugin UI is off");
});

it("refreshes parent auth before mounting an external plugin frame", async () => {
  const pendingRefresh = createDeferred<ApplicationConfig | null>();
  const pendingProbe = createDeferred<boolean>();
  probeResults = [pendingProbe.promise];
  const refresh = vi.fn(() => pendingRefresh.promise);
  const { page } = createExternalPluginPage(refresh);
  await settle();
  expect(page.querySelector("iframe")).toBeNull();
  pendingRefresh.resolve(externalPluginConfig());
  await waitForSolid(() => expect(probeCalls).toEqual(["/plugins/external/panel"]));
  expect(page.querySelector("iframe")).toBeNull();
  pendingProbe.resolve(true);
  await waitForSolid(() =>
    expect(page.querySelector("iframe")?.getAttribute("src")).toBe("/plugins/external/panel"),
  );
});

it("uses the development transport for a plugin frame and its auth probe", async () => {
  const basePath = "/openclaw";
  const gatewayUrl = `ws://gateway.example${basePath}`;
  const proxyPath = `/__openclaw_dev_gateway__/${encodeURIComponent(gatewayUrl)}`;
  vi.stubGlobal("OPENCLAW_UI_DEV_GATEWAY", { gatewayUrl, proxyPath });
  const path = `${basePath}/plugins/external/panel?view=activity#settings`;
  const refresh = vi.fn(async () =>
    externalPluginConfig([
      {
        pluginId: "external-plugin",
        path: `${proxyPath}${basePath}/plugins/external`,
        match: "prefix",
      },
    ]),
  );
  const { page } = createExternalPluginPage(refresh, true, path);
  await waitForSolid(() =>
    expect(page.querySelector("iframe")?.getAttribute("src")).toBe(`${proxyPath}${path}`),
  );
  expect(probeCalls).toEqual([`${proxyPath}${path}`]);
});

it.each(["cookie", "grant", "insecure"] as const)(
  "refuses an external frame without %s",
  async (reason) => {
    vi.useFakeTimers();
    vi.stubGlobal("isSecureContext", reason !== "insecure");
    probeResults = [Promise.resolve(false)];
    const refresh = vi.fn(async () =>
      reason === "grant" ? externalPluginConfig([]) : externalPluginConfig(),
    );
    const { page } = createExternalPluginPage(refresh);
    await settle();
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(page.textContent).toContain(
      reason === "insecure" ? "Secure browser context required" : "Plugin panel unavailable",
    );
    expect(page.querySelector("iframe")).toBeNull();
    expect(refresh).toHaveBeenCalledTimes(reason === "insecure" ? 0 : 1);
    expect(probeCalls).toEqual(reason === "cookie" ? ["/plugins/external/panel"] : []);
  },
);

it("renews external plugin auth before the route-bound grant expires", async () => {
  vi.useFakeTimers();
  const refresh = vi.fn(async () => externalPluginConfig());
  const fixture = createExternalPluginPage(refresh);
  await vi.advanceTimersByTimeAsync(0);
  flush();
  expect(refresh).toHaveBeenCalledOnce();
  const frame = fixture.page.querySelector("iframe");
  expect(frame).not.toBeNull();
  await vi.advanceTimersByTimeAsync(CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS / 2);
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(fixture.page.querySelector("iframe")).toBe(frame);
  fixture.dispose();
  await vi.advanceTimersByTimeAsync(CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS);
  expect(refresh).toHaveBeenCalledTimes(2);
});

it.each(["expiry", "resume"] as const)("serially replaces a hung renewal on %s", async (mode) => {
  vi.useFakeTimers({ now: 0 });
  const { refresh, maxActiveRefreshes } = createHungRenewal();
  const { page } = createExternalPluginPage(refresh);
  await vi.advanceTimersByTimeAsync(0);
  flush();
  expect(page.querySelector("iframe")).not.toBeNull();
  await vi.advanceTimersByTimeAsync(CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS / 2);
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(page.querySelector("iframe")).not.toBeNull();
  if (mode === "resume") {
    vi.setSystemTime(new Date(CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS));
    window.document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(refresh).toHaveBeenCalledTimes(3);
  } else {
    await vi.advanceTimersByTimeAsync(CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS / 2);
    flush();
    expect(refresh.mock.calls.length).toBeGreaterThan(2);
  }
  expect(page.querySelector("iframe")).toBeNull();
  expect(maxActiveRefreshes()).toBe(1);
});
type BundledView = (typeof import("./logbook-view.tsx"))["Logbook"];
function setBundledLoad(load: Promise<BundledView>) {
  const started = createDeferred();
  // mock-isolation: Control lazy import settlement without initializing the real Logbook module.
  vi.doMock("./logbook-view.tsx", async () => {
    started.resolve();
    return { Logbook: await load };
  });
  return started.promise;
}

function interpretMockImportError(importError: Error) {
  const isStale = staleChunkReload.isStaleChunkImportError;
  // Vitest wraps mock-factory failures; browsers reject import() with the original error.
  vi.spyOn(staleChunkReload, "isStaleChunkImportError").mockImplementation(
    (error): error is Error =>
      isStale(error) || (error instanceof Error && error.cause === importError),
  );
}

function createBundledPage(client: GatewayBrowserClient | null = null, includeExternal = false) {
  const fixture = createPage(
    [
      { pluginId: "logbook", id: "logbook", label: "Logbook" },
      ...(includeExternal
        ? [{ pluginId: "external-plugin", id: "panel", label: "External panel" }]
        : []),
    ],
    client,
  );
  cleanups.push(fixture.dispose);
  return fixture;
}

async function pendingBundledPage(includeExternal = false) {
  const load = createDeferred<BundledView>();
  const started = setBundledLoad(load.promise);
  const fixture = createBundledPage(null, includeExternal);
  await started;
  return { ...fixture, load };
}

async function retryBundledPage(page: HTMLElement) {
  const load = createDeferred<BundledView>();
  const started = setBundledLoad(load.promise);
  page.querySelector<HTMLButtonElement>('[role="alert"] button')?.click();
  await started;
  return load;
}

function logbookResponse(method: string) {
  return method === "logbook.status"
    ? logbookStatus("2026-07-05", { todayCards: 0 })
    : logbookTimeline("2026-07-05");
}

it.each(["descriptor", "connection"] as const)(
  "retires pending Logbook reads on %s replacement",
  async (change) => {
    await import("./logbook-view.tsx");
    vi.useFakeTimers({ now: new Date(2026, 6, 5, 12).getTime() });
    const pending = createDeferred();
    let held = true;
    const request = vi.fn(async (method: string) => {
      if (held) {
        await pending.promise;
      }
      return logbookResponse(method);
    });
    const fixture = createBundledPage({ request } as unknown as GatewayBrowserClient);
    const tabs = fixture.hello.controlUiTabs;
    const replace = (retired: boolean) => {
      if (change === "descriptor") {
        fixture.hello.controlUiTabs = retired ? [] : tabs;
      } else {
        fixture.snapshot.phase = retired ? "stopped" : "connected";
      }
      fixture.notify();
    };
    await waitForSolid(() => expect(request).toHaveBeenCalledTimes(2));
    replace(true);
    held = false;
    pending.resolve();
    await Promise.all(request.mock.results.map((entry) => entry.value));
    flush();
    expect(fixture.page.querySelector(".logbook__chips")).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(request).toHaveBeenCalledTimes(2);
    replace(false);
    await waitForSolid(() => expect(fixture.page.querySelector(".logbook__chips")).not.toBeNull());
    expect(fixture.page.querySelector(".logbook__day")?.textContent).toBe("2026-07-05");
    expect(request).toHaveBeenCalledTimes(4);
  },
);

it("retries the rejected view and recovers without a Gateway update", async () => {
  const { page, load } = await pendingBundledPage();
  expect(page.querySelector('[role="status"]')).not.toBeNull();
  load.reject(new Error("Logbook chunk failed"));
  await waitForSolid(() =>
    expect(page.querySelector('[role="alert"]')?.textContent).toContain("Logbook chunk failed"),
  );
  const retry = await retryBundledPage(page);
  await settle();
  expect(page.querySelector('[role="alert"]')?.textContent).toContain("Logbook chunk failed");
  retry.resolve(() => "recovered Logbook view");
  await waitForSolid(() => expect(page.textContent).toContain("recovered Logbook view"));
  expect(page.querySelector('[role="alert"]')).toBeNull();
});

it("ignores a retired import rejection before loading a fresh descriptor", async () => {
  const recover = vi.spyOn(staleChunkReload, "scheduleStaleChunkReload").mockResolvedValue(false);
  const failure = new Error("Failed to fetch dynamically imported module");
  interpretMockImportError(failure);
  const fixture = await pendingBundledPage(true);
  fixture.setProps({ pluginId: "external-plugin", tabId: "panel" });
  await settle();
  fixture.load.reject(failure);
  await vi.dynamicImportSettled();
  await settle();
  expect(fixture.page.querySelector('[role="alert"]')).toBeNull();
  expect(recover).not.toHaveBeenCalled();
  const current = createDeferred<BundledView>();
  const currentStarted = setBundledLoad(current.promise);
  fixture.setProps({ pluginId: "logbook", tabId: "logbook" });
  await currentStarted;
  current.resolve(() => "current Logbook view");
  await waitForSolid(() => expect(fixture.page.textContent).toContain("current Logbook view"));
  expect(recover).not.toHaveBeenCalled();
});

it("recovers a stale retry only while its descriptor remains advertised", async () => {
  const recover = vi.spyOn(staleChunkReload, "scheduleStaleChunkReload").mockResolvedValue(false);
  const reload = vi
    .spyOn(staleChunkReload, "retryStaleChunkReloadWhenReachable")
    .mockResolvedValue(false);
  const failure = new Error("Failed to fetch dynamically imported module");
  interpretMockImportError(failure);
  const fixture = await pendingBundledPage();
  fixture.load.reject(new Error("Logbook chunk failed"));
  await waitForSolid(() => expect(fixture.page.querySelector('[role="alert"]')).not.toBeNull());
  const stale = await retryBundledPage(fixture.page);
  stale.reject(failure);
  await waitForSolid(() => expect(recover).toHaveBeenCalledOnce());
  const mayRecover = recover.mock.calls[0]?.[0]?.canReload;
  expect(mayRecover?.()).toBe(true);
  fixture.page.querySelector<HTMLButtonElement>('[role="alert"] button')?.click();
  expect(reload).toHaveBeenCalledOnce();
  fixture.hello.controlUiTabs = [];
  fixture.notify();
  expect(mayRecover?.()).toBe(false);
});
