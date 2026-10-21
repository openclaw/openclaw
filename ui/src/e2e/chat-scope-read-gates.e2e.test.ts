import { expect, it } from "vitest";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../src/gateway/control-ui-contract.js";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD as subscribe } from "../lib/session-pull-requests.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { openDetailsPullRequests } from "./chat-details.test-support.ts";
import { chatMessage } from "./chat-flow.test-support.ts";
import {
  publicationMethods,
  waitForWatchedSessionKey,
} from "./chat-github-publication.test-support.ts";
import {
  createControlUiE2eSuite,
  createControlUiE2eContextOptions,
  expandCodingSection,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Session-only chat read gates" });
const options = {
  ...createControlUiE2eContextOptions(),
  colorScheme: "light" as const,
  viewport: { height: 800, width: 1180 },
};
const scopes = ["operator.sessions.read", "operator.sessions.write"];

suite.define(() => {
  it("retires general PR facts when only own-session reading remains on reconnect", async () => {
    await suite.withPage(options, async ({ page }) => {
      const viewer = { id: "scope-viewer", name: "Scoped viewer" };
      const row = createControlUiSessionRow("agent:main:scope-badge", "Scoped", Date.now(), {
        worktree: {
          id: "wt-scope",
          branch: "feature/scope",
          repoRoot: "/synthetic/scope-review",
        },
        pullRequest: { numbers: [42], state: "open" },
        sharingRole: "owner",
        owner: { actor: { type: "human", id: viewer.id, label: viewer.name } },
        visibility: "shared",
        spawnedCwd: "/synthetic/scope-review",
      });
      const gateway = await installMockGateway(page, {
        sessionKey: row.key,
        sessions: [row],
        workspace: "/synthetic/scope-review",
        workspaceGit: true,
        presenceUsers: [{ self: true, ...viewer }],
        historyMessages: [chatMessage("assistant", "The scoped session remains readable.")],
        operatorScopes: ["operator.read", "operator.write"],
        featureMethods: ["chat.metadata", "chat.startup", subscribe],
        methodResponses: { [subscribe]: { subscribed: true } },
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
        `.sidebar-recent-session[data-session-key="${row.key}"] [data-pull-request-state="open"]`,
      );
      await indicator.waitFor();
      const chatChip = page.locator(
        '.chat-pr__link[href="https://github.com/synthetic/repo/pull/42"]',
      );
      await openDetailsPullRequests(page);
      await chatChip.waitFor();
      const priorRequests = (await gateway.getRequests(subscribe)).length;
      const priorConnects = (await gateway.getRequests("connect")).length;
      await gateway.setOperatorScopes(scopes);
      await gateway.closeLatest();
      await gateway.waitForRequest("connect", { after: priorConnects });
      await waitForControlUiGatewayReady(page);
      await indicator.waitFor({ state: "hidden" });
      await expect.poll(() => chatChip.count()).toBe(0);
      const ownRead = await gateway.waitForRequest(subscribe, { after: priorRequests });
      expect(ownRead.params).toMatchObject({ sessionKeys: [watchedKey] });
      expect(ownRead.params).not.toHaveProperty("passiveSessionKeys");
      await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
        sessions: {
          [watchedKey]: {
            pullRequests: [],
            rateLimited: false,
            status: "unavailable",
            discardPrevious: true,
          },
        },
      });
      expect(await chatChip.count()).toBe(0);
      expect(await indicator.count()).toBe(0);
      expect(
        await evaluateControlUiContext(page, (context) => {
          const snapshot = context.gateway.snapshot;
          return { phase: snapshot.phase, scopes: snapshot.hello?.auth?.scopes };
        }),
      ).toEqual({
        phase: "connected",
        scopes,
      });
    });
  });

  it("loads publication options while the own-PR read is unavailable", async () => {
    await suite.withPage(options, async ({ page }) => {
      const row = createControlUiSessionRow("agent:main:main", "Scoped workspace", Date.now());
      const gateway = await installMockGateway(page, {
        sessionKey: row.key,
        sessions: [row],
        operatorScopes: scopes,
        featureMethods: publicationMethods,
        methodResponses: {
          "sessions.github.options": {
            shared: null,
            personal: null,
            pendingPersonal: null,
            latestShared: null,
          },
          [subscribe]: { subscribed: true },
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, row.key));
      await gateway.waitForRequest("chat.startup");
      await page.locator("openclaw-chat-pane.chat-pane-cache__pane--active").waitFor();
      await gateway.waitForRequest("sessions.github.options");
      const ownRead = await gateway.waitForRequest(subscribe);
      expect(ownRead.params).toMatchObject({ sessionKeys: [row.key] });
      expect(ownRead.params).not.toHaveProperty("passiveSessionKeys");
      await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
        sessions: {
          [row.key]: {
            pullRequests: [],
            rateLimited: false,
            status: "unavailable",
            discardPrevious: true,
          },
        },
      });
      expect(await page.locator(".chat-pr__link").count()).toBe(0);
    });
  });
});
