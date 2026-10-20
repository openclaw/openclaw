import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

const models = [
  { id: "claude-opus", name: "Claude Opus", provider: "anthropic" },
  ...Array.from({ length: 12 }, (_, index) => ({
    id: `gpt-${index}`,
    name: `GPT ${index}`,
    provider: "openai",
  })),
];

// WebKit on iOS does not focus a tapped button; focus moves to the nearest
// focusable ancestor, which is the tabindex=-1 main region of the app shell.
const iosButtonFocus = `document.addEventListener("mousedown", (event) => {
  const button = event.target instanceof Element ? event.target.closest("button") : null;
  if (!button) return;
  event.preventDefault();
  let element = button.parentElement;
  while (element && !element.hasAttribute("tabindex")) element = element.parentElement;
  element?.focus();
}, true);`;

const touch = { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } };

// Taps the centre of a locator's box with the touchscreen.
async function tap(page: Page, locator: ReturnType<Page["locator"]>): Promise<void> {
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error("tap target has no layout box");
  }
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

// Opens the composer model picker by touch and waits for the OpenAI provider toggle.
async function openPickerByTouch(page: Page) {
  await installMockGateway(page, {
    agentModel: "anthropic/claude-opus",
    models,
    methodResponses: { "models.list": { models } },
  });
  await page.goto(`${suite.server.baseUrl}chat`);
  const picker = page.locator(".agent-chat__input .chat-controls__model-picker").first();
  const trigger = picker.locator("[data-chat-model-select]");
  await expect.poll(() => trigger.getAttribute("aria-disabled")).toBe("false");
  await tap(page, trigger);
  const toggle = picker.locator(
    '[data-chat-model-provider="openai"] [data-chat-model-provider-toggle]',
  );
  await toggle.waitFor({ state: "visible" });
  return { picker, toggle };
}

suite.define(() => {
  it("expands a provider on touch when the tapped button does not take focus", async () => {
    await suite.withPage(touch, async ({ page }) => {
      await page.addInitScript({ content: iosButtonFocus });
      const { picker, toggle } = await openPickerByTouch(page);
      expect(await toggle.getAttribute("aria-expanded")).toBe("false");
      await tap(page, toggle);
      await expect.poll(() => toggle.getAttribute("aria-expanded")).toBe("true");
      expect(await picker.getAttribute("open")).not.toBeNull();
    });
  });
});
