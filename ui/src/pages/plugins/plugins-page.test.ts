/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { retainGatewayResponsePayload } from "../../../../packages/gateway-client/src/protocol-request.js";
import { buildCapabilityConsentErrorDetails } from "../../../../packages/gateway-protocol/src/capability-consent-error-details.js";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import { pathForPluginCatalogEntry } from "../../app-route-paths.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { i18n } from "../../i18n/index.ts";
import { sourceConfigSnapshot } from "../../lib/config/config-snapshot.test-support.ts";
import type {
  PluginInstallRequest,
  PluginListResult,
  PluginMutationResult,
} from "../../lib/plugins/index.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { queryWithin, runtimeFixture } from "./plugins-page.lifecycle-test-support.ts";
import {
  clickPluginAction,
  createClient,
  createContext,
  createDiscoveryDetail,
  createGateway,
  createInspectResult,
  createPlugin,
  createPluginsRouteData,
  createPluginsRouteLocation,
  createResult,
  createRuntimeConfigHarness,
  mountPage,
  resetPluginsPageTestState,
  settlePlugins,
} from "./plugins-page.test-support.ts";

vi.mock("../../components/confirm-dialog.ts", () => ({ showConfirmDialog: vi.fn() }));
beforeEach(async () => {
  await i18n.setLocale("en");
  vi.mocked(showConfirmDialog).mockReset().mockResolvedValue(true);
});
afterEach(resetPluginsPageTestState);
const enableRequest = { pluginId: "workboard", enabled: true };

function removablePlugin() {
  return createPlugin({
    id: "community-thing",
    name: "Community Thing",
    origin: "global",
    removable: true,
    featured: false,
  });
}

function consentError(reviewToken: string) {
  return new GatewayRequestError({
    code: "INVALID_REQUEST",
    message: "Capability consent required",
    details: buildCapabilityConsentErrorDetails({ pluginId: "workboard", reviewToken }),
  });
}

function consentAction(page: HTMLElement) {
  return page.querySelector<HTMLButtonElement>('[data-plugin-consent="enable"] .btn.primary');
}

const consentSelector = '[data-plugin-consent="enable"]';
const rowAlert = '.plugins-row-message[role="alert"]';
const uninstallLabel = "Uninstall Community Thing";

function routeFor(
  gateway: ReturnType<typeof createGateway>["gateway"],
  result: PluginListResult | null,
  path: string,
) {
  return createPluginsRouteData(gateway, result, createPluginsRouteLocation(path));
}

function unavailable(message: string) {
  return new GatewayRequestError({ code: "UNAVAILABLE", message });
}

function removalResult(pluginId: string) {
  return { ok: true, pluginId, removed: ["install record"] };
}

function availablePlugin(plugin: ReturnType<typeof createPlugin>) {
  return { ...plugin, installed: false, enabled: false, state: "not-installed" as const };
}

function catalogFor(plugin: ReturnType<typeof createPlugin>, id: string, local = false) {
  const catalog = createDiscoveryDetail(plugin);
  catalog.plugin.id = id;
  if (local) {
    catalog.plugin.local.pluginId = plugin.id;
    catalog.detail.origin = "local";
  }
  return catalog;
}

function waitForText(page: HTMLElement, text: string, selector?: string) {
  return waitForSolid(() =>
    expect(selector ? page.querySelector(selector)?.textContent : page.textContent).toContain(text),
  );
}

function methodCalls(request: ReturnType<typeof createClient>["request"], name: string) {
  return request.mock.calls.filter(([method]) => method === name);
}

function scriptedClient(handlers: Record<string, (params: unknown) => unknown>) {
  return createClient(async (method, params) => {
    if (method === "plugins.inspect" && !handlers[method]) {
      return createInspectResult();
    }
    const handler = handlers[method];
    if (!handler) {
      throw new Error(`Unexpected method ${method}`);
    }
    return handler(params);
  });
}

async function mountInventory(
  client: ReturnType<typeof createClient>["client"],
  result: PluginListResult | null = createResult(),
  path = "/settings/plugins/workboard",
) {
  const harness = createGateway(client);
  const context = createContext(harness.gateway);
  const { page } = await mountPage(context, routeFor(harness.gateway, result, path));
  return {
    harness,
    context,
    page,
    find: queryWithin(page),
  };
}

