import { expect, it } from "vitest";
import {
  CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT,
  SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD as subscribe,
} from "../../../src/gateway/control-ui-contract.js";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { publicationMethods } from "./chat-github-publication.test-support.ts";
import {
  createControlUiE2eSuite,
  createControlUiE2eContextOptions,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Session-only chat read gates" });
const options = {
  ...createControlUiE2eContextOptions(),
  colorScheme: "light" as const,
  viewport: { height: 800, width: 1180 },
};
const scopes = ["operator.sessions.read", "operator.sessions.write"];

suite.define(() => {
  it("keeps operator session-only command menus free of forbidden catalog reads", async () => {
    await suite.withPage(options, async ({ page }) => {
      const row = {
        ...createControlUiSessionRow("agent:main:main", "Scoped workspace", Date.now()),
        sharingRole: "owner",
        spawnedCwd: "/workspace/synthetic-project",
      };
      const gateway = await installMockGateway(page, {
        sessionKey: row.key,
        sessions: [row],
        operatorScopes: scopes,
        featureMethods: ["chat.metadata", "chat.startup", "chat.send", "commands.list"],
        methodResponses: {
          "commands.list": {
            __mockError: { code: "FORBIDDEN", message: "missing scope: operator.read" },
          },
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, row.key));
      const composer = page
        .locator(".agent-chat__composer-combobox textarea")
        .filter({ visible: true });
      await composer.fill("/help");
      await page.locator(".slash-menu[role='listbox']").waitFor();
      await expect
        .poll(() => page.locator(".slash-menu-name").allTextContents())
        .toContain("/help");
      expect(await gateway.getRequests("commands.list")).toHaveLength(0);
      expect(await page.getByText("missing scope: operator.read", { exact: false }).count()).toBe(
        0,
      );
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
      await gateway.waitForRequest("sessions.messages.subscribe", { match: { key: row.key } });
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
