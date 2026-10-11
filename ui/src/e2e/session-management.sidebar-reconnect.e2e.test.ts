import { expect, it } from "vitest";
import {
  waitForControlUiGatewayReady,
  waitForControlUiGatewayReconnecting,
} from "../test-helpers/control-ui-e2e-readiness.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it("retains authenticated Mine rows through transport and client replacement without exposing other owners", async () => {
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const sessionKey = "agent:main:owned-reconnect";
    const ownKeys = [sessionKey, "agent:main:owned-other"];
    const gateway = await installMockGateway(page, {
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
      const mine = sidebar.getByRole("button", { name: "Mine", exact: true });
      await expect.poll(() => mine.getAttribute("aria-pressed")).toBe("true");
      await expect.poll(() => rows.count()).toBe(2);
      await gateway.setOnline(false);
      await waitForControlUiGatewayReconnecting(page);
      await expect.poll(() => rows.count()).toBe(2);
      for (const key of ownKeys) {
        await sidebar.locator('[data-session-key="' + key + '"]').waitFor({ state: "visible" });
      }
      await page.locator(".sidebar-identity-card").click();
      await page
        .locator(
          'wa-dropdown.sidebar-identity-menu wa-dropdown-item[value="command:retry-connect"]',
        )
        .click();
      await expect.poll(() => rows.count()).toBe(2);
      expect(await mine.getAttribute("aria-pressed")).toBe("true");
      expect(await sidebar.locator('[data-session-key="agent:main:foreign"]').count()).toBe(0);
      expect(await sidebar.locator('[data-session-key="agent:main:agent-owned"]').count()).toBe(0);
      await gateway.setOnline(true);
      await waitForControlUiGatewayReady(page);
      await expect.poll(() => rows.count()).toBe(2);
      expect(await mine.getAttribute("aria-pressed")).toBe("true");
    } finally {
      await context.close();
    }
  });
});