it("flushes a pending config draft before enabling and refreshes afterward", async () => {
  vi.useFakeTimers();
  let config: Record<string, unknown> = { pending: false };
  let hash = "hash-1";
  const enabled = createPlugin({ enabled: true, state: "enabled" });
  const fixture = runtimeFixture({
    "config.get": () => {
      return sourceConfigSnapshot(config, hash);
    },
    "config.set": (params) => {
      config = JSON.parse((params as { raw: string }).raw) as Record<string, unknown>;
      hash = "hash-2";
      return { config, hash };
    },
    "plugins.setEnabled": () => {
      config = { ...config, pluginMutation: "enable" };
      hash = "hash-3";
      return { ok: true, plugin: enabled, restartRequired: true };
    },
    "plugins.inspect": () => {
      return createInspectResult();
    },
    "config.schema": () => {
      return { schema: { type: "object", properties: {} }, uiHints: {} };
    },
    "plugins.list": () => {
      return createResult(enabled);
    },
  });
  const { runtimeConfig } = fixture;
  await runtimeConfig.ensureLoaded();
  const { page } = await fixture.mount();
  await settlePlugins();
  fixture.request.mockClear();
  const order = () => fixture.request.mock.calls.map(([method]) => method);
  runtimeConfig.patchForm(["pending"], true);
  await clickPluginAction(page, "Enable Workboard");
  await waitForSolid(() => expect(order()).toContain("plugins.list"));
  expect(order().slice(0, 4)).toEqual([
    "config.set",
    "plugins.setEnabled",
    "config.get",
    "plugins.list",
  ]);
  expect(runtimeConfig.state.configSnapshot?.hash).toBe("hash-3");
  expect(runtimeConfig.state.configForm).toMatchObject({
    pending: true,
    pluginMutation: "enable",
  });
});

it("waits for uninstall confirmation and sends nothing when cancelled", async () => {
  const { client, request } = scriptedClient({
    "plugins.inspect": () => createInspectResult({ plugin: removablePlugin() }),
    "plugins.uninstall": () => ({
      ...removalResult("community-thing"),
      restartRequired: true,
      warnings: ["Some plugin files could not be removed."],
    }),
    "plugins.list": () => createResult(),
  });
  const calls = request.mock.calls;
  const { page, find } = await mountInventory(
    client,
    createResult([createPlugin(), removablePlugin()]),
    "/settings/plugins/community-thing",
  );

  const confirmation = deferred<boolean>();
  vi.mocked(showConfirmDialog).mockReturnValueOnce(confirmation.promise);
  await clickPluginAction(page, uninstallLabel);
  await waitForSolid(() => expect(showConfirmDialog).toHaveBeenCalledOnce());
  expect(showConfirmDialog).toHaveBeenCalledWith(
    expect.objectContaining({
      title: "Remove Community Thing?",
      danger: true,
    }),
  );
  expect(calls).not.toContainEqual(["plugins.uninstall", { pluginId: "community-thing" }]);

  confirmation.resolve(false);
  await settlePlugins();
  expect(calls).not.toContainEqual(["plugins.uninstall", { pluginId: "community-thing" }]);

  await clickPluginAction(page, uninstallLabel);

  await page.updateComplete;
  await waitForSolid(() => expect(find(`[aria-label="${uninstallLabel}"]`)).toBeNull());
  expect(find(".plugins-row-message--success")).toBeNull();
  expect(find(".plugins-row-message--warning")?.textContent).toContain(
    "Some plugin files could not be removed.",
  );
  expect(page.textContent).not.toContain("Removed Community Thing");
  expect(calls).toContainEqual(["plugins.uninstall", { pluginId: "community-thing" }]);
  expect(calls).toContainEqual(["plugins.list", {}, { signal: expect.any(AbortSignal) }]);
});

