import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { captureUiProof } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "command palette composition" });

suite.define(() => {
  for (const composition of ["none", "active", "keyCode229"] as const) {
    const keys =
      composition === "none" ? ["Enter", "Escape"] : ["Enter", "Escape", "ArrowDown", "ArrowUp"];
    it.each(keys)(`respects ${composition} composition ownership for palette %s`, async (key) => {
      await suite.withPage({}, async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "sessions.list": {
              cases: [
                {
                  match: { search: "東京" },
                  response: { ts: 1, path: "", count: 0, defaults: {}, sessions: [] },
                },
              ],
            },
            "agents.list": {
              defaultId: "main",
              mainKey: "main",
              scope: "per-sender",
              agents: [
                { id: "main", name: "Assistant" },
                { id: "tokyo-alpha", name: "東京 Alpha" },
                { id: "tokyo-beta", name: "東京 Beta" },
              ],
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}chat?session=main`);
        await page.locator(".shell").waitFor({ state: "visible" });
        await page.keyboard.press("ControlOrMeta+K");
        const input = page.locator(".cmd-palette__input");
        await input.fill("東京");
        const results = page.locator(".cmd-palette__results");
        await expect.poll(() => results.getAttribute("aria-busy")).toBe("false");
        await expect
          .poll(() => results.getByRole("option").allTextContents())
          .toEqual([expect.stringContaining("東京 Alpha"), expect.stringContaining("東京 Beta")]);
        await input.focus();
        const activeId = await input.getAttribute("aria-activedescendant");
        expect(activeId).toBeTruthy();
        expect(await results.locator('[aria-selected="true"]').textContent()).toContain(
          "東京 Alpha",
        );
        const originalUrl = page.url();

        if (composition === "none") {
          await input.press(key);
          if (key === "Enter") {
            await expect
              .poll(() => new URL(page.url()).pathname)
              .toBe("/settings/agents/tokyo-alpha");
          }
          await expect.poll(() => input.count()).toBe(0);
          if (key === "Escape") {
            expect(page.url()).toBe(originalUrl);
          }
          expect(await gateway.getRequests("chat.send")).toEqual([]);
          return;
        }

        // Synthetic events exercise mounted browser handlers, not a native IME candidate window.
        const dispatched = await input.evaluate(
          (element, args) => {
            const event = new KeyboardEvent("keydown", {
              key: args.key,
              isComposing: args.composition === "active",
              keyCode: args.composition === "keyCode229" ? 229 : 0,
              bubbles: true,
              cancelable: true,
              composed: true,
            });
            element.dispatchEvent(event);
            return {
              prevented: event.defaultPrevented,
              isComposing: event.isComposing,
              keyCode: event.keyCode,
            };
          },
          { key, composition },
        );
        expect(dispatched.isComposing).toBe(composition === "active");
        expect(dispatched.keyCode).toBe(composition === "keyCode229" ? 229 : 0);
        expect(dispatched.prevented).toBe(false);
        expect(await input.isVisible()).toBe(true);
        expect(await input.inputValue()).toBe("東京");
        expect(await input.getAttribute("aria-activedescendant")).toBe(activeId);
        expect(page.url()).toBe(originalUrl);
        expect(await gateway.getRequests("chat.send")).toEqual([]);
        if (composition === "active" && key === "Enter") {
          await captureUiProof(suite, page, "palette-composition", "composing-enter.png");
        }
      });
    });
  }
});
