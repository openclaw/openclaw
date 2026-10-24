/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { retainGatewayResponsePayload } from "../../../../packages/gateway-client/src/protocol-request.js";
import { buildCapabilityConsentErrorDetails } from "../../../../packages/gateway-protocol/src/capability-consent-error-details.js";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import { pathForPluginCatalogEntry } from "../../app-route-paths.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { i18n } from "../../i18n/index.ts";
import type { PluginInstallRequest, PluginMutationResult } from "../../lib/plugins/index.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { pageFixture } from "./plugins-page.lifecycle-test-support.ts";
import {
  clickPluginAction,
  createContext,
  createDiscoveryDetail,
  createInspectResult,
  createPlugin,
  createResult,
  createRuntimeConfigHarness,
  mountPage,
  resetPluginsPageTestState,
  settlePlugins,
} from "./plugins-page.test-support.ts";

vi.mock("../../components/confirm-dialog.ts", () => ({ showConfirmDialog: vi.fn() }));
let plugin: ReturnType<typeof createPlugin>;
let removable: ReturnType<typeof createPlugin>;
beforeEach(async () => {
  await i18n.setLocale("en");
  vi.mocked(showConfirmDialog).mockReset().mockResolvedValue(true);
  plugin = createPlugin({ origin: "global" });
  removable = createPlugin({
    id: "community-thing",
    name: "Community Thing",
    origin: "global",
    removable: true,
    featured: false,
  });
});
afterEach(resetPluginsPageTestState);

const enableRequest = { pluginId: "workboard", enabled: true };
const consentSelector = '[data-plugin-consent="enable"]';
const rowAlert = '.plugins-row-message[role="alert"]';
const uninstallLabel = "Uninstall Community Thing";
const communityPath = "/settings/plugins/community-thing";
const calendarAction = '[aria-label="Uninstall Calendar"]';

function fixture(handlers: Parameters<typeof pageFixture>[0]) {
  return pageFixture({ "plugins.inspect": () => createInspectResult(), ...handlers });
}
function consentError(reviewToken: string) {
  return new GatewayRequestError({
    code: "INVALID_REQUEST",
    message: "Capability consent required",
    details: buildCapabilityConsentErrorDetails({ pluginId: "workboard", reviewToken }),
  });
}
function consentAction(page: HTMLElement) {
  return page.querySelector<HTMLButtonElement>(`${consentSelector} .btn.primary`);
}
function unavailable(message: string) {
  return new GatewayRequestError({ code: "UNAVAILABLE", message });
}
function removalResult(pluginId: string) {
  return { ok: true, pluginId, removed: ["install record"] };
}
function availablePlugin(value: ReturnType<typeof createPlugin>) {
  return { ...value, installed: false, enabled: false, state: "not-installed" as const };
}
function catalogFor(value: ReturnType<typeof createPlugin>, id: string, local = false) {
  const catalog = createDiscoveryDetail(value);
  catalog.plugin.id = id;
  if (local) {
    catalog.plugin.local.pluginId = value.id;
    catalog.detail.origin = "local";
  }
  return catalog;
}
function waitForText(page: HTMLElement, text: string, selector?: string) {
  return waitForSolid(() =>
    expect(selector ? page.querySelector(selector)?.textContent : page.textContent).toContain(text),
  );
}

