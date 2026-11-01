import { expect, it } from "vitest";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { sendMessage } from "./chat-flow-fixtures.test-support.ts";
import {
  newChatPage,
  thinkingLevels,
  chatSessionListResponse,
  createChatFlowE2eSuite,
  expectRequestCountStable,
  controlUiSessionUrl,
  installMockGateway,
  requireRecord,
  waitForRequests,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const rosterMatch = { includeGlobal: true };
const sessionKey = "agent:main:session-a";

suite.define(() => {
  it("keeps send pending until reasoning and speed patches finish", async () => {
    const page = await newChatPage(suite);
    const roster = chatSessionListResponse();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": {
          ...roster,
          count: 1,
          sessions: [{ ...roster.sessions[0], fastMode: false, thinkingLevel: "high" }],
          defaults: {
            ...roster.defaults,
            thinkingDefault: "high",
            thinkingLevels: thinkingLevels("off", "low", "medium", "high"),
          },
        },
      },
      sessionKey,
    });

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));

    const main = page.getByRole("main");
    await main.locator('[data-chat-thinking-select="true"]').click();
    await gateway.deferNext("sessions.patch");
    const thinkingSlider = main.locator('[data-chat-thinking-slider="true"]');
    await expect.poll(() => thinkingSlider.isVisible()).toBe(true);
    await thinkingSlider.press("ArrowLeft");
    const firstPatch = await gateway.waitForRequest("sessions.patch");
    expect(requireRecord(firstPatch.params).thinkingLevel).toBe("medium");

    await gateway.deferNext("sessions.patch");
    await main.locator('[data-chat-speed-option="on"]').click();
    await expectRequestCountStable(gateway, "sessions.patch", 1);
    await page.keyboard.press("Escape");

    const prompt = "send with the new reasoning and speed";
    await sendMessage(page, prompt);
    await page.locator(".chat-queue").getByText("Applying chat settings").waitFor({
      timeout: 10_000,
    });
    expect(await gateway.getRequests("chat.send")).toHaveLength(0);

    const sessionListCount = (await gateway.getRequests("sessions.list", rosterMatch)).length;
    await gateway.resolveDeferred("sessions.patch", {});
    const patches = await waitForRequests(gateway, "sessions.patch", 2);
    expect(requireRecord(patches[1]?.params).fastMode).toBe(true);
    await expect
      .poll(async () => (await gateway.getRequests("sessions.list", rosterMatch)).length)
      .toBeGreaterThan(sessionListCount);
    expect(await gateway.getRequests("chat.send")).toHaveLength(0);

    await gateway.resolveDeferred("sessions.patch", {});
    const sendRequest = await gateway.waitForRequest("chat.send");
    expect(sendRequest.params).toMatchObject({ message: prompt, sessionKey });
  });

  it("dispatches after its settings refresh while a later roster refresh is still pending", async () => {
    const page = await newChatPage(suite);
    const gateway = await installMockGateway(page, {
      sessionKey,
      models: [{ id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai" }],
    });
    await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
    const main = page.getByRole("main");
    await main.locator('[data-chat-thinking-select="true"]').click();
    const listsBefore = (await gateway.getRequests("sessions.list", rosterMatch)).length;
    await gateway.deferNext("sessions.list", rosterMatch);
    await gateway.deferNext("sessions.list", rosterMatch);
    await main.locator('[data-chat-speed-option="on"]').click();
    await gateway.waitForRequest("sessions.patch");
    await waitForRequests(gateway, "sessions.list", listsBefore + 1, rosterMatch);
    await page.keyboard.press("Escape");
    await sendMessage(page, "send after my settings");
    await page.locator(".chat-queue").getByText("Applying chat settings").waitFor();
    expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    await evaluateControlUiContext(page, (application) => {
      void application.sessions.refresh({ force: true, backgroundHydrate: true });
    });
    await gateway.resolveDeferred("sessions.list");
    await waitForRequests(gateway, "sessions.list", listsBefore + 2, rosterMatch);
    const request = await gateway.waitForRequest("chat.send");
    expect(requireRecord(request.params).message).toBe("send after my settings");
    await gateway.emitChatFinal({
      runId: String(requireRecord(request.params).idempotencyKey),
      text: "Settings applied and message delivered.",
    });
    await page
      .locator(".chat-bubble")
      .getByText("Settings applied and message delivered.")
      .waitFor();
    await gateway.resolveDeferred("sessions.list");
  });
});
