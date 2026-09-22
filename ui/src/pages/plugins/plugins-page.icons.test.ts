/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { i18n } from "../../i18n/index.ts";
import type { PluginDiscoveryEntry, PluginListResult } from "../../lib/plugins/index.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { ModelSetupIconLoader } from "../model-setup/model-setup-icon-loader.ts";
import type { ModelSetupPageState } from "../model-setup/state.ts";
import { PluginsPageIcons } from "./plugins-page-icons.ts";
import {
  createClient,
  createContext,
  createGateway,
  createPlugin,
  createPluginsRouteData,
  createPluginsRouteLocation,
  createResult,
  mountPage,
  resetPluginsPageTestState,
} from "./plugins-page.test-support.ts";

describe("PluginsPage icon routing", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(resetPluginsPageTestState);

  const requestResult = async (method: string) => {
    if (method === "plugins.catalog.categories") {
      return { categories: [] };
    }
    if (method === "plugins.catalog.browse") {
      return { items: [] };
    }
    return createResult();
  };

  it("fetches proxied icons with auth fallback and revokes their blob URLs", async () => {
    const createObjectURL = vi.fn(() => "blob:firecrawl-icon");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal(
      "URL",
      class extends URL {
        static override createObjectURL = createObjectURL;
        static override revokeObjectURL = revokeObjectURL;
      },
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(
        new Response(
          new Blob(
            [
              new Uint8Array([
                0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0x49, 0x48, 0x44, 0x52,
                0, 0, 0, 2, 0, 0, 0, 1,
              ]),
            ],
            { type: "image/png" },
          ),
          {
            status: 200,
            headers: { "content-type": "image/png" },
          },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { client } = createClient(requestResult);
    const harness = createGateway(client);
    harness.gateway.connection.gatewayUrl = window.location.origin.replace(/^http/u, "ws");
    harness.gateway.connection.token = "first";
    harness.gateway.connection.password = "second";
    const result = createResult(
      createPlugin({ id: "remote-icon", name: "FireCrawl", hasIcon: true }),
    );

    const { page } = await mountPage(
      createContext(harness.gateway),
      createPluginsRouteData(harness.gateway, result),
    );

    await waitForFast(() => {
      expect(
        page.querySelector('[data-plugin-id="remote-icon"] img.plugins-icon')?.getAttribute("src"),
      ).toBe("blob:firecrawl-icon");
    });
    expect(
      fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get("Authorization")),
    ).toEqual(["Bearer first", "Bearer second"]);
    page.applyMutationResult({
      ok: true,
      plugin: createPlugin({ id: "other-plugin", name: "Other Plugin" }),
      restartRequired: false,
    });
    expect(revokeObjectURL).not.toHaveBeenCalled();

    page.remove();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:firecrawl-icon");
  });

  it("renders installed package icons or a placeholder when unavailable in unified catalog cards", async () => {
    const createObjectURL = vi.fn(() => "blob:package-icon");
    vi.stubGlobal(
      "URL",
      class extends URL {
        static override createObjectURL = createObjectURL;
        static override revokeObjectURL = vi.fn();
      },
    );
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("%40openclaw%2Fdiscord")) {
        return Promise.resolve(new Response(null, { status: 404 }));
      }
      return Promise.resolve(
        new Response(
          new Blob(
            [
              new Uint8Array([
                0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0x49, 0x48, 0x44, 0x52,
                0, 0, 0, 2, 0, 0, 0, 1,
              ]),
            ],
            { type: "image/png" },
          ),
          {
            status: 200,
            headers: { "content-type": "image/png" },
          },
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const discoveryEntries = [
      {
        id: "ch_brave",
        catalog: {
          name: "Brave Search",
          official: true,
          categories: ["web"],
        },
        local: {
          present: true,
          installed: true,
          enabled: false,
          state: "disabled",
          pluginId: "@openclaw/brave-plugin",
          action: "manage",
        },
      },
      {
        id: "ch_discord",
        catalog: {
          name: "Discord",
          official: true,
          categories: ["channels"],
        },
        local: {
          present: true,
          installed: true,
          enabled: false,
          state: "disabled",
          pluginId: "@openclaw/discord",
          action: "manage",
        },
      },
    ] satisfies PluginDiscoveryEntry[];
    const { client } = createClient(async (method, params) => {
      if (method === "plugins.catalog.browse") {
        return (params as { intent?: string }).intent === "featured"
          ? { items: [] }
          : { items: discoveryEntries };
      }
      return requestResult(method);
    });
    const harness = createGateway(client);
    harness.gateway.connection.gatewayUrl = window.location.origin.replace(/^http/u, "ws");
    const installedPlugin = (
      id: string,
      name: string,
      origin: "official" | "registry" = "official",
    ) =>
      createPlugin({
        id,
        name,
        origin,
        hasIcon: true,
        installed: true,
        enabled: false,
        state: "disabled",
      });
    const result = {
      plugins: [
        installedPlugin("@openclaw/brave-plugin", "Brave Search"),
        installedPlugin("@openclaw/deepseek-provider", "DeepSeek"),
        installedPlugin("@openclaw/discord", "Discord"),
        installedPlugin("@vendor/brave-plugin", "Vendor Brave", "registry"),
      ],
      diagnostics: [],
      mutationAllowed: true,
    } satisfies PluginListResult;

    const { page } = await mountPage(
      createContext(harness.gateway),
      createPluginsRouteData(harness.gateway, result, createPluginsRouteLocation("/plugins")),
    );

    await waitForFast(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/__openclaw__/plugin-icon/%40openclaw%2Fbrave-plugin",
      "/__openclaw__/plugin-icon/%40openclaw%2Fdiscord",
    ]);
    await waitForFast(() =>
      expect(
        page.querySelector('[data-plugin-id="ch_brave"] img.plugins-icon')?.getAttribute("src"),
      ).toBe("blob:package-icon"),
    );
    expect(page.querySelector('[data-plugin-id="ch_discord"] img')).toBeNull();
    expect(
      page.querySelector('[data-plugin-id="ch_discord"] .plugin-catalog-card__art svg'),
    ).not.toBeNull();
  });

  it("fetches package icons for installed settings rows", async () => {
    vi.stubGlobal(
      "URL",
      class extends URL {
        static override createObjectURL = vi.fn();
        static override revokeObjectURL = vi.fn();
      },
    );
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const { client } = createClient(requestResult);
    const harness = createGateway(client);
    harness.gateway.connection.gatewayUrl = window.location.origin.replace(/^http/u, "ws");
    const plugins = Array.from({ length: 12 }, (_, index) => {
      const suffix = String(index).padStart(2, "0");
      return createPlugin({
        id: `bounded-icon-${suffix}`,
        name: `Bounded Icon ${suffix}`,
        hasIcon: true,
        installed: true,
        enabled: false,
        state: "disabled",
      });
    });
    const result = {
      plugins,
      diagnostics: [],
      mutationAllowed: true,
    } satisfies PluginListResult;

    const { page } = await mountPage(
      createContext(harness.gateway),
      createPluginsRouteData(
        harness.gateway,
        result,
        createPluginsRouteLocation("/settings/plugins"),
      ),
    );

    await waitForFast(() => expect(fetchMock).toHaveBeenCalledTimes(12));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(
      plugins.map((plugin) => `/__openclaw__/plugin-icon/${plugin.id}`),
    );
    expect(page.querySelectorAll(".plugins-settings-row")).toHaveLength(12);
  });

  it("keeps the monogram fallback when a proxied SVG exceeds the safe icon subset", async () => {
    const createObjectURL = vi.fn();
    vi.stubGlobal(
      "URL",
      class extends URL {
        static override createObjectURL = createObjectURL;
        static override revokeObjectURL = vi.fn();
      },
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          new Blob(
            [
              `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><filter id="work"><feTurbulence /></filter><path filter="url(#work)" d="M0 0h24v24H0z"/></svg>`,
            ],
            { type: "image/svg+xml" },
          ),
          { status: 200, headers: { "content-type": "image/svg+xml" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { client } = createClient(requestResult);
    const harness = createGateway(client);
    harness.gateway.connection.gatewayUrl = window.location.origin.replace(/^http/u, "ws");
    const result = createResult(
      createPlugin({ id: "unsafe-icon", name: "Unsafe Icon", hasIcon: true }),
    );

    const { page } = await mountPage(
      createContext(harness.gateway),
      createPluginsRouteData(harness.gateway, result),
    );

    await waitForFast(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(
      page.querySelector('[data-plugin-id="unsafe-icon"] .plugins-tile--fallback')?.textContent,
    ).toContain("UI");
  });
});

describe("Model Setup icon lifecycle through the shared proxy", () => {
  const iconUrl = "https://cdn.example.com/lifecycle.png";
  let loader: ModelSetupIconLoader | undefined;
  let installedIcons: PluginsPageIcons | undefined;

  afterEach(() => {
    loader?.reset();
    loader = undefined;
    installedIcons?.reset();
    installedIcons = undefined;
    resetPluginsPageTestState();
  });

  function setupIcons() {
    const { client } = createClient(async () => createResult());
    const gateway = createGateway(client);
    gateway.gateway.connection.gatewayUrl = window.location.origin.replace(/^http/u, "ws");
    const context = createContext(gateway.gateway);
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
    const revoke = vi.fn();
    const NativeUrl = URL;
    vi.stubGlobal(
      "URL",
      class extends NativeUrl {
        static override createObjectURL = vi.fn(() => `blob:icon-${++sequence}`);
        static override revokeObjectURL = revoke;
      },
    );
    const currentLoader = new ModelSetupIconLoader(
      () => context,
      () => pageState,
      published,
    );
    loader = currentLoader;
    return {
      loader: currentLoader,
      fetchMock,
      published,
      revoke,
      gateway,
      context,
      eligible: (present: boolean) => {
        pageState = present
          ? ready
          : {
              phase: "ready",
              result: { ...ready.result, recommendedInstalls: [] },
            };
      },
    };
  }

  function iconResponse() {
    return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
      status: 200,
      headers: { "content-type": "image/png" },
    });
  }

  it.each(["key", "connection"] as const)(
    "rejects a settled icon after its %s becomes unavailable before reconciliation",
    async (scope) => {
      const fixture = setupIcons();
      const response = deferred<Response>();
      fixture.fetchMock.mockReturnValueOnce(response.promise);
      fixture.loader.reconcile();
      expect(fixture.fetchMock).toHaveBeenCalledOnce();
      if (scope === "key") {
        fixture.eligible(false);
      } else {
        fixture.gateway.emit(null, false);
      }
      response.resolve(iconResponse());
      await waitForFast(() =>
        expect(
          fixture.revoke.mock.calls.length + fixture.published.mock.calls.length,
        ).toBeGreaterThan(0),
      );
      expect(fixture.revoke).toHaveBeenCalledWith("blob:icon-1");
      expect(fixture.published).not.toHaveBeenCalled();
    },
  );

  it("keeps a replacement icon when an older same-key request settles last", async () => {
    const fixture = setupIcons();
    const first = deferred<Response>();
    const second = deferred<Response>();
    fixture.fetchMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    fixture.loader.reconcile();
    fixture.loader.reset();
    fixture.loader.reconcile();
    expect(fixture.fetchMock).toHaveBeenCalledTimes(2);
    expect(fixture.fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    second.resolve(iconResponse());
    await waitForFast(() =>
      expect(fixture.published).toHaveBeenLastCalledWith({
        [iconUrl]: "blob:icon-1",
      }),
    );
    first.resolve(iconResponse());
    await waitForFast(() =>
      expect(fixture.revoke.mock.calls.length + fixture.published.mock.calls.length).toBe(3),
    );
    expect(fixture.revoke).toHaveBeenCalledWith("blob:icon-2");
    expect(fixture.published.mock.calls).toEqual([[{}], [{ [iconUrl]: "blob:icon-1" }]]);
  });

  it.each([
    { family: "catalog", message: "catalog icon fetch timed out" },
    { family: "plugin", message: "plugin icon fetch timed out" },
  ] as const)(
    "$family times out at ten seconds and retries a missed key only after removal and re-add",
    async ({ family, message }) => {
      vi.useFakeTimers();
      const fixture = setupIcons();
      const key = family === "plugin" ? "fixture-plugin" : iconUrl;
      const pluginIcons =
        family === "plugin"
          ? new PluginsPageIcons({
              getContext: () => fixture.context,
              isConnected: () => fixture.gateway.gateway.snapshot.phase === "connected",
              onInstalledUrlsChange: fixture.published,
              onCatalogUrlsChange: vi.fn(),
            })
          : undefined;
      installedIcons = pluginIcons;
      const iconView = document.createDocumentFragment();
      const iconTile = document.createElement("span");
      iconTile.dataset.pluginIconId = key;
      iconView.append(iconTile);
      let present = true;
      const reconcile = () => {
        if (!pluginIcons) {
          fixture.loader.reconcile();
          return;
        }
        const result = createResult(present ? [createPlugin({ id: key, hasIcon: true })] : []);
        pluginIcons.reconcileInstalled(result);
        pluginIcons.syncInstalled(result, iconView);
      };
      const eligible = (value: boolean) => {
        present = value;
        fixture.eligible(value);
      };
      fixture.fetchMock
        .mockImplementationOnce(
          (_input, init) =>
            new Promise<Response>((_resolve, reject) => {
              const signal = init?.signal;
              if (!signal) {
                throw new Error("Expected the icon request abort signal");
              }
              signal.addEventListener(
                "abort",
                () => reject(new Error("fixture fetch aborted", { cause: signal.reason })),
                { once: true },
              );
            }),
        )
        .mockResolvedValueOnce(iconResponse());
      reconcile();
      expect(fixture.fetchMock).toHaveBeenCalledOnce();
      const signal = fixture.fetchMock.mock.calls[0]?.[1]?.signal;
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(signal?.aborted).toBe(true);
      expect(signal?.reason).toBeInstanceOf(DOMException);
      expect(signal?.reason).toMatchObject({
        name: "TimeoutError",
        message,
      });
      reconcile();
      expect(fixture.fetchMock).toHaveBeenCalledOnce();
      eligible(false);
      reconcile();
      eligible(true);
      reconcile();
      expect(fixture.fetchMock).toHaveBeenCalledTimes(2);
      await waitForFast(() =>
        expect(fixture.published).toHaveBeenLastCalledWith({
          [key]: "blob:icon-1",
        }),
      );
    },
  );

  it("revokes before invalidation publication and publishes both empty resets", async () => {
    const fixture = setupIcons();
    fixture.fetchMock.mockResolvedValueOnce(iconResponse());
    fixture.loader.reconcile();
    await waitForFast(() => expect(fixture.published).toHaveBeenCalledOnce());
    fixture.loader.invalidate(iconUrl);
    expect(fixture.revoke).toHaveBeenCalledWith("blob:icon-1");
    expect(fixture.revoke.mock.invocationCallOrder[0]).toBeLessThan(
      expectDefined(
        fixture.published.mock.invocationCallOrder[1],
        "invalidation publication order",
      ),
    );
    fixture.loader.reconcile();
    expect(fixture.fetchMock).toHaveBeenCalledOnce();
    fixture.loader.reset();
    fixture.loader.reset();
    expect(fixture.published.mock.calls).toEqual([
      [{ [iconUrl]: "blob:icon-1" }],
      [{}],
      [{}],
      [{}],
    ]);
  });
});
