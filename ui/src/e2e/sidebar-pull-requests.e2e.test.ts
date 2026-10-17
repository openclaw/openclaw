import { expect, it } from "vitest";
import type { ControlUiSessionPullRequest } from "../../../src/gateway/control-ui-contract.js";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../src/gateway/control-ui-contract.js";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../lib/session-pull-requests.ts";
import {
  captureUiProof,
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const selected = "agent:main:selected";
const key = "agent:main:inference";
const requests: ControlUiSessionPullRequest[] = Array.from({ length: 3 }, (_, index) => ({
  owner: "example",
  repo: "control-ui",
  number: 417 + index,
  branch: "fix/inference",
  url: "https://github.com/example/control-ui/pull/" + (417 + index),
  title:
    index === 0
      ? "Keep inference retries scoped to their original conversation"
      : "Improve provider recovery and model selection " + (index + 1),
  state: index === 0 ? "open" : index === 1 ? "draft" : "merged",
  additions: 128 + index,
  deletions: 34,
  checks:
    index === 0 ? { state: "failing", passed: 23, failed: 1, skipped: 0, running: 0 } : undefined,
}));

suite.define(() => {
  it("shows all supplied PRs and keeps pushed updates and keyboard navigation usable", async () => {
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
        const publish = async (items: ControlUiSessionPullRequest[], status = "ready") =>
          gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
            sessions: {
              [key]: { pullRequests: items, status, rateLimited: status === "rate-limited" },
            },
          });
        await publish(requests.toReversed());
        const card = page.locator(".session-progress-hovercard");
        await expect
          .poll(() => card.locator(".session-hovercard__pr-count").textContent())
          .toBe("3");
        const links = card.locator(".session-hovercard__pr-row");
        expect(await links.count()).toBe(3);
        expect(await links.first().getAttribute("href")).toBe(requests[0]!.url);
        expect(await links.nth(1).getAttribute("data-state")).toBe("draft");
        expect(await card.locator(".session-hovercard__pr-checks").textContent()).toBe(
          "CI checks failing",
        );
        await captureUiProof(suite, page, "pr-history", "mixed.png");

        expect(await card.locator("details").count()).toBe(0);
        await links.first().focus();
        await page.keyboard.press("Tab");
        expect(await links.nth(1).evaluate((element) => element === document.activeElement)).toBe(
          true,
        );

        await publish(
          requests.map((request) => ({ ...request, state: "merged", checks: undefined })),
        );
        await expect.poll(() => links.first().getAttribute("data-state")).toBe("merged");
        await captureUiProof(suite, page, "pr-history", "merged.png");
        await publish(requests, "rate-limited");
        await card.getByRole("status").waitFor();
        await captureUiProof(suite, page, "pr-history", "rate-limited.png");
        await page.keyboard.press("Escape");
        await expect.poll(() => card.count()).toBe(0);
        expect(await trigger.evaluate((element) => element === document.activeElement)).toBe(true);

        await page.setViewportSize({ width: 600, height: 700 });
        await page
          .locator(".topbar-nav-toggle:visible, .chat-pane__nav-toggle:visible")
          .first()
          .click();
        await trigger.focus();
        await expect.poll(() => card.count()).toBe(1);
        const bounds = await card.boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(600);
        await captureUiProof(suite, page, "pr-history", "narrow.png");
      },
    );
  });
});
