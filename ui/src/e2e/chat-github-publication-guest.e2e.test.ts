import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import type {
  SessionGitHubPublicationResult,
  SessionGitHubStatusResult,
} from "../../../packages/gateway-protocol/src/schema/session-github-publication.ts";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../lib/session-pull-requests.ts";
import type { GitHubPublicationOptions } from "../lib/sessions/github-publication-controller.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiSessionUrl,
  installMockGateway,
  reconnectMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { publicationMethods } from "./chat-github-publication.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI guest shared GitHub publication" });
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const viewport = { width: 1180, height: 800 };
const sessionKey = "agent:main:guest-publication";
const publisher = { source: "system-configured", accountId: 1, login: "roboclaw-bot" } as const;
const options = {
  personal: null,
  shared: publisher,
  pendingPersonal: null,
  latestShared: null,
} satisfies GitHubPublicationOptions;
const historyText = "The visitor's change is ready for publication.";

function contextOptions(record = false): Parameters<typeof suite.newBrowserContext>[0] {
  return {
    colorScheme: "light",
    locale: "en-US",
    serviceWorkers: "block",
    viewport,
    ...(record && captureUiProof
      ? { recordVideo: { dir: suite.artifactDir, size: viewport } }
      : {}),
  };
}

async function installGuestGateway(
  page: Page,
  hasWorkspace = true,
  shared: GitHubPublicationOptions["shared"] = publisher,
) {
  return await installMockGateway(page, {
    assistantName: "Publication QA",
    workspace: "/synthetic/visitor-publication",
    communityInvite: false,
    operatorScopes: ["operator.sessions.write"],
    // Guests do not receive the broad PR watcher; publication must work without its branch event.
    featureMethods: publicationMethods.filter(
      (method) => method !== SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
    ),
    sessionKey,
    mainSessionKey: "agent:main:main",
    sessions: [
      createControlUiSessionRow(sessionKey, "Visitor change", 1, {
        visibility: "shared",
        sharingRole: "owner",
        ...(hasWorkspace
          ? {
              worktree: {
                id: "visitor-worktree",
                branch: "visitor/documentation",
                repoRoot: "/synthetic/visitor-demo",
              },
            }
          : {}),
      }),
    ],
    presenceUsers: [
      {
        self: true,
        id: "synthetic-visitor",
        identity: { type: "profile", id: "synthetic-visitor" },
        name: "Visitor",
      },
    ],
    historyMessages: [
      { role: "user", content: [{ type: "text", text: "Prepare a small documentation change." }] },
      { role: "assistant", content: [{ type: "text", text: historyText }] },
    ],
    methodResponses: { "sessions.github.options": { ...options, shared } },
  });
}

async function screenshot(page: Page, filename: string) {
  if (captureUiProof) {
    await writeFile(
      path.join(suite.artifactDir, filename),
      await takeControlUiViewportScreenshot(page, page.locator(".shell"), [
        page.getByText(historyText, { exact: true }),
      ]),
    );
  }
}

async function expectNoPersonalActions(page: Page) {
  expect(await page.getByRole("button", { name: "Publication account", exact: true }).count()).toBe(
    0,
  );
  expect(
    await page.getByRole("button", { name: "Confirm original publication", exact: true }).count(),
  ).toBe(0);
}