it.each([false, true])(
  "presents the requested enabled state and restores it after rejection (enabled=%s)",
  async (enabled) => {
    const pending = deferred<PluginMutationResult>();
    const plugin = createPlugin({ enabled, state: enabled ? "enabled" : "disabled" });
    const { client, request } = scriptedClient({
      "plugins.setEnabled": () => pending.promise,
      "plugins.list": () => createResult(plugin),
    });
    const { page, find } = await mountInventory(client, createResult(plugin));
    const label = `${enabled ? "Disable" : "Enable"} Workboard`;
    await clickPluginAction(page, label);
    const action = () => find<HTMLButtonElement>(`[aria-label="${label}"]`)!;
    await waitForSolid(() => {
      expect(action().disabled).toBe(true);
      expect(action().getAttribute("aria-busy")).toBe("true");
      expect(action().classList.contains("primary")).toBe(enabled);
    });
    action().click();
    expect(methodCalls(request, "plugins.setEnabled")).toHaveLength(1);
    pending.reject(unavailable("Change refused."));
    await waitForSolid(() => {
      expect(page.textContent).toContain("Change refused.");
      expect(action().disabled).toBe(false);
      expect(action().classList.contains("primary")).toBe(!enabled);
    });
  },
);

it("keeps newer notices when an older uninstall completes", async () => {
  const uninstallResult = deferred<unknown>();
  const enabledPlugin = createPlugin({ enabled: true, state: "enabled" });
  const { client, request } = scriptedClient({
    "plugins.uninstall": () => uninstallResult.promise,
    "plugins.setEnabled": () => ({
      ok: true,
      plugin: enabledPlugin,
      restartRequired: false,
      warnings: ["Enable requires attention."],
    }),
    "plugins.list": () => createResult(enabledPlugin),
  });
  const { page, find, harness } = await mountInventory(
    client,
    createResult([createPlugin(), removablePlugin()]),
    "/settings/plugins/community-thing",
  );

  await clickPluginAction(page, uninstallLabel);
  await waitForSolid(() =>
    expect(request).toHaveBeenCalledWith("plugins.uninstall", { pluginId: "community-thing" }),
  );
  page.routeData = routeFor(
    harness.gateway,
    createResult([createPlugin(), removablePlugin()]),
    "/settings/plugins/workboard",
  );
  await clickPluginAction(page, "Enable Workboard");
  await waitForText(page, "Enable requires attention.");

  uninstallResult.resolve({
    ok: true,
    pluginId: "community-thing",
    restartRequired: true,
    removed: ["config entry", "install record", "directory"],
    warnings: ["Old uninstall warning must not replace the newer action."],
  });
  await settlePlugins();
  await page.updateComplete;

  expect(page.textContent).not.toContain(
    "Old uninstall warning must not replace the newer action.",
  );
  expect(page.textContent).not.toContain("Removed Community Thing");
  expect(find(".plugins-row-message--warning")?.textContent).toContain(
    "Enable requires attention.",
  );
});
it("reports rejected artifacts without another confirmation", async () => {
  const installRequest: PluginInstallRequest = {
    source: "official",
    pluginId: "calendar-runtime",
  };
  const available = createPlugin({
    id: "calendar-runtime",
    name: "Calendar Plus",
    origin: "official",
    installed: false,
    state: "not-installed",
    install: installRequest,
  });
  const catalog = catalogFor(available, "catalog-calendar-runtime");
  const { client, request } = createClient(async (method) => {
    if (method === "plugins.catalog.get") {
      return catalog;
    }
    if (method === "plugins.install") {
      const error = new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "The staged plugin changed before installation. Try installing again.",
        details: buildCapabilityConsentErrorDetails({
          pluginId: "calendar-runtime",
          reviewToken: "changed-artifact",
        }),
      });
      retainGatewayResponsePayload(error, undefined);
      throw error;
    }
    throw new Error(`Unexpected method ${method}`);
  });
  const { page, find } = await mountInventory(
    client,
    createResult(available),
    pathForPluginCatalogEntry(catalog.plugin.id),
  );
  await clickPluginAction(page, "Install");
  await waitForSolid(() =>
    expect(find(rowAlert)?.textContent).toContain("The staged plugin changed before installation."),
  );
  expect(find("[data-plugin-consent]")).toBeNull();
  expect(find(rowAlert)?.textContent).toContain(
    "Resolve the reported issue, then select Retry install to try again.",
  );
  expect(methodCalls(request, "plugins.install")).toHaveLength(1);
  expect(request.mock.calls.some(([method]) => method === "plugins.inspect")).toBe(false);
});

