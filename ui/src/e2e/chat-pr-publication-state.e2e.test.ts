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
