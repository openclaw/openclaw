import { expect, it } from "vitest";
import type { SessionPlacementDiskSpace } from "../../../packages/gateway-protocol/src/schema/session-placement.js";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { activePlacement, cloudSession, cloudSessionList } from "./cloud-session.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const sessionKey = "agent:main:disk-monitor";
const gibibyte = 1024 ** 3;
const mebibyte = 1024 ** 2;
const observedAtMs = Date.parse("2026-08-13T16:00:00.000Z");

const suite = createControlUiE2eSuite({ name: "Cloud-session disk-space monitoring" });

function sessionsList(diskSpace: SessionPlacementDiskSpace) {
  return cloudSessionList(
    cloudSession(
      sessionKey,
      "Disk monitor",
      diskSpace.observedAtMs,
      activePlacement(observedAtMs, {
        updatedAtMs: diskSpace.observedAtMs,
        diskSpace,
      }),
    ),
  );
}

suite.define(() => {
  it("refreshes accessible sidebar disk pressure through canonical session events", () =>
    suite.withPage(
      { ...createControlUiE2eContextOptions(), colorScheme: "dark" },
      async ({ page }) => {
        const healthy = {
          status: "ok",
          availableBytes: 6 * gibibyte,
          totalBytes: 10 * gibibyte,
          observedAtMs,
        } satisfies SessionPlacementDiskSpace;
        const gateway = await installMockGateway(page, {
          methodResponses: { "sessions.list": sessionsList(healthy) },
          sessionKey,
        });

        const sidebarRow = page.locator(
          `.sidebar-recent-session[data-session-key="${sessionKey}"]`,
        );
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

        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await sidebarRow.getByText("Disk monitor", { exact: true }).waitFor();
        await expectAccessibleBadge("ok", "Placement: active");

        for (const [status, freeMb, title] of [
          ["warning", 247, "Cloud session disk space is low"],
          ["critical", 80, "Cloud session disk space is critically low"],
        ] as const) {
          await refresh({
            status,
            availableBytes: freeMb * mebibyte,
            totalBytes: 6 * gibibyte,
            observedAtMs: observedAtMs + (status === "warning" ? 1_000 : 2_000),
          });
          await expectAccessibleBadge(status, `Placement: active · ${title}`);
        }

        await refresh({ ...healthy, observedAtMs: observedAtMs + 3_000 });
        await expectAccessibleBadge("ok", "Placement: active");
      },
    ));
});
