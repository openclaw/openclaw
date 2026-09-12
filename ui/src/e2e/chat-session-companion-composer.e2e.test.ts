import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import type { ChatSendShortcut } from "../app/settings.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  controlUiBundledSettingsStorageKey,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { captureUiProofEnabled } from "./chat-flow.test-support.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "side-chat composer" });
const viewport = { width: 1440, height: 900 };

async function openSideChat(page: Page, chatSendShortcut: ChatSendShortcut = "enter") {
  await page.addInitScript(
    ({ key, shortcut }) => {
      localStorage.setItem(key, JSON.stringify({ chatSendShortcut: shortcut }));
    },
    { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl), shortcut: chatSendShortcut },
  );
  const gateway = await installMockGateway(page, {
    methodResponses: {
      "sessions.companion.ask": { answer: "The next step is ready.", ts: 1 },
      "sessions.companion.state": { exchanges: [] },
    },
  });
  await page.goto(`${suite.server.baseUrl}chat`);
  await openChatSidePanelType(page, "Side chat");
  return gateway;
}

function composerGeometry(composer: Locator) {
  return composer.evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
}

suite.define(() => {
  it("wraps and grows a question, keeps Shift+Enter, then sends and shrinks", async () => {
    await suite.withPage({ viewport }, async ({ page }) => {
      const gateway = await openSideChat(page);
      const composer = page.getByRole("textbox", { name: "Ask in side chat", exact: true });
      const proofDir = captureUiProofEnabled
        ? createControlUiE2eArtifactDir("chat-session-companion-composer")
        : null;
      const empty = await composerGeometry(composer);
      if (proofDir) {
        await page.screenshot({ path: path.join(proofDir, "empty.png") });
      }

      const question = "Explain the next step and the remaining checks for this session. "
        .repeat(4)
        .trim();
      await composer.fill(question);
      const filled = await composerGeometry(composer);
      if (proofDir) {
        await page.screenshot({ path: path.join(proofDir, "wrapped.png") });
      }
      expect(filled.scrollWidth).toBeLessThanOrEqual(filled.clientWidth);
      expect(filled.height).toBeGreaterThan(empty.height);

      const requestsBefore = await gateway.getRequests("sessions.companion.ask");
      await composer.press("End");
      await composer.press("Shift+Enter");
      await page.keyboard.type("Include the final verification.");
      const multiline = `${question}\nInclude the final verification.`;
      expect(await composer.inputValue()).toBe(multiline);
      expect(await gateway.getRequests("sessions.companion.ask")).toHaveLength(
        requestsBefore.length,
      );

      await composer.press("Enter");
      const request = await gateway.waitForRequest("sessions.companion.ask");
      expect(request.params).toMatchObject({ question: multiline });
      await expect.poll(() => composer.inputValue()).toBe("");
      await expect.poll(async () => (await composerGeometry(composer)).height).toBe(empty.height);
      if (proofDir) {
        await page.screenshot({ path: path.join(proofDir, "cleared.png") });
      }
    });
  });

  it.each(["Control", "Meta"])(
    "uses %s+Enter to send when the configured shortcut requires a modifier",
    async (modifier) => {
      await suite.withPage({ viewport }, async ({ page }) => {
        const gateway = await openSideChat(page, "modifier-enter");
        const composer = page.getByRole("textbox", { name: "Ask in side chat", exact: true });
        await composer.fill("Explain the next step.");
        await composer.press("Enter");
        await page.keyboard.type("Include the checks.");
        const question = "Explain the next step.\nInclude the checks.";
        expect(await composer.inputValue()).toBe(question);
        expect(await gateway.getRequests("sessions.companion.ask")).toHaveLength(0);
        await composer.press(`${modifier}+Enter`);
        const request = await gateway.waitForRequest("sessions.companion.ask");
        expect(request.params).toMatchObject({ question });
        await expect.poll(() => composer.inputValue()).toBe("");
      });
    },
  );
});
