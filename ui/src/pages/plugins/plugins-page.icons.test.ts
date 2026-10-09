/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { i18n } from "../../i18n/index.ts";
import type { PluginDiscoveryEntry } from "../../lib/plugins/index.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createModelSetupIconLoader } from "../model-setup/model-setup-icon-loader.ts";
import type { ModelSetupPageState } from "../model-setup/state.ts";
import {
  createClient,
  createContext,
  createDiscoveryDetail,
  createInspectResult,
  createGateway,
  createPlugin,
  createPluginsRouteData,
  createPluginsRouteLocation,
  createResult,
  mountPage,
  resetPluginsPageTestState,
} from "./plugins-page.test-support.ts";

function stubUrls(value: () => string = () => "blob:icon") {
  const create = vi.fn(value);
  const revoke = vi.fn();
  vi.stubGlobal(
    "URL",
    class extends URL {
      static override createObjectURL = create;
      static override revokeObjectURL = revoke;
    },
  );
  return { create, revoke };
}

function iconResponse(body: BodyInit = "image", type = "image/png") {
  return new Response(body, { headers: { "content-type": type } });
}

async function requestResult(method: string) {
  if (method === "plugins.catalog.categories") {
    return { categories: [] };
  }
  if (method === "plugins.catalog.browse") {
    return { items: [] };
  }
  return createResult();
}

function iconGateway(handler: Parameters<typeof createClient>[0] = requestResult) {
  const { client, request } = createClient(handler);
  const { gateway } = createGateway(client);
  gateway.connection.gatewayUrl = window.location.origin.replace(/^http/u, "ws");
  return { gateway, request };
}

function mountIcons(
  gateway: ReturnType<typeof iconGateway>["gateway"],
  result = createResult(),
  path = "/settings/plugins",
) {
  return mountPage(
    createContext(gateway),
    createPluginsRouteData(gateway, result, createPluginsRouteLocation(path)),
  );
}

const iconUrl = "https://cdn.example.com/lifecycle.png";
let activeLoader: ReturnType<typeof createModelSetupIconLoader> | undefined;
afterEach(() => {
  activeLoader?.reset();
  activeLoader = undefined;
  resetPluginsPageTestState();
});

beforeEach(async () => {
  await i18n.setLocale("en");
});

it("loads artwork for rendered category cards and expands without per-card metadata reads", async () => {
  stubUrls();
  const fetchMock = vi.fn(async () => iconResponse());
  vi.stubGlobal("fetch", fetchMock);
  const items: PluginDiscoveryEntry[] = Array.from({ length: 12 }, (_, index) => ({
    id: `catalog-${index}`,
    catalog: {
      name: `Plugin ${index}`,
      official: false,
      categories: ["web"],
      imageUrl: `https://cdn.example.com/publisher-${index}.png`,
    },
    local: {
      present: false,
      installed: false,
      enabled: false,
      state: "not-installed",
      action: "install",
    },
  }));
  const { gateway, request } = iconGateway(async (method) =>
    method === "plugins.catalog.browse"
      ? { items, categories: [{ slug: "web", label: "Web", icon: "globe", order: 1 }] }
      : requestResult(method),
  );
  const { page } = await mountIcons(gateway, createResult(), "/plugins");
  const cards = () => page.querySelectorAll(".plugin-catalog-card");
  const images = () => page.querySelectorAll(".plugin-catalog-card img");
  await waitForFast(() => expect(cards().length).toBeGreaterThan(0));
  const visible = cards().length;
  expect(visible).toBeLessThan(items.length);
  await waitForFast(() => expect(fetchMock).toHaveBeenCalledTimes(visible));
  await waitForFast(() => expect(images()).toHaveLength(visible));
  page
    .querySelector<HTMLButtonElement>(
      '[data-catalog-section="web"] .plugin-catalog-section__view-all',
    )!
    .click();
  await waitForFast(() => expect(cards()).toHaveLength(items.length));
  await waitForFast(() => expect(images()).toHaveLength(items.length));
  expect(request.mock.calls.map(([method]) => method)).not.toContain("plugins.catalog.get");
});

it("uses late publisher enrichment after package 404 without retrying the package", async () => {
  stubUrls(() => "blob:author");
  const authorUrl = "https://cdn.example.com/publisher.png";
  const fetchMock = vi.fn(async (url: string) =>
    url.includes("/plugin-icon/")
      ? new Response(null, { status: 404, headers: { "content-type": "image/png" } })
      : iconResponse("author"),
  );
  vi.stubGlobal("fetch", fetchMock);
  const plugin = createPlugin({ hasIcon: true, catalogId: "catalog:workboard" });
  const detail = createDiscoveryDetail(plugin);
  detail.detail.author = { handle: "publisher", imageUrl: authorUrl };
  const catalog = deferred<typeof detail>();
  const result = createResult(plugin);
  const { gateway } = iconGateway(async (method) => {
    if (method === "plugins.inspect") {
      return createInspectResult();
    }
    if (method === "plugins.catalog.get") {
      return catalog.promise;
    }
    if (method === "plugins.list") {
      return result;
    }
    throw new Error(`Unexpected method: ${method}`);
  });
  const { page } = await mountIcons(gateway, result, "/settings/plugins/workboard");
  await waitForFast(() => expect(fetchMock).toHaveBeenCalledOnce());
  await waitForFast(() =>
    expect(
      page.querySelector(".plugin-catalog-detail__hero .plugins-tile.skeleton"),
    ).not.toBeNull(),
  );
  catalog.resolve(detail);
  await waitForFast(() =>
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/__openclaw__/plugin-icon/workboard",
      `/__openclaw__/catalog-icon/${encodeURIComponent(authorUrl)}`,
    ]),
  );
  await waitForFast(() =>
    expect(page.querySelector(".plugin-catalog-detail__hero img")?.getAttribute("src")).toBe(
      "blob:author",
    ),
  );
});

