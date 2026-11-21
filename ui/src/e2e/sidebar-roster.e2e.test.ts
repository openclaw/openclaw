import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI sidebar agent roster" });

suite.define(() => {
  it("keeps the running avatar ring inside the roster hover background", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 800, width: 1280 } },
      async ({ page }) => {
        await installMockGateway(page, {
          sessions: [
            {
              key: "agent:main:main",
              agentId: "main",
              kind: "direct",
              isMain: true,
              updatedAt: 100,
            },
            {
              key: "agent:forge:project",
              agentId: "forge",
              kind: "direct",
              updatedAt: 99,
              hasActiveRun: true,
              status: "running",
            },
          ],
          methodResponses: {
            "agents.list": {
              defaultId: "main",
              mainKey: "main",
              scope: "per-sender",
              agents: [
                { id: "main", name: "Harbor", identity: { emoji: "⚓" } },
                { id: "forge", name: "Forge", identity: { emoji: "🔧" } },
              ],
            },
          },
        });
        await page.goto(suite.server.baseUrl + "chat");
        const sidebar = page.locator("openclaw-app-sidebar");
        await sidebar.locator(".sidebar-agent-card__main").click();
        await sidebar.locator('[data-value="scope:all"]').click();
        const header = sidebar.locator('[data-agent-group="forge"] .sidebar-agent-roster__header');
        await header.locator(".session-glyph__ring").waitFor();
        const ringInset = await header.evaluate((element) => {
          const ring = element.querySelector<HTMLElement>(".session-glyph__ring")!;
          ring.style.animation = "none";
          return ring.getBoundingClientRect().left - element.getBoundingClientRect().left;
        });
        expect(ringInset).toBeGreaterThanOrEqual(4);
      },
    );
  });
});
