import { mkdir } from "node:fs/promises";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI reversible Goal shorthand" });
suite.define(() => {
  it("keeps shorthand typing reversible without replacing the native draft", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        sessionKey: "agent:main:main",
        agentModel: "test/objective-model",
        models: [{ id: "objective-model", name: "Objective model", provider: "test" }],
      });
      await page.goto(`${suite.server.baseUrl}chat/main`);
      const input = page.locator(".agent-chat__composer-combobox textarea");
      await input.waitFor({ state: "visible", timeout: 20_000 });
      await input.pressSequentially("/goal land it");
      if (process.env.OPENCLAW_GOAL_PROOF_DIR) {
        await mkdir(process.env.OPENCLAW_GOAL_PROOF_DIR, { recursive: true });
        await page.screenshot({ path: `${process.env.OPENCLAW_GOAL_PROOF_DIR}/shorthand.png` });
      }
      await expect.poll(() => page.locator(".agent-chat__goal-mode").count()).toBe(1);
      if (process.env.OPENCLAW_GOAL_PROOF_DIR) {
        await page.screenshot({ path: `${process.env.OPENCLAW_GOAL_PROOF_DIR}/shorthand.png` });
      }
      expect(await input.inputValue()).toBe("/goal land it");
      expect(await input.evaluate((element: HTMLTextAreaElement) => element.selectionStart)).toBe(
        13,
      );
      // Chromium may split a typing undo group when the surrounding mode changes.
      for (let step = 0; step < 4 && (await input.inputValue()); step++) {
        await input.press("ControlOrMeta+z");
        expect("/goal land it".startsWith(await input.inputValue())).toBe(true);
      }
      expect(await input.inputValue()).toBe("");
      expect(await page.locator(".agent-chat__goal-mode").count()).toBe(0);
      for (let step = 0; step < 4 && (await input.inputValue()) !== "/goal land it"; step++) {
        await input.press("ControlOrMeta+Shift+z");
      }
      expect(await input.inputValue()).toBe("/goal land it");
      expect(await page.locator(".agent-chat__goal-mode").count()).toBe(1);
      await input.press("ControlOrMeta+a");
      await input.pressSequentially("/goal sta");
      expect(await page.locator(".agent-chat__goal-mode").count()).toBe(0);
      expect(await input.inputValue()).toBe("/goal sta");
      if (process.env.OPENCLAW_GOAL_PROOF_DIR) {
        await page.screenshot({ path: `${process.env.OPENCLAW_GOAL_PROOF_DIR}/corrected.png` });
      }
      await input.press("ControlOrMeta+a");
      await input.pressSequentially("/goal land it");
      await page.reload();
      await input.waitFor({ state: "visible" });
      await expect.poll(() => input.inputValue()).toBe("/goal land it");
      expect(await page.locator(".agent-chat__goal-mode").count()).toBe(1);
      await input.press("Enter");
      const request = await gateway.waitForRequest("chat.send");
      expect(request.params).toMatchObject({
        message: "land it",
        intent: { kind: "session-goal-start" },
      });
      expect(await gateway.getRequests("chat.send")).toHaveLength(1);
    });
  });
});
