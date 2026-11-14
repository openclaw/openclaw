import fs from "node:fs/promises";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Linked channel author" });
const sessionKey = "agent:main:linked-author";
const profile = { type: "profile" as const, id: "alex" };
// Presentation fixture only. gateway.linked-channel-display.e2e.test.ts owns
// real admission, attestation, persistence and generation of these display fields.
const historyMessages = [
  {
    role: "user",
    content: "Please review the launch checklist.",
    __openclaw: {
      id: "web-message",
      seq: 1,
      senderId: profile.id,
      senderName: "Alex",
      senderIdentity: profile,
      senderProfileAvatarUrl: "/api/users/alex/avatar?v=1",
    },
  },
  {
    role: "assistant",
    content: "The checklist is ready. I will keep the review in this conversation.",
    __openclaw: { id: "answer", seq: 2 },
  },
  {
    role: "user",
    content: "I am continuing from my linked Telegram account.",
    __openclaw: {
      id: "telegram-message",
      seq: 3,
      senderId: "telegram-alex",
      senderName: "Alex on Telegram",
      senderIdentity: {
        type: "observation",
        id: "telegram-alex",
        pluginId: "telegram",
        accountId: "default",
        senderKind: "human",
      },
      transport: { channel: "telegram" },
      senderDisplayProfileId: profile.id,
      senderDisplayName: "Alex",
      senderProfileAvatarUrl: "/api/users/alex/avatar?v=1",
    },
  },
];

suite.define(() => {
  it("shows the linked author as the viewer while retaining the Telegram source", async () => {
    await suite.withPage(
      {
        viewport: { width: 1280, height: 900 },
        locale: "en-US",
        colorScheme: "light",
        serviceWorkers: "block",
      },
      async ({ page }) => {
        const image = await page.request.get(
          new URL("apple-touch-icon.png", suite.server.baseUrl).href,
        );
        await page.route("**/api/users/alex/avatar*", (route) =>
          route.fulfill({ response: image }),
        );
        await installMockGateway(page, {
          sessionKey,
          agentModel: "demo-model",
          historyMessages,
          sessions: [
            {
              key: sessionKey,
              label: "Launch checklist",
              visibility: "shared",
              sharingRole: "owner",
            },
          ],
          presenceUsers: [{ id: profile.id, name: "Alex", identity: profile, self: true }],
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const telegram = page.locator('.chat-group.user:has([data-entry-id="telegram-message"])');
        const web = page.locator('.chat-group.user:has([data-entry-id="web-message"])');
        await telegram.waitFor();
        const frame = await takeControlUiScreenshotFrame(
          page,
          page.locator("body"),
          [web, telegram],
          { animations: "disabled" },
        );
        await fs.writeFile(`${suite.artifactDir}/linked-author.png`, frame.png);
        console.log(`Linked author screenshot: ${suite.artifactDir}/linked-author.png`);
        expect(await telegram.getAttribute("class")).not.toContain("chat-group--peer");
        const portrait = telegram.locator(".chat-avatar-slot img");
        expect(await portrait.getAttribute("src")).toBe(
          await web.locator(".chat-avatar-slot img").getAttribute("src"),
        );
        expect(
          await portrait.evaluate((element: HTMLImageElement) => element.naturalWidth),
        ).toBeGreaterThan(0);
        expect(await telegram.locator(".chat-message-source").textContent()).toContain("Telegram");
      },
    );
  });
});