it.each(["close", "retry"] as const)("handles inspection failure then %s", async (outcome) => {
  const first = deferred<ReturnType<typeof createInspectResult>>();
  const retry = deferred<ReturnType<typeof createInspectResult>>();
  let inspections = 0;
  const { client, request } = scriptedClient({
    "plugins.inspect": () =>
      ++inspections === 1
        ? createInspectResult()
        : inspections === 2
          ? first.promise
          : retry.promise,
    "plugins.setEnabled": () => {
      throw consentError("review-required");
    },
  });
  const { page, find } = await mountInventory(
    client,
    createResult(createPlugin({ origin: "global" })),
  );
  await clickPluginAction(page, "Enable Workboard");
  const dialog = () => find(consentSelector);
  const loading = () => {
    expect(dialog()?.querySelector('[role="status"]')).not.toBeNull();
    expect(consentAction(page)?.disabled).toBe(true);
  };
  await waitForSolid(loading);
  first.reject(
    outcome === "close"
      ? new Error("Inspection unavailable")
      : unavailable("Inspection unavailable"),
  );
  await waitForText(page, "Inspection unavailable", `${consentSelector} [role="alert"]`);
  expect(consentAction(page)?.disabled).toBe(true);
  dialog()?.querySelector<HTMLButtonElement>('[role="alert"] button')?.click();
  await waitForSolid(() => {
    expect(inspections).toBe(3);
    loading();
  });
  if (outcome === "close") {
    dialog()?.querySelector<HTMLButtonElement>("openclaw-modal-actions button")?.click();
    await waitForSolid(() => expect(dialog()).toBeNull());
  }
  retry.resolve(createInspectResult());
  if (outcome === "close") {
    await settlePlugins();
    expect(dialog()).toBeNull();
  } else {
    await waitForSolid(() => expect(consentAction(page)?.disabled).toBe(false));
  }
  expect(methodCalls(request, "plugins.setEnabled")).toHaveLength(1);
});

it("requires fresh inspection and acknowledgement when a reviewed capability surface changes", async () => {
  const plugin = createPlugin({ origin: "global" });
  const updated = createPlugin({ ...plugin, enabled: true, state: "enabled" });
  const inspection = createInspectResult({
    reviewToken: "fresh-inspected-token",
    plugin: {
      id: "workboard",
      name: "Authoritative Workboard",
      origin: "global",
      installed: true,
      enabled: false,
    },
    declared: { ...createInspectResult().declared, tools: ["workboard_review"] },
  });
  const details = buildCapabilityConsentErrorDetails({
    pluginId: "workboard",
    reviewToken: "older-compact-token",
    widened: { tools: ["workboard_review"] },
    acceptedAt: "2026-08-20T14:03:00Z",
  });
  const changedInspection = createInspectResult({
    ...inspection,
    reviewToken: "changed-inspected-token",
    declared: { ...inspection.declared, tools: ["workboard_review", "workboard_manage"] },
  });
  const enableAttempt = deferred<never>();
  const reinspection = deferred<ReturnType<typeof createInspectResult>>();
  let inspections = 0;
  let acknowledgements = 0;
  const { client, request } = scriptedClient({
    "plugins.inspect": () => {
      inspections += 1;
      return inspections === 1
        ? createInspectResult()
        : inspections === 2
          ? inspection
          : reinspection.promise;
    },
    "plugins.setEnabled": (params) => {
      if (typeof params !== "object" || !params || !("acknowledgeCapabilities" in params)) {
        return enableAttempt.promise;
      }
      if (++acknowledgements === 1) {
        throw consentError("changed-compact-token");
      }
      return { ok: true, plugin: updated, restartRequired: true };
    },
    "plugins.list": () => createResult(updated),
  });
  const { page, find } = await mountInventory(client, createResult(plugin));

  await clickPluginAction(page, "Enable Workboard");
  await waitForSolid(() =>
    expect(request).toHaveBeenCalledWith("plugins.setEnabled", enableRequest),
  );
  expect(methodCalls(request, "plugins.inspect")).toHaveLength(1);
  expect(find("[data-plugin-consent]")).toBeNull();
  enableAttempt.reject(
    new GatewayRequestError({
      code: "INVALID_REQUEST",
      message: "Capability consent required",
      details,
    }),
  );
  await waitForSolid(() => {
    const dialog = find(consentSelector);
    expect(dialog?.textContent).toContain("Authoritative Workboard");
    expect(dialog?.textContent).toContain("workboard_review");
  });
  expect(request).toHaveBeenCalledWith("plugins.inspect", { pluginId: "workboard" });

  consentAction(page)?.click();

  await waitForSolid(() =>
    expect(request).toHaveBeenCalledWith("plugins.setEnabled", {
      pluginId: "workboard",
      enabled: true,
      acknowledgeCapabilities: { reviewToken: inspection.reviewToken },
    }),
  );
  await waitForSolid(() => expect(inspections).toBe(3));
  await page.updateComplete;
  expect(consentAction(page)?.disabled).toBe(true);
  expect(find('[aria-label="Disable Workboard"]')).toBeNull();
  expect(methodCalls(request, "plugins.setEnabled")).toHaveLength(2);

  reinspection.resolve(changedInspection);
  await waitForSolid(() => {
    const dialog = find(consentSelector);
    expect(dialog?.textContent).toContain("workboard_manage");
    expect(consentAction(page)?.disabled).toBe(false);
  });
  expect(find('[aria-label="Disable Workboard"]')).toBeNull();
  expect(methodCalls(request, "plugins.setEnabled")).toHaveLength(2);

  consentAction(page)?.click();

  await waitForSolid(() => expect(find('[aria-label="Disable Workboard"]')).not.toBeNull());
  expect(methodCalls(request, "plugins.setEnabled").map(([, params]) => params)).toEqual([
    enableRequest,
    {
      ...enableRequest,
      acknowledgeCapabilities: { reviewToken: inspection.reviewToken },
    },
    {
      ...enableRequest,
      acknowledgeCapabilities: { reviewToken: changedInspection.reviewToken },
    },
  ]);
  await page.updateComplete;
  expect(find(consentSelector)).toBeNull();
});

