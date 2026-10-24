import type { Page } from "playwright";
import { expect, it } from "vitest";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../src/gateway/control-ui-contract.js";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../lib/session-pull-requests.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { TEST_LINK_READER } from "../test-helpers/link-reader.ts";
import {
  openChatDetails,
  openChatPublication,
  openDetailsPullRequests,
} from "./chat-details.test-support.ts";
import {
  publicationMethods,
  publicationOptions,
  showPublicationBranch,
  waitForWatchedSessionKey,
} from "./chat-github-publication.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI PR publication state" });
const publicationContextOptions = () => ({
  colorScheme: "light" as const,
  locale: "en-US",
  serviceWorkers: "block" as const,
  viewport: { height: 800, width: 1180 },
});

const githubOptions = "sessions.github.options";
const repository = { owner: "synthetic", repo: "publication-demo" };
const sharedOptions = <Result>(result: Result) => ({
  ...publicationOptions,
  latestShared: { result, confirmation: null },
});
function pullRequest(number: number, branch: string, title: string, state = "merged") {
  return {
    ...repository,
    number,
    branch,
    title,
    url: `https://github.com/synthetic/publication-demo/pull/${number}`,
    state,
  };
}

function installPublicationGateway(
  page: Page,
  overrides: Parameters<typeof installMockGateway>[1] = {},
) {
  return installMockGateway(page, {
    communityInvite: false,
    featureMethods: publicationMethods,
    ...overrides,
    methodResponses: {
      [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
      [githubOptions]: publicationOptions,
      ...overrides.methodResponses,
    },
  });
}
function emitPrs(
  gateway: Awaited<ReturnType<typeof installPublicationGateway>>,
  key: string,
  state: Record<string, unknown>,
) {
  return gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
    sessions: { [key]: { status: "ready", rateLimited: false, ...state } },
  });
}

