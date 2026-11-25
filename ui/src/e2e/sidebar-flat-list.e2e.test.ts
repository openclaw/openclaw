import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { captureSidebarUiProof } from "./sidebar-customization.test-support.ts";

const suite = createControlUiE2eSuite({ name: "The flat sidebar Other list continues on scroll" });

suite.define(() => {
  it("shows the flat list's next page each time its end scrolls into view", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 700 }, locale: "en-US" },
      async ({ page }) => {
        const sessions = Array.from({ length: 100 }, (_, index) => ({
          key: "agent:main:dashboard:flat-" + index,
          kind: "direct",
          label: "Conversation " + (index + 1),
          updatedAt: 1000 - index,
        }));
        await installMockGateway(page, { sessions, sessionKey: sessions[0]!.key });
        await page.addInitScript(() => {
          localStorage.setItem("openclaw:sidebar:sessions:grouping", "none");
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessions[0]!.key));
        const list = page.locator('[data-session-section="ungrouped"]');
        const body = page.locator(".sidebar-shell__body");
        const shown = async () =>
          Number(
            await list
              .locator(".sidebar-session-window > [aria-setsize]")
              .first()
              .getAttribute("aria-setsize"),
          );
        await expect.poll(shown).toBe(30);

        for (const count of [45, 60]) {
          await body.evaluate((element) => {
            element.scrollTop = element.scrollHeight;
          });
          await expect.poll(shown).toBe(count);
        }
        await expect
          .poll(() => list.getByRole("button", { name: "Show more", exact: true }).isVisible())
          .toBe(true);
        await captureSidebarUiProof(suite, page, "flat-list-end.png");
      },
    );
  });
});