it("waits for uninstall confirmation, respects cancellation, and retains removal warnings", async () => {
  const h = fixture({
    "plugins.inspect": () => createInspectResult({ plugin: removable }),
    "plugins.uninstall": () => ({
      ...removalResult(removable.id),
      warnings: ["Some plugin files could not be removed."],
    }),
    "plugins.list": () => createResult(),
  });
  const { page, find } = await h.mount(communityPath, createResult([createPlugin(), removable]));
  const confirmation = deferred<boolean>();
  vi.mocked(showConfirmDialog).mockReturnValueOnce(confirmation.promise);
  await clickPluginAction(page, uninstallLabel);
  await waitForSolid(() => expect(showConfirmDialog).toHaveBeenCalledOnce());
  expect(showConfirmDialog).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Remove Community Thing?", danger: true }),
  );
  expect(h.calls("plugins.uninstall")).toHaveLength(0);
  confirmation.resolve(false);
  await settlePlugins();
  expect(h.calls("plugins.uninstall")).toHaveLength(0);
  await clickPluginAction(page, uninstallLabel);
  await waitForSolid(() => expect(find(`[aria-label="${uninstallLabel}"]`)).toBeNull());
  expect(find(".plugins-row-message--warning")?.textContent).toContain(
    "Some plugin files could not be removed.",
  );
  expect(page.textContent).not.toContain("Removed Community Thing");
  expect(h.request).toHaveBeenCalledWith("plugins.uninstall", { pluginId: removable.id });
});

it.each([false, true])(
  "presents and rolls back rejected enablement (enabled=%s)",
  async (enabled) => {
    const pending = deferred<PluginMutationResult>();
    const original = createPlugin({ enabled, state: enabled ? "enabled" : "disabled" });
    const h = fixture({
      "plugins.setEnabled": () => pending.promise,
      "plugins.list": () => createResult(original),
    });
    const { page, find } = await h.mount(undefined, createResult(original));
    const label = `${enabled ? "Disable" : "Enable"} Workboard`;
    const action = () => find<HTMLButtonElement>(`[aria-label="${label}"]`)!;
    await clickPluginAction(page, label);
    await waitForSolid(() => {
      expect(action().disabled).toBe(true);
      expect(action().getAttribute("aria-busy")).toBe("true");
      expect(action().classList.contains("primary")).toBe(enabled);
    });
    action().click();
    expect(h.calls("plugins.setEnabled")).toHaveLength(1);
    pending.reject(unavailable("Change refused."));
    await waitForSolid(() => {
      expect(page.textContent).toContain("Change refused.");
      expect(action().disabled).toBe(false);
      expect(action().classList.contains("primary")).toBe(!enabled);
    });
  },
);

it("keeps newer notices when an older uninstall completes", async () => {
  const pending = deferred<unknown>();
  const enabled = createPlugin({ enabled: true, state: "enabled" });
  const h = fixture({
    "plugins.uninstall": () => pending.promise,
    "plugins.setEnabled": () => ({
      ok: true,
      plugin: enabled,
      restartRequired: false,
      warnings: ["Enable requires attention."],
    }),
    "plugins.list": () => createResult(enabled),
  });
  const inventory = createResult([createPlugin(), removable]);
  const { page, find } = await h.mount(communityPath, inventory);
  await clickPluginAction(page, uninstallLabel);
  await h.waitForCall("plugins.uninstall");
  page.routeData = h.route("/settings/plugins/workboard", inventory);
  await clickPluginAction(page, "Enable Workboard");
  await waitForText(page, "Enable requires attention.");
  pending.resolve({ ...removalResult(removable.id), warnings: ["Old uninstall warning"] });
  await settlePlugins();
  await page.updateComplete;
  expect(page.textContent).not.toContain("Old uninstall warning");
  expect(find(".plugins-row-message--warning")?.textContent).toContain(
    "Enable requires attention.",
  );
});

