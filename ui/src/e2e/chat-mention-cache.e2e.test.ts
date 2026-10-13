import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e.ts";
import {
  createChatFlowE2eSuite,
  expectRequestCountStable,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const people = [
  { profileId: "harper", displayName: "Harper", online: true },
  { profileId: "henry", displayName: "Henry", online: false },
];

suite.define(() => {
  it.each([
    { width: 1200, height: 820 },
    { width: 390, height: 844 },
  ])(
    "reopens cached mentions and keeps them selectable during refresh at $width px",
    async (viewport) => {
      await suite.withPage({ viewport, colorScheme: "light" }, async ({ page }) => {
        const artifacts = createControlUiE2eArtifactDir("mention-cache-" + viewport.width);
        const now = Date.now();
        await page.clock.setFixedTime(now);
        const gateway = await installMockGateway(page, {
          featureMethods: [...defaultControlUiFeatureMethods, "users.mentionable"],
          presenceUsers: [
            {
              self: true,
              id: "sender",
              identity: { type: "profile", id: "sender" },
              name: "Sender",
            },
          ],
          methodResponses: { "users.mentionable": { users: people, truncated: false } },
        });
        await page.goto(suite.server.baseUrl + "chat", { waitUntil: "domcontentloaded" });
        const input = page.locator(".agent-chat__composer-combobox textarea");
        const menu = page.getByRole("listbox", { name: "Mention a person" });
        await input.fill("@h");
        await expect.poll(() => menu.getByRole("option").count()).toBe(2);
        await input.press("Escape");
        await gateway.deferNext("users.mentionable");
        await input.fill("Review @h");
        await menu.waitFor();
        // Capture before asserting so the same flow retains the original loading regression.
        await page.screenshot({ path: path.join(artifacts, "reopened.png") });
        expect(await menu.getByRole("option").count()).toBe(2);
        expect(await menu.locator(".mention-menu__loading").count()).toBe(0);
        await expectRequestCountStable(gateway, "users.mentionable", 1);
        await input.press("Escape");
        await page.clock.setFixedTime(now + 5 * 60_000);
        await input.fill("Again @h");
        await expect
          .poll(async () => (await gateway.getRequests("users.mentionable")).length)
          .toBe(2);
        expect(await menu.getByRole("option").count()).toBe(2);
        expect(await menu.locator(".mention-menu__loading").count()).toBe(0);
        await input.press("ArrowDown");
        await page.screenshot({ path: path.join(artifacts, "refreshing.png") });
        await gateway.resolveDeferred("users.mentionable", {
          users: [people[1], { profileId: "hazel", displayName: "Hazel", online: true }],
          truncated: false,
        });
        await expect.poll(() => menu.textContent()).toContain("Hazel");
        await page.screenshot({ path: path.join(artifacts, "refreshed.png") });
        await input.press("Enter");
        expect(await input.inputValue()).toBe("Again @Henry ");
      });
    },
  );
});
