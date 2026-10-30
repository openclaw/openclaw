import type { Page, Locator } from "playwright";
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

function withMentions(
  options: { route?: "chat" | "new"; deferred?: boolean; reducedMotion?: "reduce" },
  run: (fixture: {
    page: Page;
    input: Locator;
    menu: Locator;
    gateway: Awaited<ReturnType<typeof installMockGateway>>;
  }) => Promise<void>,
) {
  const { route = "chat", deferred = false, reducedMotion } = options;
  return suite.withPage(
    { viewport: { width: 1440, height: 900 }, colorScheme: "dark", reducedMotion },
    async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: [...defaultControlUiFeatureMethods, "users.mentionable"],
        presenceUsers: [
          { self: true, id: "sender", identity: { type: "profile", id: "sender" }, name: "Sender" },
        ],
        ...(deferred
          ? { deferredMethods: ["users.mentionable"] }
          : { methodResponses: { "users.mentionable": { users: people, truncated: false } } }),
      });
      await page.goto(`${suite.server.baseUrl}${route}`, { waitUntil: "domcontentloaded" });
      const input = page.locator(
        route === "chat" ? ".agent-chat__composer-combobox textarea" : ".new-session-page__message",
      );
      const menu = page.getByRole("listbox", { name: "Mention a person" });
      await run({ page, input, menu, gateway });
    },
  );
}

suite.define(() => {
  for (const route of ["chat", "new"] as const) {
    it.each(["prose", "caret"] as const)(
      route + " dismisses a mention on %s and ignores stale results",
      async (mode) => {
        const deferred = mode === "prose";
        await withMentions({ route, deferred }, async ({ page, input, menu, gateway }) => {
          await input.waitFor();
          await page.clock.install();
          const prefix = "Please review ";
          const suffix = "the project plan";
          if (!deferred) {
            await input.fill(prefix + suffix);
            await input.press(process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home");
            for (const key of Array.from(prefix, () => "ArrowRight")) {
              await input.press(key);
            }
          }
          await input.pressSequentially("@");
          await page.clock.fastForward(150);
          await (deferred ? menu : menu.getByRole("option").nth(1)).waitFor();
          expect(await gateway.waitForRequest("users.mentionable")).toMatchObject({
            params: { query: "" },
          });
          await input.press(
            deferred ? "Space" : process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End",
          );
          await menu.waitFor({ state: "detached" });
          await input.pressSequentially(deferred ? "please review" : " with next steps");
          if (deferred) {
            await gateway.resolveDeferred("users.mentionable", { users: people, truncated: false });
          }
          await page.clock.fastForward(500);
          expect(await gateway.getRequests("users.mentionable")).toHaveLength(1);
          expect(await menu.count()).toBe(0);
          const expected = deferred
            ? "@ please review"
            : prefix + "@" + suffix + " with next steps";
          expect(await input.inputValue()).toBe(expected);
          if (deferred) {
            await input.press("Shift+Enter");
            expect(await input.inputValue()).toBe(expected + "\n");
          }
          expect(await page.locator(".composer-context-strip__person-name").count()).toBe(0);
        });
      },
    );
  }

  it("searches refined queries on the server and reuses exact results on backspace", async () => {
    await withMentions({}, async ({ input, menu, gateway }) => {
      await input.fill("@h");
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
    });
  });

  it("reserves three person rows while loading and respects reduced motion", async () => {
    await withMentions(
      { deferred: true, reducedMotion: "reduce" },
      async ({ input, menu, gateway }) => {
        await input.fill("@ha");
        await gateway.waitForRequest("users.mentionable");
        expect(await menu.textContent()).toContain("Mention a person");
        expect(await menu.textContent()).not.toContain("Loading people");
        expect(await menu.locator(".mention-menu__loading").count()).toBe(3);
        expect(await menu.getByRole("option").count()).toBe(0);
        expect(
          await menu.evaluate((element) => {
            const currentSkeleton = element.querySelector(".mention-menu__loading .skeleton");
            return currentSkeleton
              ? getComputedStyle(currentSkeleton, "::after").animationName
              : null;
          }),
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
