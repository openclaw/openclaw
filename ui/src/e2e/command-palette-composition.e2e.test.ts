import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { captureUiProof } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "command palette composition" });

suite.define(() => {
  it("leaves composing keys to the IME and handles native Escape and Enter", async () => {
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
      const input = page.locator(".cmd-palette__input");
      const results = page.locator(".cmd-palette__results");
      const openPalette = async () => {
        await page.keyboard.press("ControlOrMeta+K");
        await input.fill("東京");
        await expect.poll(() => results.getAttribute("aria-busy")).toBe("false");
        await expect
          .poll(() => results.getByRole("option").allTextContents())
          .toEqual([expect.stringContaining("東京 Alpha"), expect.stringContaining("東京 Beta")]);
        await input.focus();
        expect(await input.getAttribute("aria-activedescendant")).toBeTruthy();
        expect(await results.locator('[aria-selected="true"]').textContent()).toContain(
          "東京 Alpha",
        );
      };
      await openPalette();
      const activeId = await input.getAttribute("aria-activedescendant");
      const originalUrl = page.url();

      for (const composition of ["active", "keyCode229"] as const) {
        for (const key of ["Enter", "Escape", "ArrowDown", "ArrowUp"]) {
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
          expect(dispatched.isComposing, `${composition} ${key}`).toBe(composition === "active");
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
        }
      }
      await input.press("Escape");
      await expect.poll(() => input.count()).toBe(0);
      expect(page.url()).toBe(originalUrl);
      expect(await gateway.getRequests("chat.send")).toEqual([]);

      await openPalette();
      await input.press("Enter");
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/agents/tokyo-alpha");
      await expect.poll(() => input.count()).toBe(0);
      expect(await gateway.getRequests("chat.send")).toEqual([]);
    });
  });
});
