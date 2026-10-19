import { expect, it } from "vitest";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import {
  chatSessionListResponse,
  controlUiSessionPath,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  expectRequestCountStable,
  installMockGateway,
  newChatPage,
  requireRecord,
  requireString,
} from "./chat-flow.test-support.ts";
import { runState } from "./chat-runtime-fixtures.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("drains an inactive agent outbox while the selected global agent is active", async () => {
    const page = await newChatPage(suite, {
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const activePane = page.locator(".chat-pane-cache__pane--active");
    const agentsList = {
      agents: [
        { id: "main", name: "Main" },
        { id: "work", name: "Work" },
      ],
      defaultId: "main",
      mainKey: "main",
      scope: "global",
    };
    const historyResponse = (agentId: "main" | "work", active: boolean) => ({
      messages: [],
      sessionId: `${agentId}-global-session`,
      sessionInfo: {
        ...runState(active, `${agentId}-active-run`),
        key: "global",
      },
      thinkingLevel: null,
    });
    const sessionsResponse = (active: boolean) =>
      chatSessionListResponse([
        {
          ...runState(active, "main-active-run"),
          key: "global",
          kind: "global",
          label: "Main Session",
          updatedAt: Date.now(),
        },
      ]);
    const historyCases = (workActive: boolean) => ({
      cases: (["work", "main"] as const).map((agentId) => ({
        match: { agentId, sessionKey: "global" },
        response: historyResponse(agentId, agentId === "main" || workActive),
      })),
    });
    const gateway = await installMockGateway(page, {
      sessionScope: "global",
      mainSessionKey: "global",
      methodResponses: {
        "agents.list": agentsList,
        "chat.history": historyCases(true),
        "chat.startup": {
          cases: (["work", "main"] as const).map((agentId) => ({
            match: { agentId },
            response: { ...historyResponse(agentId, agentId === "main"), agentsList },
          })),
        },
        "sessions.list": {
          cases: [
            { match: { agentId: "work" }, response: sessionsResponse(false) },
            { match: { agentId: "main" }, response: sessionsResponse(true) },
          ],
        },
      },
    });

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:work:main"));
    const composer = page.locator(".agent-chat__composer-combobox textarea");
    await composer.waitFor({ state: "visible", timeout: 10_000 });
    await gateway.setOnline(false);
    await page.locator(".agent-chat__input--offline").waitFor({ timeout: 10_000 });

    const prompt = "deliver the work outbox independently";
    await composer.fill(prompt);
    await page.getByRole("button", { name: "Send message" }).click();
    const queue = page.locator(".chat-queue");
    await queue.getByText("Waiting for reconnect").waitFor({ timeout: 10_000 });
    await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
    await evaluateControlUiContext(page, (application) => {
      application.agentSelection.set("main");
    });
    // A cold roster must not send the canonical global route back through its alias.
    const mainRoster = { agentId: "main", includeGlobal: true };
    await gateway.deferNext("sessions.list", mainRoster);
    await gateway.setOnline(true);
    await page
      .locator(".agent-chat__input--offline")
      .waitFor({ state: "detached", timeout: 10_000 });
    await expect
      .poll(() =>
        activePane.evaluate(
          (pane) => (pane as HTMLElement & { transcriptReady: boolean }).transcriptReady,
        ),
      )
      .toBe(true);
    await gateway.waitForRequest("sessions.list", { match: mainRoster });
    await gateway.resolveDeferred("sessions.list", sessionsResponse(true));

    await expect
      .poll(async () =>
        (await gateway.getRequests("sessions.list")).some(
          (entry) => requireRecord(entry.params).agentId === "main",
        ),
      )
      .toBe(true);
    await expect
      .poll(async () => (await gateway.getRequests("chat.history")).length)
      .toBeGreaterThan(0);
    expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    await gateway.deferNext("chat.send");
    await gateway.setMethodResponse("chat.history", historyCases(false));
    await gateway.emitGatewayEvent("sessions.changed", {
      ...runState(false, "work-active-run"),
      agentId: "work",
      key: "global",
      kind: "global",
    });

    const request = await gateway.waitForRequest("chat.send");
    const params = requireRecord(request.params);
    expect(params).toMatchObject({ agentId: "work", message: prompt, sessionKey: "global" });
    const runId = requireString(params.idempotencyKey, "inactive-agent outbox run id");
    await expectRequestCountStable(gateway, "chat.send", 1);
    const recoveryRequests = (await gateway.getRequests("chat.history"))
      .map((entry) => requireRecord(entry.params))
      .filter((historyParams) => Array.isArray(historyParams.inputRunIds));
    expect(recoveryRequests.length).toBeGreaterThan(0);
    for (const historyParams of recoveryRequests) {
      expect(historyParams).toMatchObject({
        agentId: "work",
        sessionKey: "global",
        inputRunIds: [runId],
      });
    }
    const workPath = controlUiSessionPath("agent:work:main");
    await evaluateControlUiContext(
      page,
      (application, pathname) => {
        application.agentSelection.set("work");
        application.navigate("chat", { pathname });
      },
      workPath,
    );
    await page.waitForURL((url) => url.pathname === workPath);
    await gateway.setHistoryMessages([
      {
        content: prompt,
        idempotencyKey: `${runId}:user`,
        role: "user",
        timestamp: Date.now(),
      },
    ]);
    await gateway.emitGatewayEvent("session.message", {
      agentId: "work",
      clientRunId: runId,
      hasActiveRun: true,
      message: {
        __openclaw: { id: "work-outbox-user", idempotencyKey: `${runId}:user`, seq: 1 },
        content: [{ text: prompt, type: "text" }],
        role: "user",
        timestamp: Date.now(),
      },
      messageId: "work-outbox-user",
      messageSeq: 1,
      sessionKey: "global",
      status: "running",
    });
    await activePane.locator(".chat-group.user").getByText(prompt).waitFor({ timeout: 10_000 });
    await gateway.resolveDeferred("chat.send", { runId, status: "started" });

    await gateway.emitGatewayEvent("chat", {
      agentId: "work",
      message: {
        content: [{ text: "Work outbox delivered.", type: "text" }],
        role: "assistant",
        timestamp: Date.now(),
      },
      runId,
      sessionKey: "global",
      state: "final",
    });
    await queue.waitFor({ state: "detached", timeout: 10_000 });
    // Retained panes also receive this conversation's events; assert its rendered owner.
    const reply = activePane
      .locator(".chat-group.assistant")
      .getByText("Work outbox delivered.", { exact: true });
    await reply.waitFor({ timeout: 10_000 });
    await expectRequestCountStable(gateway, "chat.send", 1);
    expect(await activePane.count()).toBe(1);
    expect(await reply.count()).toBe(1);
    const messages = await activePane.evaluate(
      (pane) => (pane as HTMLElement & { state: { chatMessages: unknown[] } }).state.chatMessages,
    );
    expect(messages.map(requireRecord).filter((message) => message.role === "assistant")).toEqual([
      expect.objectContaining({
        content: [{ text: "Work outbox delivered.", type: "text" }],
      }),
    ]);
  });
});
