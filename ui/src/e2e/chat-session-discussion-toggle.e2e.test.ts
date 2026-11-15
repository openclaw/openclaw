import type { Frame, Page } from "playwright";
import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "session discussion toggle" });
const surfaceColor = (frame: Frame | Page, token: string) =>
  frame.evaluate(
    (key) => getComputedStyle(document.documentElement).getPropertyValue(key).trim(),
    token,
  );

async function openDiscussionPanel(page: Page): Promise<void> {
  await page
    .locator(".sidebar-region__panels-toggle")
    .getByRole("button", { name: "Panels", exact: true })
    .click();
  await page
    .locator(".side-panel-launcher")
    .getByRole("button")
    .filter({
      has: page
        .getByText("Discussion", { exact: true })
        .and(page.locator(".side-panel-type-option__label")),
    })
    .click();
}

suite.define(() => {
  it("keeps an existing discussion closed until the operator opens its panel", async () => {
    await suite.withPage({ viewport: { height: 720, width: 1280 } }, async ({ page }) => {
      const open = { openUrl: "https://discussion.example/session", state: "open" };
      const sessionKey = "agent:main:discussion-proof";
      const gateway = await installMockGateway(page, {
        sessionKey,
        featureMethods: ["session.discussion.info", "session.discussion.open"],
        methodResponses: {
          "session.discussion.info": open,
          "session.discussion.open": open,
        },
        historyMessages: [
          {
            content: [{ type: "text", text: "Discussion proof." }],
            role: "assistant",
            timestamp: Date.now(),
          },
        ],
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await gateway.waitForRequest("session.discussion.info");
      const discussionPanel = page.locator('.side-panel__panel[data-panel-slot="discussion"]');
      const closeDiscussion = page.getByRole("button", { name: "Close Discussion" });
      await expect.poll(() => discussionPanel.count()).toBe(0);

      await openDiscussionPanel(page);

      await expect.poll(() => discussionPanel.count()).toBe(1);
      await expect.poll(() => closeDiscussion.isVisible()).toBe(true);
      // The lazy panel must be registered, not an empty custom-element host.
      await expect
        .poll(() =>
          page.locator("openclaw-session-discussion").evaluate((node) => node.childElementCount),
        )
        .toBeGreaterThan(0);
      expect(await gateway.getRequests("session.discussion.open")).toHaveLength(0);

      await closeDiscussion.click();

      await expect.poll(() => closeDiscussion.isVisible()).toBe(false);
      await expect.poll(() => discussionPanel.count()).toBe(0);
      expect(await gateway.getRequests("session.discussion.open")).toHaveLength(0);
    });
  });

  it("keeps a cross-origin discussion in sync when the real host color scheme changes", async () => {
    await suite.withPage(
      { viewport: { height: 720, width: 1280 }, colorScheme: "light" },
      async ({ page }) => {
        await page.route("https://discussion.example/embed/channel/**", (route) =>
          route.fulfill({
            contentType: "text/html; charset=utf-8",
            body: `<!doctype html><html><head><meta charset="utf-8">
          </head><body>
          <script>
            const params = new URLSearchParams(location.search);
            document.documentElement.dataset.hostMode = params.get("theme") || "dark";
            window.addEventListener("message", (event) => {
              if (event.source !== parent || event.origin !== params.get("hostOrigin")) return;
              if (event.data?.type !== "openclaw:widget-theme") return;
              document.documentElement.dataset.hostMode = event.data.mode;
              for (const [token, value] of Object.entries(event.data.tokens || {})) {
                if (typeof value === "string") {
                  document.documentElement.style.setProperty("--host-" + token, value);
                }
              }
            });
          </script></body></html>`,
          }),
        );

        const sessionKey = "agent:main:discussion-theme-proof";
        const gateway = await installMockGateway(page, {
          sessionKey,
          featureMethods: ["session.discussion.info", "session.discussion.open"],
          methodResponses: {
            "session.discussion.info": { state: "available" },
            "session.discussion.open": {
              embedUrl: "https://discussion.example/embed/channel/T1/C1?openclawHostTheme=1",
              openUrl: "https://discussion.example/app/T1/C1",
              state: "open",
            },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await gateway.waitForRequest("session.discussion.info");
        const navigation = page.waitForEvent("framenavigated", (frame) =>
          frame.url().startsWith("https://discussion.example/embed/channel/"),
        );
        await openDiscussionPanel(page);
        const frame = await navigation;
        expect(await page.locator("iframe.session-discussion__frame").count()).toBe(1);

        const frameUrl = new URL(frame!.url());
        expect(frameUrl.searchParams.get("theme")).toBe("light");
        expect(frameUrl.searchParams.get("hostOrigin")).toBe(new URL(suite.server.baseUrl).origin);
        await expect
          .poll(() => frame!.locator("html").getAttribute("data-host-mode"))
          .toBe("light");
        await expect.poll(() => surfaceColor(frame, "--host-surface")).not.toBe("");
        const lightSurface = await surfaceColor(page, "--bg");

        await page.emulateMedia({ colorScheme: "dark" });

        await expect
          .poll(() => page.evaluate(() => document.documentElement.dataset.themeMode))
          .toBe("dark");
        await expect.poll(() => frame!.locator("html").getAttribute("data-host-mode")).toBe("dark");
        const darkSurface = await surfaceColor(page, "--bg");
        expect(darkSurface).not.toBe("");
        expect(darkSurface).not.toBe(lightSurface);
        await expect.poll(() => surfaceColor(frame, "--host-surface")).toBe(darkSurface);
        expect(new URL(frame!.url()).searchParams.get("theme")).toBe("light");
      },
    );
  });
});
