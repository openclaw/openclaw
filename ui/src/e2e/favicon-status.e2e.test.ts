import type { Page } from "playwright";
import { expect, it } from "vitest";
import { CHAT_RUN_ACTIVITY_CHANGED_EVENT } from "../pages/chat/chat-history-events.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { requireRecord, requireString } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI favicon status" });
const iconSelector = 'link[rel="icon"]';

function iconMatchesColor(icon: HTMLLinkElement, token: string) {
  const { href } = icon;
  if (!href.startsWith("data:image/svg+xml,")) {
    return false;
  }
  const svg = new DOMParser().parseFromString(
    decodeURIComponent(href.slice(href.indexOf(",") + 1)),
    "image/svg+xml",
  );
  const color = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  return Boolean(color) && svg.documentElement.lastElementChild?.getAttribute("fill") === color;
}

function expectStatusColor(page: Page, token: string) {
  const icon = page.locator(`${iconSelector}[type="image/svg+xml"]`);
  return expect.poll(() => icon.evaluate(iconMatchesColor, token)).toBe(true);
}

const faviconLinks = (page: Page) =>
  page
    .locator(iconSelector)
    .evaluateAll((icons) =>
      icons.map((icon) => ({ href: icon.getAttribute("href"), type: icon.getAttribute("type") })),
    );

const setVisibility = (page: Page, state: DocumentVisibilityState) =>
  page.evaluate((value) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);

suite.define(() => {
  it("updates the tab icon from live chat and approval events, then clears unseen completion on focus", async () => {
    await suite.withPage({ colorScheme: "light" }, async ({ page }) => {
      const sessionKey = "agent:main:main";
      const gateway = await installMockGateway(page, { sessionKey });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.waitFor();
      await gateway.waitForRequest("exec.approval.list");
      await expect
        .poll(() => faviconLinks(page))
        .toEqual([
          { href: expect.stringMatching(/^\/favicon\.svg(?:\?v=.+)?$/), type: "image/svg+xml" },
          { href: expect.stringMatching(/^\/favicon-32\.png(?:\?v=.+)?$/), type: "image/png" },
        ]);
      const original = await faviconLinks(page);
      const expectOriginal = () => expect.poll(() => faviconLinks(page)).toEqual(original);
      await composer.fill("Draft report.");
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      const send = await gateway.waitForRequest("chat.send");
      const runId = requireString(requireRecord(send.params).idempotencyKey, "chat run id");
      const emitDelta = (text: string) =>
        gateway.emitGatewayEvent("chat", {
          state: "delta",
          runId,
          sessionKey,
          message: { role: "assistant", content: [{ type: "text", text }] },
        });
      await expectStatusColor(page, "--info");
      await page.evaluate(() => {
        document.documentElement.style.setProperty("--info", "rgb(10, 100, 200)");
      });
      await expectStatusColor(page, "--info");
      await emitDelta("Preparing.");
      await expectOriginal();
      const activity = await page.evaluateHandle((eventName) => {
        const observation = { changes: 0 };
        document.addEventListener(eventName, () => observation.changes++);
        return observation;
      }, CHAT_RUN_ACTIVITY_CHANGED_EVENT);
      await emitDelta("Preparing. Checking.");
      await page.getByText("Preparing. Checking.", { exact: true }).waitFor();
      expect(await activity.evaluate((observation) => observation.changes)).toBe(0);
      await expectOriginal();
      await gateway.emitGatewayEvent("exec.approval.requested", {
        id: "favicon",
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 60_000,
        request: { command: "echo draft", agentId: "main", sessionKey },
      });
      await expectStatusColor(page, "--session-color-orange");
      await gateway.emitGatewayEvent("exec.approval.resolved", { id: "favicon", decision: "deny" });
      await expectOriginal();
      await page.getByRole("button", { name: "Stop generating" }).waitFor();
      await setVisibility(page, "hidden");
      await gateway.emitChatFinal({ runId, sessionKey, text: "Draft report complete." });
      await expectStatusColor(page, "--ok");
      await setVisibility(page, "visible");
      await expectOriginal();
      expect(await page.locator(`${iconSelector}[data-openclaw-original-favicon]`).count()).toBe(0);
      await gateway.setOnline(false);
      await expectStatusColor(page, "--muted");
    });
  });
});
