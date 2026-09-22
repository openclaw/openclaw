import { writeFile } from "node:fs/promises";
import path from "node:path";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import {
  CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT,
  type ControlUiGitHubPreview,
  type ControlUiSessionPullRequestsChanged,
} from "../../../src/gateway/control-ui-contract.js";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../lib/session-pull-requests.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { chatSessionListResponse } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Activity session Git details" });
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const keys = {
  frontend: "agent:main:activity-frontend",
  review: "agent:reviewer:activity-review",
  branch: "agent:main:activity-branch",
  notes: "agent:main:activity-notes",
};
const repository = { owner: "example", repo: "control-ui" };
const pullRequest = {
  ...repository,
  number: 42,
  branch: "feature/activity-details",
  title: "Show Git progress in the activity feed",
  url: "https://github.com/example/control-ui/pull/42",
  state: "open" as const,
  additions: 184,
  deletions: 27,
};
const reviewRequest = {
  ...repository,
  repo: "gateway",
  number: 17,
  branch: "fix/reconnect-session-state",
  title: "Keep session state after reconnecting",
  url: "https://github.com/example/gateway/pull/17",
  state: "draft" as const,
};
const preview: ControlUiGitHubPreview = {
  ...repository,
  repo: reviewRequest.repo,
  kind: "pull",
  number: reviewRequest.number,
  title: reviewRequest.title,
  login: "casey-example",
  state: "open",
  draft: true,
  additions: 63,
  deletions: 8,
  changedFiles: 4,
  createdAt: "2026-09-10T12:00:00Z",
  updatedAt: "2026-09-11T12:00:00Z",
};

async function capture(page: Page, filename: string, content: readonly Locator[]) {
  if (captureUiProof) {
    await writeFile(
      path.join(suite.artifactDir, filename),
      await takeControlUiViewportScreenshot(page, page.locator(".shell"), content),
    );
  }
}

