// Control UI E2E tests cover chat run lifecycle behavior through the Gateway WebSocket.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContextOptions, Locator, Page } from "playwright";
import { afterEach, expect, it } from "vitest";
import { prepareChatHistoryFixture } from "../test-helpers/chat-activity-fixtures.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { openMockAbortableRun } from "./chat-run-lifecycle.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI chat run lifecycle",
});
const CHAT_RUN_STATUS_TOAST_DURATION_MS = 5_000;
const SESSION_EVENT_REFRESH_DEBOUNCE_MS = 5_000;
const rosterMatch = { includeGlobal: true };

// Browser contexts preserve test isolation; keep one process warm for this file.
let activePage: Page | undefined;

type Gateway = Awaited<ReturnType<typeof installMockGateway>>;
const mainSessionKey = "agent:main:main";
const draft = "keep this draft";
const noAbort = { ok: true, aborted: false, runIds: [] };
const noSessionAbort = { ok: true, abortedRunId: null, status: "no-active-run" };
function historyMessage(content: string, timestamp = Date.now(), role = "assistant") {
  return { role, content, timestamp };
}
function runningSession(runId: string) {
  return { activeRunIds: [runId], hasActiveRun: true, key: mainSessionKey };
}
function activeSession(runId: string, updatedAt = Date.now(), elapsed = 1_000) {
  return {
    ...runningSession(runId),
    kind: "direct",
    startedAt: updatedAt - elapsed,
    status: "running",
    updatedAt,
  };
}
async function openChat(options: Parameters<typeof installMockGateway>[1] = {}, clock = false) {
  const page = await newPage();
  if (clock) {
    await page.clock.install();
  }
  const gateway = await installMockGateway(page, options);
  await page.goto(`${suite.server.baseUrl}chat`);
  return { page, gateway };
}
async function openAbortable(runId: string) {
  const page = await newPage({});
  return { page, ...(await openMockAbortableRun(page, suite.server.baseUrl, runId)) };
}
type Abortable = Awaited<ReturnType<typeof openAbortable>>;
async function requestStop({ gateway, stop, sessionKey, runId, composer }: Abortable, after = 0) {
  await gateway.deferNext("chat.abort");
  await stop.click();
  const abort = await gateway.waitForRequest("chat.abort", { after });
  expect(abort.params).toEqual({ sessionKey, runId });
  await composer.fill(draft);
}
async function expectDraft(composer: Locator, stop: Locator, state: "visible" | "detached") {
  expect(await composer.inputValue()).toBe(draft);
  await composer.fill("");
  await stop.waitFor({ state });
}
async function expectReady(page: Page, composer: Locator, stop: Locator, exact = true) {
  await expectDraft(composer, stop, "detached");
  await composer.fill("next message");
  await sendButton(page, exact).waitFor({ state: "visible" });
}
function bubbleText(page: Page, text: string) {
  return page.locator(".chat-bubble").getByText(text, { exact: true });
}
function runIndicator(page: Page) {
  return page
    .locator(".sidebar-footer-bar__home .session-glyph")
    .getByRole("img", { name: "Active run" });
}
async function expectIdle(page: Page) {
  expect(await stopButton(page).count()).toBe(0);
  await expect.poll(() => runIndicator(page).count()).toBe(0);
}
async function newPage(
  options: BrowserContextOptions = { viewport: { height: 800, width: 1200 } },
) {
  const context = await suite.newBrowserContext(options);
  activePage = await context.newPage();
  return activePage;
}
function stopButton(page: Page) {
  return page.getByRole("button", { name: "Stop generating" });
}
function sendButton(page: Page, exact?: boolean) {
  return page.getByRole("button", {
    name: "Send message",
    ...(exact === undefined ? {} : { exact }),
  });
}
async function sendPrompt(page: Page, gateway: Gateway, prompt: string) {
  await page.locator(".agent-chat__input textarea").fill(prompt);
  await sendButton(page).click();
  const send = await gateway.waitForRequest("chat.send");
  const params = send.params as { idempotencyKey?: unknown };
  expect(typeof params.idempotencyKey).toBe("string");
  return params.idempotencyKey as string;
}
function completedHistory(sessionKey: string, runId: string, content: string, active = false) {
  return {
    messages: [{ role: "assistant", content }],
    sessionId: "session:" + sessionKey,
    sessionInfo: {
      key: sessionKey,
      sessionId: "session:" + sessionKey,
      kind: "direct",
      updatedAt: 2,
      hasActiveRun: active,
      activeRunIds: active ? [runId] : [],
      ...(active ? {} : { lastRunId: runId }),
      status: active ? "running" : "done",
    },
    inFlightRun: active ? { runId, text: "" } : null,
  };
}
async function startLifecycleRun(prompt: string) {
  const ready = "Ready for run lifecycle verification.";
  const { page, gateway } = await openChat(
    {
      historyMessages: [
        { role: "assistant", content: [{ type: "text", text: ready }], timestamp: Date.now() },
      ],
    },
    true,
  );
  await page.getByText(ready).waitFor({ timeout: 10_000 });
  await gateway.waitForRequest("sessions.list", { match: rosterMatch });
  const runId = await sendPrompt(page, gateway, prompt);
  await stopButton(page).waitFor();
  const mainSession = page.locator(".sidebar-footer-bar__home");
  await mainSession.waitFor({ state: "visible" });
  const emitActive = await deferRosterEvent(page, gateway);
  const activeUpdatedAt = await page.evaluate(() => Date.now());
  await emitActive({ ...activeSession(runId, activeUpdatedAt), reason: "lifecycle" });
  const mainSessionRunIndicator = runIndicator(page);
  await mainSessionRunIndicator.waitFor();
  return { page, gateway, runId, mainSession, mainSessionRunIndicator, activeUpdatedAt };
}
async function deferRosterEvent(page: Page, gateway: Gateway) {
  const before = (await gateway.getRequests("sessions.list", rosterMatch)).length;
  await gateway.deferNext("sessions.list", rosterMatch);
  return async (event: Record<string, unknown>) => {
    await gateway.emitGatewayEvent("sessions.changed", event);
    await page.clock.runFor(SESSION_EVENT_REFRESH_DEBOUNCE_MS);
    await expect
      .poll(async () => (await gateway.getRequests("sessions.list", rosterMatch)).length)
      .toBeGreaterThan(before);
  };
}

