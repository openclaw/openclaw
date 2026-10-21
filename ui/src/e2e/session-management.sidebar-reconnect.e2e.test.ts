import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  waitForControlUiGatewayReady,
  waitForControlUiGatewayReconnecting,
} from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  replaceGatewayClient,
  waitForGatewayRecoveryScope,
} from "./new-session-page.test-support.ts";
import {
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it("queues an offline sidebar rename and sends it once after same-scope reconnect", () =>
    suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const sessionKey = "agent:main:offline-rename";
      const gateway = await installMockGateway(page, {
        sessionKey,
        sessions: [sessionRow(sessionKey, "Original name", 1_000)],
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await waitForControlUiGatewayReady(page);
      await waitForGatewayRecoveryScope(page);
      const sidebar = page.locator("openclaw-app-sidebar");
      const row = sidebar.locator('[data-session-key="' + sessionKey + '"]');
      await row.waitFor({ state: "visible" });
      const footer = page.locator(".sidebar-shell__footer");
      const before = await takeControlUiScreenshotFrame(page, row, [row], {
        elements: [row],
        animations: "disabled",
      });
      await writeFile(path.join(suite.artifactDir, "offline-rename-before.png"), before.png);
      await gateway.setOnline(false);
      await waitForControlUiGatewayReconnecting(page);
      await row.click({ button: "right" });
      await page.getByRole("menuitem", { name: "Rename…", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Rename session", exact: true });
      await dialog.getByRole("textbox", { name: "Rename session" }).fill("Renamed offline");
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await dialog.waitFor({ state: "detached" });
      await expect.poll(() => row.textContent()).toContain("Renamed offline");
      const connectionStatus = footer.locator(".gateway-status");
      await connectionStatus.getByText("Reconnecting… · 1 queued", { exact: true }).waitFor();
      expect(await connectionStatus.getByRole("button").count()).toBe(0);
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
      const queued = await takeControlUiScreenshotFrame(page, footer, [row, connectionStatus], {
        elements: [footer, connectionStatus],
        animations: "disabled",
      });
      await writeFile(path.join(suite.artifactDir, "offline-rename-queued.png"), queued.png);
      for (const [index, element] of queued.elements.entries()) {
        await writeFile(
          path.join(suite.artifactDir, `offline-rename-queued-${index + 1}.png`),
          element.png,
        );
      }
      await gateway.setOnline(true);
      await waitForControlUiGatewayReady(page);
      await waitForGatewayRecoveryScope(page);
      await gateway.waitForRequest("sessions.patch", {
        match: { key: sessionKey, label: "Renamed offline" },
      });
      await connectionStatus.waitFor({ state: "detached" });
      await expect.poll(() => row.textContent()).toContain("Renamed offline");
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(1);
      expect(await page.locator(".shell > .sr-only[role=status]").textContent()).toBe("Connected");
    }));

  it("retains My sessions through transport and client replacement without exposing other owners", async () => {
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const sessionKey = "agent:main:owned-reconnect";
    const ownKeys = [sessionKey, "agent:main:owned-other"];
    const gateway = await installMockGateway(page, {
      hasMultipleSessionSharingIdentities: true,
      sessionKey,
      presenceUsers: [
        { self: true, id: "reader", name: "Reader", identity: { type: "profile", id: "reader" } },
      ],
      sessions: [
        ...ownKeys.map((key, index) => ({
          ...sessionRow(key, "Owned row " + index, Date.parse("2026-07-01T16:00:00.000Z") - index),
          owner: { actor: { type: "human" as const, id: "reader" } },
        })),
        {
          ...sessionRow(
            "agent:main:foreign",
            "Foreign row",
            Date.parse("2026-07-01T15:59:00.000Z"),
          ),
          owner: { actor: { type: "human" as const, id: "other" } },
        },
        {
          ...sessionRow(
            "agent:main:agent-owned",
            "Agent row",
            Date.parse("2026-07-01T15:58:00.000Z"),
          ),
          owner: { actor: { type: "agent" as const, id: "reader" } },
        },
      ],
    });
    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await waitForControlUiGatewayReady(page);
      const sidebar = page.locator("openclaw-app-sidebar");
      const rows = sidebar.locator(".sidebar-recent-session");
      const ownerFilter = sidebar.locator("#sidebar-session-owner-title");
      await expect.poll(() => ownerFilter.getAttribute("aria-label")).toBe("Owners: My sessions");
      await expect.poll(() => rows.count()).toBe(2);
      const socketCount = await gateway.getSocketCount();
      await gateway.setOnline(false);
      await waitForControlUiGatewayReconnecting(page);
      await expect.poll(() => gateway.getSocketCount()).toBeGreaterThan(socketCount);
      const reconnectSocketCount = await gateway.getSocketCount();
      await replaceGatewayClient(page);
      await expect.poll(() => gateway.getSocketCount()).toBeGreaterThan(reconnectSocketCount);
      await expect.poll(() => rows.count()).toBe(2);
      for (const key of ownKeys) {
        await sidebar.locator('[data-session-key="' + key + '"]').waitFor({ state: "visible" });
      }
      await expect.poll(() => rows.count()).toBe(2);
      expect(await ownerFilter.getAttribute("aria-label")).toBe("Owners: My sessions");
      expect(await sidebar.locator('[data-session-key="agent:main:foreign"]').count()).toBe(0);
      expect(await sidebar.locator('[data-session-key="agent:main:agent-owned"]').count()).toBe(0);
      await gateway.setOnline(true);
      await waitForControlUiGatewayReady(page);
      await expect.poll(() => rows.count()).toBe(2);
      expect(await ownerFilter.getAttribute("aria-label")).toBe("Owners: My sessions");
    } finally {
      await context.close();
    }
  });
});
