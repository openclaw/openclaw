import { expect, it } from "vitest";
import { pathForRoute } from "../app-route-paths.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Settings beside Ask OpenClaw",
  startServerBeforeBrowser: true,
});
suite.define(() => {
  it("keeps settings introductions and editable fields usable beside Ask OpenClaw", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const profile = {
        id: "11111111-1111-4111-8111-111111111111",
        displayName: "Test Person",
        avatarMime: null,
        mergedInto: null,
        createdAt: 1,
        updatedAt: 2,
        emails: ["test@example.com"],
        githubIdentity: null,
        hasAvatar: false,
      };
      await installMockGateway(page, {
        presenceUsers: [{ self: true, id: profile.id, name: profile.displayName }],
        featureMethods: [
          ...defaultControlUiFeatureMethods,
          "chat.history",
          "chat.send",
          "openclaw.chat",
          "openclaw.chat.history",
        ],
        methodResponses: {
          "users.self": { profile },
          "doctor.memory.status": {
            agentId: "main",
            provider: "local",
            embedding: { ok: true, checked: true },
          },
          "openclaw.chat": {
            sessionId: "settings-layout",
            reply: "Ready to help.",
            action: "none",
          },
          "openclaw.chat.history": { turns: [] },
        },
      });
      for (const width of [1440, 1100]) {
        await page.setViewportSize({ width, height: 900 });
        for (const route of ["memory", "profile", "mcp", "advanced"] as const) {
          const pathname = pathForRoute(route);
          await page.goto(new URL(pathname, suite.server.baseUrl).toString());
          await waitForControlUiRoute(page, { pathname, routeId: route });
          await page.locator("main.content .page-title").first().waitFor();
          await page.keyboard.press("ControlOrMeta+Shift+h");
          await page.getByRole("button", { name: "Ask OpenClaw", exact: true }).click();
          await page.locator(".assistant-panel--right textarea").waitFor();
          if (route === "mcp") {
            await page.getByRole("button", { name: "Add server", exact: true }).click();
          }
          await expect
            .poll(
              () =>
                page
                  .locator("main.content")
                  .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
              { message: `${route} stays beside the dock at ${width}px` },
            )
            .toBe(true);
          if (route === "memory") {
            await expect
              .poll(
                () =>
                  page.locator(".hub-page-header").evaluate((header) => {
                    const intro = header.querySelector(".page-subtitle")!.getBoundingClientRect();
                    const tabs = header
                      .querySelector(".hub-page-header__tabs")!
                      .getBoundingClientRect();
                    return (
                      intro.width >= Math.min(320, header.getBoundingClientRect().width * 0.8) &&
                      tabs.top >= intro.bottom
                    );
                  }),
                { message: `Memory introduction clears tabs at ${width}px` },
              )
              .toBe(true);
          } else if (route === "advanced") {
            await expect
              .poll(() =>
                page.getByRole("button", { name: "Form", exact: true }).evaluate((element) => {
                  const range = document.createRange();
                  range.selectNodeContents(element);
                  return new Set(
                    [...range.getClientRects()]
                      .filter((rect) => rect.width > 0)
                      .map((rect) => rect.y),
                  ).size;
                }),
              )
              .toBe(1);
          } else {
            const input =
              route === "profile"
                ? page.getByRole("textbox", { name: "Display name", exact: true })
                : page.locator('input[name="mcp-target"]');
            await expect
              .poll(
                () =>
                  input.evaluate((element) => {
                    const inputBox = element.getBoundingClientRect();
                    const content = document.querySelector("main.content")!.getBoundingClientRect();
                    return (
                      inputBox.width >= 180 &&
                      inputBox.left >= content.left &&
                      inputBox.right <= content.right
                    );
                  }),
                { message: `${route} input remains editable at ${width}px` },
              )
              .toBe(true);
          }
        }
      }
    });
  });
});
