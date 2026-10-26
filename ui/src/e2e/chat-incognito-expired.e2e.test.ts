import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { sessionResponseCase } from "./chat-layout-fixtures.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Expired Incognito recovery" });
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const expiredKey = "agent:main:dashboard:incognito-expired";
const expiredPath = "/chat/main/dashboard/incognito-expired";
const freshKey = "agent:main:dashboard:incognito-fresh";
const activePrivateMessage = "This synthetic Incognito conversation is active.";

async function recoverIncognito(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Identity-free history, not discovery, authorizes Incognito expiry.
  const expiredHistory = sessionResponseCase(
    { sessionKey: expiredKey },
    { sessionKey: expiredKey, messages: [] },
  );
  const gateway = await installMockGateway(page, {
    subscriptionInitialHistory: false,
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
  const startup = await gateway.waitForRequest("chat.startup");
  expect(startup.params).toMatchObject({ sessionKey: expiredKey });
  const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
  const composer = pane.locator(".agent-chat__composer-combobox textarea");
  const expired = pane.getByText("Incognito session expired", { exact: true });
  const proof = (name: string) => path.join(suite.artifactDir, name + ".png");
  const loader = pane.locator(".chat-thread openclaw-panel-loading-skeleton");
  await loader.waitFor({ state: "attached" });
  await gateway.resolveDeferred("chat.startup");
  await loader.waitFor({ state: "detached" });

  if (captureUiProof) {
    await page.screenshot({ path: proof("expired-route") });
  }
  expect(await expired.count()).toBe(1);
  expect(await composer.count()).toBe(0);
  expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
  expect(await gateway.getRequests("chat.send")).toHaveLength(0);

  await pane.getByRole("button", { name: "New Incognito session", exact: true }).click();
  const created = await gateway.waitForRequest("sessions.create");
  expect(created.params).toMatchObject({ agentId: "main", incognito: true });
  expect(created.params).not.toHaveProperty("key");
  expect(created.params).not.toHaveProperty("parentSessionKey");
  expect(created.params).not.toHaveProperty("message");
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
  if (captureUiProof) {
    await page.screenshot({ path: proof("fresh-incognito-session") });
  }

  // Expire authoritative history while the submitted failure remains in the outbox.
  const pendingText = "Keep this unsent synthetic research question available to copy.";
  await gateway.deferNext("chat.send");
  await composer.fill(pendingText);
  await pane.getByRole("button", { name: "Send message", exact: true }).click();
  const rejected = await gateway.waitForRequest("chat.send");
  expect(rejected.params).toMatchObject({ sessionKey: freshKey, message: pendingText });
  await gateway.rejectDeferred("chat.send", {
    code: "INVALID_REQUEST",
    message: "Synthetic delivery rejection",
  });
  const pendingRow = pane.locator(".chat-group.user", { hasText: pendingText });
  await pendingRow.locator('.chat-send-status[data-send-state="failed"]').waitFor();
  await pendingRow.getByRole("button", { name: "Retry queued message" }).waitFor();
  const expiredFreshHistory = { sessionKey: freshKey, messages: [] };
  await gateway.setMethodResponse("chat.startup", expiredFreshHistory);
  await gateway.setMethodResponse("chat.history", expiredFreshHistory);
  const startupCount = (await gateway.getRequests("chat.startup")).length;
  await gateway.setOnline(false);
  await gateway.setOnline(true);
  await gateway.waitForRequest("chat.startup", { after: startupCount });
  await expired.waitFor();
  await pendingRow.getByText(pendingText, { exact: true }).waitFor();
  expect(await pane.getByText(activePrivateMessage, { exact: true }).count()).toBe(0);
  expect(await pendingRow.getByRole("button", { name: /Retry/ }).count()).toBe(0);
  const discard = pendingRow.getByRole("button", { name: "Discard", exact: true });
  await discard.waitFor();
  if (captureUiProof) {
    await page.screenshot({ path: proof("expired-with-failed-message") });
  }
  await pendingRow.locator(".chat-bubble").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Copy as markdown", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(pendingText);
  await discard.click();
  await pendingRow.waitFor({ state: "detached" });
  expect(await gateway.getRequests("chat.send")).toHaveLength(1);
  expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
  expect(errors).toEqual([]);
}

suite.define(() => {
  it("replaces an expired deep link with an explicit fresh Incognito session action", () =>
    suite.withPage(
      {
        ...createControlUiE2eContextOptions(),
        permissions: ["clipboard-read", "clipboard-write"],
      },
      ({ page }) => recoverIncognito(page),
    ));
});
