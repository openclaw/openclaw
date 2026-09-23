import { expect, it } from "vitest";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  captureUiProof,
  controlUiSessionPath,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  requireRecord,
  waitForPatch,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it("direct session shortcuts preserve drafts, archive only the current conversation, and support Undo", async () => {
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const main = sessionRow("agent:main:main", "Main", 1);
    const target = sessionRow("agent:main:current-shortcut", "Current shortcut", 2);
    const others = [
      sessionRow("agent:main:selected-other-one", "Selected other one", 3),
      sessionRow("agent:main:selected-other-two", "Selected other two", 4),
    ];
    const gateway = await installMockGateway(page, {
      sessions: [main, target, ...others],
      sessionKey: target.key,
      sessionArchiveFiltering: true,
      historyMessages: [
        { role: "assistant", content: [{ type: "text", text: "Current conversation content" }] },
      ],
    });
    try {
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
      await captureUiProof(suite, page, "direct-archive-before.png");
      const modifier = await page.evaluate(() =>
        /Mac|iPhone|iPad|iPod/u.test(navigator.platform) ? "Meta" : "Control",
      );
      // Browser key events exercise the registered receiver; CDP input does not
      // certify interception of physical operating-system accelerators.
      await composer.press(`${modifier}+Shift+A`);
      const archived = await waitForPatch(
        gateway,
        (params) => params.key === target.key && params.archived === true,
      );
      expect(archived.params).toMatchObject({
        key: target.key,
        expectedSessionId: target.sessionId,
        archived: true,
      });
      expect(await gateway.getRequests("sessions.patchMany")).toEqual([]);
      expect(await gateway.getRequests("sessions.abort")).toEqual([]);
      expect(await gateway.getRequests("sessions.delete")).toEqual([]);
      const undo = page.getByRole("button", { name: "Undo", exact: true });
      await undo.waitFor({ state: "visible" });
      await captureUiProof(suite, page, "direct-archive-after.png");
      expect(new URL(page.url()).pathname).toBe(controlUiSessionPath(target.key));
      await pane.getByText("Current conversation content", { exact: true }).waitFor();
      await undo.click();
      await waitForPatch(
        gateway,
        (params) => params.key === target.key && params.archived === false,
      );
      await expect.poll(() => composer.inputValue()).toBe("Preserve this unsent draft");
      const archiveRequests = (await gateway.getRequests("sessions.patch")).filter(
        (request) => typeof requireRecord(request.params).archived === "boolean",
      );
      expect(archiveRequests).toHaveLength(2);
      expect(new URL(page.url()).pathname).toBe(controlUiSessionPath(target.key));

      await page.keyboard.press(`${modifier}+/`);
      const shortcuts = page.getByRole("dialog", { name: "Keyboard shortcuts" });
      await page
        .locator("openclaw-keyboard-shortcuts-dialog")
        .getByText("Open New Session", { exact: true })
        .waitFor({ state: "visible" });
      await page.keyboard.press(`${modifier}+Shift+A`);
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(2);
      await captureUiProof(suite, page, "direct-new-session-before.png");
      await page.keyboard.press(`${modifier}+Shift+O`);
      const newComposer = page.locator("openclaw-new-session-page .new-session-page__message");
      await newComposer.waitFor({ state: "visible" });
      await shortcuts.waitFor({ state: "detached" });
      await expect
        .poll(() => newComposer.evaluate((element) => element === document.activeElement))
        .toBe(true);
      expect(await newComposer.inputValue()).toBe("");
      expect(await gateway.getRequests("sessions.create")).toEqual([]);
      expect(await gateway.getRequests("chat.send")).toEqual([]);
      await captureUiProof(suite, page, "direct-new-session-after.png");
      await page.keyboard.press(`${modifier}+/`);
      await page
        .locator("openclaw-keyboard-shortcuts-dialog")
        .getByText("Open New Session", { exact: true })
        .waitFor({ state: "visible" });
      await captureUiProof(suite, page, "direct-session-shortcuts-help.png");
      await page.keyboard.press(`${modifier}+/`);
      await shortcuts.waitFor({ state: "detached" });
      await page.goBack();
      await expect.poll(() => composer.inputValue()).toBe("Preserve this unsent draft");
      await composer.press(`${modifier}+Shift+O`);
      await newComposer.waitFor({ state: "visible" });
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          }),
      );
      await expect
        .poll(() => newComposer.evaluate((element) => element === document.activeElement))
        .toBe(true);
    } finally {
      await context.close();
    }
  });
});
