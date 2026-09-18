import { expect, it } from "vitest";
import {
  createChatFlowE2eSuite,
  installMockGateway,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it.each([
    { width: 1440, height: 900, theme: "claw" },
    { width: 390, height: 844, theme: "claw" },
    { width: 1440, height: 900, theme: "phosphor" },
  ])("returns the reader after cancelling an empty search at $width px ($theme)", async (size) => {
    await suite.withPage({ viewport: size }, async ({ page }) => {
      const messages = Array.from({ length: 80 }, (_, index) => ({
        __openclaw: { id: `search-message-${index}`, seq: index + 1 },
        role: index % 2 === 0 ? "user" : "assistant",
        content: `Conversation checkpoint ${index + 1}.\n${"Details for the reader.\n".repeat(3)}${index % 2 ? "\n\n### Review notes\n\nThe reader should keep this place when searching the conversation." : ""}`,
      }));
      const config = { ui: { prefs: { theme: size.theme, themeMode: "dark" } } };
      const gateway = await installMockGateway(page, {
        historyMessages: messages,
        methodResponses: {
          "config.get": {
            config,
            raw: JSON.stringify(config),
            valid: true,
            issues: [],
            hash: "search-theme",
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
        .toBe(size.theme === "claw" ? "dark" : size.theme);
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      const thread = page.locator(".chat-thread");
      await page.getByText(/^Conversation checkpoint 80/).waitFor();
      await waitForChatScrollIdle(page);
      await expect
        .poll(() =>
          thread.evaluate(
            (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
          ),
        )
        .toBeLessThanOrEqual(1);
      const search = page.getByRole("textbox", { name: "Search messages", exact: true });
      await thread.hover();
      await page.mouse.wheel(0, -900);
      await waitForChatScrollIdle(page);
      const readAnchor = () =>
        thread.evaluate((element) => {
          const viewport = element.getBoundingClientRect();
          const bubble = [
            ...element.querySelectorAll<HTMLElement>(".chat-bubble[data-message-id]"),
          ].find((candidate) => {
            const rect = candidate.getBoundingClientRect();
            return rect.top >= viewport.top && rect.bottom <= viewport.bottom;
          });
          if (!bubble) {
            throw new Error("Expected a visible reading anchor");
          }
          return {
            id: bubble.dataset.messageId!,
            top: bubble.getBoundingClientRect().top,
            relativeTop: bubble.getBoundingClientRect().top - viewport.top,
            scroll: element.scrollTop,
          };
        });

      const origin = await readAnchor();
      expect(origin.scroll).toBeGreaterThan(0);
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.fill("Keep this draft.");
      for (const close of ["shortcut", "escape", "button"] as const) {
        await page.keyboard.press("ControlOrMeta+f");
        await search.fill("zzzxq149361nohit");
        await expect.poll(() => thread.locator(".chat-bubble").count()).toBe(0);
        await expect.poll(() => thread.evaluate((element) => element.scrollTop)).toBe(0);
        if (close === "button") {
          await page.getByRole("button", { name: "Close search", exact: true }).click();
        } else {
          await page.keyboard.press(close === "escape" ? "Escape" : "ControlOrMeta+f");
        }
        await waitForChatScrollIdle(page);
        await expect
          .poll(() =>
            thread.evaluate((element, id) => {
              const bubble = [
                ...element.querySelectorAll<HTMLElement>(".chat-bubble[data-message-id]"),
              ].find((candidate) => candidate.dataset.messageId === id);
              return bubble?.getBoundingClientRect().top ?? null;
            }, origin.id),
          )
          .toBeCloseTo(origin.top, 0);
        await waitForChatScrollIdle(page);
      }
      await page.keyboard.press("ControlOrMeta+f");
      await search.fill("zzzxq149361nohit");
      await expect.poll(() => thread.locator(".chat-bubble").count()).toBe(0);
      const hiddenViewport = await thread.evaluate(async (element) => {
        const pane = element.closest("openclaw-chat-pane")!;
        pane.querySelector<HTMLButtonElement>(".agent-chat__search-bar button")!.click();
        await pane.updateComplete;
        const display = pane.style.display;
        pane.style.display = "none";
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });
        const hidden = {
          connected: element.isConnected,
          height: element.getBoundingClientRect().height,
        };
        pane.style.display = display;
        pane.requestUpdate();
        await pane.updateComplete;
        return hidden;
      });
      expect(hiddenViewport).toEqual({ connected: true, height: 0 });
      await waitForChatScrollIdle(page);
      await expect
        .poll(() =>
          thread.evaluate((element, id) => {
            const bubble = Array.from(
              element.querySelectorAll<HTMLElement>(".chat-bubble[data-message-id]"),
            ).find((node) => node.dataset.messageId === id);
            return bubble?.getBoundingClientRect().top ?? null;
          }, origin.id),
        )
        .toBeCloseTo(origin.top, 0);
      await composer.focus();
      await expect
        .poll(() => page.getByRole("button", { name: "Scroll to latest", exact: true }).isVisible())
        .toBe(true);
      await page.keyboard.press("ControlOrMeta+f");
      await search.fill("zzzxq149361nohit");
      await expect.poll(() => thread.locator(".chat-bubble").count()).toBe(0);
      const historyRequests = (await gateway.getRequests("chat.history")).length;
      await gateway.setMethodResponse("chat.history", {
        messages: [
          {
            role: "user",
            content: "Earlier recovered conversation.",
            __openclaw: { id: "before-search", seq: 0 },
          },
          ...messages,
          {
            role: "assistant",
            content: "A new conversation update.",
            __openclaw: { id: "after-search", seq: 81 },
          },
        ],
      });
      await gateway.emitGatewayEvent("sessions.changed", {
        phase: "message",
        session: { key: "agent:main:main", activeRunIds: [], hasActiveRun: false },
      });
      await gateway.waitForRequest("chat.history", { after: historyRequests });
      await expect
        .poll(() =>
          page.evaluate(() => {
            const cache = document.querySelector("openclaw-chat-pane")?.chatMessagesBySession;
            const accepted = JSON.stringify(
              Array.from(cache?.values() ?? [], ({ snapshot }) => snapshot.messages),
            );
            return ["before-search", "after-search"].every((id) =>
              accepted.includes(`"id":"${id}"`),
            );
          }),
        )
        .toBe(true);
      await waitForChatScrollIdle(page);
      await search.fill("");
      await expect
        .poll(() =>
          thread.evaluate((element, id) => {
            const bubble = [
              ...element.querySelectorAll<HTMLElement>(".chat-bubble[data-message-id]"),
            ].find((candidate) => candidate.dataset.messageId === id);
            return bubble
              ? bubble.getBoundingClientRect().top - element.getBoundingClientRect().top
              : null;
          }, origin.id),
        )
        .toBeCloseTo(origin.relativeTop, 0);
      await waitForChatScrollIdle(page);
      await search.fill("Conversation checkpoint 80.");
      const match = thread.locator('.chat-bubble[data-entry-id="search-message-79"]');
      await match.waitFor();
      await page.keyboard.press("ControlOrMeta+f");
      await waitForChatScrollIdle(page);
      const matchVisible = await match.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const viewport = element.closest(".chat-thread")!.getBoundingClientRect();
        return rect.bottom > viewport.top && rect.top < viewport.bottom;
      });
      expect(matchVisible).toBe(true);
      for (const input of ["wheel", "touch"] as const) {
        await composer.focus();
        await page.keyboard.press("ControlOrMeta+f");
        await search.fill("Conversation checkpoint");
        await expect.poll(() => thread.locator(".chat-bubble").count()).toBeGreaterThan(1);
        await thread.hover();
        if (input === "wheel") {
          await page.mouse.wheel(0, -700);
        } else {
          await thread.evaluate(async (element) => {
            const touch = new Touch({ identifier: 1, target: element, clientY: 200 });
            element.dispatchEvent(
              new TouchEvent("touchstart", {
                touches: [touch],
                targetTouches: [touch],
                changedTouches: [touch],
                bubbles: true,
              }),
            );
            element.scrollTop -= 700;
            await new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            });
            element.dispatchEvent(
              new TouchEvent("touchend", { changedTouches: [touch], bubbles: true }),
            );
          });
        }
        await waitForChatScrollIdle(page);
        const recent = await readAnchor();
        await search.fill("zzzxq149361nohit");
        await expect.poll(() => thread.locator(".chat-bubble").count()).toBe(0);
        await page.keyboard.press("ControlOrMeta+f");
        await expect
          .poll(() =>
            thread.evaluate((element, id) => {
              const bubble = [
                ...element.querySelectorAll<HTMLElement>(".chat-bubble[data-message-id]"),
              ].find((candidate) => candidate.dataset.messageId === id);
              return bubble
                ? bubble.getBoundingClientRect().top - element.getBoundingClientRect().top
                : null;
            }, recent.id),
          )
          .toBeCloseTo(recent.relativeTop, 0);
        await waitForChatScrollIdle(page);
      }

      await composer.focus();
      await page.keyboard.press("ControlOrMeta+f");
      await search.fill("zzzxq149361nohit");
      await expect.poll(() => thread.locator(".chat-bubble").count()).toBe(0);
      await thread.hover();
      await page.mouse.wheel(0, -200);
      await search.focus();
      await page.keyboard.press("ControlOrMeta+f");
      await waitForChatScrollIdle(page);
      expect(await thread.evaluate((element) => element.scrollTop)).toBe(0);
      expect(await composer.inputValue()).toBe("Keep this draft.");
      expect(await composer.evaluate((element) => element === document.activeElement)).toBe(true);
      await page.getByRole("button", { name: "Scroll to latest", exact: true }).click();
      await waitForChatScrollIdle(page);
      const distanceToEnd = () =>
        thread.evaluate(
          (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
        );
      await expect.poll(distanceToEnd).toBeLessThanOrEqual(1);
      await composer.focus();
      await page.keyboard.press("ControlOrMeta+f");
      await search.fill("zzzxq149361nohit");
      await expect.poll(() => thread.locator(".chat-bubble").count()).toBe(0);
      await page.keyboard.press("ControlOrMeta+f");
      await waitForChatScrollIdle(page);
      await expect.poll(distanceToEnd).toBeLessThanOrEqual(1);
    });
  });
});
