import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Sidebar user filter",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("filters connected and offline profiles without collapsing the Users view", () =>
    suite.withPage(
      { colorScheme: "dark", locale: "en-US", serviceWorkers: "block" },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: ["users.list"],
          operatorScopes: ["operator.read", "operator.write"],
          presenceUsers: ["Ada Chen", "Bob Rivera"].map((name, index) => ({
            id: index === 0 ? "ada" : "bob",
            identity: { type: "profile", id: index === 0 ? "ada" : "bob" },
            name,
            self: index === 0 ? true : undefined,
            lastInputSeconds: index === 0 ? 5 : 180,
          })),
          methodResponses: {
            "users.list": {
              profiles: ["Ada Chen", "Bob Rivera", "Carol Singh"].map((displayName, index) => ({
                id: ["ada", "bob", "carol"][index],
                displayName,
                avatarMime: null,
                mergedInto: null,
                createdAt: 1,
                updatedAt: 1,
                emails: [],
                githubIdentity: null,
                hasAvatar: false,
              })),
            },
          },
        });
        await page.goto(suite.server.baseUrl + "chat");
        const rail = page.locator('[data-navigation-view="online"]');
        await rail.click();
        await expect.poll(() => page.locator(".sidebar-online__person").count()).toBe(2);
        const dismissHovercard = async () => {
          await page.mouse.move(900, 400);
          await expect.poll(() => page.locator(".person-activity-hovercard").count()).toBe(0);
          await page
            .locator(".sidebar-online__person-name")
            .getByText("Ada Chen", { exact: true })
            .waitFor();
        };
        await dismissHovercard();
        expect(await rail.getAttribute("aria-label")).toBe("Users");
        await rail.click();
        await expect.poll(() => rail.getAttribute("aria-pressed")).toBe("true");
        const choosePresence = async (value: "all" | "online") => {
          await page.locator("#sidebar-people-presence").click();
          await page
            .locator(`openclaw-select-picker:has(#sidebar-people-presence) [data-value="${value}"]`)
            .click();
        };
        await choosePresence("all");
        await gateway.waitForRequest("users.list");
        await expect.poll(() => page.locator(".sidebar-online__person").count()).toBe(3);
        expect(
          await page.locator('[data-online-user-id="carol"]').getAttribute("aria-description"),
        ).toContain("Offline");
        await dismissHovercard();
        await choosePresence("online");
        await expect.poll(() => page.locator(".sidebar-online__person").count()).toBe(2);
      },
    ));
});