it("reports rejected artifacts without another confirmation", async () => {
  const available = createPlugin({
    id: "calendar-runtime",
    name: "Calendar Plus",
    origin: "official",
    installed: false,
    state: "not-installed",
    install: { source: "official", pluginId: "calendar-runtime" },
  });
  const catalog = catalogFor(available, "catalog-calendar-runtime");
  const h = pageFixture({
    "plugins.catalog.get": () => catalog,
    "plugins.install": () => {
      const error = new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "The staged plugin changed before installation. Try installing again.",
        details: buildCapabilityConsentErrorDetails({
          pluginId: available.id,
          reviewToken: "changed-artifact",
        }),
      });
      retainGatewayResponsePayload(error, undefined);
      throw error;
    },
  });
  const { page, find } = await h.mount(
    pathForPluginCatalogEntry(catalog.plugin.id),
    createResult(available),
  );
  await clickPluginAction(page, "Install");
  await waitForText(page, "The staged plugin changed before installation.", rowAlert);
  expect(find("[data-plugin-consent]")).toBeNull();
  expect(find(rowAlert)?.textContent).toContain(
    "Resolve the reported issue, then select Retry install to try again.",
  );
  expect(h.calls("plugins.install")).toHaveLength(1);
  expect(h.calls("plugins.inspect")).toHaveLength(0);
});

