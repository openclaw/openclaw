import { expect, it } from "vitest";
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
  it("keeps complete mention results while refining and backspacing without another request", async () => {
    await suite.withPage(
      { viewport: { width: 1440, height: 900 }, colorScheme: "dark" },
      async ({ page }) => {
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
        await page.goto(`${suite.server.baseUrl}chat`, { waitUntil: "domcontentloaded" });
        const input = page.locator(".agent-chat__composer-combobox textarea");
        await input.fill("@h");
        const menu = page.getByRole("listbox", { name: "Mention a person" });
        await expect.poll(() => menu.getByRole("option").count()).toBe(2);
        await input.press("a");
        await expect.poll(() => menu.getByRole("option").count()).toBe(1);
        expect(await menu.textContent()).toContain("Harper");
        expect(await menu.textContent()).not.toContain("Henry");
        await input.press("Backspace");
        await expect.poll(() => menu.getByRole("option").count()).toBe(2);
        await expectRequestCountStable(gateway, "users.mentionable", 1);
        await input.press("ArrowDown");
        await input.press("Enter");
        expect(await input.inputValue()).toBe("@Henry ");
      },
    );
  });

  it("reserves one person row while loading and respects reduced motion", async () => {
    await suite.withPage(
      { viewport: { width: 1440, height: 900 }, colorScheme: "dark", reducedMotion: "reduce" },
      async ({ page }) => {
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
          deferredMethods: ["users.mentionable"],
        });
        await page.goto(`${suite.server.baseUrl}chat`, { waitUntil: "domcontentloaded" });
        await page.locator(".agent-chat__composer-combobox textarea").fill("@ha");
        await gateway.waitForRequest("users.mentionable");
        const menu = page.getByRole("listbox", { name: "Mention a person" });
        expect(await menu.textContent()).toContain("Mention a person");
        expect(await menu.textContent()).not.toContain("Loading people");
        const skeleton = menu.locator(".mention-menu__loading");
        expect(await skeleton.count()).toBe(1);
        expect(await menu.getByRole("option").count()).toBe(0);
        expect(
          await skeleton
            .locator(".skeleton")
            .first()
            .evaluate((element) => getComputedStyle(element, "::after").animationName),
        ).toBe("none");
        const loading = await menu.boundingBox();
        await gateway.resolveDeferred("users.mentionable", {
          users: people.slice(0, 1),
          truncated: false,
        });
        await menu.getByRole("option").waitFor();
        const ready = await menu.boundingBox();
        expect(loading).not.toBeNull();
        expect(ready).not.toBeNull();
        expect(ready!.height).toBeCloseTo(loading!.height, 1);
        expect(ready!.y).toBeCloseTo(loading!.y, 1);
      },
    );
  });
});
