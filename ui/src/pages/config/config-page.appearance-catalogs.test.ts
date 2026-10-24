/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PluginsListResult,
  SessionsCatalogListResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { BUILTIN_THEMES } from "../../../../packages/gateway-protocol/src/theme.ts";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ThemeCatalogSnapshot } from "../../app/theme-catalog.ts";
import { setStoredSessionCatalogHidden } from "../../components/app-sidebar-session-types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { mountAppearanceCatalogPage as mount } from "./config-page-catalog.test-support.ts";
import { publishConfigSource } from "./config-page.test-support.ts";

describe("ConfigPage model catalog lifecycle", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.useFakeTimers();
  });

  afterEach(async () => {
    cleanupSolid();
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe("Appearance catalogs", () => {
    it("recovers theme discovery without replacing the available theme controls", async () => {
      const { view, context } = await mount(
        createTestGatewayClient(
          vi.fn(async (method: string) => (method === "models.list" ? { models: [] } : {})),
        ),
      );
      const scope = {};
      const first = deferred<ThemeCatalogSnapshot | undefined>();
      const second = deferred<ThemeCatalogSnapshot | undefined>();
      const publishCatalog = (result: Promise<ThemeCatalogSnapshot | undefined>) => {
        Object.assign(context.theme, {
          catalog: { themes: [], error: null, read: { scope, result } },
        });
        publishConfigSource(context.theme);
      };
      const retry = vi.fn(() => publishCatalog(second.promise));
      Object.assign(context.theme, { retryCatalog: retry });
      publishCatalog(first.promise);
      const grid = expectDefined(view.page.querySelector(".settings-theme-grid"), "theme grid");
      const builtin = expectDefined(
        grid.querySelector<HTMLButtonElement>('[data-theme-id="claw"]'),
        "built-in theme control",
      );
      await waitForSolid(() => expect(builtin.disabled).toBe(false));

      first.resolve({ themes: [], error: "Theme catalog unavailable" });
      await waitForSolid(() =>
        expect(view.page.textContent).toContain("Theme catalog unavailable"),
      );
      const retryButton = expectDefined(
        view.page.querySelector<HTMLButtonElement>(".settings-status--error button"),
        "theme catalog retry",
      );
      retryButton.click();
      expect(retry).toHaveBeenCalledOnce();
      const recovered: ThemeCatalogSnapshot = {
        themes: [
          ...BUILTIN_THEMES,
          {
            id: "synthetic/nebula",
            name: "Nebula",
            description: "Synthetic palette",
            source: "plugin",
            modes: ["dark"],
            pluginId: "synthetic",
          },
        ],
        error: null,
      };
      Object.assign(context.theme, {
        catalog: { ...recovered, read: { scope, result: second.promise } },
      });
      publishConfigSource(context.theme);
      second.resolve(recovered);
      await waitForSolid(() =>
        expect(grid.querySelector('[data-theme-id="synthetic/nebula"]')).not.toBeNull(),
      );
      expect(view.page.querySelector(".settings-theme-grid")).toBe(grid);
      expect(grid.querySelector('[data-theme-id="claw"]')).toBe(builtin);
      await waitForSolid(() =>
        expect(view.page.textContent).not.toContain("Theme catalog unavailable"),
      );
    });

    it("does not expose a retired profile's theme catalog", async () => {
      const { view, context } = await mount(
        createTestGatewayClient(
          vi.fn(async (method: string) => (method === "models.list" ? { models: [] } : {})),
        ),
      );
      const first = deferred<ThemeCatalogSnapshot | undefined>();
      const second = deferred<ThemeCatalogSnapshot | undefined>();
      Object.assign(context.theme, {
        catalog: { themes: [], error: null, read: { scope: {}, result: first.promise } },
      });
      publishConfigSource(context.theme);
      flush();
      const currentScope = {};
      Object.assign(context.theme, {
        catalog: { themes: [], error: null, read: { scope: currentScope, result: second.promise } },
      });
      publishConfigSource(context.theme);
      const current: ThemeCatalogSnapshot = {
        themes: [
          {
            id: "synthetic/current",
            name: "Current",
            description: "Current profile palette",
            source: "plugin",
            modes: ["dark"],
            pluginId: "synthetic",
          },
        ],
        error: null,
      };
      Object.assign(context.theme, {
        catalog: { ...current, read: { scope: currentScope, result: second.promise } },
      });
      publishConfigSource(context.theme);
      second.resolve(current);
      await waitForSolid(() =>
        expect(view.page.querySelector('[data-theme-id="synthetic/current"]')).not.toBeNull(),
      );
      first.resolve({
        themes: [
          {
            id: "synthetic/retired",
            name: "Retired",
            description: "Retired profile palette",
            source: "plugin",
            modes: ["dark"],
            pluginId: "synthetic",
          },
        ],
        error: null,
      });
      await first.promise;
      flush();
      expect(view.page.querySelector('[data-theme-id="synthetic/retired"]')).toBeNull();
      expect(view.page.querySelector('[data-theme-id="synthetic/current"]')).not.toBeNull();
    });

    it("recovers plugin discovery without replacing the section or its manage link", async () => {
      const first = deferred<PluginsListResult>();
      const second = deferred<PluginsListResult>();
      let pluginRequests = 0;
      const request = vi.fn((method: string) => {
        if (method === "plugins.list") {
          return pluginRequests++ === 0 ? first.promise : second.promise;
        }
        return Promise.resolve(method === "models.list" ? { models: [] } : {});
      });
      const { view, source } = await mount(createTestGatewayClient(request));
      const hello = () => gatewayHelloForMethods(["system.info", "plugins.list"]);
      source.publish({ ...source.gateway.snapshot, hello: hello() });
      const section = expectDefined(
        view.page.querySelector("#settings-session-sources"),
        "session sources section",
      );
      const manage = expectDefined(
        section.querySelector<HTMLAnchorElement>("a"),
        "manage plugins link",
      );
      await waitForSolid(() => expect(pluginRequests).toBe(1));
      await waitForSolid(() => expect(section.textContent).toContain("Loading…"));

      first.reject(new Error("catalog unavailable"));
      await waitForSolid(() =>
        expect(section.textContent).toContain("Session source settings are unavailable."),
      );
      expect(section.querySelector("a")).toBe(manage);
      source.publish({ ...source.gateway.snapshot, hello: hello() });
      second.resolve({
        plugins: [{ id: "codex", name: "Codex", installed: true, enabled: true, state: "enabled" }],
        diagnostics: [],
        mutationAllowed: true,
      });
      await waitForSolid(() => expect(section.textContent).toContain("Show Codex sessions"));
      expect(view.page.querySelector("#settings-session-sources")).toBe(section);
      expect(section.querySelector("a")).toBe(manage);
    });

    it("keeps hidden-section restore controls live while superseding a label read", async () => {
      setStoredSessionCatalogHidden("synthetic-catalog", true);
      const first = deferred<SessionsCatalogListResult>();
      const second = deferred<SessionsCatalogListResult>();
      const labels = (label: string): SessionsCatalogListResult => ({
        catalogs: [
          {
            id: "synthetic-catalog",
            label,
            capabilities: { continueSession: false, archive: false },
            hosts: [],
          },
        ],
      });
      let labelRequests = 0;
      let firstSignal: AbortSignal | undefined;
      const request = vi.fn(
        (
          method: string,
          _params?: unknown,
          options?: Parameters<GatewayBrowserClient["request"]>[2],
        ) => {
          if (method === "sessions.catalog.list") {
            if (labelRequests++ === 0) {
              firstSignal = options?.signal;
              return first.promise;
            }
            return second.promise;
          }
          return Promise.resolve(method === "models.list" ? { models: [] } : {});
        },
      );
      const { view, source, context } = await mount(createTestGatewayClient(request));
      source.publish({
        ...source.gateway.snapshot,
        hello: gatewayHelloForMethods(["system.info", "sessions.catalog.list"]),
      });
      await waitForSolid(() => expect(labelRequests).toBe(1));
      const row = expectDefined(
        [...view.page.querySelectorAll(".settings-row")].find(
          (item) => item.querySelector(".settings-row__title")?.textContent === "synthetic-catalog",
        ),
        "hidden session catalog row",
      );
      const restore = expectDefined(
        row.querySelector<HTMLButtonElement>("button"),
        "restore hidden section button",
      );
      context.settingsAgentSelection.state.selectedId = "other-agent";
      publishConfigSource(context.settingsAgentSelection);
      await waitForSolid(() => expect(labelRequests).toBe(2));
      expect(firstSignal?.aborted).toBe(true);
      second.resolve(labels("Current synthetic sessions"));
      await waitForSolid(() => expect(row.textContent).toContain("Current synthetic sessions"));
      expect(row.querySelector("button")).toBe(restore);

      first.resolve(labels("Stale synthetic sessions"));
      await first.promise;
      flush();
      expect(row.textContent).not.toContain("Stale synthetic sessions");
      restore.click();
      await waitForSolid(() => expect(row.isConnected).toBe(false));
    });
  });
});
