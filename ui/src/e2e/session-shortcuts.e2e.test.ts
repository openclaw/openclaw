import { expect, it } from "vitest";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  button,
  expectNoRequests,
  sessionPatch,
} from "./session-management.compact.test-support.ts";
import {
  controlUiSessionPath,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
} from "./session-management.test-support.ts";
import { expectFocused } from "./sidebar-assertions.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it("direct session shortcuts preserve drafts, archive only the current conversation, and support Undo", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const target = sessionRow("agent:main:current-shortcut", "Current shortcut", 2);
      const others = ["one", "two"].map((name, index) =>
        sessionRow(`agent:main:selected-other-${name}`, `Selected other ${name}`, index + 3),
      );
      const gateway = await installMockGateway(page, {
        sessions: [sessionRow("agent:main:main", "Main", 1), target, ...others],
        sessionKey: target.key,
        sessionArchiveFiltering: true,
        historyMessages: [
          { role: "assistant", content: [{ type: "text", text: "Current conversation content" }] },
        ],
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, target.key));
      const pane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
      const composer = pane.locator(".agent-chat__composer-combobox > textarea");
      await composer.fill("Preserve this unsent draft");
      for (const row of others) {
        await page
          .locator(`.sidebar-recent-session[data-session-key="${row.key}"]`)
          .click({ modifiers: ["Alt"] });
      }
      await composer.focus();
      const modifier = await page.evaluate(() =>
        /Mac|iPhone|iPad|iPod/u.test(navigator.platform) ? "Meta" : "Control",
      );
      // Browser key events exercise the registered receiver; CDP input does not
      // certify interception of physical operating-system accelerators.
      await composer.press(`${modifier}+Shift+A`);
      const archived = await sessionPatch(gateway, target.key, { archived: true });
      expect(archived.params).toMatchObject({
        key: target.key,
        expectedSessionId: target.sessionId,
        archived: true,
      });
      await expectNoRequests(gateway, "sessions.patchMany", "sessions.abort", "sessions.delete");
      const undo = button(page, "Undo");
      await undo.waitFor({ state: "visible" });
      expect(new URL(page.url()).pathname).toBe(controlUiSessionPath(target.key));
      await pane.getByText("Current conversation content", { exact: true }).waitFor();
      await undo.click();
      await sessionPatch(gateway, target.key, { archived: false });
      await expect.poll(() => composer.inputValue()).toBe("Preserve this unsent draft");
      expect(new URL(page.url()).pathname).toBe(controlUiSessionPath(target.key));

      await page.keyboard.press(`${modifier}+/`);
      const shortcuts = page.getByRole("dialog", { name: "Keyboard shortcuts" });
      const newSessionHelp = shortcuts.getByText("Open New Session", { exact: true });
      await newSessionHelp.waitFor({ state: "visible" });
      await page.keyboard.press(`${modifier}+Shift+A`);
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(2);
      await page.keyboard.press(`${modifier}+Shift+O`);
      const newComposer = page.locator("openclaw-new-session-page .new-session-page__message");
      await newComposer.waitFor({ state: "visible" });
      await shortcuts.waitFor({ state: "detached" });
      await expectFocused(newComposer);
      expect(await newComposer.inputValue()).toBe("");
      await expectNoRequests(gateway, "sessions.create", "chat.send");
      await page.keyboard.press(`${modifier}+/`);
      await newSessionHelp.waitFor({ state: "visible" });
      await page.keyboard.press(`${modifier}+/`);
      await shortcuts.waitFor({ state: "detached" });
      await page.goBack();
      await expect.poll(() => composer.inputValue()).toBe("Preserve this unsent draft");
      await composer.press(`${modifier}+Shift+O`);
      await newComposer.waitFor({ state: "visible" });
      await page.evaluate(() => new Promise(requestAnimationFrame));
      await expectFocused(newComposer);
    });
  });
});
