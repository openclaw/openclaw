/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import type { PluginDiscoveryEntry, PluginListResult } from "../../lib/plugins/index.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
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

  it("prefers installed package icons over legacy art in unified catalog cards", async () => {
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
    expect(page.querySelector('[data-plugin-id="ch_discord"] img')?.getAttribute("src")).toBe(
      "/plugin-art/discord.webp",
    );
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
