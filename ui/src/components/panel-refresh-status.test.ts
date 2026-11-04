/* @vitest-environment jsdom */
import { createComponent } from "solid-js";
import { expect, it } from "vitest";
import { GatewayRequestError } from "../api/gateway-connect-errors.ts";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";
import { createApplicationGatewaySnapshot } from "../test-helpers/application-context-fixtures.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import {
  beginPanelRefresh,
  completePanelRefresh,
  createPanelRefreshStatus,
  failPanelRefresh,
} from "./panel-refresh-status-state.ts";
import { PanelRefreshStatus } from "./solid/panel-refresh-status.tsx";

const connected: ApplicationGatewaySnapshot = createApplicationGatewaySnapshot({
  phase: "connected",
  sessionKey: "agent:main:main",
});
function renderStatus(
  status: Parameters<typeof PanelRefreshStatus>[0]["status"],
  errorMessage?: string,
) {
  return mountSolid(() => createComponent(PanelRefreshStatus, { status, errorMessage })).container;
}

it.each([
  ["gateway-suspending", {}],
  ["gateway-restarting", {}],
  ["startup-sidecars", {}],
  ["", { phase: "reconnecting" }],
  ["", { restartPending: true }],
  ["", { suspensionPhase: "preparing" }],
  ["", { suspensionPhase: "draining" }],
  ["", { suspensionPhase: "prepared" }],
] as const)("retains stale data without a callout while unavailable: %s %j", (reason, state) => {
  const error = reason
    ? new GatewayRequestError({
        code: "UNAVAILABLE",
        message: "Temporarily unavailable",
        retryable: true,
        details: { reason },
      })
    : new Error("Transport failed");
  const status = failPanelRefresh(completePanelRefresh(), error, { ...connected, ...state });
  expect(renderStatus(status, reason ? "Could not load details" : undefined).textContent).toBe("");
  expect(status).toMatchObject({
    error: null,
    hasLoaded: true,
    stale: true,
    awaitingGateway: true,
  });
  expect(beginPanelRefresh(status).awaitingGateway).toBe(true);
  expect(completePanelRefresh().awaitingGateway).toBe(false);
});

it.each([
  [{}, "UNAVAILABLE", "Catalog service failed"],
  [{ suspensionPhase: "accepting" }, "UNAVAILABLE", "Catalog service failed"],
  [{ suspensionPhase: "draining" }, "INVALID_REQUEST", 'unknown agent id "main"'],
  [{ restartPending: true }, "INVALID_REQUEST", 'unknown agent id "main"'],
] as const)(
  "shows hard failures with stale status and no Retry button: %j",
  (state, code, message) => {
    const status = failPanelRefresh(
      completePanelRefresh(),
      new GatewayRequestError({ code, message }),
      { ...connected, ...state },
    );
    const container = renderStatus(status);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(message);
    expect(container.textContent).toContain("Showing stale data");
    expect(container.querySelector("button")).toBeNull();
    expect(status.awaitingGateway).toBe(false);
  },
);

it("does not classify lifecycle words in ordinary error messages", () => {
  expect(
    failPanelRefresh(createPanelRefreshStatus(), new Error("gateway-suspending"), connected),
  ).toMatchObject({ error: "gateway-suspending", stale: false, awaitingGateway: false });
});

it("shows a stale-only warning without an alert or button", () => {
  const container = renderStatus({ ...completePanelRefresh(), stale: true });
  expect(container.querySelector('[role="status"]')?.textContent).toContain("Showing stale data");
  expect(container.querySelector('[role="alert"], button')).toBeNull();
});
