import { expect, it } from "vitest";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  for (const composition of ["active", "keyCode229", "none"] as const) {
    it.each(["Enter", "Escape", "ArrowDown", "ArrowUp"])(
      `respects ${composition} composition ownership for model-search %s`,
      async (key) => {
        await suite.withPage({}, async ({ page }) => {
          const gateway = await installMockGateway(page, {
            agentModel: "openai/gpt-5.5",
            models: [
              { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
              { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
            ],
          });
          await page.goto(`${suite.server.baseUrl}chat`);
          const picker = page.locator(".agent-chat__input .chat-controls__model-picker").first();
          const trigger = picker.locator("[data-chat-model-select]");
          await expect.poll(() => picker.locator("[data-chat-model-option]").count()).toBe(2);
          await expect.poll(() => trigger.getAttribute("aria-disabled")).toBe("false");
          await trigger.click();
          const search = picker.locator("[data-chat-model-search]");
          const query = key.startsWith("Arrow") ? "" : "anthropic";
          await search.fill(query);
          await search.focus();
          const highlighted = await search.getAttribute("aria-activedescendant");
          expect(highlighted).toBeTruthy();

          // This exercises browser event ownership, not a native OS IME candidate window.
          const prevented = await search.evaluate(
            (input, args) => {
              const event = new KeyboardEvent("keydown", {
                key: args.key,
                isComposing: args.composition === "active",
                keyCode: args.composition === "keyCode229" ? 229 : 0,
                bubbles: true,
                cancelable: true,
                composed: true,
              });
              input.dispatchEvent(event);
              return event.defaultPrevented;
            },
            { key, composition },
          );

          if (composition !== "none") {
            expect.soft(prevented).toBe(false);
            expect.soft(await picker.getAttribute("open")).not.toBeNull();
            expect.soft(await search.inputValue()).toBe(query);
            expect.soft(await search.getAttribute("aria-activedescendant")).toBe(highlighted);
            expect.soft(await gateway.getRequests("sessions.patch")).toEqual([]);
          } else {
            expect(prevented).toBe(true);
            if (key === "Enter") {
              const patch = await gateway.waitForRequest("sessions.patch");
              expect(patch.params).toMatchObject({ model: "anthropic/claude-sonnet-4-6" });
              expect(await picker.getAttribute("open")).toBeNull();
            } else {
              expect(await picker.getAttribute("open")).not.toBeNull();
              expect(await gateway.getRequests("sessions.patch")).toEqual([]);
              if (key === "Escape") {
                expect(await search.inputValue()).toBe("");
                await search.press("Escape");
                expect(await picker.getAttribute("open")).toBeNull();
              } else {
                expect(await search.getAttribute("aria-activedescendant")).not.toBe(highlighted);
              }
            }
          }
        });
      },
    );
  }
});
