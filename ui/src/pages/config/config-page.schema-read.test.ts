/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { ConfigUiHints } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { resetServerUiPrefsSync } from "../../app/server-prefs.ts";
import type { ConfigFormProps, JsonSchema } from "../../components/config-form.shared.ts";
import * as tiers from "../../components/config-form.tiers.ts";
import { i18n } from "../../i18n/index.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { createApplicationGatewaySnapshot } from "../../test-helpers/application-context-fixtures.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import { renderConfigFormFixture } from "../../test-helpers/config-form-fixtures.tsx";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
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

afterEach(async () => {
  await i18n.setLocale("en");
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
    let minLength = 1;
    let defaultValue = "initial default";
    let heldSchema: JsonSchema | undefined;
    let uiHints: ConfigUiHints = {
      "logging.value": { advanced: false },
      "security.value": { advanced: false },
    };
    const config = { logging: { value: "initial" }, security: { value: "initial" } };
    const request = vi.fn(async (method: string) => {
      if (method === "config.get") {
        return { config: structuredClone(config), hash: "synthetic", valid: true, issues: [] };
      }
      if (method === "config.schema") {
        return {
          schema: (heldSchema ??= {
            type: "object",
            properties: Object.fromEntries(
              ["logging", "security"].map((key) => [
                key,
                {
                  type: "object",
                  properties: {
                    value: { type: "string", title, minLength, default: defaultValue },
                  },
                },
              ]),
            ),
          }),
          uiHints,
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
    const split = vi.spyOn(tiers, "splitConfigSchemaByTier");
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
      split.mockClear();
      analyze.mockClear();
      request.mockClear();
      let expectedValue = "edited";
      field.focus();
      field.value = "edited";
      field.dispatchEvent(new Event("input", { bubbles: true }));
      flush();
      expect(split).not.toHaveBeenCalled();
      publishConfigSource(context.overlays);
      flush();
      expect(split).not.toHaveBeenCalled();
      field.setSelectionRange(1, 4);
      gateway.publish({ ...gateway.gateway.snapshot, lastError: null });
      publishConfigSource(context.overlays);
      flush();
      expect(split).not.toHaveBeenCalled();
      for (const busy of [true, false]) {
        Object.assign(context.overlays.snapshot, { updateStatusRefreshing: busy });
        publishConfigSource(context.overlays);
        await waitForSolid(() => expect(field.disabled).toBe(busy));
        expect(split).not.toHaveBeenCalled();
      }
      if (pageId === "advanced") {
        expectDefined(
          [...view.page.querySelectorAll<HTMLButtonElement>(".config-accordion-nav button")].find(
            (button) => button.textContent?.trim() === "Logging",
          ),
          "Logging selection",
        ).click();
        flush();
        split.mockClear();
        gateway.publish({ ...gateway.gateway.snapshot, lastError: null });
        flush();
        expectedValue = "selected edit";
        field.value = expectedValue;
        field.dispatchEvent(new Event("input", { bubbles: true }));
        flush();
        expect(split).not.toHaveBeenCalled();
        for (const busy of [true, false]) {
          Object.assign(context.overlays.snapshot, { updateStatusRefreshing: busy });
          publishConfigSource(context.overlays);
          await waitForSolid(() => expect(field.disabled).toBe(busy));
          expect(split).not.toHaveBeenCalled();
        }
        field.setSelectionRange(1, 4);
      }
      expect(view.page.querySelector(".config-content input.settings-input")).toBe(field);
      expect(field.value).toBe(expectedValue);
      expect(document.activeElement).toBe(field);
      expect([field.selectionStart, field.selectionEnd]).toEqual([1, 4]);
      expect(runtimeConfig.state.configForm?.[section]).toEqual({ value: expectedValue });
      expect(runtimeConfig.state.configSnapshot?.config?.[section]).toEqual({ value: "initial" });
      expect(request).not.toHaveBeenCalled();
      expect(analyze).not.toHaveBeenCalled();

      title = "Replacement schema label";
      minLength = 10;
      defaultValue = "replacement default";
      heldSchema = undefined;
      await runtimeConfig.refreshSchema();
      await waitForSolid(() =>
        expect(view.page.querySelector('input[aria-label="Replacement schema label"]')).toBe(field),
      );
      expect(analyze).toHaveBeenCalledOnce();
      expect(split).toHaveBeenCalled();
      expect(field.value).toBe(expectedValue);
      expect(field.placeholder).toContain("replacement default");
      field.value = "x";
      field.dispatchEvent(new Event("input", { bubbles: true }));
      flush();
      expect(field.getAttribute("aria-invalid")).toBe("true");
      expect(runtimeConfig.state.configForm?.[section]).toEqual({ value: expectedValue });
      split.mockClear();
      uiHints = {
        [`${section}.value`]: {
          advanced: false,
          label: "Hint replacement",
          help: "Updated help",
          order: -1,
        },
      };
      await runtimeConfig.refreshSchema();
      await waitForSolid(() => {
        expect(view.page.querySelector('input[aria-label="Hint replacement"]')).toBe(field);
        expect(view.page.textContent).toContain("Updated help");
      });
      expect(split).toHaveBeenCalled();
      uiHints = { [`${section}.value`]: { advanced: true } };
      await runtimeConfig.refreshSchema();
      await waitForSolid(() =>
        expect(view.page.querySelector(".config-advanced-disclosure")).not.toBeNull(),
      );
    } finally {
      runtimeConfig.setWritesSuspended(true);
      view.dispose();
      runtimeConfig.dispose();
    }
  },
);

it("updates membership when held include or exclude arrays are replaced", async () => {
  const split = vi.spyOn(tiers, "splitConfigSchemaByTier");
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
    split.mockClear();
    renderConfigInto({ ...props, updating: true }, container);
    expect(split).not.toHaveBeenCalled();
    renderConfigInto({ ...props, [scope]: ["logging"] }, container);
    await waitForSolid(() => {
      expect(container.querySelector(`input[aria-label="${initial}"]`)).toBeNull();
      expect(container.querySelector(`input[aria-label="${replacement}"]`)).not.toBeNull();
    });
    expect(split).toHaveBeenCalled();
    renderConfigInto({ ...props, [scope]: [] }, container);
    await waitForSolid(() =>
      expect(container.querySelectorAll("input.settings-input")).toHaveLength(2),
    );
  }
  const { container, props } = renderConfigView({
    schema: {
      type: "object",
      properties: {
        ui: {
          type: "object",
          properties: {
            prefs: {
              type: "object",
              properties: {
                locale: { type: "string", title: "Owned locale" },
                sibling: { type: "string", title: "Locale sibling" },
              },
            },
          },
        },
      },
    },
    formValue: { ui: { prefs: { locale: "en", sibling: "kept" } } },
    includeSections: ["ui"],
    includeVirtualSections: false,
    forceShowAdvanced: true,
  });
  expect(container.querySelector('input[aria-label="Owned locale"]')).toBeNull();
  expect(
    container.querySelector<HTMLInputElement>('input[aria-label="Locale sibling"]')?.value,
  ).toBe("kept");
  split.mockClear();
  renderConfigInto({ ...props, updating: true }, container);
  expect(split).not.toHaveBeenCalled();
  expect(container.querySelector('input[aria-label="Owned locale"]')).toBeNull();
  expect(container.querySelector('input[aria-label="Locale sibling"]')).not.toBeNull();
});

it("keeps section paths, search values and localized labels live across tier reuse", async () => {
  const split = vi.spyOn(tiers, "splitConfigSchemaByTier");
  const leaf = { type: "object", properties: { value: { type: "string" } } };
  const section = {
    type: "object",
    properties: { first: leaf, second: leaf },
    additionalProperties: leaf,
  };
  const container = document.createElement("div");
  const props: ConfigFormProps = {
    schema: { type: "object", properties: { logging: section, auth: section } },
    uiHints: {},
    value: {
      logging: { first: { value: "one" }, second: { value: "two" } },
      auth: { first: { value: "three" } },
    },
    activeSection: "logging",
    activeSubsection: "first",
    showAdvanced: true,
    onShowAdvanced: vi.fn(),
    onPatch: vi.fn(),
  };
  const render = (overrides: Partial<ConfigFormProps> = {}) => {
    renderConfigFormFixture(container, { ...props, ...overrides });
    flush();
  };
  const field = () =>
    expectDefined(
      container.querySelector<HTMLInputElement>('input[aria-label="Value"]'),
      "subsection field",
    );
  render();
  expect(field().value).toBe("one");
  split.mockClear();
  render({
    value: { ...props.value, logging: { first: { value: "live" }, second: { value: "two" } } },
  });
  expect(field().value).toBe("live");
  expect(split).not.toHaveBeenCalled();
  render({ activeSubsection: "" });
  split.mockClear();
  await i18n.setLocale("de");
  flush();
  expect(container.querySelector(".settings-section__heading")?.textContent).toBe(
    "Protokollierung",
  );
  expect(split).not.toHaveBeenCalled();
  await i18n.setLocale("en");
  flush();
  expect(container.querySelector(".settings-section__heading")?.textContent).toBe("Logging");
  expect(split).not.toHaveBeenCalled();
  render({ activeSubsection: "second" });
  expect(field().value).toBe("two");
  field().value = "changed";
  field().dispatchEvent(new Event("input", { bubbles: true }));
  expect(props.onPatch).toHaveBeenLastCalledWith(["logging", "second", "value"], "changed");
  render({ activeSection: "auth" });
  expect(field().value).toBe("three");
  expect(split).toHaveBeenCalled();
  const search = { activeSubsection: "", searchQuery: "dynamic-match" };
  render(search);
  expect(container.querySelector("input.settings-input")).toBeNull();
  const value = { logging: { "dynamic-match": { value: "found" } } };
  render({ ...search, value });
  expect(field().value).toBe("found");
  split.mockClear();
  render({ ...search, value });
  expect(split).not.toHaveBeenCalled();
  render({ ...search, value: { logging: { "dynamic-match": { value: "updated" } } } });
  expect(field().value).toBe("updated");
  expect(split).not.toHaveBeenCalled();
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