it("discards stale consent inspections after reconnect", async () => {
  const plugin = createPlugin({ origin: "global" });
  const pendingInspection = deferred<ReturnType<typeof createInspectResult>>();
  let inspections = 0;
  const { client, request } = scriptedClient({
    "plugins.inspect": () => {
      inspections += 1;
      return inspections === 2
        ? pendingInspection.promise
        : createInspectResult({ reviewToken: "fresh-review" });
    },
    "plugins.setEnabled": (params) => {
      if (typeof params !== "object" || !params || !("acknowledgeCapabilities" in params)) {
        throw consentError("fresh-review");
      }
      return {
        ok: true,
        plugin: createPlugin({ ...plugin, enabled: true, state: "enabled" }),
        restartRequired: true,
      };
    },
    "plugins.list": () => createResult(plugin),
  });
  const { page, find, harness } = await mountInventory(client, createResult(plugin));

  await clickPluginAction(page, "Enable Workboard");
  await waitForSolid(() =>
    expect(find("openclaw-modal-dialog .plugins-consent__hint")).not.toBeNull(),
  );
  harness.emit(client, false);
  harness.emit(client, true);
  pendingInspection.resolve(createInspectResult({ reviewToken: "stale-review" }));
  await page.updateComplete;

  expect(find("openclaw-modal-dialog")).toBeNull();
  expect(methodCalls(request, "plugins.setEnabled").map(([, params]) => params)).toEqual([
    enableRequest,
  ]);
  await waitForSolid(() => expect(find('[aria-label="Enable Workboard"]')).not.toBeNull());
  await clickPluginAction(page, "Enable Workboard");
  await waitForSolid(() => expect(consentAction(page)?.disabled).toBe(false));
  consentAction(page)?.click();

  await waitForSolid(() =>
    expect(request).toHaveBeenCalledWith("plugins.setEnabled", {
      pluginId: "workboard",
      enabled: true,
      acknowledgeCapabilities: { reviewToken: "fresh-review" },
    }),
  );
});
function createQueuedRuntimeConfig(client: ReturnType<typeof createClient>["client"]) {
  const queued = deferred();
  const release = deferred();
  const harness = createRuntimeConfigHarness(
    vi.fn(async () => undefined),
    { configFormDirty: false, lastError: null },
    () => client,
  );
  harness.runtimeConfig.runExternalMutation = async (task, options) => {
    queued.resolve();
    await release.promise;
    if (options?.canDispatch && !options.canDispatch()) {
      return {
        ok: false,
        reason: "unavailable",
        error: options.dispatchError ?? "Mutation scope changed before dispatch.",
      };
    }
    return { ok: true, value: await task(client), refresh: { ok: true } };
  };
  return { harness, queued: queued.promise, release };
}