it.each(["close", "retry"] as const)("handles inspection failure then %s", async (outcome) => {
  const first = deferred<ReturnType<typeof createInspectResult>>();
  const retry = deferred<ReturnType<typeof createInspectResult>>();
  let inspections = 0;
  const h = fixture({
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
  const { page, find } = await h.mount(undefined, createResult(plugin));
  const dialog = () => find(consentSelector);
  const loading = () => {
    expect(dialog()?.querySelector('[role="status"]')).not.toBeNull();
    expect(consentAction(page)?.disabled).toBe(true);
  };
  await clickPluginAction(page, "Enable Workboard");
  await waitForSolid(loading);
  first.reject(
    outcome === "close"
      ? new Error("Inspection unavailable")
      : unavailable("Inspection unavailable"),
  );
  await waitForText(page, "Inspection unavailable", `${consentSelector} [role="alert"]`);
  expect(consentAction(page)?.disabled).toBe(true);
  dialog()?.querySelector<HTMLButtonElement>('[role="alert"] button')?.click();
  await waitForSolid(loading);
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
  expect(h.calls("plugins.setEnabled")).toHaveLength(1);
});

it("requires fresh inspection and acknowledgement when the reviewed capabilities change", async () => {
  const inspection = createInspectResult({
    reviewToken: "fresh-inspected-token",
    plugin: { ...createInspectResult().plugin, name: "Authoritative Workboard" },
    declared: { ...createInspectResult().declared, tools: ["workboard_review"] },
  });
  const changed = createInspectResult({
    ...inspection,
    reviewToken: "changed-inspected-token",
    declared: { ...inspection.declared, tools: ["workboard_review", "workboard_manage"] },
  });
  const enableAttempt = deferred<never>();
  const reinspection = deferred<typeof inspection>();
  let inspections = 0;
  let acknowledgements = 0;
  const updated = createPlugin({ ...plugin, enabled: true, state: "enabled" });
  const h = fixture({
    "plugins.inspect": () =>
      ++inspections === 1
        ? createInspectResult()
        : inspections === 2
          ? inspection
          : reinspection.promise,
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
  const { page, find } = await h.mount(undefined, createResult(plugin));
  await clickPluginAction(page, "Enable Workboard");
  await h.waitForCall("plugins.setEnabled");
  expect(find("[data-plugin-consent]")).toBeNull();
  enableAttempt.reject(consentError("older-compact-token"));
  await waitForText(page, "Authoritative Workboard", consentSelector);
  expect(find(consentSelector)?.textContent).toContain("workboard_review");
  consentAction(page)?.click();
  await waitForSolid(() => expect(inspections).toBe(3));
  await page.updateComplete;
  expect(consentAction(page)?.disabled).toBe(true);
  expect(find('[aria-label="Disable Workboard"]')).toBeNull();
  reinspection.resolve(changed);
  await waitForSolid(() => {
    expect(find(consentSelector)?.textContent).toContain("workboard_manage");
    expect(consentAction(page)?.disabled).toBe(false);
  });
  expect(find('[aria-label="Disable Workboard"]')).toBeNull();
  expect(h.calls("plugins.setEnabled")).toHaveLength(2);
  consentAction(page)?.click();
  await waitForSolid(() => expect(find('[aria-label="Disable Workboard"]')).not.toBeNull());
  expect(h.calls("plugins.setEnabled").map(([, params]) => params)).toEqual([
    enableRequest,
    ...[inspection.reviewToken, changed.reviewToken].map((reviewToken) =>
      Object.assign({}, enableRequest, { acknowledgeCapabilities: { reviewToken } }),
    ),
  ]);
  expect(find(consentSelector)).toBeNull();
});

it("discards stale consent inspections after reconnect", async () => {
  const pending = deferred<ReturnType<typeof createInspectResult>>();
  let inspections = 0;
  const h = fixture({
    "plugins.inspect": () =>
      ++inspections === 2 ? pending.promise : createInspectResult({ reviewToken: "fresh-review" }),
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
  const { page, find } = await h.mount(undefined, createResult(plugin));
  await clickPluginAction(page, "Enable Workboard");
  await waitForSolid(() =>
    expect(find("openclaw-modal-dialog .plugins-consent__hint")).not.toBeNull(),
  );
  h.emit(h.client, false);
  h.emit(h.client, true);
  pending.resolve(createInspectResult({ reviewToken: "stale-review" }));
  await page.updateComplete;
  expect(find("openclaw-modal-dialog")).toBeNull();
  expect(h.calls("plugins.setEnabled").map(([, params]) => params)).toEqual([enableRequest]);
  await clickPluginAction(page, "Enable Workboard");
  await waitForSolid(() => expect(consentAction(page)?.disabled).toBe(false));
  consentAction(page)?.click();
  await waitForSolid(() =>
    expect(h.request).toHaveBeenCalledWith("plugins.setEnabled", {
      ...enableRequest,
      acknowledgeCapabilities: { reviewToken: "fresh-review" },
    }),
  );
});

it("retains a failed uninstall, resumes inspection, and allows retry", async () => {
  const calendar = createPlugin({ id: "calendar", name: "Calendar", removable: true });
  const pending = deferred<never>();
  let inspections = 0;
  let attempts = 0;
  const h = fixture({
    "plugins.inspect": () =>
      createInspectResult({
        plugin: calendar,
        overview: { readme: ++inspections === 1 ? "# Existing plugin" : "# Still installed" },
      }),
    "plugins.uninstall": () => (++attempts === 1 ? pending.promise : removalResult(calendar.id)),
    "plugins.list": () => createResult(attempts < 2 ? calendar : []),
  });
  const { page, find } = await h.mount("/settings/plugins/calendar", createResult(calendar));
  await waitForText(page, "Existing plugin");
  await clickPluginAction(page, "Uninstall Calendar");
  await h.waitForCall("plugins.uninstall");
  expect(page.textContent).toContain("Existing plugin");
  expect(find<HTMLButtonElement>(calendarAction)?.disabled).toBe(true);
  expect(inspections).toBe(1);
  pending.reject(unavailable("Plugin removal was refused."));
  await waitForText(page, "Still installed");
  expect(find(rowAlert)?.textContent).toContain("Plugin removal was refused.");
  expect(find<HTMLButtonElement>(calendarAction)?.disabled).toBe(false);
  await clickPluginAction(page, "Uninstall Calendar");
  await waitForSolid(() => expect(find(calendarAction)).toBeNull());
  expect(find(".plugins-row-message")).toBeNull();
});

it.each(["removed", "available", "navigated", "failed"] as const)(
  "reconciles a local discovery uninstall with %s selection",
  async (outcome) => {
    const calendar = createPlugin({
      id: "calendar",
      name: "Calendar",
      removable: true,
      origin: outcome === "available" ? "official" : "global",
    });
    const other = createPlugin({ id: "other", name: "Other" });
    const catalog = catalogFor(calendar, "local_Y2FsZW5kYXI", true);
    const otherCatalog = catalogFor(other, "local_b3RoZXI", true);
    const available = availablePlugin(calendar);
    const refreshed = catalogFor(
      { ...available, install: { source: "official", pluginId: calendar.id } },
      catalog.plugin.id,
      true,
    );
    refreshed.plugin.local.present = catalog.plugin.local.present;
    const pending = deferred<unknown>();
    let removed = false;
    let missingReads = 0;
    const h = fixture({
      "plugins.catalog.get": (params) => {
        if ((params as { id: string }).id === otherCatalog.plugin.id) {
          return otherCatalog;
        }
        if (!removed) {
          return catalog;
        }
        if (outcome === "available") {
          return refreshed;
        }
        missingReads++;
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "Local plugin not found",
        });
      },
      "plugins.inspect": (params) =>
        createInspectResult({
          plugin: (params as { pluginId: string }).pluginId === other.id ? other : calendar,
        }),
      "plugins.uninstall": () => pending.promise,
      "plugins.list": () => createResult(outcome === "available" ? [available, other] : [other]),
    });
    const inventory = createResult([calendar, other]);
    const { page, find } = await h.mount(`/plugins/${catalog.plugin.id}`, inventory);
    await waitForSolid(() => expect(find("h1")?.textContent).toBe("Calendar"));
    await clickPluginAction(page, "Uninstall Calendar");
    await waitForSolid(() => expect(find(calendarAction)?.getAttribute("aria-busy")).toBe("true"));
    if (outcome === "navigated") {
      page.routeData = h.route(`/plugins/${otherCatalog.plugin.id}`, inventory);
      await waitForSolid(() => expect(find("h1")?.textContent).toBe("Other"));
    }
    removed = true;
    const failure = "Plugin files were removed, but runtime activation failed.";
    if (outcome === "failed") {
      pending.reject(unavailable(failure));
    } else {
      pending.resolve(removalResult(calendar.id));
    }
    await settlePlugins();
    await page.updateComplete;
    expect(missingReads).toBe(0);
    if (outcome === "removed" || outcome === "failed") {
      await waitForSolid(() =>
        expect(h.context.replace).toHaveBeenCalledWith("plugins", { pathname: "/plugins" }),
      );
      if (outcome === "failed") {
        expect(find(rowAlert)?.textContent).toContain(failure);
      }
    } else {
      expect(h.context.replace).not.toHaveBeenCalled();
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
    const result = createResult([createPlugin(), removable]);
    const h = fixture({
      "plugins.inspect": () =>
        createInspectResult(phase === "confirmation" ? { plugin: removable } : {}),
    });
    const replacement = fixture({ "plugins.list": () => result });
    const gate = deferred();
    const queued = deferred();
    const config = createRuntimeConfigHarness(
      async () => undefined,
      { configFormDirty: false, lastError: null },
      () => h.client,
    );
    if (phase === "queue") {
      config.runtimeConfig.runExternalMutation = async (task, options) => {
        queued.resolve();
        await gate.promise;
        if (options?.canDispatch && !options.canDispatch()) {
          return {
            ok: false,
            reason: "unavailable",
            error: options.dispatchError ?? "Scope changed",
          };
        }
        return { ok: true, value: await task(h.client), refresh: { ok: true } };
      };
    }
    const { page } = await mountPage(
      phase === "queue" ? createContext(h.gateway, undefined, undefined, config) : h.context,
      h.route(communityPath, result),
    );
    const confirmation = deferred<boolean>();
    if (phase === "confirmation") {
      vi.mocked(showConfirmDialog).mockReturnValueOnce(confirmation.promise);
    }
    await clickPluginAction(page, uninstallLabel);
    if (phase === "queue") {
      await queued.promise;
    } else {
      await waitForSolid(() => expect(showConfirmDialog).toHaveBeenCalledOnce());
    }
    h.emit(replacement.client, true);
    if (phase === "queue") {
      await page.updateComplete;
      gate.resolve();
    } else {
      confirmation.resolve(true);
    }
    await settlePlugins();
    expect(h.calls("plugins.uninstall")).toHaveLength(0);
    expect(replacement.calls("plugins.uninstall")).toHaveLength(0);
  },
);

it("requires a fresh install-policy review after reconnect", async () => {
  const available = availablePlugin({
    ...removable,
    install: { source: "official", pluginId: removable.id },
  });
  const catalog = catalogFor(available, "catalog-community-thing");
  const h = pageFixture({
    "plugins.catalog.get": () => catalog,
    "plugins.list": () => createResult(available),
    "plugins.install": (params) => {
      if (!(params as PluginInstallRequest).acknowledgeInstallPolicyWarning) {
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "install requires review",
          details: {
            installPolicyCode: "install_policy_warning_acknowledgement_required",
            targetName: removable.id,
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
    },
  });
  const { page } = await h.mount(
    pathForPluginCatalogEntry(catalog.plugin.id),
    createResult(available),
  );
  await clickPluginAction(page, "Install");
  await waitForText(page, "Review this plugin before installing it.");
  expect(showConfirmDialog).not.toHaveBeenCalled();
  h.emit(h.client, false);
  h.emit(h.client, true);
  await clickPluginAction(page, "Continue installation");
  await waitForText(page, "request a fresh review");
  expect(h.calls("plugins.install")).toHaveLength(1);
  await clickPluginAction(page, "Install");
  await waitForSolid(() => expect(h.calls("plugins.install")).toHaveLength(2));
  await waitForSolid(() => {
    const button = [...page.querySelectorAll<HTMLButtonElement>("button")].find(
      (entry) => entry.textContent?.trim() === "Continue installation",
    );
    expect(button?.disabled).toBe(false);
  });
  await clickPluginAction(page, "Continue installation");
  await waitForSolid(() => expect(h.calls("plugins.install")).toHaveLength(3));
  expect(showConfirmDialog).not.toHaveBeenCalled();
});

it.each(["settled", "navigated"] as const)(
  "restores removed-plugin focus for a %s catalog read",
  async (outcome) => {
    const calendar = createPlugin({
      id: "calendar",
      name: "Calendar",
      origin: "official",
      removable: true,
      catalogId: "catalog-calendar",
    });
    const available = availablePlugin(calendar);
    const catalog = catalogFor(calendar, calendar.catalogId!);
    const refreshed = catalogFor(available, catalog.plugin.id);
    const other = createPlugin({ id: "other", name: "Other", installed: false });
    const otherCatalog = catalogFor(other, "catalog-other");
    const pending = deferred<unknown>();
    let removed = false;
    const h = fixture({
      "plugins.catalog.get": (params) =>
        (params as { id: string }).id === otherCatalog.plugin.id
          ? otherCatalog
          : removed
            ? pending.promise
            : catalog,
      "plugins.inspect": () => createInspectResult({ plugin: calendar }),
      "plugins.uninstall": () => {
        removed = true;
        return removalResult(calendar.id);
      },
      "plugins.list": () => createResult(removed ? available : calendar),
    });
    const { page, find } = await h.mount(
      pathForPluginCatalogEntry(catalog.plugin.id),
      createResult(calendar),
    );
    await waitForSolid(() => expect(find(calendarAction)).not.toBeNull());
    const trigger = find<HTMLButtonElement>(calendarAction)!;
    const readsBefore = h.calls("plugins.catalog.get").length;
    trigger.focus();
    await clickPluginAction(page, "Uninstall Calendar");
    await waitForSolid(() => expect(h.calls("plugins.catalog.get")).toHaveLength(readsBefore + 1));
    if (outcome === "navigated") {
      page.routeData = h.route(
        pathForPluginCatalogEntry(otherCatalog.plugin.id),
        createResult(other),
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
    }
    expect(find(calendarAction)).toBeNull();
  },
);
