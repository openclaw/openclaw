import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI boot composer" });
const sessionKey = "agent:main:boot-composer";
const viewport = { width: 1280, height: 800 };
const landscapeViewport = { width: 932, height: 430 };
const phoneOptions = {
  isMobile: true,
  hasTouch: true,
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
};

function bootGateway(page: Parameters<typeof installMockGateway>[0], heldMethods: string[]) {
  return installMockGateway(page, {
    sessionKey,
    sessions: [{ key: sessionKey, kind: "direct", sessionId: "boot-composer-session" }],
    historyMessages: [{ role: "assistant", content: "Earlier reply", timestamp: 1 }],
    heldMethods,
    awaitInitialRoster: false,
  });
}

suite.define(() => {
  it("accepts typing before the Gateway and route are ready, then sends Enter once", async () => {
    await suite.withPage({ viewport }, async ({ page }) => {
      const gateway = await bootGateway(page, ["connect", "sessions.resolve"]);
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey), {
        waitUntil: "domcontentloaded",
      });
      const boot = page.locator(".connect-splash #openclaw-boot-composer");
      await boot.waitFor({ state: "visible" });
      // Like the chat composer, it takes focus only from the operator; nothing covers it.
      expect(await boot.evaluate((el) => el === document.activeElement)).toBe(false);
      await boot.click();
      await expect
        .poll(() =>
          page.evaluate(() => {
            const status = document
              .querySelector(".connect-splash__status")
              ?.getBoundingClientRect();
            const frame = document
              .querySelector(".loading-skeleton__composer")
              ?.getBoundingClientRect();
            return Boolean(
              status &&
              frame &&
              status.height > 0 &&
              frame.height > 0 &&
              status.bottom <= frame.top,
            );
          }),
        )
        .toBe(true);
      await page.keyboard.type("Ship the boot ");

      // The Gateway admits the browser; the same element moves into the shell's route frame.
      await gateway.waitForRequest("connect");
      await gateway.resolveDeferred("connect");
      const routeFrame = page.locator(".lazy-view-state--route #openclaw-boot-composer");
      await routeFrame.waitFor({ state: "visible" });
      await page.keyboard.type("composer");
      await page.keyboard.press("Enter");
      expect(await routeFrame.inputValue()).toBe("Ship the boot composer");
      expect(await routeFrame.getAttribute("data-submit-queued")).toBe("");
      // Session resolution (and its access check) is still pending: nothing is sent.
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);

      await gateway.waitForRequest("sessions.resolve");
      await gateway.resolveDeferred("sessions.resolve");
      const send = await gateway.waitForRequest("chat.send");
      expect(send.params).toMatchObject({ sessionKey, message: "Ship the boot composer" });
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await expect.poll(() => composer.inputValue()).toBe("");
      expect(await page.locator("#openclaw-boot-composer").count()).toBe(0);
      expect(await composer.evaluate((el) => el === document.activeElement)).toBe(true);
      expect(await gateway.getRequests("chat.send")).toHaveLength(1);
    });
  });

  it.each([
    { name: "desktop", options: { viewport, isMobile: false } },
    { name: "phone", options: { ...phoneOptions, viewport: { width: 390, height: 844 } } },
    { name: "phone landscape", options: { ...phoneOptions, viewport: landscapeViewport } },
    { name: "small phone", options: { ...phoneOptions, viewport: { width: 568, height: 320 } } },
  ])(
    "keeps an unsent draft, its focus and its frame still when the session opens ($name)",
    async ({ options }) => {
      await suite.withPage(options, async ({ page }) => {
        const gateway = await bootGateway(page, ["connect"]);
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey), {
          waitUntil: "domcontentloaded",
        });
        // Start this handoff check after the static frame moves, so a touch gesture
        // cannot land on its retired layout before keyboard input begins.
        await page.locator("#openclaw-boot-shell").waitFor({ state: "detached" });
        const boot = page.locator("#openclaw-boot-composer");
        await boot.waitFor({ state: "visible" });
        // Like the chat composer, it takes focus only from the operator.
        expect(await boot.evaluate((el) => el === document.activeElement)).toBe(false);
        if (options.isMobile) {
          await boot.tap();
        } else {
          await boot.click();
        }
        await expect.poll(() => boot.evaluate((el) => el === document.activeElement)).toBe(true);
        const text =
          options.isMobile && options.viewport.width > options.viewport.height
            ? "First line\nSecond line\nThird line\nFourth line"
            : "Draft, not yet sent, long enough to wrap onto another line of the composer";
        await page.keyboard.type(text);
        await page.keyboard.press(options.isMobile ? "Enter" : "Shift+Enter");
        await page.keyboard.type("second line");
        for (let index = 0; index < "line".length; index += 1) {
          await page.keyboard.press("ArrowLeft");
        }
        const geometry = (selector: string) =>
          page.locator(selector).evaluate((element) => {
            const box = element.getBoundingClientRect();
            const editor = element.querySelector("textarea")!;
            const style = getComputedStyle(editor);
            const origin = editor.getBoundingClientRect();
            return [
              box.x,
              box.y,
              box.width,
              box.height,
              origin.x + Number.parseFloat(style.paddingLeft) - editor.scrollLeft,
              origin.y + Number.parseFloat(style.paddingTop) - editor.scrollTop,
              editor.scrollTop,
            ].map(Math.round);
          });
        const before = await geometry(".loading-skeleton__composer:has(#openclaw-boot-composer)");
        // Every frame keeps one stationary composer, its visible draft and scroll position.
        await page.evaluate(() => {
          const frames: string[] = [];
          Reflect.set(window, "__bootComposerFrames", frames);
          const sample = () => {
            const editors = document.querySelectorAll(
              "#openclaw-boot-composer, .agent-chat__composer-combobox textarea",
            );
            const editor = editors[0] as HTMLTextAreaElement | undefined;
            const host = editor?.closest(".loading-skeleton__composer, .agent-chat__input");
            const box = host?.getBoundingClientRect();
            frames.push(
              editors.length === 1 && box
                ? JSON.stringify([
                    ...[box.x, box.y, box.width, box.height, editor!.scrollTop].map(Math.round),
                    editor!.value.length,
                  ])
                : `editors:${editors.length}`,
            );
            if (frames.length < 90) {
              requestAnimationFrame(sample);
            }
          };
          requestAnimationFrame(sample);
        });
        await gateway.waitForRequest("connect");
        await gateway.resolveDeferred("connect");
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        const draft = `${text}\nsecond line`;
        await expect.poll(() => composer.inputValue()).toBe(draft);
        expect(await geometry(".agent-chat__input")).toEqual(before);
        await page.waitForFunction(
          () => (Reflect.get(window, "__bootComposerFrames") as string[]).length >= 90,
        );
        const frames = new Set(
          (await page.evaluate(() => Reflect.get(window, "__bootComposerFrames"))) as string[],
        );
        expect([...frames]).toEqual([
          JSON.stringify([...before.slice(0, 4), before[6], draft.length]),
        ]);
        expect(await composer.evaluate((el) => el === document.activeElement)).toBe(true);
        await page.keyboard.type("!");
        expect(await composer.inputValue()).toBe(`${text}\nsecond !line`);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      });
    },
  );

  it("never sends early input to a session the route cannot open", async () => {
    await suite.withPage({ viewport }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        mainSessionKey: "agent:main:main",
        heldMethods: ["connect"],
        awaitInitialRoster: false,
      });
      await page.goto(`${suite.server.baseUrl}chat/main/deadbeef`, {
        waitUntil: "domcontentloaded",
      });
      await page.locator("#openclaw-boot-composer").click();
      const original = await page.locator("#openclaw-boot-composer").elementHandle();
      await page.keyboard.type("Send this only if the session opens");
      await page.keyboard.press("Enter");
      await gateway.waitForRequest("connect");
      await gateway.resolveDeferred("connect");
      const missing = page.locator(".session-route-not-found");
      await missing.waitFor({ state: "visible" });
      const retained = page.locator("#openclaw-boot-composer");
      await retained.waitFor({ state: "visible" });
      expect(
        await retained.evaluate((element) => {
          const frame = element.closest(".lazy-view-state--route")!.getBoundingClientRect();
          const outlet = element.closest("openclaw-router-outlet")!.getBoundingClientRect();
          return Math.abs(frame.width - outlet.width) < 1;
        }),
      ).toBe(true);
      expect(await original?.evaluate((element) => element.isConnected)).toBe(true);
      expect(await retained.inputValue()).toBe("Send this only if the session opens");
      // A resolved route must not leave a loading animation intercepting the editor.
      expect(
        await retained.evaluate(async (element) => {
          let intercepted = 0;
          for (let frame = 0; frame < 120; frame += 1) {
            await new Promise(requestAnimationFrame);
            const box = element.getBoundingClientRect();
            if (
              document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) !== element
            ) {
              intercepted += 1;
            }
          }
          return intercepted;
        }),
      ).toBe(0);
      await retained.fill("");
      expect(await retained.inputValue()).toBe("");
      await retained.fill("Still only for the original session");
      await missing.getByRole("button", { name: "Go to main session" }).click();
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.waitFor({ state: "visible" });
      expect(await composer.inputValue()).toBe("");
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    });
  });
});
