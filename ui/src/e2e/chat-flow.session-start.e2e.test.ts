import { expect, it } from "vitest";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e.ts";
import { closeChatDetails, openChatDetails } from "./chat-details.test-support.ts";
import {
  chatMessage,
  newChatPage,
  createChatFlowE2eSuite,
  installMockGateway,
  requireRecord,
  requireString,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("waits for configured inference before sending the first chat turn", async () => {
    const page = await newChatPage(suite);
    const models = [
      { available: true, id: "startup-model", name: "Startup Model", provider: "openai" },
    ];
    const gateway = await installMockGateway(page, {
      agentModel: "openai/startup-model",
      defaultAgentId: "ops",
      deferredMethods: ["chat.startup"],
      featureMethods: [...defaultControlUiFeatureMethods, "progressCard.get"],
      historyMessages: [],
      methodResponses: {
        "progressCard.get": {
          card: {
            sessionKey: "agent:ops:global",
            revision: 1,
            updatedAt: 1,
            markdown: "Global progress after startup",
          },
        },
      },
      models,
      sessionKey: "global",
      sessionScope: "global",
    });

    await page.goto(`${suite.server.baseUrl}chat`);
    await gateway.waitForRequest("chat.startup");
    expect(await gateway.getRequests("agents.list")).toHaveLength(1);
    expect(await gateway.getRequests("chat.metadata")).toHaveLength(0);
    expect(await gateway.getRequests("commands.list")).toHaveLength(0);
    await gateway.waitForRequest("models.list");
    const composer = page.locator(".agent-chat__composer-combobox textarea");
    const sendButton = page.getByRole("button", { name: "Send message" });
    await composer.waitFor({ state: "visible", timeout: 10_000 });
    await expect.poll(() => sendButton.count()).toBe(0);
    expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    expect(await gateway.getRequests("progressCard.get")).toHaveLength(0);

    await gateway.resolveDeferred("chat.startup", {
      messages: [],
      metadata: {
        commands: [
          {
            acceptsArgs: false,
            description: "Loaded after startup completes",
            name: "startup-ready",
            scope: "text",
            source: "native",
          },
        ],
        models,
      },
      sessionId: "session:global",
      thinkingLevel: null,
    });

    const progressRequest = await gateway.waitForRequest("progressCard.get");
    expect(progressRequest.params).toEqual({ sessionKey: "global", agentId: "ops" });
    const progress = page.getByText("Global progress after startup", { exact: true });
    await progress.waitFor({ state: "attached" });
    expect(await progress.isVisible()).toBe(false);
    const details = await openChatDetails(page);
    await details.getByText("Global progress after startup", { exact: true }).waitFor();
    await closeChatDetails(page);

    const prompt = "send after configured inference loads";
    await composer.fill(prompt);
    await sendButton.waitFor({ state: "visible", timeout: 10_000 });
    await expect.poll(() => sendButton.isEnabled()).toBe(true);
    await sendButton.click();

    const sendRequest = await gateway.waitForRequest("chat.send");
    await expect.poll(() => composer.inputValue(), { timeout: 10_000 }).toBe("");
    const params = requireRecord(sendRequest.params);
    expect(params).toMatchObject({ message: prompt, sessionKey: "global", agentId: "ops" });

    const runId = requireString(params.idempotencyKey, "chat send idempotency key");
    await page.locator(".chat-thread").getByText(prompt).waitFor({ timeout: 10_000 });
    await gateway.emitGatewayEvent("chat", {
      deltaText: "First token visible.",
      message: chatMessage("assistant", "First token visible.", {
        timestamp: Date.now(),
      }),
      runId,
      agentId: "ops",
      sessionKey: "global",
      state: "delta",
    });
    const transcript = page.locator(".chat-thread-inner");
    await transcript
      .getByText("First token visible.", { exact: true })
      .waitFor({ timeout: 10_000 });
    await page.locator(".chat-thread").getByText(prompt).waitFor({ timeout: 10_000 });
    await transcript
      .getByText("First token visible.", { exact: true })
      .waitFor({ timeout: 10_000 });
    await expect
      .poll(() => page.locator("[data-chat-model-select]").textContent())
      .toContain("Startup Model");
    await gateway.emitChatFinal({ runId, text: "History race stayed visible." });
    await transcript.getByText("History race stayed visible.").waitFor({ timeout: 10_000 });
    await composer.fill("/");
    await page.getByRole("option", { name: /\/startup-ready/ }).waitFor({ timeout: 10_000 });
    // Check after both controls render so no late fallback RPC supplied either catalog.
    expect({
      commands: (await gateway.getRequests("commands.list")).length,
      metadata: (await gateway.getRequests("chat.metadata")).length,
      models: (await gateway.getRequests("models.list")).length,
    }).toEqual({ commands: 0, metadata: 0, models: 1 });
    expect(await gateway.getRequests("agents.list")).toHaveLength(1);
  });

  it("paints startup history while canonical roster and metadata requests remain pending", async () => {
    const page = await newChatPage(suite);
    const gateway = await installMockGateway(page, {
      agentModel: "openai/hydrated-model",
      deferredMethods: ["agents.list", "chat.metadata", "models.list"],
      methodResponses: {
        "chat.startup": {
          messages: [
            chatMessage("assistant", "Transcript paints while optional startup data loads"),
          ],
          sessionId: "session:agent:main:main",
          thinkingLevel: null,
        },
      },
    });

    await page.goto(`${suite.server.baseUrl}chat`);
    await gateway.waitForRequest("chat.startup");
    await gateway.waitForRequest("agents.list");
    await gateway.waitForRequest("chat.metadata");
    await page
      .locator(".chat-thread-inner")
      .getByText("Transcript paints while optional startup data loads", { exact: true })
      .waitFor({ timeout: 10_000 });
    expect(await gateway.getRequests("agents.list")).toHaveLength(1);

    await gateway.resolveDeferred("agents.list", {
      agents: [{ id: "main", model: { primary: "openai/hydrated-model" }, name: "OpenClaw" }],
      defaultId: "main",
      mainKey: "main",
      scope: "agent",
    });
    await gateway.resolveDeferred("chat.metadata", { commands: [] });
    await gateway.resolveDeferred("models.list", {
      models: [
        {
          available: true,
          id: "hydrated-model",
          name: "Hydrated Model",
          provider: "openai",
        },
      ],
    });
    await expect
      .poll(() =>
        page.locator("[data-chat-model-select] .chat-controls__inline-select-label").textContent(),
      )
      .toContain("Hydrated Model");
    expect(await gateway.getRequests("agents.list")).toHaveLength(1);
  });
});
