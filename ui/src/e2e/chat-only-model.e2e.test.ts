import { expect, it } from "vitest";
import { revealChatModelOption, selectChatModelOption } from "../test-helpers/select-picker-e2e.ts";
import {
  createChatFlowE2eSuite,
  installMockGateway,
  newChatPage,
} from "./chat-flow.test-support.ts";
import { pollText, pollCount, pollAttribute } from "./new-session-page.test-support.ts";

const suite = createChatFlowE2eSuite();
const sessionKey = "agent:main:main";

const models = [
  {
    id: "qwen3-8b",
    name: "Qwen3 8B",
    provider: "lmstudio",
    contextWindow: 32_768,
    supportsTools: false,
  },
  {
    id: "gpt-5.5",
    name: "GPT-5.5",
    provider: "openai",
    contextWindow: 200_000,
    supportsTools: true,
  },
];

suite.define(() => {
  it("explains chat-only models and keeps model switching as the recovery path", async () => {
    const page = await newChatPage(suite);
    const gateway = await installMockGateway(page, {
      agentModel: "lmstudio/qwen3-8b",
      featureMethods: ["chat.metadata", "chat.startup", "sessions.patch"],
      models,
      sessionKey,
      methodResponses: {
        "sessions.list": {
          count: 1,
          defaults: {
            contextTokens: 32_768,
            model: "qwen3-8b",
            modelProvider: "lmstudio",
            thinkingDefault: "off",
            thinkingLevels: [{ id: "off", label: "off" }],
          },
          path: "",
          sessions: [
            {
              contextTokens: 32_768,
              displayName: "Local chat",
              hasActiveRun: false,
              key: sessionKey,
              kind: "direct",
              label: "Local chat",
              model: "qwen3-8b",
              modelProvider: "lmstudio",
              status: "done",
              totalTokens: 0,
              updatedAt: Date.now(),
            },
          ],
          ts: Date.now(),
        },
      },
    });

    await page.goto(`${suite.server.baseUrl}chat`);
    await gateway.waitForRequest("chat.startup");

    const main = page.getByRole("main");
    const composer = main.locator(".agent-chat__composer-shell");
    const picker = composer.locator('[data-chat-model-select="true"]');
    const badge = picker.locator(".chat-controls__model-capability-badge");

    await pollAttribute(picker, "data-chat-model-tools").toBe("unavailable");
    await expect.poll(async () => (await badge.textContent())?.trim()).toBe("Chat only");
    await pollAttribute(picker, "aria-label").toContain("Chat only");

    await picker.click();
    const localOption = composer.locator('[data-chat-model-option="lmstudio/qwen3-8b"]');
    const openAiOption = composer.locator('[data-chat-model-option="openai/gpt-5.5"]');
    await pollText(localOption.locator(".chat-controls__model-option-meta")).toBe("32.8k");
    await pollAttribute(localOption, "aria-label").toContain("cannot use tools");
    await revealChatModelOption(localOption);
    const infoIcon = localOption.locator(".chat-controls__model-chat-only-info");
    await pollCount(infoIcon.locator("svg")).toBe(1);
    await expect.poll(async () => (await infoIcon.boundingBox())?.width).toBe(16);
    await expect
      .poll(async () => (await openAiOption.textContent())?.includes("Chat only"))
      .toBe(false);

    await selectChatModelOption(openAiOption);
    const patch = await gateway.waitForRequest("sessions.patch");
    expect(patch.params).toMatchObject({ key: sessionKey, model: "openai/gpt-5.5" });
    await pollAttribute(picker, "data-chat-model-tools").toBe("available");
    await pollCount(badge).toBe(0);

    const pickerDetails = composer.locator("details.chat-controls__model-picker");
    if (!(await pickerDetails.evaluate((element: HTMLDetailsElement) => element.open))) {
      await picker.click();
    }
    await selectChatModelOption(localOption);
    await pollAttribute(picker, "data-chat-model-tools").toBe("unavailable");
    if (await pickerDetails.evaluate((element: HTMLDetailsElement) => element.open)) {
      await picker.click();
    }
    await page.setViewportSize({ height: 844, width: 390 });
    await composer.locator("textarea").click();
    await expect.poll(() => picker.isVisible()).toBe(true);

    if (!(await pickerDetails.evaluate((element: HTMLDetailsElement) => element.open))) {
      await picker.click();
    }
    const menu = composer.locator(".chat-controls__model-menu");
    await expect
      .poll(async () => {
        const box = await menu.boundingBox();
        return box !== null && box.x >= 0 && box.x + box.width <= 390;
      })
      .toBe(true);
  });
});
