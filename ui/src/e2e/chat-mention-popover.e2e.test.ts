import type { Page } from "playwright";
import { assert, expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import * as e2e from "./new-session-page.test-support.ts";

const suite = createControlUiE2eSuite({ name: "chat mention popover" });

const presenceUsers = [
  {
    self: true,
    id: "demo-viewer",
    identity: { type: "profile" as const, id: "demo-viewer" },
    name: "Demo viewer",
  },
];
type MentionUser = { profileId: string; displayName: string; online: boolean; avatarUrl?: string };
async function openComposer(page: Page, route: string, users: MentionUser[]) {
  const gateway = await installMockGateway(page, {
    presenceUsers,
    methodResponses: { "users.mentionable": { users, truncated: false } },
  });
  await page.goto(
    route === "new"
      ? `${suite.server.baseUrl}new`
      : controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"),
  );
  await e2e.waitForGatewayRecoveryScope(page);
  const composer = page.locator(
    route === "new" ? ".new-session-page__composer" : ".agent-chat__composer-combobox",
  );
  return { gateway, input: composer.getByRole("textbox"), rawValue: composer.locator("textarea") };
}

suite.define(() => {
  it.each(["chat", "new"])(
    "reuses the picker photo and shows initials while it loads in %s",
    (route) =>
      suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
        const profileId = "00000003-1111-4111-8111-000000000103";
        const avatarUrl = `/api/users/${profileId}/avatar?v=7`;
        const requests: string[] = [];
        const { promise: photoReady, resolve: releasePhoto } = Promise.withResolvers<void>();
        await page.route(`**/api/users/${profileId}/avatar*`, async (request) => {
          const url = new URL(request.request().url());
          requests.push(`${url.pathname}${url.search}`);
          await photoReady;
          await request.fulfill({
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="12" fill="teal"/></svg>',
          });
        });
        try {
          const { input, rawValue } = await openComposer(page, route, [
            { profileId, displayName: "Casey Vale", avatarUrl, online: true },
          ]);
          await input.pressSequentially("@Casey");
          const menu = page.getByRole("listbox", { name: "Mention a person" });
          await e2e.pollCount(menu.getByRole("option")).toBe(1);
          await expect.poll(() => requests).toEqual([avatarUrl]);
          await input.press("Enter");
          await e2e.pollValue(rawValue).toBe("@Casey Vale ");
          const mention = input.locator(".chat-composer-mention");
          expect(await mention.getAttribute("data-profile-id")).toBe(profileId);
          const avatar = mention.locator(".markdown-person-reference__avatar");
          await expect
            .poll(() => avatar.evaluate((element) => getComputedStyle(element, "::after").content))
            .toBe('"CV"');
          const size = () =>
            avatar.evaluate((element) => {
              const { width, height } = element.getBoundingClientRect();
              return { width, height };
            });
          const pendingSize = await size();
          const fontSize = await avatar.evaluate((element) =>
            Number.parseFloat(getComputedStyle(element).fontSize),
          );
          expect(pendingSize).toEqual({ width: fontSize + 2, height: fontSize + 2 });
          releasePhoto();
          await expect
            .poll(() =>
              avatar.locator("img").evaluate((image: HTMLImageElement) => image.naturalWidth),
            )
            .toBeGreaterThan(0);
          expect(await avatar.locator("img").isVisible()).toBe(true);
          expect(
            await avatar.locator("img").evaluate((image) => {
              const { x, y, width, height } = image.getBoundingClientRect();
              const avatarBounds = image.parentElement!.getBoundingClientRect();
              const hit = document.elementFromPoint(x + width / 2, y + height / 2);
              return (
                width === avatarBounds.width &&
                height === avatarBounds.height &&
                image.closest(".chat-composer-mention")!.contains(hit)
              );
            }),
          ).toBe(true);
          expect(await size()).toEqual(pendingSize);
          expect(requests).toEqual([avatarUrl]);
        } finally {
          releasePhoto();
        }
      }),
  );

  it.each([
    { route: "chat", count: 16 },
    { route: "new", count: 2 },
  ])(
    "keeps people identifiable without offline metadata in $route ($count people)",
    ({ route, count }) =>
      suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
        const users = Array.from({ length: count }, (_, index) => ({
          profileId: `${String(index + 1).padStart(8, "0")}-1111-4111-8111-${String(index + 101).padStart(12, "0")}`,
          // The directory decorates duplicate names before returning them to the composer.
          displayName:
            index < 2 ? `Robin (${String(index + 1).padStart(8, "0")})` : `Viewer ${index + 1}`,
          online: index === 0,
        }));
        const lastPerson = users.at(-1);
        assert(lastPerson, "The mention fixture must include a selectable person.");
        const { gateway, input, rawValue } = await openComposer(page, route, users);
        await input.pressSequentially("@");
        await gateway.waitForRequest("users.mentionable");
        const menu = page.getByRole("listbox", { name: "Mention a person" });
        const options = menu.getByRole("option");
        await e2e.pollCount(options).toBe(count);
        expect(await menu.textContent()).toContain("Online");
        expect(await menu.textContent()).not.toContain("Offline");
        for (const person of users) {
          expect(await menu.textContent()).not.toContain(person.profileId.slice(-8));
        }
        for (const person of users.slice(0, 2)) {
          expect(await options.filter({ hasText: person.displayName }).count()).toBe(1);
        }

        await input.press("ArrowUp");
        const last = options.last();
        await e2e.pollAttribute(last, "aria-selected").toBe("true");
        const viewports = [{ width: 1440, height: 900 }];
        if (count > 2) {
          viewports.push({ width: 844, height: 390 });
        }
        for (const viewport of viewports) {
          await page.setViewportSize(viewport);
          // Re-enter the last option so its owner scrolls after the viewport changes.
          await input.press("ArrowDown");
          await input.press("ArrowUp");
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
        await input.press("Enter");
        await e2e.pollValue(rawValue).toBe(`@${lastPerson.displayName} `);
        await e2e.pollCount(menu).toBe(0);
        const mention = input.locator(".chat-composer-mention");
        expect(await mention.textContent()).toContain(lastPerson.displayName);
        expect(await mention.getAttribute("data-profile-id")).toBe(lastPerson.profileId);
      }),
  );
});
