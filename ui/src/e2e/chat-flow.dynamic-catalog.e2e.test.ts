import { expect, it } from "vitest";
import { revealChatModelOption } from "../test-helpers/select-picker-e2e.ts";
import { sessionRow } from "./chat-flow-fixtures.test-support.ts";
import {
  newChatPage,
  createChatFlowE2eSuite,
  controlUiSessionUrl,
  installMockGateway,
  thinkingLevels,
} from "./chat-flow.test-support.ts";
import { modelSessionList } from "./chat-runtime-fixtures.test-support.ts";

const suite = createChatFlowE2eSuite();
const rosterMatch = { includeGlobal: true };

suite.define(() => {
  it("converges Chat reasoning and context metadata after dynamic catalog discovery", async () => {
    const page = await newChatPage(suite);
    const sessionKey = "agent:main:dynamic-catalog";
    const preparedLevels = thinkingLevels("off");
    const discoveredLevels = thinkingLevels("off", "low", "medium", "high", "xhigh");
    const modelId = "deepseekv4flash-equivalent";
    const modelKey = `omniroute/${modelId}`;
    const preparedModel = {
      available: true,
      id: modelId,
      name: "DeepSeek V4 Flash",
      provider: "omniroute",
      reasoning: true,
    };
    const discoveredModel = {
      ...preparedModel,
      compat: { supportedReasoningEfforts: discoveredLevels.map((level) => level.id) },
      contextWindow: 262_144,
    };
    const sessionResponse = (levels: typeof preparedLevels, contextTokens: number) => {
      const defaults = {
        contextTokens,
        model: modelId,
        modelProvider: "omniroute",
        thinkingDefault: "off",
        thinkingLevels: levels,
      };
      return {
        ...modelSessionList(
          sessionRow(sessionKey, "Dynamic catalog", 2, {
            ...defaults,
            sessionId: "control-ui-dynamic-catalog-convergence",
          }),
          defaults,
        ),
        ts: Date.now(),
      };
    };
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "chat.startup": {
          agentsList: {
            agents: [{ id: "main", model: { primary: modelKey }, name: "Main" }],
            defaultId: "main",
            mainKey: "main",
            scope: "agent",
          },
          messages: [],
          metadata: { models: [preparedModel] },
          sessionId: "control-ui-dynamic-catalog-convergence",
          thinkingLevel: null,
        },
        "sessions.list": sessionResponse(preparedLevels, 8_192),
      },
      models: [preparedModel],
      sessionKey,
    });

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
    const main = page.getByRole("main");
    const modelSelect = main.locator('[data-chat-model-select="true"]');
    const effortSelect = main.locator('[data-chat-thinking-select="true"]');

    await effortSelect.click();
    await expect.poll(() => main.locator('[data-chat-thinking-option="off"]').count()).toBe(1);
    expect(await main.locator('[data-chat-thinking-slider="true"]').count()).toBe(0);
    expect(await gateway.getRequests("models.list")).toHaveLength(1);

    await page.keyboard.press("Escape");
    await gateway.setSessionsListResponse(sessionResponse(discoveredLevels, 65_536));
    await gateway.setMethodResponse("models.list", { models: [discoveredModel] });
    const sessionListCount = (await gateway.getRequests("sessions.list", rosterMatch)).length;
    const sessionDescribeMatch = { key: sessionKey, agentId: "main" };
    const sessionDescribeCount = (
      await gateway.getRequests("sessions.describe", sessionDescribeMatch)
    ).length;
    await gateway.emitGatewayEvent("chat.metadata.changed", {});
    const modelsRequest = await gateway.waitForRequest("models.list", { after: 1 });
    expect(modelsRequest.params).toEqual({ view: "configured", agentId: "main", sessionKey });
    const refreshedSessionRequest = await gateway.waitForRequest("sessions.describe", {
      after: sessionDescribeCount,
      match: sessionDescribeMatch,
    });
    expect(refreshedSessionRequest.params).toEqual(sessionDescribeMatch);
    await modelSelect.click();
    expect(await gateway.getRequests("models.list")).toHaveLength(2);
    const modelOption = main.locator(`[data-chat-model-option="${modelKey}"]`);
    await expect.poll(() => modelOption.textContent()).toContain("262.1k");

    await page.keyboard.press("Escape");
    await effortSelect.click();
    const thinkingSlider = main.locator('[data-chat-thinking-slider="true"]');
    await expect
      .poll(() => thinkingSlider.getAttribute("data-chat-thinking-values"))
      .toBe("off,low,medium,high,xhigh");
    expect(await gateway.getRequests("sessions.list", rosterMatch)).toHaveLength(sessionListCount);

    await page.keyboard.press("Escape");
    await page.locator("openclaw-app-sidebar .sidebar-rail .sidebar-new-session").click();
    await expect.poll(() => new URL(page.url()).pathname).toBe("/new");
    const newSessionPage = page.locator("openclaw-new-session-page");
    await newSessionPage.waitFor();
    const newSessionModelSelect = newSessionPage.locator(
      '.new-session-page__composer [data-chat-model-select="true"]',
    );
    await expect.poll(() => newSessionModelSelect.getAttribute("aria-disabled")).toBe("false");
    await newSessionModelSelect.click();
    const newSessionModel = newSessionPage.locator(`[data-chat-model-option="${modelKey}"]`);
    await expect.poll(() => newSessionModel.textContent()).toContain("262.1k");
    await revealChatModelOption(newSessionModel);
    await expect.poll(() => newSessionModel.isVisible()).toBe(true);
  });
});
