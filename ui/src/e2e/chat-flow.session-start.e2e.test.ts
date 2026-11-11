import { expect, it } from "vitest";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e.ts";
import { closeChatDetails, openChatTaskProgress } from "./chat-details.test-support.ts";
import {
  newChatPage,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("gates the first turn and routes global progress through the configured agent", async () => {
    const page = await newChatPage(suite);
    const models = [
      { available: true, id: "startup-model", name: "Startup Model", provider: "openai" },
    ];
    const markdown = "Global progress after startup";
    const gateway = await installMockGateway(page, {
      subscriptionInitialHistory: false,
      agentModel: "openai/startup-model",
      defaultAgentId: "ops",
      deferredMethods: ["chat.startup"],
      featureMethods: [...defaultControlUiFeatureMethods, "progressCard.get"],
      historyMessages: [],
      methodResponses: {
        "progressCard.get": {
          card: { sessionKey: "agent:ops:global", revision: 1, updatedAt: 1, markdown },
        },
      },
      models,
      sessionKey: "global",
      sessionScope: "global",
    });
    await page.goto(`${suite.server.baseUrl}chat`);
    await gateway.waitForRequest("chat.startup");
    const composer = page.locator(".agent-chat__composer-combobox textarea");
    const send = page.getByRole("button", { name: "Send message" });
    await composer.waitFor({ state: "visible", timeout: 10_000 });
    await expect.poll(() => send.count()).toBe(0);
    expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    expect(await gateway.getRequests("progressCard.get")).toHaveLength(0);
    await gateway.resolveDeferred("chat.startup", {
      messages: [],
      metadata: { commands: [], models },
      sessionId: "session:global",
      thinkingLevel: null,
    });
    expect((await gateway.waitForRequest("progressCard.get")).params).toEqual({
      sessionKey: "global",
      agentId: "ops",
    });
    expect(await page.getByText(markdown, { exact: true }).isVisible()).toBe(false);
    const details = await openChatTaskProgress(page);
    await details
      .locator(".session-progress-card__markdown")
      .getByText(markdown, { exact: true })
      .waitFor();
    await closeChatDetails(page);
    await expect
      .poll(() => page.locator("[data-chat-model-select]").textContent())
      .toContain("Startup Model");
    const prompt = "send after configured inference loads";
    await composer.fill(prompt);
    await expect.poll(() => send.isEnabled()).toBe(true);
    await send.click();
    expect((await gateway.waitForRequest("chat.send")).params).toMatchObject({
      message: prompt,
      sessionKey: "global",
      agentId: "ops",
    });
    await expect.poll(() => composer.inputValue(), { timeout: 10_000 }).toBe("");
  });
});