suite.define(() => {
  it("publishes an owned guest session through the shared account and recovers its receipt", async () => {
    await suite.withPage(contextOptions(true), async ({ page }) => {
      const gateway = await installGuestGateway(page);
      const requestId = "8c698e8a-bdc7-4927-a0f2-73a842c2d7b7";
      const requested = {
        requestId,
        status: "requested",
        publisher,
        message: "The shared publisher is preparing the pull request.",
      } satisfies SessionGitHubPublicationResult;
      const receipt = {
        result: {
          requestId,
          status: "published",
          publisher,
          url: "https://github.com/synthetic/visitor-demo/pull/42",
          repository: "synthetic/visitor-demo",
          branch: "visitor/documentation",
          headCommit: "a".repeat(40),
        },
        confirmation: null,
      } satisfies SessionGitHubStatusResult;
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await page.getByText(historyText, { exact: true }).waitFor();
      const discovered = await gateway.waitForRequest("sessions.github.options");
      expect(discovered.params).toEqual({ sessionKey, agentId: "main" });
      const publish = page.getByRole("button", { name: "Publish PR", exact: true });
      try {
        await expect.poll(() => publish.count()).toBe(1);
        await expect.poll(() => publish.isEnabled()).toBe(true);
      } finally {
        // This same capture records the missing action when run on the pre-fix source.
        await screenshot(page, "01-guest-ready.png");
      }
      await expectNoPersonalActions(page);
      expect(await gateway.getRequests("sessions.github.publish")).toHaveLength(0);
      await gateway.deferNext("sessions.github.publish");
      await publish.click();
      const publication = await gateway.waitForRequest("sessions.github.publish");
      expect(publication.params).toEqual({
        sessionKey,
        agentId: "main",
        idempotencyKey: expect.any(String),
        selection: { source: "shared", expected: publisher },
      });
      await gateway.resolveDeferred("sessions.github.publish", requested);
      await page.getByText(requested.message, { exact: true }).waitFor();
      await screenshot(page, "02-guest-requested.png");
      await gateway.setMethodResponse("sessions.github.status", receipt);
      await gateway.setMethodResponse("sessions.github.options", {
        ...options,
        latestShared: receipt,
      });
      await page.getByRole("button", { name: "Refresh publication", exact: true }).click();
      const status = await gateway.waitForRequest("sessions.github.status");
      expect(status.params).toEqual({ sessionKey, agentId: "main", requestId });
      const openPr = page.getByRole("link", { name: "Open PR", exact: true });
      await expect.poll(() => openPr.getAttribute("href")).toBe(receipt.result.url);
      await screenshot(page, "03-guest-published.png");

      const previousOptions = (await gateway.getRequests("sessions.github.options")).length;
      await reconnectMockGateway(page, gateway);
      await gateway.waitForRequest("sessions.github.options", { after: previousOptions });
      await expect.poll(() => openPr.getAttribute("href")).toBe(receipt.result.url);
      await expectNoPersonalActions(page);
      expect(await gateway.getRequests("sessions.github.publish")).toHaveLength(1);
      expect(await gateway.getRequests("sessions.github.confirm")).toHaveLength(0);
      expect(await gateway.getRequests(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD)).toHaveLength(0);
      await page.reload();
      await gateway.waitForRequest("sessions.github.options");
      await expect.poll(() => openPr.getAttribute("href")).toBe(receipt.result.url);
      await screenshot(page, "04-guest-recovered.png");
      expect(await gateway.getRequests("sessions.github.publish")).toHaveLength(0);
      expect(await gateway.getRequests("sessions.github.confirm")).toHaveLength(0);
    });
  });

  it.each([false, true])(
    "waits for an available publication target (managed workspace: %s)",
    async (hasWorkspace) => {
      await suite.withPage(contextOptions(), async ({ page }) => {
        const gateway = await installGuestGateway(page, hasWorkspace, null);
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await page.getByText(historyText, { exact: true }).waitFor();
        await gateway.waitForRequest("sessions.github.options");
        expect(await page.getByRole("button", { name: "Publish PR", exact: true }).count()).toBe(0);
        await expectNoPersonalActions(page);
        expect(await gateway.getRequests("sessions.github.publish")).toHaveLength(0);
        expect(await gateway.getRequests("sessions.github.confirm")).toHaveLength(0);
        if (hasWorkspace) {
          // The Gateway has qualified the supported worktree rebind before rediscovery.
          await gateway.setMethodResponse("sessions.github.options", options);
          const previousOptions = (await gateway.getRequests("sessions.github.options")).length;
          await reconnectMockGateway(page, gateway);
          await gateway.waitForRequest("sessions.github.options", { after: previousOptions });
          await expect
            .poll(() => page.getByRole("button", { name: "Publish PR", exact: true }).count())
            .toBe(1);
          expect(await gateway.getRequests("sessions.github.publish")).toHaveLength(0);
        }
      });
    },
  );
});
