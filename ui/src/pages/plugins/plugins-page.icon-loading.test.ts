/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { i18n } from "../../i18n/index.ts";
import {
  createClient,
  createContext,
  createInspectResult,
  createGateway,
  createPlugin,
  createPluginsRouteData,
  createPluginsRouteLocation,
  createResult,
  mountPage,
  resetPluginsPageTestState,
} from "./plugins-page.test-support.ts";

describe("plugin icon loading and navigation", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    await i18n.setLocale("en");
  });
  afterEach(resetPluginsPageTestState);

  it.each([200, 404])(
    "keeps a pending detail icon on its skeleton until status %s",
    async (status) => {
      vi.stubGlobal(
        "URL",
        class extends URL {
          static override createObjectURL = vi.fn(() => "blob:loaded-icon");
          static override revokeObjectURL = vi.fn();
        },
      );
      const response = deferred<Response>();
      const fetchMock = vi.fn(() => response.promise);
      vi.stubGlobal("fetch", fetchMock);
      const plugin = createPlugin({ hasIcon: true });
      const result = createResult(plugin);
      const { client } = createClient(async (method) =>
        method === "plugins.inspect" ? createInspectResult() : result,
      );
      const harness = createGateway(client);
      harness.gateway.connection.gatewayUrl = window.location.origin.replace(/^http/u, "ws");
      const { page } = await mountPage(
        createContext(harness.gateway),
        createPluginsRouteData(
          harness.gateway,
          result,
          createPluginsRouteLocation("/settings/plugins/workboard"),
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      const icon = () => page.querySelector(".plugin-catalog-detail__hero .plugins-tile");
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(icon()?.classList.contains("skeleton")).toBe(true);
      expect(icon()?.classList.contains("plugins-tile--fallback")).toBe(false);
      response.resolve(
        new Response(status === 200 ? "image" : null, {
          status,
          headers: { "content-type": "image/png" },
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      if (status === 200) {
        const image = icon()?.querySelector("img");
        expect(image?.getAttribute("src")).toBe("blob:loaded-icon");
        expect(icon()?.classList.contains("skeleton")).toBe(true);
        image?.dispatchEvent(new Event("load"));
        expect(icon()?.classList.contains("skeleton")).toBe(false);
      } else {
        expect(icon()?.classList.contains("skeleton")).toBe(false);
        expect(icon()?.textContent?.trim()).toBe("WO");
      }
    },
  );

  it("reuses installed artwork across navigation and retires it on a new plugin generation", async () => {
    const revokeObjectURL = vi.fn();
    let sequence = 0;
    vi.stubGlobal(
      "URL",
      class extends URL {
        static override createObjectURL = vi.fn(() => `blob:icon-${++sequence}`);
        static override revokeObjectURL = revokeObjectURL;
      },
    );
    const fetchMock = vi.fn(
      async () =>
        new Response("image", {
          headers: { "content-type": "image/png" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = { ...createResult(createPlugin({ hasIcon: true })), generation: 1 };
    const { client } = createClient(async (method) =>
      method === "plugins.inspect" ? createInspectResult() : result,
    );
    const harness = createGateway(client);
    harness.gateway.connection.gatewayUrl = window.location.origin.replace(/^http/u, "ws");
    const { page } = await mountPage(
      createContext(harness.gateway),
      createPluginsRouteData(harness.gateway, result),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(page.querySelector("img.plugins-icon")?.getAttribute("src")).toBe("blob:icon-1");
    const detailRoute = createPluginsRouteLocation("/settings/plugins/workboard");
    page.routeData = createPluginsRouteData(harness.gateway, result, detailRoute);
    await vi.advanceTimersByTimeAsync(0);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(page.querySelector(".plugin-catalog-detail__hero img")?.getAttribute("src")).toBe(
      "blob:icon-1",
    );
    page.routeData = createPluginsRouteData(
      harness.gateway,
      { ...result, generation: 2 },
      detailRoute,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:icon-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(page.querySelector(".plugin-catalog-detail__hero img")?.getAttribute("src")).toBe(
      "blob:icon-2",
    );
    page.remove();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:icon-2");
  });
});
