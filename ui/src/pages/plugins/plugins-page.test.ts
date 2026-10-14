/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { retainGatewayResponsePayload } from "../../../../packages/gateway-client/src/protocol-request.js";
import { buildCapabilityConsentErrorDetails } from "../../../../packages/gateway-protocol/src/capability-consent-error-details.js";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import { pathForPluginCatalogEntry } from "../../app-route-paths.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { i18n } from "../../i18n/index.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import type {
  PluginInstallRequest,
  PluginListResult,
  PluginMutationResult,
} from "../../lib/plugins/index.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
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
    if (method === "plugins.inspect") {
      return createInspectResult();
    }
    if (method === "config.schema") {
      return { schema: { type: "object", properties: {} }, uiHints: {} };
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
      createPluginsRouteData(
        harness.gateway,
        createResult(),
        createPluginsRouteLocation("/settings/plugins/workboard"),
      ),
    );
    await settlePlugins();
    order.length = 0;
    runtimeConfig.patchForm(["pending"], true);
    await clickPluginAction(page, "Enable Workboard");
    await waitForSolid(() => expect(order).toContain("plugins.list"));
    expect(order.slice(0, 4)).toEqual([
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
  } finally {
    runtimeConfig.dispose();
  }
});

it("waits for uninstall confirmation and sends nothing when cancelled", async () => {
  const calls: Array<[string, unknown]> = [];
  const { client } = createClient(async (method, params) => {
    calls.push([method, params]);
    if (method === "plugins.inspect") {
      return createInspectResult({ plugin: removablePlugin() });
    }
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
  const { page } = await mountInventory(
    client,
    createResult([createPlugin(), removablePlugin()]),
    "/settings/plugins/community-thing",
  );

  const confirmation = deferred<boolean>();
  vi.mocked(showConfirmDialog).mockReturnValueOnce(confirmation.promise);
  await clickPluginAction(page, "Uninstall Community Thing");
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

  await clickPluginAction(page, "Uninstall Community Thing");

  await page.updateComplete;
  await waitForSolid(() =>
    expect(page.querySelector('[aria-label="Uninstall Community Thing"]')).toBeNull(),
  );
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
  const { page, harness } = await mountInventory(
    client,
    createResult([createPlugin(), removablePlugin()]),
    "/settings/plugins/community-thing",
  );

  await clickPluginAction(page, "Uninstall Community Thing");
  await waitForSolid(() =>
    expect(request).toHaveBeenCalledWith("plugins.uninstall", { pluginId: "community-thing" }),
  );
  page.routeData = createPluginsRouteData(
    harness.gateway,
    createResult([createPlugin(), removablePlugin()]),
    createPluginsRouteLocation("/settings/plugins/workboard"),
  );
  await clickPluginAction(page, "Enable Workboard");
  await waitForSolid(() => expect(page.textContent).toContain("Enable requires attention."));

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
  expect(page.querySelector(".plugins-row-message--warning")?.textContent).toContain(
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
  const catalog = createDiscoveryDetail(available);
  catalog.plugin.id = "catalog-calendar-runtime";
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
  const { page } = await mountInventory(
    client,
    createResult(available),
    pathForPluginCatalogEntry(catalog.plugin.id),
  );
  await clickPluginAction(page, "Install");
  await waitForSolid(() =>
    expect(page.querySelector('.plugins-row-message[role="alert"]')?.textContent).toContain(
      "The staged plugin changed before installation.",
    ),
  );
  expect(page.querySelector("[data-plugin-consent]")).toBeNull();
  expect(page.querySelector('.plugins-row-message[role="alert"]')?.textContent).toContain(
    "Resolve the reported issue, then select Retry install to try again.",
  );
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
  const { page } = await mountInventory(client, createResult(plugin));

  await clickPluginAction(page, "Enable Workboard");
  await waitForSolid(() =>
    expect(request).toHaveBeenCalledWith("plugins.setEnabled", enableRequest),
  );
  expect(methodCalls(request, "plugins.inspect")).toHaveLength(1);
  expect(page.querySelector("[data-plugin-consent]")).toBeNull();
  enableAttempt.reject(
    new GatewayRequestError({
      code: "INVALID_REQUEST",
      message: "Capability consent required",
      details,
    }),
  );
  await waitForSolid(() => {
    const dialog = page.querySelector('[data-plugin-consent="enable"]');
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
  expect(page.querySelector('[aria-label="Disable Workboard"]')).toBeNull();
  expect(methodCalls(request, "plugins.setEnabled")).toHaveLength(2);

  reinspection.resolve(changedInspection);
  await waitForSolid(() => {
    const dialog = page.querySelector('[data-plugin-consent="enable"]');
    expect(dialog?.textContent).toContain("workboard_manage");
    expect(consentAction(page)?.disabled).toBe(false);
  });
  expect(page.querySelector('[aria-label="Disable Workboard"]')).toBeNull();
  expect(methodCalls(request, "plugins.setEnabled")).toHaveLength(2);

  consentAction(page)?.click();

  await waitForSolid(() =>
    expect(page.querySelector('[aria-label="Disable Workboard"]')).not.toBeNull(),
  );
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
      if (attempts === 2) {
        throw new GatewayRequestError({ code: "UNAVAILABLE", message: "Inspection unavailable" });
      }
      return createInspectResult();
    },
  });
  const { page } = await mountInventory(client, createResult(plugin));

  await clickPluginAction(page, "Enable Workboard");
  await waitForSolid(() =>
    expect(
      page.querySelector('[data-plugin-consent="enable"] [role="alert"]')?.textContent,
    ).toContain("Inspection unavailable"),
  );
  expect(consentAction(page)?.disabled).toBe(true);

  page
    .querySelector<HTMLButtonElement>('[data-plugin-consent="enable"] [role="alert"] .btn')
    ?.click();

  await waitForSolid(() => expect(consentAction(page)?.disabled).toBe(false));
  expect(methodCalls(request, "plugins.inspect")).toHaveLength(3);
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
  const { page, harness } = await mountInventory(client, createResult(plugin));

  await clickPluginAction(page, "Enable Workboard");
  await waitForSolid(() =>
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
  await waitForSolid(() =>
    expect(page.querySelector('[aria-label="Enable Workboard"]')).not.toBeNull(),
  );
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
      return uninstallAttempts === 1
        ? removing.promise
        : { ok: true, pluginId: plugin.id, removed: ["install record"] };
    },
    "plugins.list": () => createResult(uninstallAttempts < 2 ? plugin : []),
  });
  const { page } = await mountInventory(client, createResult(plugin), "/settings/plugins/calendar");
  await waitForSolid(() => expect(page.textContent).toContain("Existing plugin"));
  await clickPluginAction(page, "Uninstall Calendar");
  await waitForSolid(() =>
    expect(request).toHaveBeenCalledWith("plugins.uninstall", { pluginId: plugin.id }),
  );
  expect(inspectionReads).toBe(1);
  removing.reject(
    new GatewayRequestError({ code: "UNAVAILABLE", message: "Plugin removal was refused." }),
  );
  await settlePlugins();
  await waitForSolid(() => expect(page.textContent).toContain("Still installed"));
  expect(page.querySelector('.plugins-row-message[role="alert"]')?.textContent).toContain(
    "Plugin removal was refused.",
  );
  expect(page.querySelector<HTMLButtonElement>('[aria-label="Uninstall Calendar"]')?.disabled).toBe(
    false,
  );
  await clickPluginAction(page, "Uninstall Calendar");
  await waitForSolid(() => expect(uninstallAttempts).toBe(2));
  await waitForSolid(() =>
    expect(page.querySelector('[aria-label="Uninstall Calendar"]')).toBeNull(),
  );
  expect(page.querySelector(".plugins-row-message")).toBeNull();
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
    await waitForSolid(() => expect(page.querySelector("h1")?.textContent).toBe("Calendar"));
    await clickPluginAction(page, "Uninstall Calendar");
    await waitForSolid(() =>
      expect(
        page.querySelector('[aria-label="Uninstall Calendar"]')?.getAttribute("aria-busy"),
      ).toBe("true"),
    );
    if (outcome === "navigated") {
      page.routeData = route(otherCatalog.plugin.id);
      await waitForSolid(() => expect(page.querySelector("h1")?.textContent).toBe("Other"));
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
    await settlePlugins();
    await page.updateComplete;
    expect(missingCatalogReads).toBe(0);
    if (outcome === "removed" || outcome === "failed") {
      await waitForSolid(() =>
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
        await waitForSolid(() =>
          expect(page.querySelector("openclaw-plugin-install-action")).not.toBeNull(),
        );
      } else {
        expect(page.querySelector("h1")?.textContent).toBe("Other");
      }
    }
  },
);

it("rejects uninstall confirmation after Gateway replacement", async () => {
  const result = createResult([createPlugin(), removablePlugin()]);
  const { client: initialClient, request: initialRequest } = createClient(async (method) => {
    if (method === "plugins.inspect") {
      return createInspectResult({ plugin: removablePlugin() });
    }
    throw new Error("The initial Gateway must not receive a request while confirmation is open.");
  });
  const { client: replacementClient, request: replacementRequest } = scriptedClient({
    "plugins.list": () => result,
  });
  const { page, harness } = await mountInventory(
    initialClient,
    result,
    "/settings/plugins/community-thing",
  );
  const confirmation = deferred<boolean>();
  vi.mocked(showConfirmDialog).mockReturnValueOnce(confirmation.promise);

  await clickPluginAction(page, "Uninstall Community Thing");
  await waitForSolid(() => expect(showConfirmDialog).toHaveBeenCalledOnce());
  harness.emit(replacementClient, true);
  confirmation.resolve(true);
  await settlePlugins();

  expect(methodCalls(initialRequest, "plugins.uninstall")).toHaveLength(0);
  expect(methodCalls(replacementRequest, "plugins.uninstall")).toHaveLength(0);
});

it("rejects queued uninstall after Gateway replacement", async () => {
  const result = createResult([createPlugin(), removablePlugin()]);
  const { client, request: gatewayRequest } = scriptedClient({});
  const initialGateway = createGateway(client);
  const { client: replacementClient, request: replacementRequest } = scriptedClient({
    "plugins.list": () => result,
  });
  const config = createQueuedRuntimeConfig(client);
  const { page } = await mountPage(
    createContext(initialGateway.gateway, undefined, undefined, config.harness),
    createPluginsRouteData(
      initialGateway.gateway,
      result,
      createPluginsRouteLocation("/settings/plugins/community-thing"),
    ),
  );

  await clickPluginAction(page, "Uninstall Community Thing");
  await config.queued;
  initialGateway.emit(replacementClient, true);
  await page.updateComplete;
  config.release.resolve();
  await settlePlugins();

  expect(methodCalls(gatewayRequest, "plugins.uninstall")).toHaveLength(0);
  expect(methodCalls(replacementRequest, "plugins.uninstall")).toHaveLength(0);
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
  const catalog = createDiscoveryDetail(available);
  catalog.plugin.id = "catalog-community-thing";
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
  await waitForSolid(() =>
    expect(page.textContent).toContain("Review this plugin before installing it."),
  );
  expect(installCalls).toBe(1);
  expect(showConfirmDialog).not.toHaveBeenCalled();
  harness.emit(client, false);
  harness.emit(client, true);
  await clickPluginAction(page, "Continue installation");
  await waitForSolid(() => expect(page.textContent).toContain("request a fresh review"));
  expect(installCalls).toBe(1);
  await clickPluginAction(page, "Install");
  await waitForSolid(() => expect(installCalls).toBe(2));
  await clickPluginAction(page, "Continue installation");
  await waitForSolid(() => expect(installCalls).toBe(3));
  expect(showConfirmDialog).not.toHaveBeenCalled();
});
