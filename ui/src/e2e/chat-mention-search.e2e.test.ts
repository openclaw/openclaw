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
  for (const route of ["chat", "new"] as const) {
    const selector =
      route === "chat" ? ".agent-chat__composer-combobox textarea" : ".new-session-page__message";

    it(
      route + " dismisses a lone mention followed by prose and ignores its late result",
      async () => {
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
              deferredMethods: ["users.mentionable"],
            });
            await page.goto(`${suite.server.baseUrl}${route}`, { waitUntil: "domcontentloaded" });
            const input = page.locator(selector);
            const menu = page.getByRole("listbox", { name: "Mention a person" });
            await input.waitFor();
            await page.clock.install();
            await input.pressSequentially("@");
            await page.clock.fastForward(150);
            expect(await gateway.waitForRequest("users.mentionable")).toMatchObject({
              params: { query: "" },
            });
            await menu.waitFor();

            await input.press("Space");
            await menu.waitFor({ state: "detached" });
            await input.pressSequentially("please review the project plan");
            await gateway.resolveDeferred("users.mentionable", { users: people, truncated: false });
            await page.clock.fastForward(500);
            expect(await gateway.getRequests("users.mentionable")).toHaveLength(1);
            expect(await menu.count()).toBe(0);
            expect(await input.inputValue()).toBe("@ please review the project plan");
            await input.press("Shift+Enter");
            expect(await input.inputValue()).toBe("@ please review the project plan\n");
            expect(await page.locator(".composer-context-strip__person-name").count()).toBe(0);
          },
        );
      },
    );

    it(route + " stops an inserted mention when the caret moves into existing prose", async () => {
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
          await page.goto(`${suite.server.baseUrl}${route}`, { waitUntil: "domcontentloaded" });
          const input = page.locator(selector);
          const menu = page.getByRole("listbox", { name: "Mention a person" });
          await input.waitFor();
          await page.clock.install();
          const prefix = "Please review ";
          const suffix =
            "the project plan and leave the rest of this prompt unchanged while checking every detail";
          await input.fill(prefix + suffix);
          await input.press("Control+Home");
          for (const key of Array.from(prefix, () => "ArrowRight")) {
            await input.press(key);
          }
          await input.press("@");
          await page.clock.fastForward(150);
          await menu.getByRole("option").nth(1).waitFor();
          expect(await gateway.waitForRequest("users.mentionable")).toMatchObject({
            params: { query: "" },
          });

          await input.press("Control+End");
          await menu.waitFor({ state: "detached" });
          await input.pressSequentially(" with next steps");
          await page.clock.fastForward(500);
          expect(await gateway.getRequests("users.mentionable")).toHaveLength(1);
          expect(await menu.count()).toBe(0);
          expect(await input.inputValue()).toBe(prefix + "@" + suffix + " with next steps");
          expect(await page.locator(".composer-context-strip__person-name").count()).toBe(0);
        },
      );
    });
  }

  it("searches refined queries on the server and reuses exact results on backspace", async () => {
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
        await gateway.setMethodResponse("users.mentionable", {
          users: people.slice(0, 1),
          truncated: false,
        });
        await input.press("a");
        await expect.poll(() => menu.getByRole("option").count()).toBe(1);
        expect(await menu.textContent()).toContain("Harper");
        expect(await menu.textContent()).not.toContain("Henry");
        await input.press("Backspace");
        await expect.poll(() => menu.getByRole("option").count()).toBe(2);
        await expectRequestCountStable(gateway, "users.mentionable", 2);
        await input.press("ArrowDown");
        await input.press("Enter");
        expect(await input.inputValue()).toBe("@Henry ");
      },
    );
  });

  it("reserves three person rows while loading and respects reduced motion", async () => {
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
        expect(await skeleton.count()).toBe(3);
        expect(await menu.getByRole("option").count()).toBe(0);
        expect(
          await skeleton
            .locator(".skeleton")
            .first()
            .evaluate((element) => getComputedStyle(element, "::after").animationName),
        ).toBe("none");
        const loading = await menu.boundingBox();
        await gateway.resolveDeferred("users.mentionable", {
          users: [...people, { profileId: "hazel", displayName: "Hazel", online: false }],
          truncated: false,
        });
        await expect.poll(() => menu.getByRole("option").count()).toBe(3);
        const ready = await menu.boundingBox();
        expect(loading).not.toBeNull();
        expect(ready).not.toBeNull();
        expect(ready!.height).toBeCloseTo(loading!.height, 1);
        expect(ready!.y).toBeCloseTo(loading!.y, 1);
      },
    );
  });
});
