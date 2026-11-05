import { expect, it } from "vitest";
import type { AgentsListResult } from "../api/types.ts";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { navigationDrawerToggle } from "../test-helpers/control-ui-navigation.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { waitForMobileSidebarDrawerOpen } from "./session-management.test-support.ts";
import { seedSidebarSettings } from "./sidebar-contract.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Pinned agent centering" });

suite.define(() => {
  it.each([1, 2, 7])("centers every wrapped row of %s pinned agents", (count) =>
    suite.withPage(
      { locale: "en-US", viewport: { width: 1440, height: 900 } },
      async ({ page }) => {
        const agents = Array.from({ length: count }, (_, index) => ({
          id: index === 0 ? "main" : `agent-${index}`,
          name: ["Roboclaw", "ClawHub Research and Intelligence"][index] ?? `Agent ${index + 1}`,
          identity: { emoji: index === 0 ? "🤖" : "🔬" },
        }));
        const agentsList: AgentsListResult = {
          defaultId: "main",
          mainKey: "main",
          scope: "per-sender",
          agents,
        };
        await seedSidebarSettings(page, suite.server.baseUrl, {
          sidebarAgentsMode: "roster",
          pinnedAgentIds: agents.map((agent) => agent.id),
        });
        await installMockGateway(page, {
          methodResponses: {
            "agents.list": agentsList,
            "chat.startup": {
              agentsList,
              messages: [],
              metadata: { models: [] },
              sessionId: "main-session",
              thinkingLevel: null,
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await waitForControlUiRoute(page, { routeId: "chat" });
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: 900 });
          if (await page.locator(".shell--mobile-nav").count()) {
            await navigationDrawerToggle(page).click();
            await waitForMobileSidebarDrawerOpen(page);
          }
          const sidebar = page.locator("openclaw-app-sidebar:visible");
          const pins = sidebar.locator(".sidebar-pinned-agents");
          const cards = pins.locator("[data-pinned-agent]");
          await expect.poll(() => cards.count()).toBe(count);
          await expect
            .poll(() =>
              pins.evaluate((element) => {
                const bounds = element.getBoundingClientRect();
                const rows = new Map<number, DOMRect[]>();
                for (const card of element.querySelectorAll("[data-pinned-agent]")) {
                  const rect = card.getBoundingClientRect();
                  const row = rows.get(rect.top) ?? [];
                  row.push(rect);
                  rows.set(rect.top, row);
                }
                return [...rows.values()].every((row) => {
                  const left = Math.min(...row.map((rect) => rect.left));
                  const right = Math.max(...row.map((rect) => rect.right));
                  return (
                    Math.abs((left + right) / 2 - (bounds.left + bounds.right) / 2) < 1 &&
                    left >= bounds.left &&
                    right <= bounds.right &&
                    row.every((rect) => rect.width >= 64)
                  );
                });
              }),
            )
            .toBe(true);
        }
      },
    ),
  );
});
