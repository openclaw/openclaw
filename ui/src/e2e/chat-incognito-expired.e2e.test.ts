import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Expired Incognito recovery" });
const expiredKey = "agent:main:dashboard:incognito-expired";
const expiredPath = "/chat/main/dashboard/incognito-expired";
const freshKey = "agent:main:dashboard:incognito-fresh";
const activePrivateMessage = "This synthetic Incognito conversation is active.";

async function recoverIncognito(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Identity-free history, not discovery, authorizes Incognito expiry.
  const expiredHistory = {
    cases: [
      {
        match: { sessionKey: expiredKey },
        response: { sessionKey: expiredKey, messages: [] },
      },
    ],
  };
  const gateway = await installMockGateway(page, {
    sessions: [],
    sessionTranscripts: {
      [freshKey]: {
        messages: [{ role: "assistant", content: activePrivateMessage }],
      },
    },
    deferredMethods: ["chat.startup"],
    methodResponses: {
      "chat.startup": expiredHistory,
      "chat.history": expiredHistory,
      "sessions.create": {
        key: freshKey,
        entry: { sessionId: "fresh-incognito-session", incognito: true },
      },
    },
  });
  await page.goto(`${suite.server.baseUrl}${expiredPath.slice(1)}`);
  await waitForControlUiRoute(page, { routeId: "chat", pathname: expiredPath });
  await gateway.waitForRequest("chat.startup");
  const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
  const composer = pane.locator(".agent-chat__composer-combobox textarea");
  const expired = pane.getByText("Incognito session expired", { exact: true });
  const proof = (name: string) => path.join(suite.artifactDir, name + ".png");
  const loader = pane.locator(".chat-thread openclaw-panel-loading-skeleton");
  await loader.waitFor({ state: "attached" });
  await gateway.resolveDeferred("chat.startup");
  await loader.waitFor({ state: "detached" });

  await page.screenshot({ path: proof("expired-route") });
  expect(await expired.count()).toBe(1);
  expect(await composer.count()).toBe(0);
  expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
  expect(await gateway.getRequests("chat.send")).toHaveLength(0);

  await pane.getByRole("button", { name: "New Incognito session", exact: true }).click();
  const created = await gateway.waitForRequest("sessions.create");
  expect(created.params).toMatchObject({ agentId: "main", incognito: true });
  await waitForControlUiRoute(page, {
    routeId: "chat",
    pathname: `/chat/${freshKey.slice("agent:".length).replaceAll(":", "/")}`,
  });
  await composer.waitFor({ state: "visible" });
  await pane.getByText(activePrivateMessage, { exact: true }).waitFor();
  expect(await expired.count()).toBe(0);
  expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
  expect(await gateway.getRequests("chat.send")).toHaveLength(0);
  expect(errors).toEqual([]);
  await page.screenshot({ path: proof("fresh-incognito-session") });
}

suite.define(() => {
  it("replaces an expired deep link with an explicit fresh Incognito session action", () =>
    suite.withPage(createControlUiE2eContextOptions(), ({ page }) => recoverIncognito(page)));
});
