import { expect, it } from "vitest";
import type { SessionPlacementDiskSpace } from "../../../packages/gateway-protocol/src/schema/session-placement.js";
import type { SessionsListResult } from "../api/types.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { activePlacement, cloudSession, cloudSessionList } from "./cloud-session.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const sessionKey = "agent:main:disk-monitor";
const viewport = { height: 900, width: 1280 };
const gibibyte = 1024 ** 3;
const mebibyte = 1024 ** 2;
const observedAtMs = Date.parse("2026-08-13T16:00:00.000Z");

const suite = createControlUiE2eSuite({
  name: "Control UI cloud-session disk-space monitoring",
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

function sessionsList(diskSpace: SessionPlacementDiskSpace): SessionsListResult {
  const placementUpdatedAtMs = diskSpace.observedAtMs;
  return cloudSessionList(
    cloudSession(
      sessionKey,
      "Disk monitor",
      placementUpdatedAtMs,
      activePlacement(observedAtMs, {
        updatedAtMs: placementUpdatedAtMs,
        diskSpace,
      }),
    ),
  );
}

suite.define(() => {
  it("refreshes selected-chat and sidebar disk pressure through canonical session events", async () => {
    const context = await suite.newBrowserContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport,
    });
    const page = await context.newPage();
    const healthy = {
      status: "ok",
      availableBytes: 6 * gibibyte,
      totalBytes: 10 * gibibyte,
      observedAtMs,
    } satisfies SessionPlacementDiskSpace;
    const gateway = await installMockGateway(page, {
      historyMessages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Disk monitor is ready." }],
          timestamp: observedAtMs - 1_000,
        },
      ],
      methodResponses: { "sessions.list": sessionsList(healthy) },
      sessionKey,
    });

    const sidebarRow = page.locator(`.sidebar-recent-session[data-session-key="${sessionKey}"]`);
    const cloudBadge = sidebarRow.locator(".session-row-badge--cloud");
    const expectAccessibleBadge = async (
      status: SessionPlacementDiskSpace["status"],
      label: string,
    ): Promise<void> => {
      await expect.poll(() => cloudBadge.getAttribute("data-disk-space-status")).toBe(status);
      await expect.poll(() => cloudBadge.getAttribute("aria-label")).toBe(label);
      const descriptionId = await cloudBadge.getAttribute("aria-describedby");
      expect(descriptionId).toBeTruthy();
      await expect.poll(() => page.locator(`#${descriptionId}`).textContent()).toBe(label);
    };
    const refresh = async (diskSpace: SessionPlacementDiskSpace): Promise<void> => {
      const requestCount = (await gateway.getRequests("sessions.list")).length;
      await gateway.setSessionsListResponse(sessionsList(diskSpace));
      await gateway.emitGatewayEvent("sessions.changed", {
        reason: "worker-disk-space",
        sessionKey,
      });
      await expect
        .poll(async () => (await gateway.getRequests("sessions.list")).length)
        .toBeGreaterThan(requestCount);
    };

    try {
      const response = await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      expect(response?.status()).toBe(200);
      await gateway.waitForRequest("connect");
      await gateway.waitForRequest("sessions.list");
      await page.getByText("Disk monitor is ready.", { exact: true }).waitFor();
      await sidebarRow.getByText("Disk monitor", { exact: true }).waitFor();
      expect(await page.locator(".chat-cloud-disk-space-notice").count()).toBe(0);
      await expectAccessibleBadge("ok", "Placement: active");

      for (const [status, freeMb, role, title, description] of [
        [
          "warning",
          247,
          "status",
          "Cloud session disk space is low",
          "96% used · 247 MB free. Delete unneeded files or stop the cloud worker before large writes.",
        ],
        [
          "critical",
          80,
          "alert",
          "Cloud session disk space is critically low",
          "99% used · 80 MB free. New writes may fail and stop the agent. Delete unneeded files or stop the cloud worker before large writes.",
        ],
      ] as const) {
        await refresh({
          status,
          availableBytes: freeMb * mebibyte,
          totalBytes: 6 * gibibyte,
          observedAtMs: observedAtMs + (status === "warning" ? 1_000 : 2_000),
        });
        const notice = page.getByRole(role).filter({ hasText: title });
        await notice.waitFor();
        expect(await notice.textContent()).toContain(description);
        await expectAccessibleBadge(status, `Placement: active · ${title}`);
      }

      await refresh({ ...healthy, observedAtMs: observedAtMs + 3_000 });
      await expect.poll(() => page.locator(".chat-cloud-disk-space-notice").count()).toBe(0);
      await expectAccessibleBadge("ok", "Placement: active");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
