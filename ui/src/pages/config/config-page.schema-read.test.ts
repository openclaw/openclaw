/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { ApplicationContext } from "../../app/context.ts";
import { resetServerUiPrefsSync } from "../../app/server-prefs.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { createApplicationGatewaySnapshot } from "../../test-helpers/application-context-fixtures.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  createConfigRouteContext,
  mountConfigPage,
  publishConfigSource,
} from "./config-page.test-support.ts";
import { preloadConfigPage } from "./config-page.tsx";
import { ADVANCED_EXCLUDED_SECTIONS, configSectionKeysForPage } from "./config-sections.ts";
import { renderConfigInto, renderConfigView } from "./config-view.test-support.tsx";
import * as schemaAnalysis from "./view-schema.tsx";

beforeEach(() => {
  window.history.replaceState({}, "", "/");
  vi.stubGlobal("localStorage", createStorageMock());
  resetServerUiPrefsSync();
});

afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
  resetServerUiPrefsSync();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each(["advanced", "security"] as const)(
  "reuses unchanged schema scope while keeping the %s editor live",
  async (pageId) => {
    const section = pageId === "advanced" ? "logging" : "security";
    let title = "Synthetic scoped value";
    const config = { logging: { value: "initial" }, security: { value: "initial" } };
    const request = vi.fn(async (method: string) => {
      if (method === "config.get") {
        return { config: structuredClone(config), hash: "synthetic", valid: true, issues: [] };
      }
      if (method === "config.schema") {
        return {
          schema: {
            type: "object",
            properties: Object.fromEntries(
              ["logging", "security"].map((key) => [
                key,
                { type: "object", properties: { value: { type: "string", title } } },
              ]),
            ),
          },
          uiHints: { "logging.value": { advanced: false }, "security.value": { advanced: false } },
          version: "synthetic",
        };
      }
      throw new Error(`Unexpected RPC: ${method}`);
    });
    const gateway = createApplicationGateway(
      createApplicationGatewaySnapshot({
        client: createTestGatewayClient(request),
        phase: "connected",
        hello: gatewayHelloForMethods([
          "config.schema",
          "config.set",
          "config.apply",
          "config.patch",
        ]),
      }),
    );
    const runtimeConfig = createRuntimeConfigCapability(gateway.gateway);
    const context = { ...createConfigRouteContext(), gateway: gateway.gateway, runtimeConfig };
    await runtimeConfig.ensureLoaded();
    await runtimeConfig.ensureSchemaLoaded();
    await preloadConfigPage(pageId);
    const analyze = vi.spyOn(schemaAnalysis, "getConfigSchemaAnalysis");
    const view = mountConfigPage(context, { pageId });
    try {
      await waitForSolid(() =>
        expect(view.page.querySelectorAll(".config-content input.settings-input")).toHaveLength(1),
      );
      const field = expectDefined(
        view.page.querySelector<HTMLInputElement>('input[aria-label="Synthetic scoped value"]'),
        "scoped field",
      );
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      analyze.mockClear();
      request.mockClear();
      field.focus();
      field.value = "edited";
      field.dispatchEvent(new Event("input", { bubbles: true }));
      publishConfigSource(context.overlays);
      field.setSelectionRange(1, 4);
      gateway.publish({ ...gateway.gateway.snapshot, lastError: null });
      publishConfigSource(context.overlays);
      for (const busy of [true, false]) {
        Object.assign(context.overlays.snapshot, { updateStatusRefreshing: busy });
        publishConfigSource(context.overlays);
        await waitForSolid(() => expect(field.disabled).toBe(busy));
      }
      if (pageId === "advanced") {
        expectDefined(
          [...view.page.querySelectorAll<HTMLButtonElement>(".config-accordion-nav button")].find(
            (button) => button.textContent?.trim() === "Logging",
          ),
          "Logging selection",
        ).click();
        publishConfigSource(context.overlays);
      }
      expect(view.page.querySelector(".config-content input.settings-input")).toBe(field);
      expect(field.value).toBe("edited");
      expect(document.activeElement).toBe(field);
      expect([field.selectionStart, field.selectionEnd]).toEqual([1, 4]);
      expect(runtimeConfig.state.configForm?.[section]).toEqual({ value: "edited" });
      expect(runtimeConfig.state.configSnapshot?.config?.[section]).toEqual({ value: "initial" });
      expect(request).not.toHaveBeenCalled();
      expect(analyze).not.toHaveBeenCalled();

      title = "Replacement schema label";
      await runtimeConfig.refreshSchema();
      await waitForSolid(() =>
        expect(view.page.querySelector('input[aria-label="Replacement schema label"]')).toBe(field),
      );
      expect(analyze).toHaveBeenCalledOnce();
      expect(field.value).toBe("edited");
    } finally {
      runtimeConfig.setWritesSuspended(true);
      view.dispose();
      runtimeConfig.dispose();
    }
  },
);

