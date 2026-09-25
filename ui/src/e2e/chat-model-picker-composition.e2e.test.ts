import { expect, it } from "vitest";
import {
  captureUiProof,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it.each([
    { width: 1280, height: 900, minimumTarget: 32 },
    { width: 390, height: 844, minimumTarget: 44 },
  ])(
    "opens provider groups and searches across collapsed models at $width pixels",
    async ({ width, height, minimumTarget }) => {
      await suite.withPage({ viewport: { width, height } }, async ({ page }) => {
        const models = [
          { id: "shared-alpha", name: "Shared Alpha", provider: "openai" },
          { id: "shared-beta", name: "Shared Beta", provider: "anthropic" },
        ];
        const gateway = await installMockGateway(page, {
          agentModel: "openai/shared-alpha",
          models,
          methodResponses: {
            "models.list": {
              models,
              accountSelection: {
                kind: "shared",
                authProfileId: "openai:siwc",
                label: "Sign in with ChatGPT",
              },
            },
            "models.authStatus": {
              ts: 1,
              providers: [
                {
                  provider: "openai",
                  displayName: "OpenAI",
                  status: "ok",
                  profiles: [
                    {
                      profileId: "openai:siwc",
                      type: "oauth",
                      status: "ok",
                      displayName: "Sign in with ChatGPT",
                      email: "long-account-name+siwc@example.test",
                    },
                  ],
                },
              ],
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const picker = page.locator(".agent-chat__input .chat-controls__model-picker").first();
        const trigger = picker.locator("[data-chat-model-select]");
        const alpha = picker.locator('[data-chat-model-option="openai/shared-alpha"]');
        const beta = picker.locator('[data-chat-model-option="anthropic/shared-beta"]');
        const openai = picker.locator(
          '[data-chat-model-provider-group="openai"] [data-chat-model-provider-toggle]',
        );
        await expect
          .poll(() => picker.locator("[data-chat-model-provider-toggle]").count())
          .toBe(2);
        await trigger.click();
        const auth = picker.locator(
          '[data-chat-model-provider="openai"] .chat-controls__auth-meta',
        );
        await expect
          .poll(() => auth.textContent())
          .toContain("long-account-name+siwc@example.test");
        await auth.waitFor({ state: "visible" });
        const toggleContentsRight = await openai.evaluate((button) =>
          Math.max(...Array.from(button.children, (child) => child.getBoundingClientRect().right)),
        );
        const authBox = await auth.boundingBox();
        expect(toggleContentsRight).toBeLessThanOrEqual(authBox!.x);
        await openai.click({ trial: true });
        await captureUiProof(suite, page, "model-account-identity", `${width}.png`);
        await expect.poll(() => alpha.isVisible()).toBe(false);
        expect(await beta.isVisible()).toBe(false);
        expect(await openai.getAttribute("aria-expanded")).toBe("false");
        await expect
          .poll(() => openai.evaluate((button) => button.getBoundingClientRect().height))
          .toBeGreaterThanOrEqual(minimumTarget);
        await openai.focus();
        await page.keyboard.press("Enter");
        await expect.poll(() => alpha.isVisible()).toBe(true);
        expect(await beta.isVisible()).toBe(false);
        const search = picker.locator("[data-chat-model-search]");
        await search.fill("shared");
        await expect.poll(() => beta.isVisible()).toBe(true);
        expect(await openai.getAttribute("aria-expanded")).toBe("true");
        await search.fill("shared-beta");
        await captureUiProof(suite, page, "model-id-search", `${width}.png`);
        expect(await beta.isVisible()).toBe(true);
        expect(await alpha.isVisible()).toBe(false);
        await search.fill("ANTHROPIC/SHARED-BETA");
        expect(await beta.isVisible()).toBe(true);
        expect(await alpha.isVisible()).toBe(false);
        await search.press("ControlOrMeta+A");
        await search.press("Backspace");
        expect(await search.inputValue()).toBe("");
        expect(await alpha.isVisible()).toBe(true);
        expect(await beta.isVisible()).toBe(false);
        await search.press("Escape");
        await expect.poll(() => picker.getAttribute("open")).toBeNull();
        await trigger.click();
        await expect.poll(() => alpha.isVisible()).toBe(false);
        expect(await openai.getAttribute("aria-expanded")).toBe("false");
        await search.fill("shared");
        await search.press("ArrowDown");
        await search.press("Enter");
        const patch = await gateway.waitForRequest("sessions.patch");
        expect(patch.params).toMatchObject({ model: "anthropic/shared-beta" });
      });
    },
  );

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
          await page.mouse.move(0, 0);
          const search = picker.locator("[data-chat-model-search]");
          const query = key.startsWith("Arrow") ? "" : "anthropic";
          if (key.startsWith("Arrow")) {
            for (const toggle of await picker.locator("[data-chat-model-provider-toggle]").all()) {
              await toggle.focus();
              await toggle.press("Enter");
            }
          }
          await search.fill(query);
          await search.focus();
          // This exercises browser event ownership, not a native OS IME candidate window.
          const { prevented, highlightedBefore, highlightedAfter } = await search.evaluate(
            (input, args) => {
              const previousHighlight = input.getAttribute("aria-activedescendant");
              const event = new KeyboardEvent("keydown", {
                key: args.key,
                isComposing: args.composition === "active",
                keyCode: args.composition === "keyCode229" ? 229 : 0,
                bubbles: true,
                cancelable: true,
                composed: true,
              });
              input.dispatchEvent(event);
              return {
                prevented: event.defaultPrevented,
                highlightedBefore: previousHighlight,
                highlightedAfter: input.getAttribute("aria-activedescendant"),
              };
            },
            { key, composition },
          );

          expect(highlightedBefore).toBeTruthy();

          if (composition !== "none") {
            expect.soft(prevented).toBe(false);
            expect.soft(await picker.getAttribute("open")).not.toBeNull();
            expect.soft(await search.inputValue()).toBe(query);
            expect.soft(highlightedAfter).toBe(highlightedBefore);
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
                expect(highlightedAfter).not.toBe(highlightedBefore);
              }
            }
          }
        });
      },
    );
  }
});
