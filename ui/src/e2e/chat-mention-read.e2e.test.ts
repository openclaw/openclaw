import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect as expectBrowser } from "playwright/test";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiSessionUrl,
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { seedChatSettings, splitColumns } from "./chat-layout-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Seen mentions leave the Inbox",
  startServerBeforeBrowser: true,
});
const sessionKey = "agent:main:release-review";
const messages = [
  { id: "earlier", role: "user", content: "@Bob please review the release notes." },
  ...Array.from({ length: 25 }, (_, index) => ({
    id: `context-${index}`,
    role: index % 2 ? "user" : "assistant",
    content: `Release checklist item ${index + 1}. ${"The release checks are complete. ".repeat(8)}`,
  })),
  { id: "visible", role: "user", content: "@Bob the release checklist is ready for your review." },
];

suite.define(() => {
  it("clears the visible source message, not an off-screen mention in the same session", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 820 }, reducedMotion: "reduce", colorScheme: "dark" },
      async ({ page }) => {
        const items = ["earlier", "visible"].map((messageId) => ({
          id: `mention-${messageId}`,
          senderProfileId: "alice",
          senderLabel: "Alice",
          sessionKey,
          agentId: "main",
          sessionTitle: "Release review",
          messageId,
          createdAt: 1_000,
          expiresAt: 10_000,
          excerpt: messageId === "earlier" ? messages[0]!.content : messages.at(-1)!.content,
        }));
        const gateway = await installMockGateway(page, {
          sessionKey,
          sessions: [{ key: sessionKey, sessionId: "release-review", label: "Release review" }],
          historyMessages: messages,
          presenceUsers: [
            { self: true, id: "bob", name: "Bob", identity: { type: "profile", id: "bob" } },
          ],
          featureMethods: [...defaultControlUiFeatureMethods, "mentions.list", "mentions.dismiss"],
          methodResponses: {
            "mentions.list": { gatewayInstanceId: "e2e-gateway-boot", revision: 1, items },
            "mentions.dismiss": {
              gatewayInstanceId: "e2e-gateway-boot",
              revision: 2,
              items: [items[0]],
            },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const visible = page.locator('[data-entry-id="visible"]');
        await expectBrowser(visible).toBeInViewport();
        await gateway.waitForRequest("mentions.list");
        await page.locator(".sidebar-issues-button:visible").click();
        await page.getByRole("tab", { name: /Mentions/ }).click();
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const frame = await takeControlUiScreenshotFrame(
            page,
            page.locator("#sidebar-issues-panel"),
            [visible, page.locator('[data-mention-id="mention-earlier"]')],
            { animations: "disabled" },
          );
          await writeFile(path.join(suite.artifactDir, "seen-mention.png"), frame.png);
        }
        await expect
          .poll(async () => (await gateway.getRequests("mentions.dismiss")).map((r) => r.params))
          .toEqual([{ ids: ["mention-visible"] }]);
        await expectBrowser(page.locator('[data-mention-id="mention-visible"]')).toHaveCount(0);
        await expectBrowser(page.locator('[data-mention-id="mention-earlier"]')).toBeVisible();
        await page.keyboard.press("Escape");
        await gateway.setMethodResponse("mentions.dismiss", {
          gatewayInstanceId: "e2e-gateway-boot",
          revision: 3,
          items: [],
        });
        // Actual scrolling, rather than merely opening the session, sees the older message.
        const thread = page.locator(".chat-thread");
        await thread.focus();
        await page.keyboard.press("Control+Home");
        await expectBrowser(page.locator('[data-entry-id="earlier"]')).toBeInViewport();
        await expect
          .poll(async () => (await gateway.getRequests("mentions.dismiss")).map((r) => r.params))
          .toEqual([{ ids: ["mention-visible"] }, { ids: ["mention-earlier"] }]);
      },
    );
  });

  it("keeps mentions in hidden mobile panes and background tabs until their source is visible", async () => {
    await suite.withPage(
      { viewport: { width: 390, height: 844 }, reducedMotion: "reduce" },
      async ({ page }) => {
        const otherKey = "agent:main:planning";
        const rows = [
          { key: sessionKey, label: "Release review" },
          { key: otherKey, label: "Planning" },
        ];
        await seedChatSettings(page, suite.server.baseUrl, {
          chatSplitLayout: splitColumns(rows, 1),
        });
        const item = {
          id: "mention-hidden-pane",
          senderProfileId: "alice",
          senderLabel: "Alice",
          sessionKey,
          agentId: "main",
          sessionTitle: "Release review",
          messageId: "same-id",
          createdAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        };
        const gateway = await installMockGateway(page, {
          sessionKey: otherKey,
          sessions: rows,
          // Same entry id in another session must not acknowledge the mention.
          historyMessages: [{ id: "same-id", role: "user", content: "@Bob please review this." }],
          presenceUsers: [
            { self: true, id: "bob", name: "Bob", identity: { type: "profile", id: "bob" } },
          ],
          featureMethods: [...defaultControlUiFeatureMethods, "mentions.list", "mentions.dismiss"],
          methodResponses: {
            "mentions.list": { gatewayInstanceId: "e2e-gateway-boot", revision: 1, items: [item] },
            "mentions.dismiss": { gatewayInstanceId: "e2e-gateway-boot", revision: 2, items: [] },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, otherKey));
        await expectBrowser(page.locator('[data-entry-id="same-id"]:visible')).toBeInViewport();
        await gateway.waitForRequest("mentions.list");
        await page.getByRole("button", { name: "Expand sidebar" }).click();
        await page.locator(".sidebar-issues-button:visible").click();
        await page.getByRole("tab", { name: /Mentions/ }).click();
        await expectBrowser(page.locator('[data-mention-id="mention-hidden-pane"]')).toBeVisible();
        expect(await gateway.getRequests("mentions.dismiss")).toEqual([]);
        await page.keyboard.press("Escape");
        await page.keyboard.press("Escape");
        // Both desktop split panes count as presented, even when only one has keyboard focus.
        await page.setViewportSize({ width: 1440, height: 900 });
        await expect
          .poll(async () => (await gateway.getRequests("mentions.dismiss")).map((r) => r.params))
          .toEqual([{ ids: [item.id] }]);

        // Drive the platform visibility boundary while delivering a new Inbox snapshot.
        await page.evaluate(() => {
          Object.defineProperty(document, "visibilityState", {
            configurable: true,
            value: "hidden",
          });
          document.dispatchEvent(new Event("visibilitychange"));
        });
        await gateway.setMethodResponse("mentions.list", {
          gatewayInstanceId: "e2e-gateway-boot",
          revision: 3,
          items: [{ ...item, id: "mention-background", sessionKey: otherKey }],
        });
        const reads = await gateway.getRequests("mentions.list");
        await gateway.emitGatewayEvent("mentions.changed", {
          gatewayInstanceId: "e2e-gateway-boot",
          revision: 3,
        });
        await gateway.waitForRequest("mentions.list", { after: reads.length });
        await page.locator(".sidebar-issues-button:visible").click();
        await expectBrowser(page.locator('[data-mention-id="mention-background"]')).toBeVisible();
        expect(await gateway.getRequests("mentions.dismiss")).toHaveLength(1);
        await gateway.setMethodResponse("mentions.dismiss", {
          gatewayInstanceId: "e2e-gateway-boot",
          revision: 4,
          items: [],
        });
        await page.evaluate(() => {
          Reflect.deleteProperty(document, "visibilityState");
          document.dispatchEvent(new Event("visibilitychange"));
        });
        await expect
          .poll(async () => (await gateway.getRequests("mentions.dismiss")).map((r) => r.params))
          .toEqual([{ ids: [item.id] }, { ids: ["mention-background"] }]);
      },
    );
  });
});