it("retains a failed uninstall, resumes inspection, and allows retry", async () => {
  const plugin = createPlugin({ id: "calendar", name: "Calendar", removable: true });
  const removing = deferred<never>();
  let inspectionReads = 0;
  let uninstallAttempts = 0;
  const { client, request } = scriptedClient({
    "plugins.inspect": () => {
      inspectionReads += 1;
      return createInspectResult({
        plugin,
        overview: { readme: inspectionReads === 1 ? "# Existing plugin" : "# Still installed" },
      });
    },
    "plugins.uninstall": () => {
      uninstallAttempts += 1;
      return uninstallAttempts === 1 ? removing.promise : removalResult(plugin.id);
    },
    "plugins.list": () => createResult(uninstallAttempts < 2 ? plugin : []),
  });
  const { page, find } = await mountInventory(
    client,
    createResult(plugin),
    "/settings/plugins/calendar",
  );
  await waitForText(page, "Existing plugin");
  await clickPluginAction(page, "Uninstall Calendar");
  await waitForSolid(() =>
    expect(request).toHaveBeenCalledWith("plugins.uninstall", { pluginId: plugin.id }),
  );
  expect(page.textContent).toContain("Existing plugin");
  expect(find<HTMLButtonElement>('[aria-label="Uninstall Calendar"]')?.disabled).toBe(true);
  expect(inspectionReads).toBe(1);
  removing.reject(unavailable("Plugin removal was refused."));
  await settlePlugins();
  await waitForText(page, "Still installed");
  expect(find(rowAlert)?.textContent).toContain("Plugin removal was refused.");
  expect(find<HTMLButtonElement>('[aria-label="Uninstall Calendar"]')?.disabled).toBe(false);
  await clickPluginAction(page, "Uninstall Calendar");
  await waitForSolid(() => expect(uninstallAttempts).toBe(2));
  await waitForSolid(() => expect(find('[aria-label="Uninstall Calendar"]')).toBeNull());
  expect(find(".plugins-row-message")).toBeNull();
});

