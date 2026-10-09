import { expect, it } from "vitest";
import type { AppSidebarElement } from "../components/app-sidebar.tsx";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { sessionsListResponse } from "./session-management.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Pinned sessions boot priority" });

suite.define(() => {
  it("loads the selected chat before describing thirty off-page pins", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const selected = createControlUiSessionRow("agent:main:selected", "Selected chat", 100);
      const pins = Array.from({ length: 30 }, (_, index) =>
        createControlUiSessionRow(`agent:main:pin-${index}`, `Pinned chat ${index}`, index),
      );
      const entries = pins.map((row) => `session:${row.key}`);
      await page.addInitScript(
        ({ key, entries: savedEntries }) =>
          localStorage.setItem(key, JSON.stringify({ railShortcuts: savedEntries })),
        { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl), entries },
      );
      const gateway = await installMockGateway(page, {
        awaitInitialRoster: false,
        sessionKey: selected.key,
        sessions: [selected, ...pins],
        heldMethods: ["chat.startup"],
        historyMessages: [{ role: "assistant", content: "Selected conversation ready." }],
        methodResponses: { "sessions.list": sessionsListResponse([selected]) },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, selected.key));
      await gateway.waitForRequest("chat.startup");
      await page.locator("openclaw-app-sidebar .sidebar-rail").waitFor();
      await page.locator("openclaw-app-sidebar").evaluate(async (element) => {
        await (element as AppSidebarElement).updateComplete;
      });
      const pinReads = async () =>
        (await gateway.getRequests("sessions.describe")).filter((request) =>
          pins.some((pin) => pin.key === (request.params as { key?: string }).key),
        );
      console.log("Off-page pin requests before selected chat startup:", (await pinReads()).length);
      expect(await pinReads()).toHaveLength(0);
      await gateway.resolveDeferred("chat.startup");
      await page.getByText("Selected conversation ready.", { exact: true }).waitFor();
      await page.getByRole("link", { name: "Pinned chat 29", exact: true }).waitFor();
      expect(
        await page
          .locator(".sidebar-rail__pin")
          .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-sidebar-entry"))),
      ).toEqual(entries);
      expect(await pinReads()).toHaveLength(30);
    });
  });
});
