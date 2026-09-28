/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { i18n } from "../../i18n/index.ts";
import type { PluginsInspectResult } from "../../lib/plugins/index.ts";
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

  async function setup(handler: (method: string, params: unknown) => Promise<unknown>) {
    const { client, request } = createClient(handler);
    const harness = createGateway(client);
    const result = createResult(createPlugin({ enabled: true, state: "enabled" }));
    const route = createPluginsRouteData(
      harness.gateway,
      result,
      createPluginsRouteLocation("/settings/plugins/workboard"),
    );
    const mounted = await mountPage(createContext(harness.gateway), route, "settings");
    await waitForFast(() => expect(mounted.page.detail?.inspection).toBeTruthy());
    await mounted.page.updateComplete;
    return { ...mounted, ...harness, client, request, route };
  }

  it.each([
    "unauthenticated",
    "requires-authorization",
    "pending-authorization",
    "authorized",
    undefined,
  ] as const)(
    "shows sign-in only when the OAuth owner reports missing authorization (%s)",
    async (state) => {
      const inspection = createInspectResult({
        mcpAuth: state ? [{ serverName: "workboard-mcp", state }] : undefined,
      });
      const { page } = await setup(async () => inspection);
      const alert = page.querySelector(".plugin-auth-alert");
      if (state && state !== "authorized") {
        expect(alert?.textContent).toContain("Sign in to Workboard");
        expect(alert?.previousElementSibling?.className).toBe("plugin-catalog-detail__hero");
      } else {
        expect(alert).toBeNull();
      }
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
    page.querySelector<HTMLButtonElement>(".plugin-auth-alert button")!.click();
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
    expect(page.querySelector(".plugin-auth-alert")).not.toBeNull();
    refreshed.resolve(
      createInspectResult({ mcpAuth: [{ serverName: "workboard-mcp", state: "authorized" }] }),
    );
    await waitForFast(() => expect(page.querySelector(".plugin-auth-alert")).toBeNull());
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
      page.querySelector<HTMLButtonElement>(".plugin-auth-alert button")!.click();
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
