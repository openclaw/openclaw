/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { retainGatewayResponsePayload } from "../../../../packages/gateway-client/src/protocol-request.js";
import { buildCapabilityConsentErrorDetails } from "../../../../packages/gateway-protocol/src/capability-consent-error-details.js";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { i18n } from "../../i18n/index.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import type {
  PluginInstallRequest,
  PluginListResult,
  PluginMutationResult,
} from "../../lib/plugins/index.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  activatePluginControl,
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

function methodCalls(request: ReturnType<typeof createClient>["request"], name: string) {
  return request.mock.calls.filter(([method]) => method === name);
}

function scriptedClient(handlers: Record<string, (params: unknown) => unknown>) {
  return createClient(async (method, params) => {
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
  path = "/settings/plugins",
) {
  const harness = createGateway(client);
  return {
    harness,
    ...(await mountPage(
      createContext(harness.gateway),
      createPluginsRouteData(harness.gateway, result, createPluginsRouteLocation(path)),
    )),
  };
}

it("flushes a pending config draft before enabling and refreshes afterward", async () => {
  vi.useFakeTimers();
  const order: string[] = [];
  let config: Record<string, unknown> = { pending: false };
  let hash = "hash-1";
  const enabled = createPlugin({ enabled: true, state: "enabled" });
  const { client } = createClient(async (method, params) => {
    order.push(method);
    if (method === "config.get") {
      return {
        config,
        sourceConfig: config,
        raw: JSON.stringify(config),
        hash,
        valid: true,
        issues: [],
      };
    }
    if (method === "config.set") {
      config = JSON.parse((params as { raw: string }).raw) as Record<string, unknown>;
      hash = "hash-2";
      return { config, hash };
    }
    if (method === "plugins.setEnabled") {
      config = { ...config, pluginMutation: "enable" };
      hash = "hash-3";
      return { ok: true, plugin: enabled, restartRequired: true };
    }
    if (method === "plugins.list") {
      return createResult(enabled);
    }
    throw new Error(`Unexpected method ${method}`);
  });
  const harness = createGateway(client);
  const runtimeConfig = createRuntimeConfigCapability(harness.gateway);
  try {
    await runtimeConfig.ensureLoaded();
    const { page } = await mountPage(
      { ...createContext(harness.gateway), runtimeConfig },
      createPluginsRouteData(harness.gateway),
    );
    order.length = 0;
    runtimeConfig.patchForm(["pending"], true);
    await page.consentController.mutateInstalledPlugin("workboard", "enable");
    expect(order).toEqual(["config.set", "plugins.setEnabled", "config.get", "plugins.list"]);
    expect(runtimeConfig.state.configSnapshot?.hash).toBe("hash-3");
    expect(runtimeConfig.state.configForm).toMatchObject({
      pending: true,
      pluginMutation: "enable",
    });
  } finally {
    runtimeConfig.dispose();
  }
});

it("keeps the enable action retryable after a failed enable", async () => {
  const { client, request } = scriptedClient({
    "plugins.setEnabled": () => {
      throw new Error("Enable failed");
    },
  });
  const { page } = await mountInventory(client);

  await activatePluginControl(page, '[data-plugin-id="workboard"]', "Enable or disable");
  await waitForFast(() =>
    expect(page.querySelector('[role="alert"]')?.textContent).toContain("Enable failed"),
  );

  await activatePluginControl(page, '[data-plugin-id="workboard"]', "Enable or disable");
  await waitForFast(() => {
    const calls = methodCalls(request, "plugins.setEnabled");
    expect(calls).toHaveLength(2);
    expect(calls.map(([, params]) => params)).toEqual([enableRequest, enableRequest]);
  });
});

it("waits for uninstall confirmation and sends nothing when cancelled", async () => {
  const calls: Array<[string, unknown]> = [];
  const { client } = createClient(async (method, params) => {
    calls.push([method, params]);
    if (method === "plugins.uninstall") {
      return {
        ok: true,
        pluginId: "community-thing",
        restartRequired: true,
        removed: ["config entry", "install record"],
        warnings: ["Some plugin files could not be removed."],
      };
    }
    if (method === "plugins.list") {
      return createResult();
    }
    throw new Error(`Unexpected method ${method}`);
  });
  const { page } = await mountInventory(client, createResult([createPlugin(), removablePlugin()]));

  const confirmation = deferred<boolean>();
  vi.mocked(showConfirmDialog).mockReturnValueOnce(confirmation.promise);
  const cancelledUninstall = page.uninstall("community-thing", "plugin:community-thing");
  await waitForFast(() => expect(showConfirmDialog).toHaveBeenCalledOnce());
  expect(showConfirmDialog).toHaveBeenCalledWith(
    expect.objectContaining({
      title: "Remove Community Thing?",
      danger: true,
    }),
  );
  expect(calls).not.toContainEqual(["plugins.uninstall", { pluginId: "community-thing" }]);

  confirmation.resolve(false);
  await cancelledUninstall;
  expect(calls).not.toContainEqual(["plugins.uninstall", { pluginId: "community-thing" }]);

  await page.uninstall("community-thing", "plugin:community-thing");

  await page.updateComplete;
  expect(page.result?.plugins.some((plugin) => plugin.id === "community-thing")).toBe(false);
  expect(page.querySelector(".plugins-row-message--success")).toBeNull();
  expect(page.querySelector(".plugins-row-message--warning")?.textContent).toContain(
    "Some plugin files could not be removed.",
  );
  expect(page.textContent).not.toContain("Removed Community Thing");
  expect(calls).toContainEqual(["plugins.uninstall", { pluginId: "community-thing" }]);
  expect(calls).toContainEqual(["plugins.list", {}]);
});

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
  const { page } = await mountInventory(client, createResult([createPlugin(), removablePlugin()]));

  const uninstall = page.uninstall("community-thing", "plugin:community-thing");
  await waitForFast(() =>
    expect(request).toHaveBeenCalledWith("plugins.uninstall", { pluginId: "community-thing" }),
  );
  await page.consentController.mutateInstalledPlugin("workboard", "enable");

  uninstallResult.resolve({
    ok: true,
    pluginId: "community-thing",
    restartRequired: true,
    removed: ["config entry", "install record", "directory"],
    warnings: ["Old uninstall warning must not replace the newer action."],
  });
  await uninstall;
  await page.updateComplete;

  expect(page.textContent).not.toContain(
    "Old uninstall warning must not replace the newer action.",
  );
  expect(page.textContent).not.toContain("Removed Community Thing");
  expect(page.messages["plugin:workboard"]).toEqual({
    kind: "warning",
    text: "Enable requires attention.",
  });
});
it("reports rejected artifacts without another confirmation", async () => {
  const installRequest: PluginInstallRequest = {
    source: "official",
    pluginId: "calendar-runtime",
  };
  const { client, request } = createClient(async (method) => {
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
  const { page } = await mountInventory(
    client,
    createResult(
      createPlugin({
        id: "calendar-runtime",
        name: "Calendar Plus",
        origin: "official",
        installed: false,
        state: "not-installed",
        install: installRequest,
      }),
    ),
    "/settings/plugins/discover",
  );
  await page.consentController.install(installRequest, "plugin:calendar-runtime");
  await page.updateComplete;
  expect(page.querySelector("[data-plugin-consent]")).toBeNull();
  expect(page.messages["plugin:calendar-runtime"]).toMatchObject({
    kind: "error",
    text: "Resolve the reported issue, then select Retry install to try again.\nThe staged plugin changed before installation. Try installing again.",
  });
  expect(methodCalls(request, "plugins.install")).toHaveLength(1);
  expect(request.mock.calls.some(([method]) => method === "plugins.inspect")).toBe(false);
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
    "plugins.inspect": () => (++inspections === 1 ? inspection : reinspection.promise),
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
  const { page } = await mountInventory(client, createResult(plugin));

  await activatePluginControl(page, '[data-plugin-id="workboard"]', "Enable");
  await waitForFast(() =>
    expect(request).toHaveBeenCalledWith("plugins.setEnabled", enableRequest),
  );
  expect(request.mock.calls.some(([method]) => method === "plugins.inspect")).toBe(false);
  expect(page.querySelector("[data-plugin-consent]")).toBeNull();
  enableAttempt.reject(
    new GatewayRequestError({
      code: "INVALID_REQUEST",
      message: "Capability consent required",
      details,
    }),
  );
  await waitForFast(() => {
    const dialog = page.querySelector('[data-plugin-consent="enable"]');
    expect(dialog?.textContent).toContain("Authoritative Workboard");
    expect(dialog?.textContent).toContain("workboard_review");
  });
  expect(request).toHaveBeenCalledWith("plugins.inspect", { pluginId: "workboard" });

  consentAction(page)?.click();

  await waitForFast(() =>
    expect(request).toHaveBeenCalledWith("plugins.setEnabled", {
      pluginId: "workboard",
      enabled: true,
      acknowledgeCapabilities: { reviewToken: inspection.reviewToken },
    }),
  );
  await waitForFast(() => expect(inspections).toBe(2));
  await page.updateComplete;
  expect(consentAction(page)?.disabled).toBe(true);
  expect(page.result?.plugins[0]?.enabled).toBe(false);
  expect(methodCalls(request, "plugins.setEnabled")).toHaveLength(2);

  reinspection.resolve(changedInspection);
  await waitForFast(() => {
    const dialog = page.querySelector('[data-plugin-consent="enable"]');
    expect(dialog?.textContent).toContain("workboard_manage");
    expect(consentAction(page)?.disabled).toBe(false);
  });
  expect(page.result?.plugins[0]?.enabled).toBe(false);
  expect(methodCalls(request, "plugins.setEnabled")).toHaveLength(2);

  consentAction(page)?.click();

  await waitForFast(() => expect(page.result?.plugins[0]?.enabled).toBe(true));
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
  expect(page.querySelector('[data-plugin-consent="enable"]')).toBeNull();
});

it("blocks consent until inspection retry succeeds", async () => {
  const plugin = createPlugin({ origin: "global" });
  let attempts = 0;
  const { client, request } = scriptedClient({
    "plugins.setEnabled": () => {
      throw consentError("review-token-workboard");
    },
    "plugins.inspect": () => {
      attempts += 1;
      if (attempts === 1) {
        throw new GatewayRequestError({ code: "UNAVAILABLE", message: "Inspection unavailable" });
      }
      return createInspectResult();
    },
  });
  const { page } = await mountInventory(client, createResult(plugin));

  await activatePluginControl(page, '[data-plugin-id="workboard"]', "Enable");
  await waitForFast(() =>
    expect(
      page.querySelector('[data-plugin-consent="enable"] [role="alert"]')?.textContent,
    ).toContain("Inspection unavailable"),
  );
  expect(consentAction(page)?.disabled).toBe(true);

  page
    .querySelector<HTMLButtonElement>('[data-plugin-consent="enable"] [role="alert"] .btn')
    ?.click();

  await waitForFast(() => expect(consentAction(page)?.disabled).toBe(false));
  expect(methodCalls(request, "plugins.inspect")).toHaveLength(2);
});

it("discards stale consent inspections after reconnect", async () => {
  const plugin = createPlugin({ origin: "global" });
  const pendingInspection = deferred<ReturnType<typeof createInspectResult>>();
  let inspections = 0;
  const { client, request } = scriptedClient({
    "plugins.inspect": () => {
      inspections += 1;
      return inspections === 1
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
  const { page, harness } = await mountInventory(client, createResult(plugin));

  await activatePluginControl(page, '[data-plugin-id="workboard"]', "Enable");
  await waitForFast(() =>
    expect(page.querySelector("openclaw-modal-dialog .plugins-consent__hint")).not.toBeNull(),
  );
  harness.emit(client, false);
  harness.emit(client, true);
  pendingInspection.resolve(createInspectResult({ reviewToken: "stale-review" }));
  await page.updateComplete;

  expect(page.querySelector("openclaw-modal-dialog")).toBeNull();
  expect(methodCalls(request, "plugins.setEnabled").map(([, params]) => params)).toEqual([
    enableRequest,
  ]);
  await waitForFast(() =>
    expect(page.querySelector('[data-plugin-id="workboard"]')).not.toBeNull(),
  );
  await activatePluginControl(page, '[data-plugin-id="workboard"]', "Enable");
  await waitForFast(() => expect(consentAction(page)?.disabled).toBe(false));
  consentAction(page)?.click();

  await waitForFast(() =>
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

it("installs directly, preserves warnings, and rejects duplicate submission", async () => {
  const warnings = ["A plugin service needs attention."];
  const offered = createPlugin({
    id: "calendar",
    name: "Calendar",
    packageName: "calendar",
    installed: false,
    state: "not-installed",
    removable: true,
  });
  const detail = createDiscoveryDetail(offered);
  detail.plugin.id = "ch_Y2FsZW5kYXI";
  const committed = {
    ...offered,
    installed: true,
    state: "disabled" as const,
    catalogId: detail.plugin.id,
  };
  const installing = deferred<PluginMutationResult>();
  const { client, request } = scriptedClient({
    "plugins.catalog.get": () => detail,
    "plugins.install": () => installing.promise,
    "plugins.list": () => createResult(committed),
    "plugins.inspect": () => createInspectResult({ plugin: committed }),
  });
  const { page } = await mountInventory(
    client,
    createResult(offered),
    `/plugins/${detail.plugin.id}`,
  );
  await waitForFast(() =>
    expect(page.querySelector(".plugin-catalog-detail__install")).not.toBeNull(),
  );
  page.querySelector<HTMLButtonElement>(".plugin-catalog-detail__install")!.click();
  await waitForFast(() =>
    expect(request).toHaveBeenCalledWith(
      "plugins.install",
      {
        source: "clawhub",
        packageName: "calendar",
      },
      expect.objectContaining({ onSent: expect.any(Function) }),
    ),
  );
  expect(showConfirmDialog).not.toHaveBeenCalled();
  expect(page.querySelector("openclaw-modal-dialog")).toBeNull();
  expect(page.querySelector<HTMLButtonElement>(".plugin-catalog-detail__install")?.disabled).toBe(
    false,
  );
  page.querySelector<HTMLButtonElement>(".plugin-catalog-detail__install")!.click();
  expect(methodCalls(request, "plugins.install")).toHaveLength(1);
  installing.resolve({ ok: true, plugin: committed, restartRequired: false, warnings });
  await waitForFast(() =>
    expect(page.querySelector('[aria-label="Enable Calendar"]')).not.toBeNull(),
  );
  expect(page.textContent).not.toContain("Installed Calendar.");
  expect(page.messages["plugin:calendar"]).toEqual({ kind: "warning", text: warnings[0] });
  expect(request.mock.calls.some(([method]) => method === "plugins.setEnabled")).toBe(false);
  expect(
    [
      ...page.querySelectorAll(
        ".plugin-catalog-detail__actions button, .plugin-catalog-detail__actions a",
      ),
    ].map((element) => element.getAttribute("aria-label")),
  ).toEqual(["Enable Calendar", "Uninstall Calendar", "Settings"]);
});

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
      return uninstallAttempts === 1
        ? removing.promise
        : { ok: true, pluginId: plugin.id, removed: ["install record"] };
    },
    "plugins.list": () => createResult(uninstallAttempts < 2 ? plugin : []),
  });
  const { page } = await mountInventory(client, createResult(plugin), "/settings/plugins/calendar");
  await waitForFast(() => expect(page.textContent).toContain("Existing plugin"));
  const uninstall = page.uninstall(plugin.id, "plugin:calendar");
  await waitForFast(() =>
    expect(request).toHaveBeenCalledWith("plugins.uninstall", { pluginId: plugin.id }),
  );
  expect(inspectionReads).toBe(1);
  removing.reject(
    new GatewayRequestError({ code: "UNAVAILABLE", message: "Plugin removal was refused." }),
  );
  await uninstall;
  await waitForFast(() => expect(page.textContent).toContain("Still installed"));
  expect(page.querySelector('.plugins-row-message[role="alert"]')?.textContent).toContain(
    "Plugin removal was refused.",
  );
  expect(page.busy["plugin:calendar"]).toBeUndefined();
  expect(page.querySelector<HTMLButtonElement>('[aria-label="Uninstall Calendar"]')?.disabled).toBe(
    false,
  );
  await page.uninstall(plugin.id, "plugin:calendar");
  expect(uninstallAttempts).toBe(2);
  expect(page.result?.plugins).toEqual([]);
  expect(page.messages["plugin:calendar"]).toBeUndefined();
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
    const catalog = createDiscoveryDetail(plugin);
    catalog.plugin.id = "local_Y2FsZW5kYXI";
    catalog.plugin.local.pluginId = plugin.id;
    catalog.plugin.local.action = "manage";
    catalog.detail.origin = "local";
    const otherCatalog = createDiscoveryDetail(other);
    otherCatalog.plugin.id = "local_b3RoZXI";
    otherCatalog.plugin.local.pluginId = other.id;
    otherCatalog.detail.origin = "local";
    const available = {
      ...plugin,
      installed: false,
      enabled: false,
      state: "not-installed" as const,
    };
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
      createPluginsRouteData(
        harness.gateway,
        createResult([plugin, other]),
        createPluginsRouteLocation(`/plugins/${id}`),
      );
    const { page } = await mountPage(context, route(catalog.plugin.id));
    await waitForFast(() => expect(page.detail?.inspection?.plugin.id).toBe(plugin.id));
    const uninstall = page.uninstall(plugin.id, "plugin:calendar");
    await waitForFast(() => expect(page.busy["plugin:calendar"]).toBe("uninstall"));
    if (outcome === "navigated") {
      page.routeData = route(otherCatalog.plugin.id);
      await waitForFast(() => expect(page.detail?.inspection?.plugin.id).toBe(other.id));
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
      removing.resolve({ ok: true, pluginId: plugin.id, removed: ["install record"] });
    }
    await uninstall;
    await page.updateComplete;
    expect(missingCatalogReads).toBe(0);
    if (outcome === "removed" || outcome === "failed") {
      await waitForFast(() =>
        expect(context.replace).toHaveBeenCalledWith("plugins", { pathname: "/plugins" }),
      );
      if (outcome === "failed") {
        expect(page.querySelector('.plugins-row-message[role="alert"]')?.textContent).toContain(
          "Plugin files were removed, but runtime activation failed.",
        );
      }
    } else {
      expect(context.replace).not.toHaveBeenCalled();
      if (outcome === "available") {
        await waitForFast(() =>
          expect(page.querySelector("openclaw-plugin-install-action")).not.toBeNull(),
        );
      } else {
        expect(page.detail?.pluginId).toBe(other.id);
      }
    }
  },
);

it("rejects uninstall confirmation after Gateway replacement", async () => {
  const result = createResult([createPlugin(), removablePlugin()]);
  const { client: initialClient, request: initialRequest } = createClient(async () => {
    throw new Error("The initial Gateway must not receive a request while confirmation is open.");
  });
  const { client: replacementClient, request: replacementRequest } = scriptedClient({
    "plugins.list": () => result,
  });
  const { page, harness } = await mountInventory(initialClient, result);
  const confirmation = deferred<boolean>();
  vi.mocked(showConfirmDialog).mockReturnValueOnce(confirmation.promise);

  const uninstall = page.uninstall("community-thing", "plugin:community-thing");
  await waitForFast(() => expect(showConfirmDialog).toHaveBeenCalledOnce());
  harness.emit(replacementClient, true);
  confirmation.resolve(true);
  await uninstall;

  expect(methodCalls(initialRequest, "plugins.uninstall")).toHaveLength(0);
  expect(methodCalls(replacementRequest, "plugins.uninstall")).toHaveLength(0);
});

it("rejects queued uninstall after Gateway replacement", async () => {
  const result = createResult([createPlugin(), removablePlugin()]);
  const { client, request: gatewayRequest } = scriptedClient({});
  const initialGateway = createGateway(client);
  const replacementGateway = createGateway(client);
  const config = createQueuedRuntimeConfig(client);
  const { page, provider } = await mountPage(
    createContext(initialGateway.gateway, undefined, undefined, config.harness),
    createPluginsRouteData(initialGateway.gateway, result),
  );

  const uninstall = page.uninstall("community-thing", "plugin:community-thing");
  await config.queued;
  provider.setContext(
    createContext(replacementGateway.gateway, undefined, undefined, config.harness),
  );
  await page.updateComplete;
  config.release.resolve();
  await uninstall;

  expect(methodCalls(gatewayRequest, "plugins.uninstall")).toHaveLength(0);
});

it("requires a fresh install-policy review after reconnect", async () => {
  const available = createPlugin({
    id: "community-thing",
    name: "Community Thing",
    origin: "global",
    installed: false,
    state: "not-installed",
    install: { source: "official", pluginId: "community-thing" },
  });
  let installCalls = 0;
  const { client } = createClient(async (method, params) => {
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
  const { page, harness } = await mountInventory(client, createResult(available));
  const request = {
    source: "official",
    pluginId: "community-thing",
  } satisfies PluginInstallRequest;

  await page.consentController.install(request, "plugin:community-thing");
  expect(installCalls).toBe(1);
  expect(showConfirmDialog).not.toHaveBeenCalled();
  harness.emit(client, false);
  harness.emit(client, true);
  await page.consentController.install(
    { ...request, acknowledgeInstallPolicyWarning: true },
    "plugin:community-thing",
  );
  expect(installCalls).toBe(1);
  expect(page.messages["plugin:community-thing"]?.text).toContain("request a fresh review");
  await page.consentController.install(request, "plugin:community-thing");
  expect(installCalls).toBe(2);
  await page.consentController.install(
    { ...request, acknowledgeInstallPolicyWarning: true },
    "plugin:community-thing",
  );
  expect(installCalls).toBe(3);
  expect(showConfirmDialog).not.toHaveBeenCalled();
});