it.each(["removed", "available", "navigated", "failed"] as const)(
  "reconciles a local discovery uninstall with %s selection",
  async (outcome) => {
    const plugin = createPlugin({
      id: "calendar",
      name: "Calendar",
      origin: outcome === "available" ? "official" : "global",
      removable: true,
    });
    const other = createPlugin({ id: "other", name: "Other" });
    const catalog = catalogFor(plugin, "local_Y2FsZW5kYXI", true);
    const otherCatalog = catalogFor(other, "local_b3RoZXI", true);
    const available = availablePlugin(plugin);
    const removing = deferred<unknown>();
    let removed = false;
    let missingCatalogReads = 0;
    const { client } = scriptedClient({
      "plugins.catalog.get": (params) => {
        if ((params as { id: string }).id === otherCatalog.plugin.id) {
          return otherCatalog;
        }
        if (!removed) {
          return catalog;
        }
        if (outcome !== "available") {
          missingCatalogReads += 1;
          throw new GatewayRequestError({
            code: "INVALID_REQUEST",
            message: "Local plugin not found",
          });
        }
        return {
          ...catalog,
          plugin: {
            ...catalog.plugin,
            local: {
              ...catalog.plugin.local,
              installed: false,
              enabled: false,
              state: "not-installed",
              action: "install",
              install: { source: "official", pluginId: plugin.id },
            },
          },
        };
      },
      "plugins.inspect": (params) =>
        createInspectResult({
          plugin: (params as { pluginId: string }).pluginId === other.id ? other : plugin,
        }),
      "plugins.uninstall": () => removing.promise,
      "plugins.list": () => createResult(outcome === "available" ? [available, other] : [other]),
    });
    const harness = createGateway(client);
    const context = createContext(harness.gateway);
    const route = (id: string) =>
      routeFor(harness.gateway, createResult([plugin, other]), `/plugins/${id}`);
    const { page } = await mountPage(context, route(catalog.plugin.id));
    const find = queryWithin(page);
    await waitForSolid(() => expect(find("h1")?.textContent).toBe("Calendar"));
    await clickPluginAction(page, "Uninstall Calendar");
    await waitForSolid(() =>
      expect(find('[aria-label="Uninstall Calendar"]')?.getAttribute("aria-busy")).toBe("true"),
    );
    if (outcome === "navigated") {
      page.routeData = route(otherCatalog.plugin.id);
      await waitForSolid(() => expect(find("h1")?.textContent).toBe("Other"));
    }
    removed = true;
    if (outcome === "failed") {
      removing.reject(
        new GatewayRequestError({
          code: "UNAVAILABLE",
          message: "Plugin files were removed, but runtime activation failed.",
        }),
      );
    } else {
      removing.resolve(removalResult(plugin.id));
    }
    await settlePlugins();
    await page.updateComplete;
    expect(missingCatalogReads).toBe(0);
    if (outcome === "removed" || outcome === "failed") {
      await waitForSolid(() =>
        expect(context.replace).toHaveBeenCalledWith("plugins", { pathname: "/plugins" }),
      );
      if (outcome === "failed") {
        expect(find(rowAlert)?.textContent).toContain(
          "Plugin files were removed, but runtime activation failed.",
        );
      }
    } else {
      expect(context.replace).not.toHaveBeenCalled();
      if (outcome === "available") {
        await waitForSolid(() => expect(find("openclaw-plugin-install-action")).not.toBeNull());
      } else {
        expect(find("h1")?.textContent).toBe("Other");
      }
    }
  },
);

it.each(["confirmation", "queue"] as const)(
  "rejects uninstall after Gateway replacement during %s",
  async (phase) => {
    const result = createResult([createPlugin(), removablePlugin()]);
    const { client, request } = scriptedClient({
      "plugins.inspect": () =>
        createInspectResult(phase === "confirmation" ? { plugin: removablePlugin() } : {}),
    });
    const initialGateway = createGateway(client);
    const { client: replacementClient, request: replacementRequest } = scriptedClient({
      "plugins.list": () => result,
    });
    const config = phase === "queue" ? createQueuedRuntimeConfig(client) : undefined;
    const { page } = await mountPage(
      createContext(initialGateway.gateway, undefined, undefined, config?.harness),
      routeFor(initialGateway.gateway, result, "/settings/plugins/community-thing"),
    );
    const confirmation = deferred<boolean>();
    if (!config) {
      vi.mocked(showConfirmDialog).mockReturnValueOnce(confirmation.promise);
    }
    await clickPluginAction(page, uninstallLabel);
    if (config) {
      await config.queued;
    } else {
      await waitForSolid(() => expect(showConfirmDialog).toHaveBeenCalledOnce());
    }
    initialGateway.emit(replacementClient, true);
    if (config) {
      await page.updateComplete;
      config.release.resolve();
    } else {
      confirmation.resolve(true);
    }
    await settlePlugins();
    expect(methodCalls(request, "plugins.uninstall")).toHaveLength(0);
    expect(methodCalls(replacementRequest, "plugins.uninstall")).toHaveLength(0);
  },
);

