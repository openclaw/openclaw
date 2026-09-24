import type { Page } from "playwright";
import { expect, it } from "vitest";
import { CHAT_RUN_ACTIVITY_CHANGED_EVENT } from "../pages/chat/chat-history-events.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { requireRecord, requireString } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI favicon status",
});

async function expectStatusColor(page: Page, token: string) {
  await expect
    .poll(() =>
      page.evaluate((colorToken) => {
        const icon = document.querySelector<HTMLLinkElement>(
          'link[rel="icon"][type="image/svg+xml"]',
        );
        if (!icon?.href.startsWith("data:image/svg+xml,")) {
          return false;
        }
        const svg = new DOMParser().parseFromString(
          decodeURIComponent(icon.href.slice(icon.href.indexOf(",") + 1)),
          "image/svg+xml",
        );
        const color = getComputedStyle(document.documentElement)
          .getPropertyValue(colorToken)
          .trim();
        return (
          Boolean(color) && svg.documentElement.lastElementChild?.getAttribute("fill") === color
        );
      }, token),
    )
    .toBe(true);
}

async function faviconLinks(page: Page) {
  return page.locator('link[rel="icon"]').evaluateAll((icons) =>
    icons.map((icon) => ({
      href: icon.getAttribute("href"),
      type: icon.getAttribute("type"),
    })),
  );
}

async function setVisibility(page: Page, state: DocumentVisibilityState) {
  await page.evaluate((value) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
}

suite.define(() => {
  it("updates the tab icon from live chat and approval events, then clears unseen completion on focus", async () => {
    await suite.withPage(
      { viewport: { width: 1200, height: 800 }, colorScheme: "light" },
      async ({ page }) => {
        const sessionKey = "agent:main:main";
        const gateway = await installMockGateway(page, {
          sessionKey,
          models: [{ id: "demo-model", name: "Demo model", provider: "mock" }],
          historyMessages: [
            { role: "assistant", content: [{ type: "text", text: "Ready for your next task." }] },
          ],
        });
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
        await composer.fill("Prepare the draft report.");
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        const send = await gateway.waitForRequest("chat.send");
        const runId = requireString(requireRecord(send.params).idempotencyKey, "chat run id");
        await gateway.emitGatewayEvent("chat", {
          state: "delta",
          runId,
          sessionKey,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Preparing the draft report." }],
          },
        });
        await expectStatusColor(page, "--info");
        await page.screenshot({ path: `${suite.artifactDir}/working.png` });
        const activity = await page.evaluateHandle((eventName) => {
          const observation = { changes: 0 };
          document.addEventListener(eventName, () => observation.changes++);
          return observation;
        }, CHAT_RUN_ACTIVITY_CHANGED_EVENT);
        await gateway.emitGatewayEvent("chat", {
          state: "delta",
          runId,
          sessionKey,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Preparing the draft report. Checking the details." }],
          },
        });
        await page
          .getByText("Preparing the draft report. Checking the details.", { exact: true })
          .waitFor();
        expect(await activity.evaluate((observation) => observation.changes)).toBe(0);
        await page.evaluate(() => {
          document.documentElement.style.setProperty("--info", "rgb(10, 100, 200)");
        });
        await expectStatusColor(page, "--info");
        await gateway.emitGatewayEvent("exec.approval.requested", {
          id: "favicon-approval",
          createdAtMs: Date.now(),
          expiresAtMs: Date.now() + 60_000,
          request: { command: "echo draft", agentId: "main", sessionKey },
        });
        await expectStatusColor(page, "--session-color-orange");
        await gateway.emitGatewayEvent("exec.approval.resolved", {
          id: "favicon-approval",
          decision: "deny",
        });
        await expectStatusColor(page, "--info");
        await setVisibility(page, "hidden");
        await gateway.emitChatFinal({ runId, sessionKey, text: "Draft report complete." });
        await expectStatusColor(page, "--ok");
        await setVisibility(page, "visible");
        await expect.poll(() => faviconLinks(page)).toEqual(original);
        expect(await page.locator('link[rel="icon"][data-openclaw-original-favicon]').count()).toBe(
          0,
        );
        await gateway.setOnline(false);
        await expectStatusColor(page, "--muted");
      },
    );
  });
});
