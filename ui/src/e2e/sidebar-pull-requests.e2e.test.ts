import { expect, it } from "vitest";
import type { ControlUiSessionPullRequest } from "../../../src/gateway/control-ui-contract.js";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../src/gateway/control-ui-contract.js";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../lib/session-pull-requests.ts";
import { navigationDrawerToggle } from "../test-helpers/control-ui-navigation.ts";
import {
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const selected = "agent:main:selected";
const key = "agent:main:inference";
const requests: ControlUiSessionPullRequest[] = [417, 418].map((number) => ({
  owner: "example",
  repo: "control-ui",
  number,
  branch: "fix/inference",
  url: "https://github.com/example/control-ui/pull/" + number,
  title: "Pull request " + number,
  state: "open",
}));

suite.define(() => {
  it("keeps pushed PR updates and keyboard navigation usable in a narrow sidebar", async () => {
    await suite.withPage(
      { colorScheme: "dark", viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        await page.addInitScript(() =>
          localStorage.setItem("openclaw:sidebar:sessions:collapsed-sections", "[]"),
        );
        const gateway = await installMockGateway(page, {
          sessionKey: selected,
          featureMethods: [
            "chat.metadata",
            "chat.startup",
            "progressCard.get",
            SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
          ],
          methodResponses: {
            [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
            "progressCard.get": { card: null },
            "sessions.list": chatSessionListResponse([
              { key: selected, kind: "direct", label: "Release planning", updatedAt: Date.now() },
              {
                key,
                kind: "direct",
                label: "Inference bugs and model tests",
                updatedAt: Date.now(),
                worktree: {
                  id: "inference-worktree",
                  branch: "fix/inference",
                  repoRoot: "/work/control-ui",
                },
              },
            ]),
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, selected));
        const row = page.locator('.sidebar-recent-session[data-session-key="' + key + '"]');
        const trigger = row.locator(".sidebar-recent-session__link");
        await trigger.focus();
        await gateway.waitForRequest(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD);
        const publish = async (items: ControlUiSessionPullRequest[]) =>
          gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
            sessions: {
              [key]: { pullRequests: items, status: "ready", rateLimited: false },
            },
          });
        await publish(requests.toReversed());
        const card = page.locator(".session-progress-hovercard");
        const links = card.locator(".session-hovercard__pr-row");
        await expect.poll(() => links.count()).toBe(2);
        await links.first().focus();
        await page.keyboard.press("Tab");
        expect(await links.nth(1).evaluate((element) => element === document.activeElement)).toBe(
          true,
        );

        await publish(
          requests.map((request) => Object.assign({}, request, { state: "merged" as const })),
        );
        await expect.poll(() => links.first().getAttribute("data-state")).toBe("merged");
        await page.keyboard.press("Escape");
        await expect.poll(() => card.count()).toBe(0);
        expect(await trigger.evaluate((element) => element === document.activeElement)).toBe(true);

        await page.setViewportSize({ width: 600, height: 700 });
        await navigationDrawerToggle(page).click();
        await trigger.focus();
        await expect.poll(() => card.count()).toBe(1);
        const bounds = await card.boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(600);
      },
    );
  });
});
