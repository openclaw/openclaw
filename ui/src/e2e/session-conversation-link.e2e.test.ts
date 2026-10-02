import path from "node:path";
import { expect as expectBrowser } from "playwright/test";
import { assert, it } from "vitest";
import {
  controlUiSessionUrl,
  createControlUiMockSameOriginGatewayScript,
  installMockGateway,
  navigateToControlUiSession,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Session conversation return link" });

suite.define(() => {
  it("leaves saved conversation links invisible without a plugin UI contribution", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 800 } }, async ({ page }) => {
      const session = {
        key: "agent:main:discord-link-without-plugin",
        kind: "direct",
        agentId: "main",
        updatedAt: 1,
        conversationLink: {
          label: "Discord Thread",
          url: "https://discord.com/channels/123456789012345678/234567890123456789",
        },
      };
      await installMockGateway(page, {
        sessionKey: session.key,
        historyMessages: [
          { role: "assistant", content: "This task has saved Discord link metadata." },
        ],
        methodResponses: {
          "sessions.list": { ts: 1, count: 1, defaults: {}, sessions: [session] },
          "sessions.describe": { session },
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, session.key));
      await expectBrowser(
        page.getByText("This task has saved Discord link metadata.", { exact: true }),
      ).toBeVisible();
      await expectBrowser(
        page.getByRole("link", { name: "Discord Thread ↗", exact: true }),
      ).toHaveCount(0);
      await page.screenshot({ path: path.join(suite.artifactDir, "no-plugin.png") });
    });
  });

  it("opens each session's channel directly and removes the link for a web-only session", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 800 } }, async ({ page, context }) => {
      const sessions = [
        {
          key: "agent:main:discord-link",
          // Delivery may move while the original Discord destination remains unchanged.
          origin: { provider: "slack" },
          conversationLink: {
            label: "Discord Thread",
            url: "https://discord.com/channels/123456789012345678/234567890123456789",
          },
        },
        {
          key: "agent:main:slack-link",
          conversationLink: {
            label: "Slack",
            url: "https://slack.com/app_redirect?channel=C123&team=T123",
          },
        },
        {
          key: "agent:main:govslack-message-link",
          conversationLink: {
            label: "Slack",
            url: "https://slack-gov.com/app_redirect?channel=C123&team=T123",
          },
        },
        {
          key: "agent:main:slack-insecure-link",
          conversationLink: {
            label: "Slack",
            url: "http://slack.com/app_redirect?channel=C123&team=T123",
          },
        },
        {
          key: "agent:main:discord-channel-link",
          conversationLink: {
            label: "Discord Conversation",
            url: "https://discord.com/channels/123456789012345678/345678901234567890",
          },
        },
        { key: "agent:main:web-only", conversationLink: undefined },
      ].map((session) => Object.assign(session, { kind: "direct", agentId: "main", updatedAt: 1 }));
      const [firstSession] = sessions;
      assert(firstSession);
      await installMockGateway(page, {
        sessionKey: firstSession.key,
        sessions,
        nativePlugins: ["discord", "slack"].map((pluginId) => ({
          pluginId,
          rootDir: path.resolve("extensions", pluginId),
          source: "browser/index.ts",
        })),
        historyMessages: [],
        methodResponses: {
          "sessions.list": {
            ts: 1,
            count: sessions.length - 1,
            defaults: {},
            // A directly opened task need not appear in the sidebar's current page.
            sessions: sessions.slice(1),
          },
          "sessions.describe": {
            cases: sessions.map((session) => ({
              match: { key: session.key },
              response: { session },
            })),
          },
        },
      });
      await page.addInitScript(createControlUiMockSameOriginGatewayScript());
      // Capture navigation at the external boundary without contacting real workspaces.
      await context.route(
        /^https:\/\/(discord\.com|(?:[a-z0-9-]+\.)?slack(?:-gov)?\.com)\//,
        (route) =>
          route.fulfill({
            contentType: "text/html",
            body: "<title>Conversation destination</title>",
          }),
      );
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, firstSession.key));
      await expectBrowser(page.locator(".plugin-session-header-link")).toBeVisible();
      for (const session of sessions) {
        await navigateToControlUiSession(page, session.key);
        const link = page.locator(".chat-pane-cache__pane--visible .plugin-session-header-link");
        if (
          !session.conversationLink ||
          new URL(session.conversationLink.url).protocol !== "https:"
        ) {
          await expectBrowser(link).toHaveCount(0);
          await page.screenshot({
            path: path.join(suite.artifactDir, `${session.key.split(":").at(-1)}.png`),
          });
          continue;
        }
        await expectBrowser(link).toHaveCount(1);
        await expectBrowser(link).toHaveAccessibleName(`${session.conversationLink.label} ↗`);
        await expectBrowser(link).toHaveAttribute("href", session.conversationLink.url);
        await page.screenshot({
          path: path.join(suite.artifactDir, `${session.key.split(":").at(-1)}.png`),
        });
        const opened = page.waitForEvent("popup");
        await link.click();
        const destination = await opened;
        await expectBrowser(destination).toHaveURL(session.conversationLink.url);
        await destination.close();
      }
    });
  });
});
