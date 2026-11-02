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
        subscriptionInitialHistory: false,
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
      const pinned = page.locator('[data-session-section="pinned"] .sidebar-recent-session');
      const viewport = page.locator(".sidebar-shell__body");
      await pinned.getByText("Pinned chat 0", { exact: true }).waitFor();
      // Describe replies can settle out of order; collect rows only after all pins arrive.
      await page
        .locator('[data-session-section="pinned"] [role="listitem"][aria-setsize="30"]')
        .first()
        .waitFor();
      const seen = new Map<string, number>();
      await expect
        .poll(async () => {
          for (const [key, position] of await pinned.evaluateAll((rows) =>
            rows.map(
              (row) =>
                [
                  `session:${row.getAttribute("data-session-key")}`,
                  Number(row.closest('[role="listitem"]')?.getAttribute("aria-posinset")),
                ] as const,
            ),
          )) {
            seen.set(key, position);
          }
          if (seen.size < pins.length) {
            await viewport.evaluate((element) => {
              element.scrollTop += element.clientHeight * 0.75;
            });
          }
          return [...seen].toSorted((a, b) => a[1] - b[1]);
        })
        .toEqual(entries.map((entry, index) => [entry, index + 1]));
      await pinned.getByText("Pinned chat 29", { exact: true }).waitFor();
      expect(await pinReads()).toHaveLength(30);
    });
  });
});
