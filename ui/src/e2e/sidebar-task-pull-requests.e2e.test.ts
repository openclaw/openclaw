import { expect, it } from "vitest";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../src/gateway/control-ui-contract.js";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../lib/session-pull-requests.ts";
import {
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";
import { waitForWatchedSessionKey } from "./chat-github-publication.test-support.ts";

const suite = createChatFlowE2eSuite();
const selected = "agent:main:selected";
const parent = "agent:main:task-parent";
const taskPullRequests = ["Typed recovery", "Terminal presentation", "Bounded backlog"].map(
  (title, index) => {
    const number = 417 + index;
    const identity = {
      owner: "example",
      repo: "project",
      number,
      title,
      branch: "fix/child-" + index,
      url: "https://github.com/example/project/pull/" + number,
    };
    return Object.assign(identity, {
      sourceSessionKey: "agent:main:child-" + index,
      sourceAgentId: "main",
      pullRequest: Object.assign(
        { state: "open" as const, additions: 40 + index, deletions: 8 },
        identity,
      ),
    });
  },
);

suite.define(() => {
  it("shows delegated task PRs without a parent worktree and preserves the parent branch action", () =>
    suite.withPage(
      { colorScheme: "dark", viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        await page.addInitScript(() =>
          localStorage.setItem("openclaw:sidebar:sessions:collapsed-sections", "[]"),
        );
        const now = Date.now();
        const gateway = await installMockGateway(page, {
          sessionKey: selected,
          sessions: [
            { key: selected, kind: "direct", label: "Release planning", updatedAt: now },
            { key: parent, kind: "direct", label: "Recovery improvements", updatedAt: now },
          ],
          featureMethods: [
            "chat.metadata",
            "chat.startup",
            "progressCard.get",
            SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
          ],
          methodResponses: {
            [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
            "progressCard.get": { card: null },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, selected));
        const sessionRow = (key: string) =>
          page.locator(`.sidebar-recent-session[data-session-key="${key}"]`);
        const row = sessionRow(parent);
        await row.locator(".sidebar-recent-session__link").focus();
        await waitForWatchedSessionKey(gateway, parent);
        await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
          sessions: {
            [parent]: {
              pullRequests: [],
              taskPullRequests,
              taskPullRequestCount: 3,
              status: "ready",
              rateLimited: false,
              branch: {
                owner: "example",
                repo: "project",
                branch: "coordination",
                createUrl: "https://github.com/example/project/pull/new/coordination",
              },
            },
          },
        });
        const card = page.locator(".session-progress-hovercard");
        await expect.poll(() => card.locator(".session-hovercard__pr-row").count()).toBe(3);
        await expect
          .poll(() => row.locator(".session-row-badge--pull-request").getAttribute("aria-label"))
          .toContain("#417");
        expect(
          await card.getByRole("link", { name: "Create a pull request for coordination" }).count(),
        ).toBe(1);
        for (const request of taskPullRequests) {
          expect(
            await card.getByRole("link", { name: new RegExp(request.title) }).getAttribute("href"),
          ).toBe(request.url);
        }
        await page.keyboard.press("Escape");
        await sessionRow(selected).locator(".sidebar-recent-session__link").focus();
        await row.locator(".sidebar-recent-session__link").focus();
        await expect.poll(() => card.locator(".session-hovercard__pr-row").count()).toBe(3);
      },
    ));
});
