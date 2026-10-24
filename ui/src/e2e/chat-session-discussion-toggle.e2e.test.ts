import type { Page } from "playwright";
import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "session discussion toggle" });
async function openDiscussion(
  page: Page,
  sessionKey: string,
  methodResponses: Record<string, unknown>,
) {
  const gateway = await installMockGateway(page, {
    sessionKey,
    methodResponses,
    featureMethods: ["session.discussion.info", "session.discussion.open"],
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
  return gateway;
}
async function openDiscussionPanel(page: Page): Promise<void> {
  await page
    .locator(".sidebar-region__panels-toggle")
    .getByRole("button", { name: "Panels", exact: true })
    .click();
  const launcher = page.locator(".side-panel-launcher");
  await launcher
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
      const gateway = await openDiscussion(page, "agent:main:discussion-proof", {
        "session.discussion.info": open,
        "session.discussion.open": open,
      });
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

        await openDiscussion(page, "agent:main:discussion-theme-proof", {
          "session.discussion.info": { state: "available" },
          "session.discussion.open": {
            embedUrl: "https://discussion.example/embed/channel/T1/C1?openclawHostTheme=1",
            openUrl: "https://discussion.example/app/T1/C1",
            state: "open",
          },
        });
        await openDiscussionPanel(page);

        const frameElement = page.locator("iframe.session-discussion__frame");
        await expect.poll(() => frameElement.count()).toBe(1);
        const discussionFrame = () =>
          page
            .frames()
            .find((candidate) =>
              candidate.url().startsWith("https://discussion.example/embed/channel/"),
            );
        await expect.poll(() => Boolean(discussionFrame())).toBe(true);
        const frame = discussionFrame();
        expect(frame).toBeDefined();

        const frameUrl = new URL(frame!.url());
        expect(frameUrl.searchParams.get("theme")).toBe("light");
        expect(frameUrl.searchParams.get("hostOrigin")).toBe(new URL(suite.server.baseUrl).origin);
        await expect
          .poll(() => frame!.locator("html").getAttribute("data-host-mode"))
          .toBe("light");
        await expect
          .poll(() =>
            frame!.evaluate(() =>
              getComputedStyle(document.documentElement).getPropertyValue("--host-surface").trim(),
            ),
          )
          .not.toBe("");

        await page.emulateMedia({ colorScheme: "dark" });

        await expect
          .poll(() => page.evaluate(() => document.documentElement.dataset.themeMode))
          .toBe("dark");
        await expect.poll(() => frame!.locator("html").getAttribute("data-host-mode")).toBe("dark");
        await expect
          .poll(async () => {
            const [hostSurface, embeddedSurface] = await Promise.all([
              page.evaluate(() =>
                getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(),
              ),
              frame!.evaluate(() =>
                getComputedStyle(document.documentElement)
                  .getPropertyValue("--host-surface")
                  .trim(),
              ),
            ]);
            return { hostSurface, embeddedSurface };
          })
          .toEqual({ hostSurface: "#0e1015", embeddedSurface: "#0e1015" });
        expect(new URL(frame!.url()).searchParams.get("theme")).toBe("light");
      },
    );
  });
});