suite.define(() => {
  it.each(["link", "actions"] as const)(
    "keeps accepted publication pending and enriches the confirmed %s in place",
    async (focus) => {
      await suite.withPage(publicationContextOptions(), async ({ page }) => {
        const branch = "feature/publication-feedback";
        const receipt = {
          requestId: "2fead998-d749-42b6-baa2-bef4e07c13df",
          publisher: publicationOptions.shared,
          status: "requested",
          message: "The publication was accepted.",
        };
        const published = {
          ...receipt,
          status: "published",
          repository: "synthetic/publication-demo",
          branch,
          headCommit: "a".repeat(40),
          url: "https://github.com/synthetic/publication-demo/pull/44",
        };
        const gateway = await installPublicationGateway(page, {
          methodResponses: { "sessions.github.publish": receipt },
        });
        await page.goto(suite.server.baseUrl + "chat");
        await showPublicationBranch(gateway, branch);
        const environment = await openChatPublication(page);
        await page.keyboard.press("Escape");
        const trigger = environment.locator(".chat-pr__publication-actions > .chat-pr__create");
        await trigger.getByText("Create PR", { exact: true }).waitFor();
        await trigger.click();
        await gateway.waitForRequest("sessions.github.publish");
        await environment
          .locator('.chat-pr__publication-outcome[data-state="requested"]')
          .waitFor({ state: "attached" });
        expect.soft(await trigger.textContent()).toContain("Creating");
        expect.soft(await trigger.locator(".btn__spinner").count()).toBe(1);
        expect.soft(await trigger.locator(".chat-pr__publication-warning").count()).toBe(0);
        const target = (await gateway.waitForRequest(githubOptions)).params;
        if (!target || typeof target !== "object" || Array.isArray(target)) {
          throw new Error("Expected publication request parameters");
        }
        await gateway.setMethodResponse("sessions.github.status", {
          result: published,
          confirmation: null,
        });
        await gateway.setMethodResponse(githubOptions, sharedOptions(published));
        await gateway.emitGatewayEvent("sessions.changed", {
          ...target,
          reason: "github-publication",
        });
        const group = await openDetailsPullRequests(page);
        const link = group.locator(`a[href="${published.url}"]`).first();
        await link.waitFor();
        const row = group
          .locator("article")
          .filter({ has: page.locator(`a[href="${published.url}"]`) });
        const originalRow = await row.elementHandle();
        const focused = focus === "link" ? link : row.getByRole("button").first();
        let originalFocus = await focused.elementHandle();
        const before = await row.boundingBox();
        await focused.focus();
        const key = await waitForWatchedSessionKey(gateway);
        const unrelated = pullRequest(41, "feature/earlier-work", "Earlier pull request", "open");
        await emitPrs(gateway, key, { repository, pullRequests: [unrelated] });
        await group.getByText("Earlier pull request", { exact: true }).waitFor();
        expect.soft(await link.count()).toBe(1);
        if (focus === "actions") {
          expect(
            await originalFocus!.evaluate((element) => element === document.activeElement),
          ).toBe(true);
          await focused.press("Enter");
          const hide = row.getByRole("menuitem", { name: "Hide", exact: true });
          await hide.focus();
          originalFocus = await hide.elementHandle();
          expect(
            await row.locator("openclaw-chat-ci-details, openclaw-chat-ci-automation").count(),
          ).toBe(0);
          expect(
            await row
              .getByRole("menuitem", { name: "Open on GitHub", exact: true })
              .getAttribute("href"),
          ).toBe(published.url);
        }
        await emitPrs(gateway, key, {
          repository,
          pullRequests: [
            unrelated,
            pullRequest(44, branch, "Keep publication feedback consistent", "open"),
          ],
        });
        await group.getByText("Keep publication feedback consistent", { exact: true }).waitFor();
        expect.soft(await originalRow!.evaluate((element) => element.isConnected)).toBe(true);
        expect
          .soft(await originalFocus!.evaluate((element) => element === document.activeElement))
          .toBe(true);
        expect.soft((await row.boundingBox())!.height).toBe(before!.height);
        expect(await gateway.getRequests("sessions.github.publish")).toHaveLength(1);
        expect(await gateway.getRequests("sessions.github.confirm")).toHaveLength(0);
        expect(await gateway.getRequests("sessions.github.status")).toHaveLength(1);
        if (focus === "actions") {
          await page.keyboard.press("Escape");
        }
        const reads = (await gateway.getRequests(githubOptions)).length;
        const oldRow = group.locator("article").filter({ hasText: "Earlier pull request" });
        await oldRow.locator(".chat-pr__actions-trigger").click();
        await oldRow.getByRole("menuitem", { name: "Hide", exact: true }).click();
        await oldRow.waitFor({ state: "hidden" });
        expect(await link.count()).toBe(1);
        expect(await gateway.getRequests(githubOptions)).toHaveLength(reads);
      });
    },
  );

  it("keeps a merged transcript PR separate from an idle publication workspace", async () => {
    await suite.withPage(publicationContextOptions(), async ({ page }) => {
      const href = "https://github.com/synthetic/publication-demo/pull/42";
      const gateway = await installPublicationGateway(page, {
        featureMethods: [
          ...publicationMethods,
          TEST_LINK_READER.linkReader.previewMethod!,
          TEST_LINK_READER.linkReader.detailMethod,
        ],
        controlUiLinkReaders: [TEST_LINK_READER],
        deferredMethods: [githubOptions],
        historyMessages: [
          {
            role: "assistant",
            content: [{ type: "text", text: `The previous task PR was merged: ${href}` }],
          },
        ],
        methodResponses: {
          [TEST_LINK_READER.linkReader.previewMethod!]: {
            url: href,
            subtitle: "synthetic/publication-demo #42",
            badge: { label: "Merged", tone: "accent" },
            createdAt: "2026-09-11T00:00:00Z",
            updatedAt: "2026-09-12T00:00:00Z",
            author: "reviewer",
            title: "Completed task in another worktree",
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await showPublicationBranch(gateway, "openclaw/review-request");
      await gateway.waitForRequest(githubOptions);
      const chip = page.locator(`a.markdown-github-item[href="${href}"]`);
      await expect.poll(() => chip.getAttribute("data-link-reader-tone")).toBe("accent");
      await chip.focus();
      await expect
        .poll(() => page.locator(".link-reader-hovercard").textContent())
        .toContain("Merged");
      await page.keyboard.press("Escape");
      await openChatDetails(page);
      expect(await chip.getAttribute("data-link-reader-tone")).toBe("accent");
      expect(await page.locator(".chat-environment__branch").textContent()).not.toContain(
        "Publishing",
      );
      expect(await gateway.getRequests("sessions.github.publish")).toHaveLength(0);
      await gateway.resolveDeferred(githubOptions);
      await openChatPublication(page);
      await page.getByRole("button", { name: "Create PR", exact: true }).waitFor();
      expect(await page.locator(".chat-environment__branch").textContent()).toContain(
        "openclaw/review-request",
      );
      expect(await gateway.getRequests("sessions.github.publish")).toHaveLength(0);
      expect(await gateway.getRequests(TEST_LINK_READER.linkReader.previewMethod!)).toHaveLength(1);
    });
  });

  it("shows unavailable cached PR state distinctly and clears the warning after recovery", async () => {
    await suite.withPage(publicationContextOptions(), async ({ page }) => {
      const gateway = await installPublicationGateway(page);
      await page.goto(suite.server.baseUrl + "chat");
      await openChatDetails(page);
      const key = await waitForWatchedSessionKey(gateway);
      const emit = (status: "ready" | "unavailable", state: "open" | "merged" = "open") =>
        emitPrs(gateway, key, {
          repository,
          pullRequests: [pullRequest(43, "feature/current-task", "Current task", state)],
          status,
        });
      const row = page.locator(".chat-prs");
      const menu = row.locator(".chat-pr-menu");
      const warning = menu.locator(".chat-pr__stale");
      await emit("ready");
      await openDetailsPullRequests(page);
      await row.locator(".chat-pr__actions-trigger").click();
      await expect.poll(() => menu.textContent()).toContain("#43");
      expect(await warning.count()).toBe(0);
      await emit("unavailable", "merged");
      await expect
        .poll(() => warning.textContent())
        .toContain("Couldn’t update PR info. It may be outdated.");
      expect(await warning.textContent()).not.toContain("rate limit");
      expect(await menu.textContent()).toContain("#43");
      expect(await row.locator("article").getAttribute("data-state")).toBe("merged");
      await emit("ready", "merged");
      await expect.poll(() => warning.count()).toBe(0);
      expect(await menu.textContent()).toContain("#43");
      await emitPrs(gateway, key, {
        repository,
        branch: { ...repository, branch: "feature/next-task", additions: 9 },
        pullRequests: [],
        status: "unavailable",
      });
      const environment = await openChatPublication(page);
      await expect.poll(() => environment.textContent()).toContain("feature/next-task");
      expect(await row.count()).toBe(0);
      expect(await environment.locator(".chat-pr__warning").count()).toBe(1);
      expect(await gateway.getRequests("sessions.github.publish")).toHaveLength(0);
    });
  });

  it("retires superseded publication failure after a merge without hiding new unpublished failures", async () => {
    await suite.withPage(publicationContextOptions(), async ({ page }) => {
      const failure = {
        requestId: "3a9d86d9-87fb-4aa1-afc3-e98df3b2cb56",
        status: "failed",
        code: "unavailable",
        publisher: { source: "agent-override", accountId: 3, login: "agent-bot" },
        message: "GitHub publication failed.",
        nextAction:
          "The pull request base or its Git history could not be verified. Check repository read access, connectivity, and local Git objects before retrying publication.",
      };
      const gateway = await installPublicationGateway(page, {
        methodResponses: {
          [githubOptions]: sharedOptions(failure),
        },
      });
      await page.goto(suite.server.baseUrl + "chat");
      await openChatDetails(page);
      const key = await waitForWatchedSessionKey(gateway);
      await openChatPublication(page);
      await page.getByText(failure.nextAction, { exact: true }).waitFor({ state: "attached" });
      await emitPrs(gateway, key, {
        pullRequests: [pullRequest(45, "feature/finished-task", "Completed task")],
      });
      const surface = page.locator(".chat-prs");
      const merged = surface.locator('article[data-state="merged"]');
      await merged.waitFor();
      expect(await merged.textContent()).not.toContain(failure.nextAction);
      expect(await merged.locator("[data-publication-account]").count()).toBe(0);
      const environment = page.locator('[data-details-group="environment"]');
      const history = environment.locator("details.chat-pr__publication-status");
      expect(await history.count()).toBe(1);
      expect(await history.evaluate((element) => element.closest("article") === null)).toBe(true);
      expect(await history.getAttribute("open")).toBeNull();
      const summary = history.locator("summary").first();
      expect((await summary.textContent())?.trim()).toBe("Publication failed");
      const guidance = history.getByText(failure.nextAction, { exact: true });
      expect(await guidance.isVisible()).toBe(false);
      await openChatPublication(page);
      await summary.click();
      await guidance.waitFor();
      const account = environment.locator("[data-publication-account]");
      expect(await account.textContent()).toContain("Publish as @agent-bot");
      expect(await account.textContent()).toContain("Agent override");
      const refresh = environment.getByRole("button", { name: "Refresh publication" });
      const tokens = await history.evaluate((element) => {
        const probe = document.createElement("span");
        element.append(probe);
        const resolve = (token: string) => {
          probe.style.color = `var(${token})`;
          return getComputedStyle(probe).color;
        };
        const colors = {
          danger: resolve("--danger"),
          muted: resolve("--muted"),
          text: resolve("--text"),
        };
        probe.remove();
        return colors;
      });
      expect(
        await summary
          .locator(".chat-pr__publication-headline")
          .evaluate((element) => getComputedStyle(element).color),
      ).toBe(tokens.danger);
      for (const neutral of [account, guidance, refresh]) {
        const color = await neutral.evaluate((element) => getComputedStyle(element).color);
        expect(color).not.toBe(tokens.danger);
        expect([tokens.muted, tokens.text]).toContain(color);
      }
      const readsBefore = (await gateway.getRequests(githubOptions)).length;
      await refresh.click();
      await gateway.waitForRequest(githubOptions, { after: readsBefore });
      await refresh.waitFor();
      expect(await merged.getAttribute("data-state")).toBe("merged");
      const target = (await gateway.waitForRequest(githubOptions)).params;
      if (target === null || typeof target !== "object" || Array.isArray(target)) {
        throw new Error("Expected publication request parameters");
      }
      const published = {
        pullRequests: [
          {
            ...pullRequest(45, "feature/finished-task", "Completed task"),
            headSha: "f".repeat(40),
          },
        ],
      };
      // An inconclusive coverage observation must not permanently suppress another
      // automatic check of this same PR head after GitHub becomes readable again.
      const beforeInconclusive = (await gateway.getRequests(githubOptions)).length;
      await emitPrs(gateway, key, published);
      await gateway.waitForRequest(githubOptions, { after: beforeInconclusive });
      await refresh.waitFor({ state: "visible" });
      await expect.poll(() => refresh.isEnabled()).toBe(true);
      expect(await history.count()).toBe(1);
      await gateway.setMethodResponse(githubOptions, publicationOptions);
      const beforeRetirement = (await gateway.getRequests(githubOptions)).length;
      await emitPrs(gateway, key, published);
      await gateway.waitForRequest(githubOptions, { after: beforeRetirement });
      await expect.poll(() => history.count()).toBe(0);
      await page.reload();
      await openChatDetails(page);
      const reloadedKey = await waitForWatchedSessionKey(gateway);
      await gateway.waitForRequest(githubOptions);
      await emitPrs(gateway, reloadedKey, published);
      await openDetailsPullRequests(page);
      await merged.waitFor();
      expect(await history.count()).toBe(0);
      await emitPrs(gateway, reloadedKey, {
        pullRequests: [],
        branch: {
          ...repository,
          branch: "feature/next-work",
          changedFiles: 1,
        },
      });
      await environment.locator(".chat-environment__branch").waitFor();
      expect(await surface.count()).toBe(0);
      expect(await page.getByText(failure.nextAction, { exact: true }).count()).toBe(0);
      await gateway.setMethodResponse(
        githubOptions,
        sharedOptions({
          ...failure,
          requestId: "18bcedb0-bc8f-468d-88e8-6a048b8e9ed9",
          nextAction: "Publish the new changes.",
        }),
      );
      await gateway.emitGatewayEvent("sessions.changed", {
        ...target,
        reason: "github-publication",
      });
      await page
        .getByText("Publish the new changes.", { exact: true })
        .waitFor({ state: "attached" });
      expect(await gateway.getRequests("sessions.github.publish")).toHaveLength(0);
      expect(await gateway.getRequests("sessions.github.confirm")).toHaveLength(0);
    });
  });

  it("recovers shared receipts and observes committed status without publishing", async () => {
    await suite.withPage(publicationContextOptions(), async ({ page }) => {
      const branch = "openclaw/shared-read-proof";
      const publisher = publicationOptions.shared;
      const requestId = "bdca439a-e787-4f9f-b5f3-a878c662cc77";
      const accepted = {
        requestId,
        publisher,
        status: "requested",
        message: "The shared publication was accepted.",
      };
      const published = {
        requestId,
        publisher,
        status: "published",
        repository: "synthetic/publication-demo",
        branch,
        headCommit: "a".repeat(40),
        url: "https://github.com/synthetic/publication-demo/pull/44",
      };
      const completed = { result: published, confirmation: null };
      const gateway = await installPublicationGateway(page, {
        featureMethods: [...publicationMethods, "sessions.subscribe"],
        deferredMethods: ["sessions.github.status"],
        methodResponses: {
          "sessions.subscribe": { subscribed: true },
          [githubOptions]: sharedOptions(accepted),
          "sessions.github.status": completed,
        },
      });
      const showBranch = async () => {
        const key = await waitForWatchedSessionKey(gateway);
        await emitPrs(gateway, key, {
          repository,
          branch: { ...repository, branch, additions: 9, deletions: 2 },
          pullRequests: [],
        });
        return key;
      };
      await page.goto(suite.server.baseUrl + "chat");
      await openChatDetails(page);
      const key = await showBranch();
      await openChatPublication(page);
      const optionsRequest = await gateway.waitForRequest(githubOptions);
      const target = optionsRequest.params as { sessionKey: string; agentId?: string };
      expect(target.sessionKey).toBe(key);
      await page.locator(".chat-pr__publication-outcome[data-state=requested]").waitFor();
      for (let index = 0; index < 5; index += 1) {
        await gateway.emitGatewayEvent("sessions.changed", {
          ...target,
          reason: "github-publication",
        });
      }
      await gateway.waitForRequest("sessions.github.status");
      expect(await gateway.getRequests("sessions.github.status")).toHaveLength(1);
      expect(await gateway.getRequests("sessions.github.publish")).toHaveLength(0);
      await gateway.setMethodResponse(githubOptions, sharedOptions(published));
      await gateway.resolveDeferred("sessions.github.status", completed);
      const publishedGroup = await openDetailsPullRequests(page);
      await publishedGroup.getByRole("link", { name: /^Open PR:/ }).waitFor();
      const environment = page.locator(".chat-environment__branch");
      expect(
        await environment.locator(".chat-pr__diff, .chat-pr__publication-actions").count(),
      ).toBe(0);
      expect(await page.locator(".chat-pr__publication-outcome").count()).toBe(0);
      await expect.poll(async () => (await gateway.getRequests(githubOptions)).length).toBe(2);
      expect(await publishedGroup.locator("a.chat-pr__link").getAttribute("href")).toBe(
        published.url,
      );
      const beforeReconnect = (await gateway.getRequests(githubOptions)).length;
      const watchedBefore = (await gateway.getRequests(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD))
        .length;
      await gateway.setGatewayBootId("shared-publication-restart");
      await gateway.closeLatest(1012, "Gateway restart");
      await gateway.waitForRequest(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD, {
        after: watchedBefore,
      });
      await showBranch();
      await openDetailsPullRequests(page);
      await gateway.waitForRequest(githubOptions, { after: beforeReconnect });
      await page.getByRole("link", { name: /^Open PR:/ }).waitFor();
      await emitPrs(gateway, key, {
        repository,
        pullRequests: [pullRequest(44, branch, "Shared publication")],
      });
      const rows = page.locator(".chat-prs .chat-pr");
      await expect.poll(() => rows.count()).toBe(1);
      await expect.poll(() => rows.getAttribute("data-state")).toBe("merged");
      expect(
        await environment.locator(".chat-pr__diff, .chat-pr__publication-actions").count(),
      ).toBe(0);
      expect(await rows.textContent()).not.toContain("Publish as");
      expect(await page.getByRole("button", { name: "Choose a new publication" }).count()).toBe(0);
      const prName = "pull request synthetic/publication-demo#44";
      const actions = { name: `Actions for ${prName}`, exact: true };
      const dismiss = { name: "Hide", exact: true };
      await rows.getByRole("button", actions).click();
      await page.getByRole("menuitem", dismiss).click();
      await expect.poll(() => rows.count()).toBe(0);
      await showBranch();
      await openChatPublication(page);
      await page.getByRole("button", { name: "Create PR", exact: true }).waitFor();
      expect(await gateway.getRequests("sessions.github.publish")).toHaveLength(0);
      expect(await gateway.getRequests("sessions.github.confirm")).toHaveLength(0);
    });
  });
});
