import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Sidebar user filter",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("filters connected and offline profiles without collapsing the Users view", async () => {
    const output = createControlUiE2eArtifactDir("sidebar-users-filter");
    await suite.withPage(
      {
        viewport: { width: 1280, height: 800 },
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: ["users.list"],
          operatorScopes: ["operator.read", "operator.write"],
          historyMessages: [
            { role: "assistant", content: "The release notes are ready for review." },
          ],
          presenceUsers: [
            {
              id: "ada",
              identity: { type: "profile", id: "ada" },
              name: "Ada Chen",
              self: true,
              lastInputSeconds: 5,
            },
            {
              id: "bob",
              identity: { type: "profile", id: "bob" },
              name: "Bob Rivera",
              lastInputSeconds: 180,
            },
          ],
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
        const capture = async (name: string) => {
          await page.mouse.move(900, 400);
          await expect.poll(() => page.locator(".person-activity-hovercard").count()).toBe(0);
          const frame = await takeControlUiScreenshotFrame(
            page,
            page.locator(".sidebar"),
            [page.locator(".sidebar-online__person-name").getByText("Ada Chen", { exact: true })],
            { elements: [page.locator(".sidebar")], animations: "disabled" },
          );
          writeFileSync(path.join(output, name + ".png"), frame.elements[0]!.png);
        };
        await capture("online");
        expect(await rail.getAttribute("aria-label")).toBe("Users");
        await rail.click();
        await expect.poll(() => rail.getAttribute("aria-pressed")).toBe("true");
        const filter = page.locator("#sidebar-people-presence");
        await filter.click();
        await page
          .locator('openclaw-select-picker:has(#sidebar-people-presence) [data-value="all"]')
          .click();
        await gateway.waitForRequest("users.list");
        await expect.poll(() => page.locator(".sidebar-online__person").count()).toBe(3);
        expect(
          await page.locator('[data-online-user-id="carol"]').getAttribute("aria-description"),
        ).toContain("Offline");
        await capture("all-users");
        await filter.click();
        await page
          .locator('openclaw-select-picker:has(#sidebar-people-presence) [data-value="online"]')
          .click();
        await expect.poll(() => page.locator(".sidebar-online__person").count()).toBe(2);
      },
    );
  });
});
