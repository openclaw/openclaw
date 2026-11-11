import { mkdir } from "node:fs/promises";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI objective-only Goal shorthand" });
suite.define(() => {
  it("consumes command syntax and restores command entry when the objective is deleted", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        sessionKey: "agent:main:main",
        agentModel: "test/objective-model",
        models: [{ id: "objective-model", name: "Objective model", provider: "test" }],
      });
      const capture = async (name: string) => {
        const dir = process.env.OPENCLAW_GOAL_PROOF_DIR;
        if (dir) {
          await mkdir(dir, { recursive: true });
          await page.screenshot({ path: dir + "/" + name + ".png" });
        }
      };
      await page.goto(suite.server.baseUrl + "chat/main");
      const input = page.locator(".agent-chat__composer-combobox textarea");
      const mode = page.locator(".agent-chat__goal-mode");
      await input.waitFor({ state: "visible", timeout: 20_000 });
      await input.pressSequentially("/goal l");
      await expect.poll(() => mode.count()).toBe(1);
      expect(await input.inputValue()).toBe("l");
      expect(await input.evaluate((element: HTMLTextAreaElement) => element.selectionStart)).toBe(
        1,
      );
      await input.pressSequentially("and it");
      expect(await input.inputValue()).toBe("land it");
      await capture("objective-only");

      // Objective edits retain meaningful native undo/redo after command consumption.
      await input.press("ArrowLeft");
      await input.press("ArrowRight");
      await input.pressSequentially("!");
      await input.press("ControlOrMeta+z");
      expect(await input.inputValue()).toBe("land it");
      await input.press("ControlOrMeta+Shift+z");
      expect(await input.inputValue()).toBe("land it!");
      await input.press("Backspace");
      await input.press("ControlOrMeta+a");
      await input.press("Backspace");
      await expect.poll(() => mode.count()).toBe(0);
      expect(await input.inputValue()).toBe("/goal ");
      expect(await input.evaluate((element: HTMLTextAreaElement) => element.selectionStart)).toBe(
        6,
      );
      await capture("restored-command");
      await input.pressSequentially("sta");
      expect(await input.inputValue()).toBe("/goal sta");
      expect(await mode.count()).toBe(0);
      await page.getByText("status", { exact: true }).first().waitFor();
      await input.press("Backspace");
      await input.press("Backspace");
      await input.press("Backspace");
      await input.pressSequentially("land it");
      expect(await input.inputValue()).toBe("land it");
      expect(await mode.count()).toBe(1);
      await input.press("Escape");

      // An explicit starter intentionally begins empty; navigation/Enter do not exit it.
      await input.fill("/goal start ");
      await expect.poll(() => mode.count()).toBe(1);
      expect(await input.inputValue()).toBe("");
      await input.press("ArrowLeft");
      await input.press("Enter");
      expect(await mode.count()).toBe(1);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      await input.press("Backspace");
      expect(await mode.count()).toBe(0);
      expect(await input.inputValue()).toBe("/goal ");

      // A complete bulk/pasted command uses the same mode and persists only its objective.
      await input.fill("/goal create land it");
      expect(await input.inputValue()).toBe("land it");
      await page.reload();
      await input.waitFor({ state: "visible" });
      await expect.poll(() => input.inputValue()).toBe("land it");
      expect(await mode.count()).toBe(1);
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