suite.define(() => {
  it("shows pushed changes and scoped PR previews without taking over session navigation", async () => {
    await suite.withPage(
      {
        colorScheme: "light",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { width: 1440, height: 1000 },
      },
      async ({ context, page }) => {
        await context.route("https://github.com/**", (route) =>
          route.fulfill({
            contentType: "text/html",
            body: "<!doctype html><title>Synthetic pull request destination</title>",
          }),
        );
        const now = Date.now();
        const sessions = chatSessionListResponse(
          (
            [
              [keys.frontend, "Activity feed improvements", "Alex Morgan", "main"],
              [keys.review, "Review Gateway reconnection", "Casey Brooks", "reviewer"],
              [keys.branch, "Polish responsive navigation", "Sam Rivera", "main"],
              [keys.notes, "Release planning notes", "Alex Morgan", "main"],
            ] as const
          ).map(([key, label, owner, agentId], index) => ({
            key,
            label,
            agentId,
            kind: "direct",
            updatedAt: now - (index + 1) * 60_000,
            createdActor: { type: "human", id: owner, label: owner },
          })),
        );
        const gateway = await installMockGateway(page, {
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
          ],
          methodResponses: {
            "sessions.list": {
              cases: [
                { match: { includePeople: true }, response: sessions },
                { response: chatSessionListResponse([]) },
              ],
            },
            [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
            "controlUi.githubPreview": {
              cases: [
                { match: { owner: "example", repo: "gateway", number: 17 }, response: preview },
                { response: { ...preview, ...pullRequest } },
              ],
            },
          },
        });
        const watchedKeys = async () => {
          const requests = await gateway.getRequests(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD);
          return asNullableRecord(requests.at(-1)?.params)?.sessionKeys;
        };
        await page.goto(`${suite.server.baseUrl}activity`);
        await waitForControlUiRoute(page, { pathname: "/activity", routeId: "activity" });
        const activity = page.locator("openclaw-activity-page");
        const row = (key: string) =>
          activity.locator(".activity-feed__session-row").filter({
            has: page.locator(`[data-activity-session="${key}"]`),
          });
        await expect.poll(() => activity.locator("[data-activity-session]").count()).toBe(4);
        await expect.poll(watchedKeys).toEqual(expect.arrayContaining(Object.values(keys)));

        const snapshots: ControlUiSessionPullRequestsChanged = {
          sessions: {
            [keys.frontend]: {
              pullRequests: [
                pullRequest,
                {
                  ...pullRequest,
                  number: 39,
                  state: "merged",
                  url: "https://github.com/example/control-ui/pull/39",
                  additions: 46,
                  deletions: 12,
                },
              ],
              branch: { ...repository, branch: pullRequest.branch, additions: 205, deletions: 31 },
              rateLimited: false,
              status: "ready",
            },
            [keys.review]: { pullRequests: [reviewRequest], rateLimited: false, status: "ready" },
            [keys.branch]: {
              pullRequests: [],
              branch: {
                ...repository,
                branch: "feature/responsive-navigation-and-keyboard-shortcuts",
                additions: 1_284,
                deletions: 96,
              },
              rateLimited: true,
              status: "rate-limited",
            },
            [keys.notes]: { pullRequests: [], rateLimited: false, status: "ready" },
          },
        };
        await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, snapshots);
        const openPr = row(keys.frontend).locator('.activity-feed__pr[data-state="open"]');
        await expect.poll(() => openPr.textContent()).toContain("control-ui#42");
        expect(await openPr.locator(".activity-feed__additions").textContent()).toBe("+184");
        expect(await openPr.locator(".activity-feed__deletions").textContent()).toBe("−27");
        expect(
          await row(keys.frontend).locator('.activity-feed__pr[data-state="merged"]').count(),
        ).toBe(1);
        expect(await row(keys.frontend).locator(".activity-feed__branch").count()).toBe(0);
        expect(
          await openPr.evaluate((element) => element.closest("[data-activity-session]")),
        ).toBeNull();

        const draftPr = row(keys.review).locator('.activity-feed__pr[data-state="draft"]');
        await expect.poll(() => draftPr.textContent()).toContain("gateway#17");
        expect(
          await draftPr.locator(".activity-feed__additions, .activity-feed__deletions").count(),
        ).toBe(0);
        expect(await row(keys.notes).locator(".activity-feed__git").count()).toBe(0);
        const branch = row(keys.branch).locator(".activity-feed__branch");
        await expect
          .poll(() => branch.textContent())
          .toContain("feature/responsive-navigation-and-keyboard-shortcuts");
        expect(await branch.locator(".activity-feed__additions").textContent()).toBe("+1,284");
        expect(await branch.locator(".activity-feed__deletions").textContent()).toBe("−96");
        await row(keys.branch)
          .getByRole("img", { name: "Git status may be out of date" })
          .waitFor();
        await capture(page, "01-desktop-activity-git.png", [openPr, branch]);

        const card = page.locator(".github-link-hovercard");
        await draftPr.hover();
        await expect.poll(() => card.textContent()).toContain(reviewRequest.title);
        const request = await gateway.waitForRequest("controlUi.githubPreview", {
          match: { owner: "example", repo: "gateway", number: 17 },
        });
        expect(request.params).toMatchObject({ agentId: "reviewer", kind: "pull" });
        expect(await draftPr.getAttribute("href")).toBe(reviewRequest.url);
        expect(await draftPr.getAttribute("target")).toBe("_blank");
        await capture(page, "02-desktop-pr-hover.png", [card]);
        await page.mouse.move(1, 1);
        await expect.poll(() => card.count()).toBe(0);

        await page.setViewportSize({ width: 390, height: 844 });
        await draftPr.scrollIntoViewIfNeeded();
        await expect
          .poll(() => activity.evaluate((element) => element.scrollWidth - element.clientWidth))
          .toBeLessThanOrEqual(1);
        await capture(page, "03-mobile-activity-git.png", [draftPr]);
        await draftPr.focus();
        await expect.poll(() => card.textContent()).toContain(reviewRequest.title);
        const bounds = await card.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
        await capture(page, "04-mobile-pr-focus.png", [card]);
        await page.keyboard.press("Escape");
        await expect.poll(() => card.count()).toBe(0);
        expect(await draftPr.evaluate((element) => element === document.activeElement)).toBe(true);
        const popupPromise = page.waitForEvent("popup");
        await page.keyboard.press("Enter");
        const popup = await popupPromise;
        await popup.waitForLoadState("domcontentloaded");
        expect(popup.url()).toBe(reviewRequest.url);
        expect(new URL(page.url()).pathname).toBe("/activity");
        await popup.close();

        await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
          sessions: {
            [keys.frontend]: {
              ...snapshots.sessions[keys.frontend],
              pullRequests: [{ ...pullRequest, state: "merged", additions: 192, deletions: 30 }],
            },
          },
        });
        const updatedPr = row(keys.frontend).locator('.activity-feed__pr[data-state="merged"]');
        await expect
          .poll(() => updatedPr.locator(".activity-feed__additions").textContent())
          .toBe("+192");
        expect(await updatedPr.locator(".activity-feed__deletions").textContent()).toBe("−30");
        await expect
          .poll(() => row(keys.frontend).locator(".activity-feed__branch").textContent())
          .toContain(pullRequest.branch);

        const sessionLink = row(keys.notes).locator("[data-activity-session]");
        const href = await sessionLink.getAttribute("href");
        expect(href).toBeTruthy();
        const destination = new URL(href!, page.url());
        await sessionLink.click();
        await expect.poll(() => new URL(page.url()).pathname).toBe(destination.pathname);
        await expect.poll(() => new URL(page.url()).search).toBe(destination.search);
        await expect.poll(watchedKeys).not.toEqual(expect.arrayContaining([keys.review]));
        expect(await page.locator("openclaw-activity-session-git").count()).toBe(0);
      },
    );
  });
});
