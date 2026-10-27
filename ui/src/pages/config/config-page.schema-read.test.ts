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
import { mountConfigPage, publishConfigSource } from "./config-page.test-support.ts";

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
  vi.unstubAllGlobals();
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