it("requires a fresh install-policy review after reconnect", async () => {
  const available = createPlugin({
    id: "community-thing",
    name: "Community Thing",
    origin: "global",
    installed: false,
    state: "not-installed",
    install: { source: "official", pluginId: "community-thing" },
  });
  const catalog = catalogFor(available, "catalog-community-thing");
  let installCalls = 0;
  const { client } = createClient(async (method, params) => {
    if (method === "plugins.catalog.get") {
      return catalog;
    }
    if (method === "plugins.list") {
      return createResult(available);
    }
    if (method !== "plugins.install") {
      throw new Error(`Unexpected method ${method}`);
    }
    installCalls += 1;
    if (!(params as PluginInstallRequest).acknowledgeInstallPolicyWarning) {
      throw new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "install requires review",
        details: {
          installPolicyCode: "install_policy_warning_acknowledgement_required",
          targetName: "community-thing",
          targetType: "plugin",
          requestMode: "install",
          reason: "Review this plugin before installing it.",
        },
      });
    }
    return {
      ok: true,
      plugin: { ...available, installed: true },
      restartRequired: true,
    } satisfies PluginMutationResult;
  });
  const { page, harness } = await mountInventory(
    client,
    createResult(available),
    pathForPluginCatalogEntry(catalog.plugin.id),
  );

  await clickPluginAction(page, "Install");
  await waitForText(page, "Review this plugin before installing it.");
  expect(installCalls).toBe(1);
  expect(showConfirmDialog).not.toHaveBeenCalled();
  harness.emit(client, false);
  harness.emit(client, true);
  await clickPluginAction(page, "Continue installation");
  await waitForText(page, "request a fresh review");
  expect(installCalls).toBe(1);
  await clickPluginAction(page, "Install");
  await waitForSolid(() => expect(installCalls).toBe(2));
  await waitForSolid(() => {
    const continueButton = [...page.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Continue installation",
    );
    expect(continueButton?.disabled).toBe(false);
  });
  await clickPluginAction(page, "Continue installation");
  await waitForSolid(() => expect(installCalls).toBe(3));
  expect(showConfirmDialog).not.toHaveBeenCalled();
});

it.each(["settled", "navigated"] as const)(
  "restores removed-plugin focus for a %s catalog read",
  async (outcome) => {
    const plugin = createPlugin({
      id: "calendar",
      name: "Calendar",
      origin: "official",
      removable: true,
      catalogId: "catalog-calendar",
    });
    const available = availablePlugin(plugin);
    const catalog = catalogFor(plugin, "catalog-calendar");
    const refreshed = catalogFor(available, catalog.plugin.id);
    const other = createPlugin({ id: "other", name: "Other", installed: false });
    const otherCatalog = catalogFor(other, "catalog-other");
    const pending = deferred<unknown>();
    let removed = false;
    const { client, request } = scriptedClient({
      // SAFETY: the catalog loader passes its validated request shape to this test client.
      "plugins.catalog.get": (params) =>
        (params as { id: string }).id === otherCatalog.plugin.id
          ? otherCatalog
          : removed
            ? pending.promise
            : catalog,
      "plugins.inspect": () => createInspectResult({ plugin }),
      "plugins.uninstall": () => {
        removed = true;
        return removalResult(plugin.id);
      },
      "plugins.list": () => createResult(removed ? available : plugin),
    });
    const harness = createGateway(client);
    const { page } = await mountPage(
      createContext(harness.gateway),
      routeFor(harness.gateway, createResult(plugin), pathForPluginCatalogEntry(catalog.plugin.id)),
    );
    const find = queryWithin(page);
    await waitForSolid(() => expect(find('[aria-label="Uninstall Calendar"]')).not.toBeNull());
    // SAFETY: waitForSolid above established the control exists before focus is exercised.
    const trigger = find<HTMLButtonElement>('[aria-label="Uninstall Calendar"]')!;
    const readsBefore = methodCalls(request, "plugins.catalog.get").length;
    trigger.focus();
    await clickPluginAction(page, "Uninstall Calendar");
    await waitForSolid(() =>
      expect(methodCalls(request, "plugins.catalog.get")).toHaveLength(readsBefore + 1),
    );
    if (outcome === "navigated") {
      page.routeData = routeFor(
        harness.gateway,
        createResult(other),
        pathForPluginCatalogEntry(otherCatalog.plugin.id),
      );
      await waitForSolid(() => expect(find("h1")?.textContent).toBe("Other"));
      pending.reject(new Error("Retired detail"));
      await settlePlugins();
      expect(document.activeElement).toBe(document.body);
      expect(page.textContent).not.toContain("Retired detail");
    } else {
      pending.resolve(refreshed);
      await waitForSolid(() => {
        const title = find("h1");
        expect(title?.textContent).toBe("Calendar");
        expect(document.activeElement).toBe(title);
      });
      expect(methodCalls(request, "plugins.catalog.get")).toHaveLength(readsBefore + 1);
    }
    expect(find('[aria-label="Uninstall Calendar"]')).toBeNull();
  },
);
