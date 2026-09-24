import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import type { NativeGatewaysSnapshot } from "../app/native-gateways.runtime.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "native Gateway health" });
const snapshot: NativeGatewaysSnapshot = {
  currentId: "profile:team",
  gateways: [
    {
      id: "primary",
      name: "Local Gateway",
      kind: "local",
      isPrimary: true,
      canPromote: false,
      health: "ok",
    },
    {
      id: "profile:team",
      name: "Team",
      kind: "remote",
      isPrimary: false,
      canPromote: true,
      health: "unknown",
    },
    {
      id: "profile:studio",
      name: "Studio",
      kind: "remote",
      isPrimary: false,
      canPromote: true,
      health: "unknown",
    },
  ],
};

// Chromium models only the native host boundary. The production application owns
// the handshake and health report; no test writes a successful health report.
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
  return page.locator(`wa-dropdown-item[value="gateway:${encodeURIComponent(id)}"]`);
}

async function assertSelectionUnchanged(page: Page) {
  const primary = gatewayRow(page, "primary");
  const team = gatewayRow(page, "profile:team");
  const studio = gatewayRow(page, "profile:studio");
  expect(await primary.getAttribute("aria-checked")).toBe("false");
  expect(await primary.locator(".sidebar-gateway-primary").textContent()).toBe("primary");
  expect(await primary.locator(".sidebar-gateway-check").count()).toBe(0);
  expect(await team.getAttribute("aria-checked")).toBe("true");
  expect(await team.locator(".sidebar-gateway-check").count()).toBe(1);
  expect(await team.locator(".sidebar-gateway-primary").count()).toBe(0);
  expect(await studio.getAttribute("aria-checked")).toBe("false");
  expect(await studio.locator(".sidebar-gateway-health").getAttribute("data-health")).toBe(
    "unknown",
  );
  expect(await studio.locator(".sidebar-gateway-health").getAttribute("aria-label")).toBe(
    "Unknown status",
  );
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
        const proof = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim()
          ? createControlUiE2eArtifactDir("native-gateway-health")
          : undefined;
        await installNativeHost(page);
        const gateway = await installMockGateway(page, {
          presenceUsers: [
            { self: true, id: "proof-user", name: "Alex", email: "alex@example.test" },
          ],
          assistantName: "Assistant",
          agentModel: "example/sample-model",
          models: [{ id: "sample-model", name: "Sample model", provider: "example" }],
          sessions: [],
          historyMessages: [],
        });
        await page.goto(`${suite.server.baseUrl}new`);
        await waitForControlUiGatewayReady(page);
        expect((await gateway.getRequests("connect")).length).toBeGreaterThan(0);
        await page.locator(".sidebar-identity-card").click();
        const teamHealth = gatewayRow(page, "profile:team").locator(".sidebar-gateway-health");
        await expect.poll(() => teamHealth.getAttribute("data-health")).toBe("ok");
        expect(await teamHealth.getAttribute("aria-label")).toBe("Connected");
        const identity = page.locator(".sidebar-identity-card");
        expect(await identity.locator(".sidebar-gateway-health").count()).toBe(0);
        await expect.poll(() => identity.locator(".gateway-status__label").count()).toBe(0);
        await assertSelectionUnchanged(page);
        await page.mouse.move(1100, 850);
        if (proof) {
          await page.screenshot({
            path: path.join(proof, "after-connected.png"),
            animations: "disabled",
          });
        }

        const firstConnectCount = (await gateway.getRequests("connect")).length;
        await gateway.setOnline(false);
        await expect.poll(() => teamHealth.getAttribute("data-health")).toBe("error");
        expect(await teamHealth.getAttribute("aria-label")).toBe("Unreachable");
        await assertSelectionUnchanged(page);
        if (proof) {
          await page.screenshot({
            path: path.join(proof, "connection-lost.png"),
            animations: "disabled",
          });
        }

        await gateway.setOnline(true);
        await gateway.waitForRequest("connect", { after: firstConnectCount });
        await waitForControlUiGatewayReady(page);
        await expect.poll(() => teamHealth.getAttribute("data-health")).toBe("ok");
        expect(await teamHealth.getAttribute("aria-label")).toBe("Connected");
        await assertSelectionUnchanged(page);
        expect(await identity.locator(".sidebar-gateway-health").count()).toBe(0);
        await expect.poll(() => identity.locator(".gateway-status__label").count()).toBe(0);
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
        if (proof) {
          await page.screenshot({
            path: path.join(proof, "after-reconnected.png"),
            animations: "disabled",
          });
        }
      },
    );
  });
});
