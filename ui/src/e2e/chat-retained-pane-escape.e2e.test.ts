import { expect, it } from "vitest";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../src/gateway/control-ui-contract.js";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD as subscribe } from "../lib/session-pull-requests.ts";
import { controlUiSessionPath, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { chatSessionListResponse } from "./chat-flow.test-support.ts";
import { waitForWatchedSessionKey } from "./chat-github-publication.test-support.ts";
import { polledAttribute, polledCount, polledVisible } from "./chat-presentation.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI retained pane Escape",
  startServerBeforeBrowser: true,
});
const sessionKeys = ["agent:main:review-a", "agent:main:review-b"] as const;

suite.define(() => {
  it("dismisses the visible PR menu after a keyboard session switch", async () => {
    await suite.withPage(
      {
        colorScheme: "light",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: ["chat.metadata", "chat.startup", subscribe],
          methodResponses: {
            [subscribe]: { subscribed: true },
            "sessions.list": chatSessionListResponse(
              sessionKeys.map((key, index) => ({
                key,
                kind: "direct",
                label: `Review ${index === 0 ? "A" : "B"}`,
                updatedAt: sessionKeys.length - index,
              })),
            ),
          },
          sessionKey: sessionKeys[0],
        });
        await page.goto(new URL(controlUiSessionPath(sessionKeys[0]), suite.server.baseUrl).href);
        const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
        for (const [index, key] of sessionKeys.entries()) {
          if (index > 0) {
            const link = page.locator(`.sidebar-recent-session[data-session-key="${key}"] a`);
            await link.focus();
            await link.press("Enter");
            await expect.poll(() => new URL(page.url()).pathname).toBe(controlUiSessionPath(key));
          }
          await waitForWatchedSessionKey(gateway, key);
          await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
            sessions: {
              [key]: {
                pullRequests: [
                  {
                    number: 101 + index,
                    owner: "example",
                    repo: "release-planning",
                    branch: `review-${index === 0 ? "a" : "b"}`,
                    title: "Review release checklist",
                    url: `https://github.com/example/release-planning/pull/${101 + index}`,
                    state: "open",
                    checks: { state: "passing", passed: 4, failed: 0, skipped: 0, running: 0 },
                  },
                ],
                rateLimited: false,
                status: "ok",
              },
            },
          });
          // Keep this regression keyboard-only: a pointer click would light-dismiss
          // the previous pane's PR menu before Escape is exercised.
          await pane.getByRole("button", { name: "Details", exact: true }).press("Enter");
          await polledAttribute(
            pane.locator('[data-details-group="pull-requests"]'),
            "open",
          ).not.toBeNull();
          const actions = pane.locator(".chat-pr__actions-trigger");
          await actions.focus();
          await actions.press("Enter");
          const menu = pane.locator(".chat-pr-menu");
          await menu.waitFor();
          await menu.locator('[data-value="monitoring"]').press("Enter");
          await menu.locator(".chat-pr-menu__page:visible").waitFor();
        }
        await polledCount(page.locator("openclaw-chat-pane")).toBe(2);
        const hiddenPane = page.locator('openclaw-chat-pane[aria-hidden="true"][inert]');
        const visibleMenu = pane.locator(".chat-pr-menu");
        const expectClosed = async (target: typeof pane) => {
          expect(
            await target.locator(".chat-pr__actions-trigger").getAttribute("aria-expanded"),
          ).toBe("false");
          expect(await target.locator(".chat-pr-menu").isVisible()).toBe(false);
        };
        await expectClosed(hiddenPane);
        await polledVisible(visibleMenu).toBe(true);
        await page.keyboard.press("Escape");
        await polledCount(visibleMenu.locator(".chat-pr-menu__page:visible")).toBe(0);
        expect(await visibleMenu.isVisible()).toBe(true);
        await page.keyboard.press("Escape");
        await polledVisible(visibleMenu).toBe(false);
        await expectClosed(pane);
        await expectClosed(hiddenPane);
      },
    );
  });
});