suite.define(() => {
  afterEach(async () => {
    if (activePage) {
      await suite.closeBrowserContext(activePage.context());
    }
    activePage = undefined;
  });

  it("excludes a reply-less failed turn's idle time from the next successful turn", async () => {
    const page = await newPage();
    const sessionKey = "agent:main:dashboard:failed-turn-elapsed";
    const gateway = await installMockGateway(page, { sessionKey });
    await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
    const composer = page.locator(".agent-chat__input textarea");
    await composer.fill("First attempt");
    // Freeze wall time without pausing the animation frames that publish sends.
    const firstStartedAt = Date.now();
    await page.clock.setFixedTime(firstStartedAt);
    const messages: Record<string, unknown>[] = [];
    const persistUser = async (text: string, timestamp: number, after: number) => {
      const send = await gateway.waitForRequest("chat.send", { after });
      expect(send.params).toMatchObject({ sessionKey, idempotencyKey: expect.any(String) });
      const { idempotencyKey: runId } = send.params as { idempotencyKey: string };
      const message = {
        ...historyMessage(text, timestamp, "user"),
        __openclaw: {
          id: `user-${after}`,
          idempotencyKey: `${runId}:user`,
          senderId: "operator",
        },
      };
      messages.push(message);
      await gateway.setHistoryMessages(messages);
      await gateway.emitGatewayEvent("session.message", {
        sessionKey,
        clientRunId: runId,
        message,
        messageId: message["__openclaw"].id,
        messageSeq: messages.length,
        activeRunIds: [runId],
        hasActiveRun: true,
      });
      await stopButton(page).waitFor();
      return runId;
    };
    await sendButton(page).click();
    const failedRunId = await persistUser("First attempt", firstStartedAt, 0);
    const diagnostic = "⚠️ 🛠️ Exec failed (exit 1): command failed near 🧭.";
    const renderedDiagnostic = "Exec failed (exit 1): command failed near 🧭.";
    await gateway.emitGatewayEvent("chat", {
      sessionKey,
      runId: failedRunId,
      state: "error",
      errorMessage: diagnostic,
    });
    const failedAlert = page.getByRole("alert").filter({ hasText: renderedDiagnostic });
    await failedAlert.waitFor();
    await failedAlert
      .locator("summary strong")
      .getByText("Couldn't finish this reply. Check the conversation before trying again.")
      .waitFor();
    expect(await failedAlert.locator("details").getAttribute("open")).toBeNull();
    await failedAlert.locator("summary").click();
    await failedAlert.getByLabel("Error details", { exact: true }).waitFor();
    expect(await failedAlert.getByLabel("Error details", { exact: true }).textContent()).toContain(
      renderedDiagnostic,
    );
    expect(await page.locator(".chat-group.assistant").count()).toBe(0);
    expect(await stopButton(page).count()).toBe(0);

    await page.clock.setFixedTime(firstStartedAt + 981_000);
    await composer.fill("Try again independently");
    await sendButton(page).click();
    const runId = await persistUser("Try again independently", firstStartedAt + 981_000, 1);
    expect(runId).not.toBe(failedRunId);
    await page.clock.setFixedTime(firstStartedAt + 982_000);
    const tool = {
      ...historyMessage("ok", firstStartedAt + 982_000, "toolResult"),
      toolName: "bash",
      toolCallId: "successful-tool",
      isError: false,
      __openclaw: { id: "successful-tool-result", runId },
    };
    messages.push(tool);
    await gateway.setHistoryMessages(messages);
    await gateway.emitGatewayEvent("session.message", {
      sessionKey,
      runId,
      message: tool,
      messageId: tool["__openclaw"].id,
      messageSeq: messages.length,
      activeRunIds: [runId],
      hasActiveRun: true,
    });
    await page.clock.setFixedTime(firstStartedAt + 994_000);
    const reply = {
      // Creation precedes the long final request; lifecycle owns completion.
      ...historyMessage("Success after the earlier failure.", firstStartedAt + 983_000),
      __openclaw: { id: "successful-reply", runId },
    };
    messages.push(reply);
    // The same canonical history must survive a full page reload, not just
    // the live terminal projection or its retained local timestamps.
    const completedSession = {
      key: sessionKey,
      sessionId: `session:${sessionKey}`,
      kind: "direct",
      hasActiveRun: false,
      activeRunIds: [],
      status: "done",
      lastRunId: runId,
      startedAt: firstStartedAt + 981_000,
      endedAt: firstStartedAt + 994_000,
      runtimeMs: 13_000,
      updatedAt: firstStartedAt + 994_000,
    };
    // A terminal event also refreshes the roster; every read must retain its timing.
    await gateway.setSessionsListResponse({ sessions: [completedSession] });
    await gateway.setMethodResponse("chat.history", {
      ...prepareChatHistoryFixture(messages),
      sessionId: `session:${sessionKey}`,
      sessionInfo: completedSession,
    });
    await gateway.emitGatewayEvent("agent", {
      stream: "usage",
      runId,
      seq: 1,
      sessionKey,
      data: { outputTokens: 42 },
      ts: completedSession.endedAt,
    });
    await gateway.emitGatewayEvent("chat", { sessionKey, runId, state: "final", message: reply });
    await gateway.emitGatewayEvent("sessions.changed", {
      ...completedSession,
      reason: "lifecycle",
    });
    const replyBody = page
      .locator(".chat-group.assistant")
      .getByText(reply.content, { exact: true });
    await replyBody.waitFor();
    const operationLabel = page.locator(".chat-work-group .chat-activity-group__label");
    const refreshedSession = await evaluateControlUiContext(
      page,
      async (application, key) => {
        const sessions = application.sessions;
        await sessions.refresh({ agentId: "main", force: true });
        return sessions.state.result?.sessions.find((row) => row.key === key);
      },
      sessionKey,
    );
    expect(refreshedSession).toMatchObject({ lastRunId: runId, runtimeMs: 13_000 });
    await operationLabel.waitFor();
    await expect.poll(() => operationLabel.textContent()).toBe("Worked for 13 seconds");
    expect(await stopButton(page).count()).toBe(0);

    const successorSession = {
      ...completedSession,
      lastRunId: "background-successor",
      runtimeMs: 27_000,
      updatedAt: completedSession.updatedAt + 30_000,
    };
    await gateway.setSessionsListResponse({ sessions: [successorSession] });
    await gateway.emitGatewayEvent("sessions.changed", {
      sessionKey,
      reason: "lifecycle",
      session: successorSession,
    });
    await evaluateControlUiContext(page, async (application) => {
      await application.sessions.refresh({ agentId: "main", force: true });
    });
    const screenshot = await takeControlUiScreenshotFrame(
      page,
      page.locator(".chat-thread"),
      [operationLabel, replyBody],
      { animations: "disabled" },
    );
    await writeFile(join(suite.artifactDir, "worked-duration.png"), screenshot.png);
    console.log("WORKED_DURATION_PROOF", suite.artifactDir);
    await expect.poll(() => operationLabel.textContent()).toBe("Worked for 13 seconds");
    expect(await page.locator(".chat-turn-recap").allTextContents()).not.toEqual(
      expect.arrayContaining([expect.stringContaining("Done in")]),
    );
    expect(await page.locator(".chat-turn-recap").textContent()).toBe("42 output tokens");
    await gateway.setSessionsListResponse({ sessions: [completedSession] });

    await page.reload();
    await gateway.waitForRequest("chat.startup");
    await replyBody.waitFor();
    await operationLabel.waitFor();
    expect(await operationLabel.textContent()).toBe("Worked for 13 seconds");
    expect(await page.locator(".chat-group.user").count()).toBe(2);
    await operationLabel.click();
    await expect
      .poll(() => page.locator(".chat-work-group > button").getAttribute("aria-expanded"))
      .toBe("true");
    await page.locator(".chat-thread").getByText("bash", { exact: true }).waitFor();
    expect(await replyBody.isVisible()).toBe(true);
  });

  it("keeps a continuing run inside its latest assistant reply", async () => {
    const { page } = await openChat({
      historyMessages: [historyMessage("First result is ready.", Date.now() - 1_000)],
      inFlightRun: { runId: "run-continuing", text: "" },
      sessionInfo: runningSession("run-continuing"),
    });

    const assistantGroup = page.locator(".chat-group.assistant");
    await assistantGroup.getByText("First result is ready.", { exact: true }).waitFor();
    await assistantGroup.locator(".chat-working-indicator--continuation").waitFor();

    expect(await assistantGroup.count()).toBe(1);
    expect(await page.locator(".chat-reading-indicator").count()).toBe(0);
    expect(
      await assistantGroup.getByText("Waiting for turn to start…", { exact: true }).count(),
    ).toBe(1);
  });

  it("keeps a different active run in its own status row", async () => {
    const { page } = await openChat({
      historyMessages: [
        {
          ...historyMessage("Older run result.", Date.now() - 1_000),
          __openclaw: { id: "older-result", idempotencyKey: "older-run" },
        },
      ],
      inFlightRun: { runId: "newer-run", text: "" },
      sessionInfo: runningSession("newer-run"),
    });

    await page.getByText("Older run result.", { exact: true }).waitFor();
    await page.locator(".chat-reading-indicator").waitFor();

    expect(await page.locator(".chat-group.assistant").count()).toBe(2);
    expect(
      await page
        .locator(".chat-group.assistant", { hasText: "Older run result." })
        .locator(".chat-working-indicator--continuation")
        .count(),
    ).toBe(0);
  });

  it("restores only the unpersisted assistant response after reconnecting", async () => {
    const { page } = await openChat({
      historyMessages: [
        historyMessage("Continue working.", Date.now() - 2_000, "user"),
        historyMessage("Saved opening.", Date.now() - 1_000),
      ],
      inFlightRun: {
        runId: "run-reconnected",
        text: "Still working after reconnect.",
      },
      sessionInfo: runningSession("run-reconnected"),
    });

    await page.getByText("Saved opening.", { exact: true }).waitFor();
    const stream = page.locator(".chat-bubble.streaming", {
      hasText: "Still working after reconnect.",
    });
    await stream.waitFor({ state: "visible" });

    expect(await page.getByText("Saved opening.", { exact: true }).count()).toBe(1);
    expect(await stream.textContent()).not.toContain("Saved opening.");
    await stopButton(page).waitFor();
  });

  it("queues an exact-run Stop while offline and replays it after reconnecting", async () => {
    const page = await newPage({});
    const sessionKey = "agent:main:main";
    const gateway = await installMockGateway(page, { sessionKey });

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
    const runId = await sendPrompt(page, gateway, "keep this run stoppable");
    const stop = stopButton(page);
    await stop.waitFor({ state: "visible" });
    const composer = page.locator(".agent-chat__input textarea");

    await gateway.setOnline(false);
    await expect
      .poll(() => page.evaluate(() => window.openclawControlUi?.snapshot().gatewayPhase))
      .toBe("reconnecting");
    await stop.waitFor({ state: "visible" });
    expect(await stop.isEnabled()).toBe(true);

    await stop.click();
    expect(await gateway.getRequests("chat.abort")).toHaveLength(0);
    await composer.fill("keep this draft");
    expect(await composer.inputValue()).toBe("keep this draft");

    await gateway.setOnline(true);
    const abort = await gateway.waitForRequest("chat.abort");
    expect(abort.params).toEqual({ runId, sessionKey });
    await stop.waitFor({ state: "detached" });
    expect(await gateway.getRequests("chat.abort")).toHaveLength(1);
    expect(await composer.inputValue()).toBe("keep this draft");
  });

  it("restores stale Stop through a terminal mock-Gateway history response", async () => {
    const run = await openAbortable("finished-run");
    const { page, gateway, sessionKey, runId, stop, composer } = run;
    // Change only the mock server's next snapshot after the browser observes activity.
    // No terminal event reaches the page; Stop must request the new history.
    await gateway.setMethodResponse(
      "chat.history",
      completedHistory(sessionKey, runId, "The completed reply."),
    );
    const historyCount = (await gateway.getRequests("chat.history")).length;
    await requestStop(run);
    await gateway.resolveDeferred("chat.abort", noAbort);
    await gateway.waitForRequest("chat.history", { after: historyCount });
    await bubbleText(page, "The completed reply.").waitFor();
    await expectReady(page, composer, stop, false);
    expect(await gateway.getRequests("chat.abort")).toHaveLength(1);
  });

  it("keeps a finalizing mock-Gateway run active after a no-op Stop refresh", async () => {
    const run = await openAbortable("finalizing-run");
    const { page, gateway, sessionKey, runId, stop, composer } = run;
    const toolEvent = (seq: number, data: Record<string, unknown>) =>
      gateway.emitGatewayEvent("agent", {
        runId,
        sessionKey,
        seq,
        stream: "tool",
        ts: Date.now(),
        data: { toolCallId: "finalizing-check", name: "exec", ...data },
      });
    await toolEvent(1, { phase: "start", args: { command: "verify-finalization" } });
    await toolEvent(2, { phase: "update", partialResult: "Cleanup is still in progress." });
    const runningTool = page
      .locator(".chat-tool-row--running")
      .filter({ hasText: "verify-finalization" });
    await runningTool.waitFor({ state: "visible" });
    await gateway.setMethodResponse(
      "chat.history",
      completedHistory(sessionKey, runId, "The reply is waiting for cleanup.", true),
    );
    const historyCount = (await gateway.getRequests("chat.history")).length;
    await requestStop(run);
    await gateway.resolveDeferred("chat.abort", noAbort);
    await gateway.waitForRequest("chat.history", { after: historyCount });
    await bubbleText(page, "The reply is waiting for cleanup.").waitFor();
    await runningTool.waitFor({ state: "visible" });
    expect(await runningTool.count()).toBe(1);
    await page.locator(".chat-working-indicator").waitFor({ state: "visible" });
    await expectDraft(composer, stop, "visible");
    expect(await sendButton(page, true).count()).toBe(0);
  });

  it("keeps an accepted mock-Gateway abort owned until its terminal event", async () => {
    const run = await openAbortable("live-abort-run");
    const { page, gateway, sessionKey, runId, stop, composer } = run;
    const historyCount = (await gateway.getRequests("chat.history")).length;
    await requestStop(run);
    // Deferred responses do not synthesize chat.abort lifecycle events.
    await gateway.resolveDeferred("chat.abort", { ok: true, aborted: true, runIds: [runId] });
    await page.locator(".chat-working-indicator").waitFor({ state: "visible" });
    // An answer retires visual activity, not the accepted abort's run ownership.
    await gateway.emitGatewayEvent("chat", {
      sessionKey,
      runId,
      state: "delta",
      deltaText: "Waiting for the accepted abort to settle.",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Waiting for the accepted abort to settle." }],
      },
    });
    await page.getByText("Waiting for the accepted abort to settle.", { exact: false }).waitFor();
    const interrupted = page.locator(".chat-bubble [role=status]", {
      hasText: "Interrupted",
    });
    expect(await interrupted.count()).toBe(0);
    await page.locator(".chat-working-indicator").waitFor({ state: "detached" });
    expect(await composer.inputValue()).toBe("keep this draft");
    expect(await gateway.getRequests("chat.history")).toHaveLength(historyCount);
    await composer.fill("");
    await stop.waitFor({ state: "visible" });
    await composer.fill("keep this draft");
    expect(await interrupted.count()).toBe(0);
    await gateway.emitGatewayEvent("chat", { sessionKey, runId, state: "aborted" });
    await page.locator(".chat-working-indicator").waitFor({ state: "detached" });
    await expectReady(page, composer, stop);
    await interrupted.waitFor({ state: "visible" });
    expect(await interrupted.count()).toBe(1);
    expect(await page.getByLabel("Run status: Interrupted").count()).toBe(0);
    expect(await page.locator(".agent-chat__run-status-announcement").textContent()).toBe(
      "Interrupted",
    );
  });

  it("retains stale Stop after a mock-Gateway history error and recovers on the next Stop", async () => {
    const run = await openAbortable("refresh-retry-run");
    const { page, gateway, sessionKey, runId, stop, composer } = run;
    const historyCount = (await gateway.getRequests("chat.history")).length;
    await gateway.deferNext("chat.history");
    await requestStop(run);
    await gateway.resolveDeferred("chat.abort", noAbort);
    await gateway.waitForRequest("chat.history", { after: historyCount });
    await gateway.rejectDeferred("chat.history", {
      code: "UNAVAILABLE",
      message: "History is temporarily unavailable.",
    });
    const error = page
      .getByRole("status")
      .filter({ hasText: "History is temporarily unavailable." });
    await error.waitFor();
    expect(await composer.inputValue()).toBe("keep this draft");
    await page.getByText("The fixture run is still working.", { exact: true }).waitFor();
    await composer.fill("");
    await stop.waitFor({ state: "visible" });

    await gateway.setMethodResponse(
      "chat.history",
      completedHistory(sessionKey, runId, "The reply recovered after retry."),
    );
    const retryHistoryCount = (await gateway.getRequests("chat.history")).length;
    const abortCount = (await gateway.getRequests("chat.abort")).length;
    await requestStop(run, abortCount);
    await gateway.resolveDeferred("chat.abort", noAbort);
    await gateway.waitForRequest("chat.history", { after: retryHistoryCount });
    await bubbleText(page, "The reply recovered after retry.").waitFor();
    await error.waitFor({ state: "detached" });
    await expectReady(page, composer, stop);
  });

  it.each(["direct", "descendant"] as const)(
    "refreshes cached %s activity after a session-only mock-Gateway Stop",
    async (activity) => {
      const page = await newPage({});
      const sessionKey = "agent:main:main";
      const activeUpdatedAt = Date.now();
      const sessionInfo = {
        key: sessionKey,
        kind: "direct",
        updatedAt: activeUpdatedAt,
        hasActiveRun: activity === "direct",
        hasActiveSubagentRun: activity === "descendant",
        status: activity === "direct" ? "running" : "done",
      };
      const gateway = await installMockGateway(page, {
        sessionKey,
        sessions: [sessionInfo],
        sessionInfo,
        methodResponses: {
          "sessions.abort": noSessionAbort,
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const stop = stopButton(page);
      const composer = page.locator(".agent-chat__input textarea");
      await stop.waitFor({ state: "visible" });
      const finishedSession = {
        key: sessionKey,
        sessionId: `session:${sessionKey}`,
        kind: "direct",
        updatedAt: activeUpdatedAt + 1,
        hasActiveRun: false,
        hasActiveSubagentRun: false,
        activeRunIds: [],
        status: "done",
      };
      const historyCount = (await gateway.getRequests("chat.history")).length;
      await gateway.deferNext("sessions.abort");
      await stop.click();
      const abort = await gateway.waitForRequest("sessions.abort");
      expect(abort.params).toEqual({ key: sessionKey, clearQueued: true });
      expect(await gateway.getRequests("chat.abort")).toHaveLength(0);
      // Post-Stop reads begin when the Gateway answers Stop. Publishing them earlier
      // lets a still-pending startup read settle the run before Stop is clicked.
      await gateway.setMethodResponse("chat.history", {
        messages: [{ role: "assistant", content: "Cached activity has finished." }],
        sessionId: `session:${sessionKey}`,
        sessionInfo: finishedSession,
      });
      await gateway.deferNext("chat.history");
      await composer.fill("keep this draft");
      await gateway.resolveDeferred("sessions.abort", noSessionAbort);
      await gateway.waitForRequest("chat.history", { after: historyCount });
      // A newer sidebar read may publish while Stop's history is still pending.
      await evaluateControlUiContext(page, async (application) => {
        await application.sessions.refreshList({ force: true });
      });
      await gateway.resolveDeferred("chat.history");
      await bubbleText(page, "Cached activity has finished.").waitFor();
      await expectReady(page, composer, stop);
    },
  );

  it("shows compaction savings and live working time", async () => {
    const page = await newPage();
    await page.clock.install();
    const gateway = await installMockGateway(page, {
      historyMessages: [
        {
          role: "system",
          timestamp: Date.now() - 1_000,
          __openclaw: {
            kind: "compaction",
            id: "compact-entry-1",
            tokensBefore: 900_000,
            tokensAfter: 24_700,
          },
        },
      ],
    });

    await page.goto(`${suite.server?.baseUrl ?? ""}chat`);
    await page.getByText("saved 875.3k tokens", { exact: true }).waitFor();
    await page.locator(".agent-chat__input textarea").fill("keep working");
    // Fix wall time without freezing the mock ACK and rendering timers.
    const startedAt = Date.now();
    await page.clock.setFixedTime(startedAt);
    await sendButton(page).click();
    await gateway.waitForRequest("chat.send");
    await page.locator(".chat-working-indicator").waitFor();

    await page.clock.setFixedTime(startedAt + 177_000);

    await expect
      .poll(() => page.locator(".chat-working-indicator__elapsed").textContent())
      .toBe("2m 57s");
    const workingLabel = page.locator(".chat-working-indicator__status > span:first-child");
    expect(await workingLabel.textContent()).toBe("Waiting for turn to start…");
    expect(
      await page.locator(".chat-working-indicator__status > span:not(.sr-only)").allTextContents(),
    ).toEqual(["Waiting for turn to start…", "·"]);
  });

  it.each(["final", "error"] as const)(
    "clears shared session activity when chat %s arrives first",
    async (terminalState) => {
      const { page, gateway, runId, mainSession, mainSessionRunIndicator, activeUpdatedAt } =
        await startLifecycleRun("finish this run");
      const diagnostic =
        "Provider request failed: session store unavailable. Retry after recovery.";
      if (terminalState === "error") {
        const readMatch = { key: "agent:main:main", unread: false };
        const readsBeforeError = (await gateway.getRequests("sessions.patch", readMatch)).length;
        // Inspect terminal attention before the visible pane acknowledges it as read.
        await gateway.deferNext("sessions.patch", readMatch);
        await gateway.emitGatewayEvent("chat", {
          runId,
          sessionKey: "agent:main:main",
          state: "error",
          errorMessage: diagnostic,
        });
        try {
          await gateway.waitForRequest("sessions.patch", {
            after: readsBeforeError,
            match: readMatch,
          });
          await page.getByRole("alert").filter({ hasText: diagnostic }).waitFor();
          await mainSession.locator('[data-session-attention="error"]').waitFor();
          expect(
            await mainSession.locator("[data-session-attention=error]").getAttribute("aria-label"),
          ).toContain(diagnostic);
          expect(await stopButton(page).count()).toBe(0);
          await expect.poll(() => mainSessionRunIndicator.count()).toBe(0);
        } finally {
          try {
            await gateway.resolveDeferred("sessions.patch");
          } finally {
            await gateway.resolveDeferred("sessions.list");
          }
        }
        return;
      }
      await gateway.emitChatFinal({ runId, text: "Run complete." });
      await bubbleText(page, "Run complete.").waitFor();
      await expect.poll(() => mainSessionRunIndicator.count()).toBe(0);
      const staleActiveLabel = "Main stale active snapshot";
      await gateway.resolveDeferred("sessions.list", {
        count: 1,
        defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
        path: "",
        sessions: [
          {
            ...activeSession(runId, activeUpdatedAt),
            displayName: staleActiveLabel,
            label: staleActiveLabel,
            model: "gpt-5.5",
            modelProvider: "openai",
          },
        ],
        ts: activeUpdatedAt,
      });
      await page.locator(".chat-pane__session-title", { hasText: staleActiveLabel }).waitFor();
      await expectIdle(page);

      const staleUpdatedAt = await page.evaluate(() => Date.now());
      const emitStale = await deferRosterEvent(page, gateway);
      await emitStale({
        ...activeSession(runId, staleUpdatedAt),
        reason: "lifecycle",
      });
      await expectIdle(page);
      await gateway.resolveDeferred("sessions.list");

      await page.clock.fastForward(CHAT_RUN_STATUS_TOAST_DURATION_MS + 250);
      expect(await stopButton(page).count()).toBe(0);
      expect(await mainSessionRunIndicator.count()).toBe(0);

      // Event timestamps must follow the page's virtual clock so freshness checks
      // see the same elapsed suppression window that the UI just observed.
      const otherSessionUpdatedAt = await page.evaluate(() => Date.now());
      const emitOther = await deferRosterEvent(page, gateway);
      await emitOther({
        key: "agent:main:another-session",
        kind: "direct",
        label: "Another session",
        reason: "lifecycle",
        updatedAt: otherSessionUpdatedAt,
      });
      await expectIdle(page);
      await gateway.resolveDeferred("sessions.list");

      // Re-publish after the former 10-second suppression window. The completed
      // run identity stays terminal until the Gateway publishes different state.
      await page.clock.fastForward(CHAT_RUN_STATUS_TOAST_DURATION_MS + 250);
      const lateStaleUpdatedAt = await page.evaluate(() => Date.now());
      const emitLateStale = await deferRosterEvent(page, gateway);
      await emitLateStale({
        ...activeSession(runId, lateStaleUpdatedAt, 11_000),
        reason: "lifecycle",
      });
      await expectIdle(page);
      await gateway.resolveDeferred("sessions.list");
    },
  );

  it("does not announce Done when a yielded parent is waiting for continuation", async () => {
    const { page, gateway, runId } = await startLifecycleRun("restart and continue");
    const finalText = "The gateway will restart; I will resume verification afterward.";
    await gateway.emitGatewayEvent("chat", {
      message: {
        content: [{ text: finalText, type: "text" }],
        role: "assistant",
        timestamp: Date.now(),
      },
      runId,
      sessionKey: "agent:main:main",
      state: "final",
      stopReason: "end_turn",
      yielded: true,
    });

    await page.locator(".chat-thread-inner").getByText(finalText, { exact: true }).waitFor();
    await expectIdle(page);
    await expect
      .poll(() => page.locator(".agent-chat__run-status-announcement").textContent())
      .toBe("");
    await gateway.resolveDeferred("sessions.list");
  });

  it("renders a safe self-abort diagnostic without leaving stale composer status", async () => {
    const { page, gateway } = await openChat();
    const runId = await sendPrompt(page, gateway, "run the edit");
    const diagnostic = "edit tool validation failed: edits: must be an array";

    await gateway.emitGatewayEvent("chat", {
      errorMessage: diagnostic,
      runId,
      sessionKey: "agent:main:main",
      state: "aborted",
    });

    const alert = page.getByRole("alert").filter({ hasText: diagnostic });
    await alert.waitFor();
    expect((await alert.textContent())?.trim()).toContain(`Error: ${diagnostic}`);
    expect(await page.getByLabel("Run status: Interrupted").count()).toBe(0);
    expect(await stopButton(page).count()).toBe(0);
  });
});