it("updates membership when held include or exclude arrays are replaced", async () => {
  const schema = {
    type: "object",
    properties: {
      logging: {
        type: "object",
        properties: { value: { type: "string", title: "Logging value" } },
      },
      mcp: { type: "object", properties: { value: { type: "string", title: "MCP value" } } },
    },
  };
  for (const scope of ["includeSections", "excludeSections"] as const) {
    const { container, props } = renderConfigView({
      schema,
      [scope]:
        scope === "includeSections" ? configSectionKeysForPage("mcp") : ADVANCED_EXCLUDED_SECTIONS,
      includeVirtualSections: false,
      forceShowAdvanced: true,
      formValue: { logging: { value: "log" }, mcp: { value: "server" } },
    });
    const initial = scope === "includeSections" ? "MCP value" : "Logging value";
    const replacement = scope === "includeSections" ? "Logging value" : "MCP value";
    await waitForSolid(() =>
      expect(container.querySelector(`input[aria-label="${initial}"]`)).not.toBeNull(),
    );
    renderConfigInto({ ...props, [scope]: ["logging"] }, container);
    await waitForSolid(() => {
      expect(container.querySelector(`input[aria-label="${initial}"]`)).toBeNull();
      expect(container.querySelector(`input[aria-label="${replacement}"]`)).not.toBeNull();
    });
    renderConfigInto({ ...props, [scope]: [] }, container);
    await waitForSolid(() =>
      expect(container.querySelectorAll("input.settings-input")).toHaveLength(2),
    );
  }
});

it("retains a schema failure until Retry and keeps loaded fields during revalidation", async () => {
  const first = deferred<unknown>();
  const retry = deferred<unknown>();
  const refresh = deferred<unknown>();
  const config = { gateway: { port: 18789 } };
  const response = {
    schema: {
      type: "object",
      properties: {
        gateway: { type: "object", properties: { port: { type: "number" } } },
      },
    },
    uiHints: { "gateway.port": { advanced: false } },
    version: "synthetic-schema",
  };
  let reads = 0;
  const request = vi.fn((method: string) => {
    if (method === "config.get") {
      return Promise.resolve({
        config,
        hash: "synthetic",
        raw: JSON.stringify(config),
        valid: true,
        issues: [],
      });
    }
    if (method === "config.schema") {
      reads += 1;
      return reads === 1 ? first.promise : reads === 2 ? retry.promise : refresh.promise;
    }
    return Promise.resolve({});
  });
  const { gateway } = createApplicationGateway(
    createApplicationGatewaySnapshot({
      client: createTestGatewayClient(request),
      phase: "connected",
      hello: gatewayHelloForMethods([
        "config.schema",
        "config.set",
        "config.apply",
        "config.patch",
      ]),
      assistantAgentId: "main",
      sessionKey: "main",
    }),
  );
  const runtimeConfig = createRuntimeConfigCapability(gateway);
  // SAFETY: the mount helper fills unrelated page capabilities; these Gateway and Config owners are real.
  const context = { gateway, runtimeConfig } as ApplicationContext;
  const view = mountConfigPage(context, { pageId: "infrastructure" });
  try {
    await vi.dynamicImportSettled();
    await waitForSolid(() => {
      expect(reads).toBe(1);
      expect(view.page.querySelector(".config-loading")).not.toBeNull();
    });
    first.reject(new Error("Synthetic schema service unavailable"));
    await waitForSolid(() =>
      expect(view.page.textContent).toContain("Synthetic schema service unavailable"),
    );
    publishConfigSource(context.theme);
    window.dispatchEvent(new Event("focus"));
    await waitForSolid(() => expect(reads).toBe(1));
    const retryButton = expectDefined(
      view.page.querySelector<HTMLButtonElement>('.config-content [role="alert"] button'),
      "schema Retry",
    );
    expect(retryButton.textContent?.trim()).toBe("Retry");
    retryButton.click();
    await waitForSolid(() => {
      expect(reads).toBe(2);
      expect(view.page.textContent).toContain("Synthetic schema service unavailable");
    });
    retry.resolve(response);
    await waitForSolid(() =>
      expect(view.page.textContent).not.toContain("Synthetic schema service unavailable"),
    );
    await waitForSolid(() =>
      expect(view.page.querySelector('.config-content input[type="number"]')).not.toBeNull(),
    );
    const field = expectDefined(
      view.page.querySelector<HTMLInputElement>('.config-content input[type="number"]'),
      "loaded port field",
    );
    const revalidation = runtimeConfig.refreshSchema();
    await waitForSolid(() => {
      expect(reads).toBe(3);
      expect(view.page.querySelector('.config-content input[type="number"]')).toBe(field);
      expect(
        field.disabled,
        `ownerLoading=${runtimeConfig.state.configSchemaLoading}, ariaBusy=${view.page.querySelector(".config-content")?.getAttribute("aria-busy")}`,
      ).toBe(true);
    });
    refresh.reject(new Error("Synthetic schema refresh unavailable"));
    await revalidation;
    await waitForSolid(() => {
      expect(view.page.querySelector('.config-content input[type="number"]')).toBe(field);
      expect(field.disabled).toBe(false);
      expect(
        view.page.querySelector('.config-content .callout[role="alert"]')?.textContent,
      ).toContain("Synthetic schema refresh unavailable");
    });
  } finally {
    first.resolve(response);
    retry.resolve(response);
    refresh.resolve(response);
    view.dispose();
    runtimeConfig.dispose();
  }
});
