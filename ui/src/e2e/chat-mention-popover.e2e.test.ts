import { assert, expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { waitForGatewayRecoveryScope } from "./new-session-page.test-support.ts";

const suite = createControlUiE2eSuite({ name: "chat mention popover" });

suite.define(() => {
  it.each([
    { route: "chat", count: 2 },
    { route: "chat", count: 16 },
    { route: "new", count: 2 },
  ])(
    "keeps people identifiable without offline metadata in $route ($count people)",
    async ({ route, count }) => {
      await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
        const users = Array.from({ length: count }, (_, index) => ({
          profileId: `${String(index + 1).padStart(8, "0")}-1111-4111-8111-${String(index + 101).padStart(12, "0")}`,
          // The directory decorates duplicate names before returning them to the composer.
          displayName:
            index < 2 ? `Robin (${String(index + 1).padStart(8, "0")})` : `Viewer ${index + 1}`,
          online: index === 0,
        }));
        const lastPerson = users.at(-1);
        assert(lastPerson, "The mention fixture must include a selectable person.");
        const gateway = await installMockGateway(page, {
          presenceUsers: [
            {
              self: true,
              id: "demo-viewer",
              identity: { type: "profile", id: "demo-viewer" },
              name: "Demo viewer",
            },
          ],
          methodResponses: { "users.mentionable": { users, truncated: false } },
        });
        await page.goto(
          route === "new"
            ? `${suite.server.baseUrl}new`
            : controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"),
        );
        await waitForGatewayRecoveryScope(page);
        const textarea = page.locator(
          route === "new"
            ? ".new-session-page__message"
            : ".agent-chat__composer-combobox textarea",
        );
        await textarea.pressSequentially("@");
        await gateway.waitForRequest("users.mentionable");
        const menu = page.getByRole("listbox", { name: "Mention a person" });
        const options = menu.getByRole("option");
        await expect.poll(() => options.count()).toBe(count);
        expect(await menu.textContent()).toContain("Online");
        expect(await menu.textContent()).not.toContain("Offline");
        for (const person of users) {
          expect(await menu.textContent()).not.toContain(person.profileId.slice(-8));
        }
        for (const person of users.slice(0, 2)) {
          expect(await options.filter({ hasText: person.displayName }).count()).toBe(1);
        }

        await textarea.press("ArrowUp");
        const last = options.last();
        await expect.poll(() => last.getAttribute("aria-selected")).toBe("true");
        const viewports =
          count > 2
            ? [
                { width: 1440, height: 900 },
                { width: 844, height: 390 },
              ]
            : [{ width: 1440, height: 900 }];
        for (const viewport of viewports) {
          await page.setViewportSize(viewport);
          // Re-enter the last option so its owner scrolls after the viewport changes.
          await textarea.press("ArrowDown");
          await textarea.press("ArrowUp");
          await expect
            .poll(() =>
              last.evaluate((element) => {
                const row = element.getBoundingClientRect();
                const scroll = element.closest(".slash-menu__scroll")!.getBoundingClientRect();
                const panel = element.closest('[role="listbox"]')!.getBoundingClientRect();
                return (
                  row.top >= Math.max(scroll.top, panel.top) &&
                  row.bottom <= Math.min(scroll.bottom, panel.bottom) + 1
                );
              }),
            )
            .toBe(true);
        }
        await last.hover();
        expect(await last.textContent()).not.toContain(lastPerson.profileId.slice(-8));
        await textarea.press("Enter");
        await expect.poll(() => textarea.inputValue()).toBe(`@${lastPerson.displayName} `);
        await expect.poll(() => menu.count()).toBe(0);
        expect(await page.locator(".chat-reply-preview").textContent()).toContain(
          lastPerson.displayName,
        );
      });
    },
  );
});
