/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { i18n } from "../../i18n/index.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { createConnectedContext, mountProfilePage } from "./profile-page.test-support.ts";

beforeEach(async () => {
  await i18n.setLocale("en");
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it.each([
  { scopes: ["operator.read"] },
  { scopes: ["operator.sessions.read", "operator.sessions.write"] },
  { scopes: ["operator.admin"] },
])("shows negotiated scopes without requiring profile editing: $scopes", async ({ scopes }) => {
  const request = vi.fn(async () => ({}));
  const harness = createConnectedContext(request as GatewayBrowserClient["request"]);
  harness.emitHello(gatewayHelloForMethods([], scopes));
  const page = mountProfilePage(harness.context);
  await page.updateComplete;

  const access = page.querySelector("#settings-profile-access");
  expect(access?.querySelector(".settings-row__value")?.textContent).toBe(scopes.join(", "));
  expect(access?.textContent).toContain("The Gateway browser panel requires operator.admin.");
  expect(request).not.toHaveBeenCalled();
});

it("distinguishes unreported permissions from an explicit empty grant", async () => {
  const harness = createConnectedContext(
    vi.fn(async () => ({})) as GatewayBrowserClient["request"],
  );
  const page = mountProfilePage(harness.context);
  await page.updateComplete;
  expect(page.querySelector("#settings-profile-access")?.textContent).toContain(
    "The gateway did not report this connection's permissions.",
  );

  harness.emitHello(gatewayHelloForMethods([], []));
  await page.updateComplete;
  expect(page.querySelector("#settings-profile-access")?.textContent).toContain(
    "No scopes granted.",
  );
  expect(page.querySelector("#settings-profile-access")?.textContent).not.toContain(
    "did not report",
  );
});

it("retires displayed grants on disconnect and uses the newly negotiated scopes", async () => {
  const harness = createConnectedContext(
    vi.fn(async () => ({})) as GatewayBrowserClient["request"],
  );
  harness.emitHello(gatewayHelloForMethods([], ["operator.admin"]));
  const page = mountProfilePage(harness.context);
  await page.updateComplete;
  expect(page.querySelector(".settings-row__value")?.textContent).toBe("operator.admin");

  harness.emitConnected(false);
  await page.updateComplete;
  expect(page.querySelector("#settings-profile-access")).toBeNull();

  harness.emitHello(gatewayHelloForMethods([], ["operator.read"]));
  harness.emitConnected(true);
  await page.updateComplete;
  expect(page.querySelector(".settings-row__value")?.textContent).toBe("operator.read");

  // Narrow-grant updates do not change the profile editor's broad write permission.
  harness.emitHello(gatewayHelloForMethods([], ["operator.sessions.read"]));
  await page.updateComplete;
  expect(page.querySelector(".settings-row__value")?.textContent).toBe("operator.sessions.read");
});
