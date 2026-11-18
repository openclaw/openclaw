import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { revealChatModelOption } from "../test-helpers/select-picker-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import { cronList, cronRuns } from "./cron-fixtures.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Cron model and reasoning pickers",
  startServerBeforeBrowser: true,
});

const levels = (ids: string[]) => ids.map((id) => ({ id, label: id }));
const models = [
  {
    id: "gpt-5.5",
    name: "GPT-5.5",
    provider: "openai",
    thinkingLevels: levels(["off", "minimal", "low", "medium", "high", "xhigh"]),
    thinkingDefault: "medium",
  },
  {
    id: "claude-opus-4.5",
    name: "Claude Opus 4.5",
    provider: "anthropic",
    thinkingLevels: levels(["off", "low", "medium", "high"]),
    thinkingDefault: "high",
  },
];

suite.define(() => {
  it("sets the payload model and reasoning with the session composer's pickers", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        agentModel: "openai/gpt-5.5",
        models,
        methodResponses: {
          "cron.add": { id: "picker-automation" },
          "cron.list": cronList([], "picker-fixture"),
          "cron.runs": cronRuns([]),
          "cron.status": { enabled: true, jobs: 0, triggersEnabled: true },
        },
      });
      await page.goto(suite.server.baseUrl + "cron?new");
      await page.locator("#cron-name").fill("Synthetic release digest");
      await page.locator("#cron-payload-text").fill("Summarize the fictional release notes.");
      const controls = page.locator(".cron-prompt__run-controls");
      const model = controls.locator('[data-chat-model-select="true"]');
      const effort = controls.locator('[data-chat-thinking-select="true"]');
      const label = (trigger: typeof model) =>
        trigger.locator(".chat-controls__inline-select-label").textContent();
      // Default follows the agent's model and that model's own level.
      await expect.poll(() => label(model)).toBe("GPT-5.5");
      await expect.poll(() => label(effort)).toBe("Medium");

      const setLevel = async (key: "Home" | "End") => {
        await effort.click();
        const slider = page.locator(
          '.chat-controls__effort-menu [data-chat-thinking-slider="true"]',
        );
        await slider.focus();
        await slider.press(key);
        await page.keyboard.press("Escape");
      };
      await setLevel("End");
      await expect.poll(() => label(effort)).toBe("Extra high");

      // Claude Opus does not offer Extra high, so reasoning returns to its Default.
      await model.click();
      await (await revealChatModelOption(page, "anthropic/claude-opus-4.5")).click();
      await expect.poll(() => label(model)).toBe("Claude Opus 4.5");
      await expect.poll(() => label(effort)).toBe("High");
      await setLevel("Home");
      await expect.poll(() => label(effort)).toBe("Off");

      await page.locator('[data-test-id="cron-submit"]').click();
      const added = await gateway.waitForRequest("cron.add");
      expect(added.params).toMatchObject({
        payload: { kind: "agentTurn", model: "anthropic/claude-opus-4.5", thinking: "off" },
      });
    });
  });
});
