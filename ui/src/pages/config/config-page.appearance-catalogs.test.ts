/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PluginsListResult,
  SessionsCatalogListResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
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
