import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../src/gateway/control-ui-contract.js";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../lib/session-pull-requests.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { TEST_LINK_READER } from "../test-helpers/link-reader.ts";
import {
  publicationMethods,
  publicationOptions,
  showPublicationBranch,
  waitForWatchedSessionKey,
} from "./chat-github-publication.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const suite = createControlUiE2eSuite({ name: "Control UI PR publication state" });
const publicationContextOptions = () => ({
  colorScheme: "light" as const,
  locale: "en-US",
  serviceWorkers: "block" as const,
  viewport: { height: 800, width: 1180 },
});

suite.define(() => {
  it("keeps a merged transcript PR separate from an idle publication workspace", async () => {
    await suite.withPage(publicationContextOptions(), async ({ page }) => {
      const href = "https://github.com/synthetic/publication-demo/pull/42";
      const gateway = await installMockGateway(page, {
        communityInvite: false,
        featureMethods: [
          ...publicationMethods,
          TEST_LINK_READER.linkReader.previewMethod!,
          TEST_LINK_READER.linkReader.detailMethod,
        ],
        controlUiLinkReaders: [TEST_LINK_READER],
        deferredMethods: ["sessions.github.options"],
        historyMessages: [
          {
            role: "assistant",
            content: [{ type: "text", text: `The previous task PR was merged: ${href}` }],
          },
        ],
        methodResponses: {
          [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
          "sessions.github.options": publicationOptions,
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
      await gateway.waitForRequest("sessions.github.options");
      const chip = page.locator(`a.markdown-github-item[href="${href}"]`);
      await expect.poll(() => chip.getAttribute("data-link-reader-tone")).toBe("accent");
      await chip.focus();
      await expect
        .poll(() => page.locator(".link-reader-hovercard").textContent())
        .toContain("Merged");
      await page.keyboard.press("Escape");
      if (captureUiProof) {
        await writeFile(
          path.join(suite.artifactDir, "merged-pr-discovery.png"),
          await takeControlUiViewportScreenshot(page, page.locator(".chat-prs"), [chip]),
        );
      }
      expect(await chip.getAttribute("data-link-reader-tone")).toBe("accent");
      expect(await page.locator(".chat-prs").textContent()).not.toContain("Publishing");
      expect(await gateway.getRequests("sessions.github.publish")).toHaveLength(0);
      await gateway.resolveDeferred("sessions.github.options");
      await page.getByRole("button", { name: "Publish PR", exact: true }).waitFor();
      expect(await page.locator(".chat-prs").textContent()).toContain("openclaw/review-request");
      expect(await gateway.getRequests("sessions.github.publish")).toHaveLength(0);
      expect(await gateway.getRequests(TEST_LINK_READER.linkReader.previewMethod!)).toHaveLength(1);
      if (captureUiProof) {
        await writeFile(
          path.join(suite.artifactDir, "merged-pr-idle-workspace.png"),
          await takeControlUiViewportScreenshot(page, page.locator(".chat-prs"), [chip]),
        );
      }
    });
  });

  it("shows unavailable cached PR state distinctly and clears the warning after recovery", async () => {
    await suite.withPage(publicationContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        communityInvite: false,
        featureMethods: publicationMethods,
        methodResponses: {
          [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
          "sessions.github.options": publicationOptions,
        },
      });
      await page.goto(suite.server.baseUrl + "chat");
      const key = await waitForWatchedSessionKey(gateway);
      const repository = { owner: "synthetic", repo: "publication-demo" };
      const emit = (status: "ready" | "unavailable", state: "open" | "merged" = "open") =>
        gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
          sessions: {
            [key]: {
              repository,
              pullRequests: [
                {
                  ...repository,
                  number: 43,
                  branch: "feature/current-task",
                  title: "Current task",
                  url: "https://github.com/synthetic/publication-demo/pull/43",
                  state,
                },
              ],
              rateLimited: false,
              status,
            },
          },
        });
      const row = page.locator(".chat-prs");
      const warning = row.locator(".chat-pr__warning");
      await emit("ready");
      await expect.poll(() => row.textContent()).toContain("#43");
      expect(await warning.count()).toBe(0);
      await emit("unavailable", "merged");
      await expect.poll(() => warning.getAttribute("aria-label")).toContain("last known state");
      expect(await warning.getAttribute("aria-label")).not.toContain("rate limit");
      expect(await row.textContent()).toContain("#43");
      if (captureUiProof) {
        await writeFile(
          path.join(suite.artifactDir, "unavailable-pr-status.png"),
          await takeControlUiViewportScreenshot(page, row, [warning]),
        );
      }
      expect(await row.locator("article").getAttribute("data-state")).toBe("merged");
      await emit("ready", "merged");
      await expect.poll(() => warning.count()).toBe(0);
      expect(await row.textContent()).toContain("#43");
      await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
        sessions: {
          [key]: {
            repository,
            branch: { ...repository, branch: "feature/next-task", additions: 9 },
            pullRequests: [],
            rateLimited: false,
            status: "unavailable",
          },
        },
      });
      await expect.poll(() => row.textContent()).toContain("feature/next-task");
      expect(await row.textContent()).not.toContain("#43");
      expect(await row.locator("article").getAttribute("data-state")).toBe("branch");
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
      const gateway = await installMockGateway(page, {
        communityInvite: false,
        featureMethods: publicationMethods,
        methodResponses: {
          [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
          "sessions.github.options": {
            ...publicationOptions,
            latestShared: { result: failure, confirmation: null },
          },
        },
      });
      await page.goto(suite.server.baseUrl + "chat");
      const key = await waitForWatchedSessionKey(gateway);
      await page.getByText(failure.nextAction, { exact: true }).waitFor({ state: "attached" });
      await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
        sessions: {
          [key]: {
            pullRequests: [
              {
                owner: "synthetic",
                repo: "publication-demo",
                number: 45,
                branch: "feature/finished-task",
                title: "Completed task",
                url: "https://github.com/synthetic/publication-demo/pull/45",
                state: "merged",
              },
            ],
            rateLimited: false,
            status: "ready",
          },
        },
      });
      const surface = page.locator(".chat-prs");
      const merged = surface.locator('article[data-state="merged"]');
      await merged.waitFor();
      // Capture the actual baseline before the regression assertion as well as the repaired state.
      if (captureUiProof) {
        await writeFile(
          path.join(suite.artifactDir, "failed-publication-merged.png"),
          await takeControlUiViewportScreenshot(page, surface, [merged]),
        );
      }
      expect(await merged.textContent()).not.toContain(failure.nextAction);
      expect(await merged.locator("[data-publication-account]").count()).toBe(0);
      const history = surface.locator("details.chat-pr__publication-history");
      expect(await history.count()).toBe(1);
      expect(await history.evaluate((element) => element.closest("article") === null)).toBe(true);
      expect(await history.getAttribute("open")).toBeNull();
      const summary = history.locator("summary").first();
      expect((await summary.textContent())?.trim()).toBe("Publication attempt failed");
      const guidance = history.getByText(failure.nextAction, { exact: true });
      expect(await guidance.isVisible()).toBe(false);
      await summary.click();
      await guidance.waitFor();
      const account = history.locator("[data-publication-account]");
      expect(await account.textContent()).toContain("Publish as @agent-bot");
      expect(await account.textContent()).toContain("Agent override");
      const refresh = history.getByRole("button", { name: "Refresh publication" });
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
      expect(await summary.evaluate((element) => getComputedStyle(element).color)).toBe(
        tokens.danger,
      );
      for (const neutral of [account, guidance, refresh]) {
        const color = await neutral.evaluate((element) => getComputedStyle(element).color);
        expect(color).not.toBe(tokens.danger);
        expect([tokens.muted, tokens.text]).toContain(color);
      }
      if (captureUiProof) {
        await writeFile(
          path.join(suite.artifactDir, "failed-publication-expanded.png"),
          await takeControlUiViewportScreenshot(page, surface, [merged, guidance, refresh]),
        );
      }
      const readsBefore = (await gateway.getRequests("sessions.github.options")).length;
      await refresh.click();
      await gateway.waitForRequest("sessions.github.options", { after: readsBefore });
      await refresh.waitFor();
      expect(await merged.textContent()).toContain("Merged");
      const target = (await gateway.waitForRequest("sessions.github.options")).params;
      if (target === null || typeof target !== "object" || Array.isArray(target)) {
        throw new Error("Expected publication request parameters");
      }
      const published = {
        pullRequests: [
          {
            owner: "synthetic",
            repo: "publication-demo",
            number: 45,
            branch: "feature/finished-task",
            title: "Completed task",
            url: "https://github.com/synthetic/publication-demo/pull/45",
            state: "merged",
            headSha: "f".repeat(40),
          },
        ],
        status: "ready",
        rateLimited: false,
      };
      // An inconclusive coverage observation must not permanently suppress another
      // automatic check of this same PR head after GitHub becomes readable again.
      const beforeInconclusive = (await gateway.getRequests("sessions.github.options")).length;
      await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
        sessions: { [key]: published },
      });
      await gateway.waitForRequest("sessions.github.options", { after: beforeInconclusive });
      await refresh.waitFor({ state: "visible" });
      await expect.poll(() => refresh.isEnabled()).toBe(true);
      expect(await history.count()).toBe(1);
      await gateway.setMethodResponse("sessions.github.options", publicationOptions);
      const beforeRetirement = (await gateway.getRequests("sessions.github.options")).length;
      await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
        sessions: { [key]: published },
      });
      await gateway.waitForRequest("sessions.github.options", { after: beforeRetirement });
      await expect.poll(() => history.count()).toBe(0);
      if (captureUiProof) {
        await writeFile(
          path.join(suite.artifactDir, "superseded-publication-retired.png"),
          await takeControlUiViewportScreenshot(page, surface, [merged]),
        );
      }
      await page.reload();
      const reloadedKey = await waitForWatchedSessionKey(gateway);
      await gateway.waitForRequest("sessions.github.options");
      await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
        sessions: { [reloadedKey]: published },
      });
      await merged.waitFor();
      expect(await history.count()).toBe(0);
      await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
        sessions: {
          [reloadedKey]: {
            pullRequests: [],
            status: "ready",
            rateLimited: false,
            branch: {
              owner: "synthetic",
              repo: "publication-demo",
              branch: "feature/next-work",
              changedFiles: 1,
            },
          },
        },
      });
      await surface.locator("article[data-state=branch]").waitFor();
      expect(await page.getByText(failure.nextAction, { exact: true }).count()).toBe(0);
      await gateway.setMethodResponse("sessions.github.options", {
        ...publicationOptions,
        latestShared: {
          result: {
            ...failure,
            requestId: "18bcedb0-bc8f-468d-88e8-6a048b8e9ed9",
            nextAction: "Publish the new changes.",
          },
          confirmation: null,
        },
      });
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
      const repository = { owner: "synthetic", repo: "publication-demo" };
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
      const gateway = await installMockGateway(page, {
        communityInvite: false,
        featureMethods: [...publicationMethods, "sessions.subscribe"],
        deferredMethods: ["sessions.github.status"],
        methodResponses: {
          [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
          "sessions.subscribe": { subscribed: true },
          "sessions.github.options": {
            ...publicationOptions,
            latestShared: { result: accepted, confirmation: null },
          },
          "sessions.github.status": completed,
        },
      });
      const showBranch = async () => {
        const key = await waitForWatchedSessionKey(gateway);
        await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
          sessions: {
            [key]: {
              repository,
              branch: { ...repository, branch, additions: 9, deletions: 2 },
              pullRequests: [],
              rateLimited: false,
              status: "ready",
            },
          },
        });
        return key;
      };
      await page.goto(suite.server.baseUrl + "chat");
      const key = await showBranch();
      const optionsRequest = await gateway.waitForRequest("sessions.github.options");
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
      await gateway.setMethodResponse("sessions.github.options", {
        ...publicationOptions,
        latestShared: completed,
      });
      await gateway.resolveDeferred("sessions.github.status", completed);
      await page.getByRole("link", { name: "Open PR", exact: true }).waitFor();
      expect(await page.locator(".chat-pr__publication-outcome").count()).toBe(0);
      await expect
        .poll(async () => (await gateway.getRequests("sessions.github.options")).length)
        .toBe(2);
      expect(await page.locator(".chat-prs a.chat-pr__create").getAttribute("href")).toBe(
        published.url,
      );
      const beforeReconnect = (await gateway.getRequests("sessions.github.options")).length;
      const watchedBefore = (await gateway.getRequests(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD))
        .length;
      await gateway.setGatewayBootId("shared-publication-restart");
      await gateway.closeLatest(1012, "Gateway restart");
      await gateway.waitForRequest(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD, {
        after: watchedBefore,
      });
      await showBranch();
      await gateway.waitForRequest("sessions.github.options", { after: beforeReconnect });
      await page.getByRole("link", { name: "Open PR", exact: true }).waitFor();
      if (captureUiProof) {
        const row = page.locator(".chat-prs");
        await writeFile(
          path.join(suite.artifactDir, "shared-publication-reconnected.png"),
          await takeControlUiViewportScreenshot(page, row, [row.locator("a.chat-pr__create")]),
        );
      }
      await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
        sessions: {
          [key]: {
            repository,
            pullRequests: [
              {
                ...repository,
                number: 44,
                branch,
                title: "Shared publication",
                url: published.url,
                state: "merged",
              },
            ],
            rateLimited: false,
            status: "ready",
          },
        },
      });
      const rows = page.locator(".chat-prs .chat-pr");
      await expect.poll(() => rows.count()).toBe(1);
      await expect.poll(() => rows.getAttribute("data-state")).toBe("merged");
      expect(await rows.textContent()).not.toContain("Publish as");
      expect(await page.getByRole("button", { name: "Choose a new publication" }).count()).toBe(0);
      if (captureUiProof) {
        await writeFile(
          path.join(suite.artifactDir, "shared-publication-merged.png"),
          await takeControlUiViewportScreenshot(page, page.locator(".chat-prs"), [
            rows.locator(".chat-pr__number"),
          ]),
        );
      }
      await rows.getByRole("button", { name: "Dismiss pull request #44" }).click();
      await expect.poll(() => rows.count()).toBe(0);
      await showBranch();
      await page.getByRole("button", { name: "Publish PR", exact: true }).waitFor();
      expect(await gateway.getRequests("sessions.github.publish")).toHaveLength(0);
      expect(await gateway.getRequests("sessions.github.confirm")).toHaveLength(0);
    });
  });
});
