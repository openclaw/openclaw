import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import type { NativeGatewaysSnapshot } from "../app/native-gateways.runtime.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "native Gateway health" });
const snapshot: NativeGatewaysSnapshot = {
  currentId: "profile:team",
  gateways: ["primary", "profile:team", "profile:studio"].map((id) => ({
    id,
    name: id === "profile:team" ? "Team" : id,
    kind: id === "primary" ? "local" : "remote",
    isPrimary: id === "primary",
    canPromote: id !== "primary",
    health: id === "primary" ? "ok" : "unknown",
  })),
};

// Model the native host boundary only; the application owns handshake and health reports.
async function installNativeHost(page: Page) {
  await page.addInitScript((initial) => {
    type HealthReport = { gatewayUrl: string; health: "ok" | "error" | "unknown" };
    const state: {
      __OPENCLAW_NATIVE_GATEWAYS__: NativeGatewaysSnapshot;
      __OPENCLAW_NATIVE_GATEWAY_HEALTH__?: HealthReport;
      nativeHealthReports: HealthReport[];
      nativeGatewayActions: unknown[];
    } = {
      __OPENCLAW_NATIVE_GATEWAYS__: initial,
      nativeHealthReports: [],
      nativeGatewayActions: [],
    };
    const host = Object.assign(window, state);
    const expectedEndpoint = new URL(window.location.origin);
    expectedEndpoint.protocol = expectedEndpoint.protocol === "https:" ? "wss:" : "ws:";
    Object.assign(host, {
      webkit: {
        messageHandlers: {
          openclawGateways: {
            postMessage: (message: unknown) => host.nativeGatewayActions.push(message),
          },
        },
      },
    });
    window.addEventListener("openclaw:native-gateway-health-changed", () => {
      const report = host["__OPENCLAW_NATIVE_GATEWAY_HEALTH__"];
      if (!report || new URL(report.gatewayUrl).href !== expectedEndpoint.href) {
        return;
      }
      host.nativeHealthReports.push({ ...report });
      const current = host["__OPENCLAW_NATIVE_GATEWAYS__"];
      const next = structuredClone(current);
      const currentGateway = next.gateways.find((gateway) => gateway.id === next.currentId);
      if (currentGateway) {
        currentGateway.health = report.health;
      }
      host["__OPENCLAW_NATIVE_GATEWAYS__"] = next;
      window.dispatchEvent(new CustomEvent("openclaw:native-gateways-changed", { detail: next }));
    });
  }, snapshot);
}

function gatewayRow(page: Page, id: string): Locator {
  return page.locator(`[data-value="gateway:${encodeURIComponent(id)}"]`);
}

async function assertSelectionUnchanged(page: Page) {
  const primary = gatewayRow(page, "primary");
  const team = gatewayRow(page, "profile:team");
  const studio = gatewayRow(page, "profile:studio");
  const health = studio.locator(".sidebar-gateway-health");
  expect(
    await Promise.all([
      primary.getAttribute("aria-checked"),
      primary.locator(".sidebar-gateway-primary").textContent(),
      primary.locator(".sidebar-gateway-check").count(),
      team.getAttribute("aria-checked"),
      team.locator(".sidebar-gateway-check").count(),
      team.locator(".sidebar-gateway-primary").count(),
      studio.getAttribute("aria-checked"),
      health.getAttribute("data-health"),
      health.getAttribute("aria-label"),
    ]),
  ).toEqual(["false", "primary", 0, "true", 1, 0, "false", "unknown", "Unknown status"]);
  expect(await page.evaluate(() => Reflect.get(window, "nativeGatewayActions"))).toEqual([]);
}

suite.define(() => {
  it("reports a connected saved window, connection loss, and recovery without promoting or probing other profiles", async () => {
    await suite.withPage(
      {
        viewport: { width: 1280, height: 900 },
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
      },
      async ({ page }) => {
        await installNativeHost(page);
        const gateway = await installMockGateway(page, { sessions: [], historyMessages: [] });
        await page.goto(`${suite.server.baseUrl}new`);
        await waitForControlUiGatewayReady(page);
        expect((await gateway.getRequests("connect")).length).toBeGreaterThan(0);
        await page.locator(".sidebar-identity-card").click();
        const switcher = page.locator('[data-value="command:gateways"]');
        await switcher.click();
        await page.getByRole("menu", { name: "Team", exact: true }).waitFor({ state: "visible" });
        const currentHealth = switcher.locator(".sidebar-gateway-health");
        const teamHealth = gatewayRow(page, "profile:team").locator(".sidebar-gateway-health");
        const identity = page.locator(".sidebar-identity-card");
        const footer = page.locator(".sidebar-shell__footer .gateway-status");
        let firstConnectCount = 0;
        for (const [phase, health, label] of [
          ["after-connected", "ok", "Connected"],
          ["connection-lost", "error", "Unreachable"],
          ["after-reconnected", "ok", "Connected"],
        ]) {
          if (phase === "connection-lost") {
            firstConnectCount = (await gateway.getRequests("connect")).length;
            await gateway.setOnline(false);
          } else if (phase === "after-reconnected") {
            await gateway.setOnline(true);
            await gateway.waitForRequest("connect", { after: firstConnectCount });
            await waitForControlUiGatewayReady(page);
          }
          await expect.poll(() => teamHealth.getAttribute("data-health")).toBe(health);
          expect(await teamHealth.getAttribute("aria-label")).toBe(label);
          await expect.poll(() => currentHealth.getAttribute("data-health")).toBe(health);
          await expect
            .poll(() => identity.getAttribute("data-connection-status"))
            .toBe(health === "ok" ? "connected" : "reconnecting");
          if (health === "ok") {
            expect(await identity.locator(".sidebar-gateway-health").count()).toBe(0);
            await footer.waitFor({ state: "detached" });
          } else {
            await footer
              .getByRole("button", { name: "Reconnecting… — Retry now", exact: true })
              .waitFor();
          }
          await assertSelectionUnchanged(page);
        }
        const reportedHealth = await page.evaluate(() => {
          const reports = Reflect.get(window, "nativeHealthReports") as Array<{ health: string }>;
          return reports.map((report) => report.health);
        });
        expect(reportedHealth[0]).toBe("unknown");
        expect(reportedHealth).toContain("error");
        expect(reportedHealth.filter((health) => health === "ok")).toHaveLength(2);
        const socketUrls = await gateway.getSocketUrls();
        expect(new Set(socketUrls).size).toBe(1);
        expect(new URL(socketUrls[0]!).host).toBe(new URL(suite.server.baseUrl).host);
      },
    );
  });
});