it("keeps the monogram fallback when a proxied SVG exceeds the safe icon subset", async () => {
  const { create } = stubUrls();
  const fetchMock = vi
    .fn()
    .mockResolvedValue(
      iconResponse(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><filter id="work"><feTurbulence /></filter><path filter="url(#work)" d="M0 0h24v24H0z"/></svg>`,
        "image/svg+xml",
      ),
    );
  vi.stubGlobal("fetch", fetchMock);
  const { gateway } = iconGateway();
  const { page } = await mountIcons(
    gateway,
    createResult(createPlugin({ id: "unsafe-icon", name: "Unsafe Icon", hasIcon: true })),
  );
  await waitForFast(() =>
    expect(
      page.querySelector('[data-plugin-id="unsafe-icon"] .plugins-tile--fallback')?.textContent,
    ).toContain("UI"),
  );
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(create).not.toHaveBeenCalled();
});
function setupIcons() {
  const { gateway } = iconGateway(async () => createResult());
  const context = createContext(gateway);
  const ready: Extract<ModelSetupPageState, { phase: "ready" }> = {
    phase: "ready",
    result: {
      candidates: [],
      manualProviders: [],
      workspace: "/tmp/icon-fixture",
      setupComplete: false,
      recommendedInstalls: [
        {
          id: "fixture",
          label: "Fixture",
          hint: "Fixture",
          website: "https://example.com",
          icon: iconUrl,
        },
      ],
    },
  };
  let pageState: ModelSetupPageState = ready;
  const published = vi.fn<(urls: Record<string, string>) => void>();
  const fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
  let sequence = 0;
  const { revoke } = stubUrls(() => `blob:icon-${++sequence}`);
  const loader = createModelSetupIconLoader(
    () => context,
    () => pageState,
    published,
  );
  activeLoader = loader;
  return {
    loader,
    fetchMock,
    published,
    revoke,
    eligible: (present: boolean) => {
      pageState = present
        ? ready
        : { phase: "ready", result: { ...ready.result, recommendedInstalls: [] } };
    },
  };
}

it("times out and retries a missed icon only after removal and re-add", async () => {
  vi.useFakeTimers();
  const { loader, fetchMock, published, eligible } = setupIcons();
  fetchMock
    .mockImplementationOnce(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = expectDefined(init?.signal, "icon request abort signal");
          signal.addEventListener(
            "abort",
            () => reject(new Error("fixture fetch aborted", { cause: signal.reason })),
            { once: true },
          );
        }),
    )
    .mockResolvedValueOnce(iconResponse());
  loader.reconcile();
  expect(fetchMock).toHaveBeenCalledOnce();
  const signal = fetchMock.mock.calls[0]?.[1]?.signal;
  expect(signal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(9_999);
  expect(signal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(signal?.aborted).toBe(true);
  expect(signal?.reason).toBeInstanceOf(DOMException);
  expect(signal?.reason).toMatchObject({
    name: "TimeoutError",
    message: "catalog icon fetch timed out",
  });
  loader.reconcile();
  expect(fetchMock).toHaveBeenCalledOnce();
  eligible(false);
  loader.reconcile();
  eligible(true);
  loader.reconcile();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await waitForFast(() => expect(published).toHaveBeenLastCalledWith({ [iconUrl]: "blob:icon-1" }));
});

it("revokes before invalidation publication and publishes both empty resets", async () => {
  const { loader, fetchMock, published, revoke } = setupIcons();
  fetchMock.mockResolvedValueOnce(iconResponse());
  loader.reconcile();
  await waitForFast(() => expect(published).toHaveBeenCalledOnce());
  loader.invalidate(iconUrl);
  expect(revoke).toHaveBeenCalledWith("blob:icon-1");
  expect(revoke.mock.invocationCallOrder[0]).toBeLessThan(
    expectDefined(published.mock.invocationCallOrder[1], "invalidation publication order"),
  );
  loader.reconcile();
  expect(fetchMock).toHaveBeenCalledOnce();
  loader.reset();
  loader.reset();
  expect(published.mock.calls).toEqual([[{ [iconUrl]: "blob:icon-1" }], [{}], [{}], [{}]]);
});

it("keeps a pending detail icon on its skeleton until the image loads", async () => {
  vi.useFakeTimers();
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
    new Response("image", {
      headers: { "content-type": "image/png" },
    }),
  );
  await vi.advanceTimersByTimeAsync(0);
  const image = icon()?.querySelector("img");
  expect(image?.getAttribute("src")).toBe("blob:loaded-icon");
  expect(icon()?.classList.contains("skeleton")).toBe(true);
  image?.dispatchEvent(new Event("load"));
  expect(icon()?.classList.contains("skeleton")).toBe(false);
});

it("reuses installed artwork across navigation and retires it on a new plugin generation", async () => {
  vi.useFakeTimers();
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
