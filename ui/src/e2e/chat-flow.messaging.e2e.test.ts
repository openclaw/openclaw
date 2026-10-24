import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  timedText,
  persistedText,
  sessionMessage,
  expectCount,
  chatDelta,
  chatFixture,
  composer as chatComposer,
  newChatPage,
  sendMessage,
  sessionState,
  transcript as chatTranscript,
} from "./chat-flow-fixtures.test-support.ts";
import {
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  expectRequestCountStable,
  installMockGateway,
  requireRecord,
  requireString,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
type Gateway = Awaited<ReturnType<typeof installMockGateway>>;
const emitSession = (gateway: Gateway, ...args: Parameters<typeof sessionMessage>) =>
  gateway.emitGatewayEvent("session.message", sessionMessage(...args));
const emitDelta = (gateway: Gateway, runId: string, text: string) =>
  gateway.emitGatewayEvent("chat", chatDelta(runId, text, "agent:main:main", { seq: 1 }));
const assistantText = (page: Page, text: string) =>
  page.locator(".chat-group.assistant .chat-text", { hasText: text });
const streamingText = (page: Page, text: string) =>
  page.locator(".chat-bubble.streaming", { hasText: text });
const runIdFrom = async (gateway: Gateway) =>
  requireString(
    requireRecord((await gateway.waitForRequest("chat.send")).params).idempotencyKey,
    "chat send idempotency key",
  );

const userPrecedesReply = (
  page: Page,
  promptText: string,
  replySelector: string,
  replyText: string,
) =>
  chatTranscript(page).evaluate(
    (thread, { prompt, selector, reply }) => {
      const find = (query: string, text: string) =>
        Array.from(thread.querySelectorAll(query)).find((row) => row.textContent?.includes(text));
      const user = find(".chat-group.user", prompt);
      const assistant = find(selector, reply);
      return Boolean(
        user &&
        assistant &&
        user.compareDocumentPosition(assistant) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
    },
    { prompt: promptText, selector: replySelector, reply: replyText },
  );

suite.define(() => {
  it.each([
    { draft: "Draft from a shared link", name: "a one-shot chat draft" },
    { draft: undefined, name: "an existing session URL" },
  ])("preserves remaining URL state while resolving $name", async ({ draft }) => {
    const { page } = await chatFixture(suite, { historyMessages: [] });
    const sessionUrl = new URL(controlUiSessionUrl(suite.server.baseUrl, "main"));
    if (draft !== undefined) {
      sessionUrl.searchParams.set("draft", draft);
    }
    sessionUrl.searchParams.set("panel", "details");
    sessionUrl.hash = "#pane";

    await page.goto(sessionUrl.href);
    const composer = chatComposer(page);
    await expect.poll(() => composer.inputValue()).toBe(draft ?? "");
    await expect.poll(() => new URL(page.url()).search).toBe("?panel=details");
    await expect.poll(() => new URL(page.url()).hash).toBe("#pane");
  });

  it("sends a spaced slash prefix as an ordinary chat message", async () => {
    const { page, gateway } = await chatFixture(suite);
    await page.goto(`${suite.server.baseUrl}chat`);
    const command = "/ pair qr";
    await sendMessage(page, command);
    const request = await gateway.waitForRequest("chat.send");
    expect(requireRecord(request.params).message).toBe(command);
  });

  it("adopts a browser-local prompt from a metadata-free gateway event without duplication", async () => {
    const { page, gateway } = await chatFixture(suite, {
      historyMessages: [],
      deferredMethods: ["chat.send"],
    });
    const prompt = "Keep my browser-local prompt synchronized.";
    await page.goto(`${suite.server.baseUrl}chat`);
    await sendMessage(page, prompt);

    const runId = await runIdFrom(gateway);
    await gateway.resolveDeferred("chat.send", { runId, status: "started" });
    const userRow = page.locator(".chat-group.user", { hasText: prompt });
    await userRow.waitFor({ timeout: 10_000 });

    await emitSession(
      gateway,
      timedText("user", prompt),
      "browser-local-authoritative-user",
      1,
      sessionState([runId], true, "running"),
      { clientRunId: runId },
    );

    await expectCount(userRow, 1);
    const finalText = "Browser prompt stayed synchronized.";
    await gateway.setHistoryMessages([
      persistedText("user", prompt, {
        id: "browser-local-authoritative-user",
        idempotencyKey: `${runId}:user`,
        seq: 1,
      }),
      persistedText("assistant", finalText, {
        id: "browser-local-authoritative-assistant",
        seq: 2,
        runId,
      }),
    ]);
    await gateway.emitChatFinal({ runId, text: finalText });
    await assistantText(page, finalText).waitFor({ timeout: 10_000 });
    await expectCount(userRow, 1);
  });

  it.each([
    { identity: "transcript metadata", includeMessageMetadata: true },
    { identity: "gateway event envelope", includeMessageMetadata: false },
  ])(
    "keeps another client's $identity user turn ahead of its already-streaming reply",
    async ({ includeMessageMetadata }) => {
      const { page, gateway } = await chatFixture(suite, { historyMessages: [] });
      const runId = "shared-session-tui-run";
      const prompt = "Sent from the other client.";
      const secondPrompt = "A distinct turn in the same shared run.";
      const partial = "Streaming into both clients.";
      const userMessage = timedText("user", prompt);
      const persistedUserMessage = {
        ...userMessage,
        __openclaw: { id: "shared-session-user", idempotencyKey: `${runId}:user`, seq: 1 },
      };
      const secondUserMessage = timedText("user", secondPrompt);
      const persistedSecondUserMessage = {
        ...secondUserMessage,
        __openclaw: { id: "shared-session-second-user", idempotencyKey: `${runId}:user`, seq: 2 },
      };
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      // Even an envelope-only event reads back with its canonical transcript identity.
      await gateway.setHistoryMessages([persistedUserMessage]);
      await emitDelta(gateway, runId, partial);
      await streamingText(page, partial).waitFor({ timeout: 10_000 });

      const sharedUserEvent = sessionMessage(
        includeMessageMetadata ? persistedUserMessage : userMessage,
        "shared-session-user",
        1,
        sessionState([runId], true, "running"),
        { clientRunId: includeMessageMetadata ? "conflicting-envelope-run" : runId },
      );
      await gateway.emitGatewayEvent("session.message", sharedUserEvent);

      const userRow = page.locator(".chat-group.user", { hasText: prompt });
      await userRow.waitFor({ timeout: 10_000 });
      expect(await userRow.count()).toBe(1);
      await gateway.emitGatewayEvent("session.message", sharedUserEvent);
      await expectCount(userRow, 1);
      await gateway.emitGatewayEvent("session.message", {
        ...sharedUserEvent,
        message: includeMessageMetadata ? persistedSecondUserMessage : secondUserMessage,
        messageId: "shared-session-second-user",
        messageSeq: 2,
      });
      const secondUserRow = page.locator(".chat-group.user", { hasText: secondPrompt });
      await secondUserRow.waitFor({ timeout: 10_000 });
      await expectCount(userRow, 1);
      await expectCount(secondUserRow, 1);
      await expect
        .poll(() => userPrecedesReply(page, prompt, ".chat-bubble.streaming", partial))
        .toBe(true);

      const finalText = "Both clients stayed synchronized.";
      await gateway.setHistoryMessages([
        persistedUserMessage,
        persistedSecondUserMessage,
        persistedText("assistant", finalText, { id: "shared-session-assistant", seq: 3, runId }),
      ]);
      await gateway.emitChatFinal({ runId, text: finalText });
      await assistantText(page, finalText).waitFor({ timeout: 10_000 });
      await expectCount(userRow, 1);
      await expectCount(secondUserRow, 1);
    },
  );

  it.each([
    { history: "up-to-date", includesPrompt: true },
    { history: "stale", includesPrompt: false },
  ])(
    "preserves a delayed persisted prompt ahead of a finalized reply with $history history",
    async ({ includesPrompt }) => {
      const { page, gateway } = await chatFixture(suite, { historyMessages: [] });
      const runId = "shared-session-finalized-run";
      const prompt = "The persisted prompt arrived after the final.";
      const finalText = "The reply was already finished.";
      const userMessage = persistedText("user", prompt, {
        id: "finalized-run-user",
        idempotencyKey: `${runId}:user`,
        seq: 1,
      });
      const assistantMessage = persistedText("assistant", finalText, {
        id: "finalized-run-assistant",
        seq: 2,
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      await emitDelta(gateway, runId, finalText);
      await streamingText(page, finalText).waitFor({ timeout: 10_000 });
      await gateway.emitChatFinal({ runId, text: finalText });
      await assistantText(page, finalText).waitFor({ timeout: 10_000 });
      await gateway.setHistoryMessages([userMessage, assistantMessage]);
      await gateway.deferNext("chat.history");
      await gateway.emitGatewayEvent(
        "session.message",
        sessionMessage(userMessage, "finalized-run-user", 1, sessionState([], false, "done"), {
          clientRunId: runId,
        }),
      );

      await expect
        .poll(() => userPrecedesReply(page, prompt, ".chat-group.assistant", finalText))
        .toBe(true);
      await gateway.resolveDeferred("chat.history", {
        messages: includesPrompt ? [userMessage, assistantMessage] : [assistantMessage],
        sessionId: "session:agent:main:main",
        thinkingLevel: null,
      });
      await expectCount(page.locator(".chat-group.user", { hasText: prompt }), 1);
    },
  );

  it("sends annotated /stop to the exact selected channel session and clears its working indicator", async () => {
    const { page } = await newChatPage(suite);
    const channelSessionKey = "agent:main:openclaw-weixin:direct:wechat-user";
    const gateway = await installMockGateway(page, {
      sessionKey: channelSessionKey,
      methodResponses: {
        "sessions.abort": { abortedRunId: null, ok: true, status: "aborted" },
        "sessions.list": chatSessionListResponse([
          {
            hasActiveRun: true,
            key: channelSessionKey,
            kind: "direct",
            label: "WeChat user",
            status: "running",
            updatedAt: Date.now(),
          },
        ]),
      },
    });
    await page.goto(controlUiSessionUrl(suite.server.baseUrl, channelSessionKey));
    const composer = chatComposer(page);
    await composer.waitFor({ state: "visible", timeout: 10_000 });
    await gateway.waitForRequest("sessions.list");
    const workingIndicator = page.locator(".chat-working-indicator");
    await workingIndicator.waitFor({ state: "visible", timeout: 10_000 });

    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent("openclaw:browser-annotation", {
          cancelable: true,
          detail: {
            modelContext: "Review the annotated page",
            dataUrl:
              "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=",
            fileName: "annotated-page.png",
            card: {
              title: "Annotated page",
              displayUrl: "example.com",
              markedRegionCount: 1,
              inspectedElement: false,
            },
          },
        }),
      );
    });
    await page.locator(".chat-attachment-thumb--browser-annotation").waitFor();

    await composer.fill("/stop");
    await page.getByRole("option", { name: /\/stop/ }).waitFor();
    await composer.press("Enter");

    const abortRequest = await gateway.waitForRequest("sessions.abort");
    expect(requireRecord(abortRequest.params)).toEqual({
      key: channelSessionKey,
      clearQueued: true,
    });
    await gateway.setSessionsListResponse(
      chatSessionListResponse([
        {
          activeRunIds: [],
          hasActiveRun: false,
          key: channelSessionKey,
          kind: "direct",
          label: "WeChat user",
          status: "running",
          updatedAt: Date.now(),
        },
      ]),
    );
    await gateway.emitGatewayEvent("sessions.changed", {
      activeRunIds: [],
      hasActiveRun: false,
      reason: "abort",
      sessionKey: channelSessionKey,
      status: "running",
      updatedAt: Date.now(),
    });
    await workingIndicator.waitFor({ state: "detached", timeout: 10_000 });
    await page.locator(".chat-attachment-thumb--browser-annotation").waitFor();
    await expectRequestCountStable(gateway, "chat.abort", 0);
    await expectRequestCountStable(gateway, "chat.send", 0);
    await expectCount(page.getByRole("listbox"), 0);
    expect(await composer.inputValue()).toBe("");
  });

  it("keeps the composer clear when a stale native input replay arrives after send", async () => {
    const { page, gateway } = await chatFixture(suite, {
      historyMessages: [timedText("assistant", "Ready for stale replay check.")],
    });
    await page.goto(`${suite.server.baseUrl}chat`);
    await page.getByText("Ready for stale replay check.").waitFor({ timeout: 10_000 });

    const prompt = "submitted message";
    const composer = chatComposer(page);
    await sendMessage(page, prompt);
    await gateway.waitForRequest("chat.send");
    expect(await composer.inputValue()).toBe("");

    const afterReplay = await composer.evaluate((element, submitted) => {
      const textarea = element as HTMLTextAreaElement;
      textarea.value = submitted;
      textarea.dispatchEvent(
        new InputEvent("input", { bubbles: true, data: submitted, inputType: "insertText" }),
      );
      return textarea.value;
    }, prompt);

    expect(afterReplay).toBe("");
    expect(await composer.inputValue()).toBe("");

    await composer.pressSequentially(prompt);
    expect(await composer.inputValue()).toBe(prompt);
  });
});
