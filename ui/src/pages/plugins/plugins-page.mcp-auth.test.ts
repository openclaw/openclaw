/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { i18n } from "../../i18n/index.ts";
import type { PluginsInspectResult } from "../../lib/plugins/index.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { pageFixture } from "./plugins-page.lifecycle-test-support.ts";
import {
  createInspectResult,
  createPlugin,
  createPluginsRouteLocation,
  createResult,
  resetPluginsPageTestState,
} from "./plugins-page.test-support.ts";

beforeEach(async () => {
  await i18n.setLocale("en");
  vi.spyOn(window, "open").mockReturnValue(null);
});
afterEach(resetPluginsPageTestState);

const inspectionWithAuth = (state: "requires-authorization" | "authorized" | "unauthenticated") =>
  createInspectResult({ mcpAuth: [{ serverName: "workboard-mcp", state }] });
const accountButton = (page: ParentNode) =>
  page.querySelector<HTMLButtonElement>(
    '.plugin-capabilities [aria-label="Sign in to workboard-mcp"]',
  );
const heroSignIn = (page: ParentNode) =>
  page.querySelector<HTMLButtonElement>(".plugin-catalog-detail__sign-in");
async function setup(handlers: Record<string, () => unknown>, advertiseMcpLogin = true) {
  const fixture = pageFixture(handlers);
  const { client, gateway, emit } = fixture;
  if (advertiseMcpLogin) {
    emit(client, true, {
      hello: gatewayHelloForMethods([
        ...(gateway.snapshot.hello?.features?.methods ?? []),
        "mcp.authLogin",
      ]),
    });
  }
  const result = createResult(createPlugin({ enabled: true, state: "enabled" }));
  const route = fixture.route("/settings/plugins/workboard", result);
  const mounted = await fixture.mount("/settings/plugins/workboard", result);
  await waitForSolid(() =>
    expect(mounted.page.querySelector(".plugin-capabilities")).not.toBeNull(),
  );
  await mounted.page.updateComplete;
  return { ...fixture, ...mounted, route };
}

it("shows configured credentials and opens existing Settings", async () => {
  const inspection = createInspectResult({
    credentials: [
      {
        path: ["plugins", "entries", "workboard", "config", "apiKey"],
        label: "Workboard API key",
        envVars: ["WORKBOARD_API_KEY"],
        status: "configured",
      },
    ],
  });
  const { page, context } = await setup({ "plugins.inspect": () => inspection });
  const sections = [...page.querySelectorAll(".plugin-capabilities")];
  expect(sections[0]?.textContent).toContain("WORKBOARD_API_KEY");
  expect(sections[0]?.querySelector('[role="status"]')?.textContent?.trim() ?? null).toBe(
    "Configured",
  );
  expect(sections[0]?.querySelector("button")?.textContent?.trim()).toBe("Edit");
  sections[0]?.querySelector<HTMLButtonElement>("button")?.click();
  expect(context.navigate).toHaveBeenCalledWith(
    "plugin-settings",
    expect.objectContaining({ search: "?view=settings" }),
  );
});

it("starts the server's existing OAuth flow and waits for authoritative status after completion", async () => {
  const refreshed = createDeferred<PluginsInspectResult>();
  let completed = false;
  const { page, context, calls, waitForCall } = await setup({
    "plugins.inspect": () =>
      completed ? refreshed.promise : inspectionWithAuth("requires-authorization"),
    "mcp.authLogin": () => {
      completed = true;
      return { done: true, status: "done" };
    },
  });
  // Until the account is connected, sign-in takes the hero's primary action slot.
  expect(heroSignIn(page)?.textContent?.trim()).toBe("Sign in");
  expect(heroSignIn(page)?.getAttribute("aria-label")).toBe("Sign in to workboard-mcp");
  expect(accountButton(page)?.textContent?.trim()).toBe("Sign in");
  heroSignIn(page)!.click();
  await waitForCall("mcp.authLogin");
  expect(calls("mcp.authLogin")[0]?.[1]).toEqual({
    serverName: "workboard-mcp",
    sessionId: expect.any(String),
  });
  await waitForSolid(() => expect(calls("plugins.inspect")).toHaveLength(2));
  expect(accountButton(page)).not.toBeNull();
  refreshed.resolve(inspectionWithAuth("authorized"));
  await waitForSolid(() => expect(accountButton(page)).toBeNull());
  expect(heroSignIn(page)).toBeNull();
  expect(page.querySelector(".plugin-capabilities")?.textContent).toContain("Connected");
  page.querySelector<HTMLButtonElement>('[aria-label="Edit workboard-mcp connection"]')!.click();
  expect(context.navigate).toHaveBeenCalledWith("mcp");
});

it("disables Sign in and refuses sign-in when the gateway does not advertise MCP OAuth", async () => {
  const { page, calls } = await setup(
    {
      "mcp.authLogin": () => ({ done: true, status: "done" }),
      "plugins.inspect": () => inspectionWithAuth("requires-authorization"),
    },
    false,
  );
  const button = accountButton(page)!;
  expect.soft(button.disabled).toBe(true);
  expect(heroSignIn(page)).toBeNull();
  button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await page.updateComplete;
  expect(calls("mcp.authLogin")).toHaveLength(0);
  expect(window.open).not.toHaveBeenCalled();
});

it.each(["navigation", "reconnect"])(
  "cancels pending sign-in on %s without opening a late authorization URL",
  async (change) => {
    const admission = createDeferred<unknown>();
    const { page, request, calls, route, emit, client } = await setup({
      "plugins.inspect": () => inspectionWithAuth("unauthenticated"),
      "mcp.authLogin": () => admission.promise,
      "wizard.cancel": () => ({ status: "cancelled" }),
      "plugins.list": () => createResult(createPlugin({ enabled: true, state: "enabled" })),
    });
    accountButton(page)!.click();
    const start = request.mock.calls.find(([method]) => method === "mcp.authLogin")!;
    if (change === "navigation") {
      page.routeData = { ...route, location: createPluginsRouteLocation("/settings/plugins") };
      await page.updateComplete;
    } else {
      emit(client, false);
      emit(client, true);
    }
    await waitForSolid(() =>
      expect(request).toHaveBeenCalledWith(
        "wizard.cancel",
        { sessionId: (start[1] as { sessionId: string }).sessionId, closeInput: true },
        expect.anything(),
      ),
    );
    admission.resolve({ done: false, status: "running" });
    await waitForSolid(() => expect(calls("wizard.cancel")).toHaveLength(2));
    expect(calls("wizard.next")).toHaveLength(0);
    expect(window.open).toHaveBeenCalledTimes(1);
  },
);
