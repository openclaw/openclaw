/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { i18n } from "../../i18n/index.ts";
import type { PluginsInspectResult } from "../../lib/plugins/index.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  createClient,
  createContext,
  createGateway,
  createInspectResult,
  createPlugin,
  createPluginsRouteData,
  createPluginsRouteLocation,
  createResult,
  mountPage,
  resetPluginsPageTestState,
} from "./plugins-page.test-support.ts";

describe("plugin MCP sign-in", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
    vi.spyOn(window, "open").mockReturnValue(null);
  });
  afterEach(resetPluginsPageTestState);

  async function setup(
    handler: (method: string, params: unknown) => Promise<unknown>,
    advertiseMcpLogin = true,
  ) {
    const { client, request } = createClient(handler);
    const harness = createGateway(client);
    if (advertiseMcpLogin) {
      harness.emit(client, true, {
        hello: gatewayHelloForMethods([
          ...(harness.gateway.snapshot.hello?.features?.methods ?? []),
          "mcp.authLogin",
        ]),
      });
    }
    const result = createResult(createPlugin({ enabled: true, state: "enabled" }));
    const route = createPluginsRouteData(
      harness.gateway,
      result,
      createPluginsRouteLocation("/settings/plugins/workboard"),
    );
    const context = createContext(harness.gateway);
    const mounted = await mountPage(context, route, "settings");
    await waitForFast(() => expect(mounted.page.detail?.inspection).toBeTruthy());
    await mounted.page.updateComplete;
    return { ...mounted, ...harness, client, request, route, context };
  }

  it.each(["unauthenticated", "authorized", undefined] as const)(
    "shows Connect before sign-in and Connected with Edit afterward (%s)",
    async (state) => {
      const inspection = createInspectResult({
        mcpAuth: state ? [{ serverName: "workboard-mcp", state }] : undefined,
      });
      const { page, context } = await setup(async () => inspection);
      const section = [...page.querySelectorAll(".plugin-capabilities")].find((entry) =>
        entry.querySelector("h2")?.textContent?.startsWith("Accounts"),
      );
      if (state) {
        expect(section?.textContent).toContain("workboard-mcp");
        const status = section?.querySelector('[role="status"]');
        const button = section?.querySelector<HTMLButtonElement>("button");
        expect(status?.textContent?.trim() ?? null).toBe(
          state === "authorized" ? "Connected" : null,
        );
        expect(button?.textContent?.trim()).toBe(state === "authorized" ? "Edit" : "Connect");
        if (state === "authorized") {
          button?.click();
          expect(context.navigate).toHaveBeenCalledWith("mcp");
        }
        expect(page.querySelector(".plugin-catalog-detail__panel")?.firstElementChild).toBe(
          section,
        );
      } else {
        expect(section).toBeUndefined();
      }
    },
  );

  it.each([
    ["missing", undefined],
    ["configured", undefined],
  ] as const)(
    "shows credential state %s (required=%s) and opens existing Settings",
    async (status, requiresCredential) => {
      const inspection = createInspectResult({
        credentials: [
          {
            path: ["plugins", "entries", "workboard", "config", "apiKey"],
            label: "Workboard API key",
            envVars: ["WORKBOARD_API_KEY"],
            status,
            requiresCredential,
          },
        ],
        overview: {
          capabilities: {
            providers: [],
            channels: [],
            contracts: { webSearchProviders: ["workboard"] },
          },
        },
      });
      const { page, context } = await setup(async () => inspection);
      const sections = [...page.querySelectorAll(".plugin-capabilities")];
      expect(sections.map((section) => section.querySelector("h2")?.textContent)).toEqual([
        "Credentials1",
        "Capabilities1",
      ]);
      expect(sections[0]?.textContent).toContain("WORKBOARD_API_KEY");
      expect(sections[0]?.querySelector('[role="status"]')?.textContent?.trim() ?? null).toBe(
        status === "configured" ? "Configured" : null,
      );
      expect(sections[0]?.querySelector("button")?.textContent?.trim()).toBe(
        status === "configured" ? "Edit" : "Configure",
      );
      sections[0]?.querySelector<HTMLButtonElement>("button")?.click();
      expect(context.navigate).toHaveBeenCalledWith(
        "plugin-settings",
        expect.objectContaining({ search: "?view=settings" }),
      );
    },
  );

  it("starts the server's existing OAuth flow and waits for authoritative status after completion", async () => {
    const refreshed = createDeferred<PluginsInspectResult>();
    let completed = false;
    const { page, request } = await setup(async (method) => {
      if (method === "plugins.inspect") {
        return completed
          ? refreshed.promise
          : createInspectResult({
              mcpAuth: [{ serverName: "workboard-mcp", state: "requires-authorization" }],
            });
      }
      if (method === "mcp.authLogin") {
        completed = true;
        return { done: true, status: "done" };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    page.querySelector<HTMLButtonElement>('[aria-label="Connect workboard-mcp"]')!.click();
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith(
        "mcp.authLogin",
        { serverName: "workboard-mcp", sessionId: expect.any(String) },
        { timeoutMs: null },
      ),
    );
    await waitForFast(() =>
      expect(request.mock.calls.filter(([method]) => method === "plugins.inspect")).toHaveLength(2),
    );
    expect(page.querySelector('[aria-label="Connect workboard-mcp"]')).not.toBeNull();
    refreshed.resolve(
      createInspectResult({ mcpAuth: [{ serverName: "workboard-mcp", state: "authorized" }] }),
    );
    await waitForFast(() =>
      expect(page.querySelector('[aria-label="Connect workboard-mcp"]')).toBeNull(),
    );
    expect(page.querySelector(".plugin-capabilities")?.textContent).toContain("Connected");
  });

  it("disables Connect and refuses sign-in when the gateway does not advertise MCP OAuth", async () => {
    const { page, request } = await setup(
      async (method) =>
        method === "mcp.authLogin"
          ? { done: true, status: "done" }
          : createInspectResult({
              mcpAuth: [{ serverName: "workboard-mcp", state: "requires-authorization" }],
            }),
      false,
    );
    const button = page.querySelector<HTMLButtonElement>('[aria-label="Connect workboard-mcp"]')!;
    expect.soft(button.disabled).toBe(true);
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await page.updateComplete;
    expect(request.mock.calls.filter(([method]) => method === "mcp.authLogin")).toHaveLength(0);
    expect(window.open).not.toHaveBeenCalled();
  });

  it.each(["navigation", "reconnect"])(
    "cancels pending sign-in on %s without opening a late authorization URL",
    async (change) => {
      const admission = createDeferred<unknown>();
      const { page, request, route, emit, client } = await setup(async (method) => {
        if (method === "plugins.inspect") {
          return createInspectResult({
            mcpAuth: [{ serverName: "workboard-mcp", state: "unauthenticated" }],
          });
        }
        if (method === "mcp.authLogin") {
          return admission.promise;
        }
        if (method === "wizard.cancel") {
          return { status: "cancelled" };
        }
        if (method === "plugins.list") {
          return createResult(createPlugin({ enabled: true, state: "enabled" }));
        }
        throw new Error(`Unexpected method ${method}`);
      });
      page.querySelector<HTMLButtonElement>('[aria-label="Connect workboard-mcp"]')!.click();
      const start = request.mock.calls.find(([method]) => method === "mcp.authLogin")!;
      if (change === "navigation") {
        page.routeData = { ...route, location: createPluginsRouteLocation("/settings/plugins") };
        await page.updateComplete;
      } else {
        emit(client, false);
        emit(client, true);
      }
      await waitForFast(() =>
        expect(request).toHaveBeenCalledWith(
          "wizard.cancel",
          { sessionId: (start[1] as { sessionId: string }).sessionId, closeInput: true },
          expect.anything(),
        ),
      );
      admission.resolve({ done: false, status: "running" });
      await waitForFast(() =>
        expect(request.mock.calls.filter(([method]) => method === "wizard.cancel")).toHaveLength(2),
      );
      expect(request.mock.calls.some(([method]) => method === "wizard.next")).toBe(false);
      expect(window.open).toHaveBeenCalledTimes(1);
    },
  );
});
