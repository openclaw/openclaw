import { expect, it } from "vitest";
import {
  createChatFlowE2eSuite,
  installMockGateway,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
type TouchContact = [identifier: number, clientY: number];

suite.define(() => {
  it("wires settled transcript gestures, escalation, keyboard choices, and visit reset", async () => {
    const context = await suite.newBrowserContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const sessionKey = "agent:main:main";
    const gateway = await installMockGateway(page, {
      sessionKey,
      sessionInfo: { key: sessionKey, hasActiveRun: true, activeRunIds: ["progress-run"] },
      inFlightRun: { runId: "progress-run", startedAt: Date.now() },
      historyMessages: Array.from({ length: 80 }, (_, index) => ({
        role: index % 2 ? "assistant" : "user",
        content: [{ type: "text", text: `History ${index}: ${"Reading context. ".repeat(8)}` }],
      })),
      methodResponses: {
        "progressCard.get": {
          card: {
            sessionKey,
            revision: 1,
            updatedAt: Date.now(),
            steps: [
              { step: "Inspect the conversation", status: "in_progress" },
              { step: "Verify navigation", status: "pending" },
            ],
          },
        },
      },
    });
    const card = page.locator(".session-progress-card--composer");
    const thread = page.locator(".chat-thread");
    const open = () => card.evaluate((element) => (element as HTMLDetailsElement).open);
    const gestures = async (count: number, distance: number) => {
      await thread.hover();
      for (let index = 0; index < count; index++) {
        if (index) {
          await page.waitForTimeout(201); // Distinct user gestures, beyond the 200 ms burst boundary.
        }
        const before = await thread.evaluate((element) => element.scrollTop);
        await page.mouse.wheel(0, -distance);
        await expect
          .poll(() => thread.evaluate((element) => element.scrollTop))
          .toBeLessThan(before);
      }
      await waitForChatScrollIdle(page);
    };
    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await card.waitFor();
      await waitForChatScrollIdle(page);
      expect(await open()).toBe(true);
      await gestures(1, 500);
      await page.waitForTimeout(300);
      expect(await open()).toBe(true);
      await gestures(1, 200);
      await expect.poll(open).toBe(false);
      const retainedCard = await card.elementHandle();
      await gateway.setOnline(false);
      const offline = page.locator('.agent-chat__composer-underlaps[data-tone="warn"]');
      await offline.waitFor();
      expect(await retainedCard?.evaluate((element) => element.isConnected)).toBe(true);
      expect(await open()).toBe(false);
      await gateway.setOnline(true);
      await offline.waitFor({ state: "hidden" });
      expect(await retainedCard?.evaluate((element) => element.isConnected)).toBe(true);
      expect(await open()).toBe(false);
      await page.locator('.chat-scroll-to-bottom[data-visible="true"]').click();
      await waitForChatScrollIdle(page);
      expect(await open()).toBe(false);
      await card.locator("summary").press("Enter");
      expect(await open()).toBe(true);
      await gestures(2, 320);
      await page.waitForTimeout(300);
      expect(await open()).toBe(true);
      await gestures(1, 100);
      await expect.poll(open).toBe(false);
      await card.locator("summary").press("Space");
      expect(await open()).toBe(true);
      await gestures(4, 320);
      await page.waitForTimeout(300);
      expect(await open()).toBe(true);
      const retainedPane = await page.locator("openclaw-chat-pane").elementHandle();
      const sidebar = page.locator("openclaw-app-sidebar");
      await sidebar.locator(".sidebar-identity-card").click();
      await sidebar
        .locator("wa-dropdown.sidebar-identity-menu")
        .getByRole("menuitem", { exact: true, name: "Settings" })
        .click();
      await page.locator("openclaw-chat-pane").waitFor({ state: "hidden" });
      expect(await retainedPane?.evaluate((element) => element.isConnected)).toBe(true);
      await page.goBack();
      await card.waitFor({ state: "visible" });
      await waitForChatScrollIdle(page);
      expect(await open()).toBe(true);
      await gestures(2, 320);
      await expect.poll(open).toBe(false);
      await card.locator("summary").click();
      await card.locator("summary").click();
      await gestures(3, 320);
      await page.waitForTimeout(300);
      expect(await open()).toBe(false);
      await page.reload();
      await card.waitFor();
      await waitForChatScrollIdle(page);
      expect(await open()).toBe(true);
      await card.locator("summary").click();
      expect(await open()).toBe(false);
      await sidebar.locator(".sidebar-identity-card").click();
      await sidebar
        .locator("wa-dropdown.sidebar-identity-menu")
        .getByRole("menuitem", { exact: true, name: "Settings" })
        .click();
      await page.locator('.settings-sidebar__item[href="/settings/connection"]').click();
      const connection = page.locator("openclaw-connection-page .settings-section").filter({
        has: page.locator(".settings-section__heading").getByText("Connection", { exact: true }),
      });
      await connection.getByText("Connected", { exact: true }).waitFor();
      const replacementUrl = "ws://127.0.0.1:19998";
      await connection.getByLabel("Gateway URL", { exact: true }).fill(replacementUrl);
      await connection.getByRole("button", { name: "Apply and reconnect", exact: true }).click();
      await connection.getByText("Connected", { exact: true }).waitFor();
      expect((await gateway.getSocketUrls()).at(-1)).toBe(replacementUrl);
      await page.goBack();
      await page.goBack();
      await card.waitFor();
      expect(await open()).toBe(true);
      await waitForChatScrollIdle(page);
      await gestures(1, 500);
      const touch = (type: string, contacts: TouchContact[], changed: TouchContact[]) =>
        thread.evaluate(
          (element, input) => {
            const contact = ([identifier, clientY]: TouchContact) =>
              new Touch({ identifier, clientY, target: element });
            element.dispatchEvent(
              new TouchEvent(input.type, {
                bubbles: true,
                touches: input.contacts.map(contact),
                changedTouches: input.changed.map(contact),
              }),
            );
          },
          { type, contacts, changed },
        );
      await touch("touchstart", [[1, 0]], [[1, 0]]);
      await touch("touchmove", [[1, 30]], [[1, 30]]);
      await touch(
        "touchstart",
        [
          [1, 30],
          [2, 300],
        ],
        [[2, 300]],
      );
      await touch(
        "touchmove",
        [
          [1, 160],
          [2, 250],
        ],
        [
          [1, 160],
          [2, 250],
        ],
      );
      await touch("touchend", [[1, 160]], [[2, 250]]);
      await touch("touchmove", [[1, 320]], [[1, 320]]);
      await page.waitForTimeout(300);
      expect(await open()).toBe(true);
      await touch("touchend", [], [[1, 320]]);
      expect(await open()).toBe(true);
      await touch("touchstart", [[1, 0]], [[1, 0]]);
      await touch("touchmove", [[1, 160]], [[1, 160]]);
      await page.waitForTimeout(300);
      expect(await open()).toBe(true);
      await touch("touchend", [], [[1, 160]]);
      await expect.poll(open).toBe(false);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
