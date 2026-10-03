import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../src/gateway/control-ui-contract.js";
import type { ApplicationContext } from "../app/context.ts";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../lib/session-pull-requests.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  publicationMethods,
  waitForWatchedSessionKey,
} from "./chat-github-publication.test-support.ts";
import {
  createControlUiE2eSuite,
  expandCodingSection,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Session-only chat read gates" });

suite.define(() => {
  it("retires the visible PR badge and chat chip after read access is revoked on reconnect", async () => {
    await suite.withPage(
      {
        colorScheme: "light",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 800, width: 1180 },
      },
      async ({ page }) => {
        const row = createControlUiSessionRow(
          "agent:main:scope-badge",
          "Scoped workspace",
          Date.now(),
          {
            worktree: {
              id: "wt-scope",
              branch: "feature/scope",
              repoRoot: "/synthetic/scope-review",
            },
            pullRequest: { numbers: [42], state: "open" },
            sharingRole: "owner",
            visibility: "shared",
            spawnedCwd: "/synthetic/scope-review",
          },
        );
        const gateway = await installMockGateway(page, {
          communityInvite: false,
          sessionKey: row.key,
          sessions: [row],
          workspace: "/synthetic/scope-review",
          workspaceGit: true,
          presenceUsers: [
            { self: true, id: "synthetic-scope-viewer", name: "Synthetic scope viewer" },
          ],
          historyMessages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "The scoped session remains readable." }],
            },
          ],
          operatorScopes: ["operator.read", "operator.write"],
          featureMethods: ["chat.metadata", "chat.startup", SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD],
          methodResponses: { [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true } },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, row.key));
        await page.getByText("The scoped session remains readable.").waitFor();
        await expandCodingSection(page, true);
        const watchedKey = await waitForWatchedSessionKey(gateway, row.key);
        await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
          sessions: {
            [watchedKey]: {
              pullRequests: [
                {
                  number: 42,
                  owner: "synthetic",
                  repo: "repo",
                  branch: "feature/scope",
                  title: "Scoped review",
                  url: "https://github.com/synthetic/repo/pull/42",
                  state: "open",
                },
              ],
              rateLimited: false,
              status: "ready",
            },
          },
        });
        const indicator = page.locator(
          '.sidebar-recent-session[data-session-key="' +
            row.key +
            '"] [data-pull-request-state="open"]',
        );
        await indicator.waitFor();
        const chatChip = page.locator(
          '.chat-pr__link[href="https://github.com/synthetic/repo/pull/42"]',
        );
        await chatChip.waitFor();
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          await writeFile(
            path.join(suite.artifactDir, "pr-scope-before-revocation.png"),
            await takeControlUiViewportScreenshot(page, page.locator(".shell"), [chatChip]),
          );
        }
        const priorRequests = (await gateway.getRequests(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD))
          .length;
        const priorConnects = (await gateway.getRequests("connect")).length;
        await gateway.setOperatorScopes(["operator.sessions.read", "operator.sessions.write"]);
        await gateway.closeLatest();
        await gateway.waitForRequest("connect", { after: priorConnects });
        await waitForControlUiGatewayReady(page);
        await indicator.waitFor({ state: "hidden" });
        await expect.poll(() => chatChip.count()).toBe(0);
        expect(await gateway.getRequests(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD)).toHaveLength(
          priorRequests,
        );
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          await writeFile(
            path.join(suite.artifactDir, "pr-scope-after-revocation.png"),
            await takeControlUiViewportScreenshot(page, page.locator(".shell"), [
              page.getByText("The scoped session remains readable.", { exact: true }),
            ]),
          );
        }
        expect(await chatChip.count()).toBe(0);
        expect(await indicator.count()).toBe(0);
        expect(
          await page.evaluate(() => {
            const app = document.querySelector<
              HTMLElement & { runtime: { context: ApplicationContext } }
            >("openclaw-app");
            const snapshot = app?.runtime.context.gateway.snapshot;
            return { phase: snapshot?.phase, scopes: snapshot?.hello?.auth?.scopes };
          }),
        ).toEqual({
          phase: "connected",
          scopes: ["operator.sessions.read", "operator.sessions.write"],
        });
      },
    );
  });

  it("loads shared publication options without broad PR status with session-only scopes", async () => {
    await suite.withPage(
      {
        colorScheme: "light",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 800, width: 1180 },
      },
      async ({ page }) => {
        const row = createControlUiSessionRow("agent:main:main", "Scoped workspace", Date.now());
        const gateway = await installMockGateway(page, {
          communityInvite: false,
          sessionKey: row.key,
          sessions: [row],
          operatorScopes: ["operator.sessions.read", "operator.sessions.write"],
          featureMethods: publicationMethods,
          methodResponses: {
            "sessions.github.options": {
              shared: null,
              personal: null,
              pendingPersonal: null,
              latestShared: null,
            },
            [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: {
              __mockError: { code: "FORBIDDEN", message: "missing scope operator.read" },
            },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, row.key));
        await gateway.waitForRequest("chat.startup");
        await page.locator("openclaw-chat-pane.chat-pane-cache__pane--active").waitFor();
        await gateway.waitForRequest("sessions.github.options");
        expect(await gateway.getRequests(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD)).toHaveLength(0);
        expect(await page.getByText("missing scope operator.read").count()).toBe(0);
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          await writeFile(
            path.join(suite.artifactDir, "session-only-chat-after.png"),
            await takeControlUiViewportScreenshot(page, page.locator(".shell"), [
              page.locator("openclaw-chat-pane.chat-pane-cache__pane--active"),
            ]),
          );
        }
      },
    );
  });
});
