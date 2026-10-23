import type { Locator, Page } from "playwright";
import { assert, expect, it } from "vitest";
import { outboxStorageScope } from "../lib/chat/outbox-payload-store.runtime.ts";
import { storageTargetForGateway, storedChatOutboxScopeKey } from "../lib/chat/outbox-store.ts";
import type { StoredComposerState } from "../lib/chat/outbox-store.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import {
  createChatFlowE2eSuite,
  chatSessionListResponse,
  controlUiSessionPath,
  controlUiSessionUrl,
  expectRequestCountStable,
  installMockGateway,
  newChatPage,
  requireRecord,
  requireString,
} from "./chat-flow.test-support.ts";
import {
  countOutboxPayloads,
  readOutboxQueue,
  readOutboxPayloadBytes,
  sizedOutboxPng,
} from "./chat-outbox-payloads.test-support.ts";
import { runState } from "./chat-runtime-fixtures.test-support.ts";

const suite = createChatFlowE2eSuite();
const rosterMatch = { includeGlobal: true };
type OutboxHost = Parameters<typeof outboxStorageScope>[0];
const largePngBytes = 2_404_765;
const smallPngBytes = 25_536;
const storageError =
  "Could not store this message for reconnect. Free browser storage or reconnect before sending.";

async function expectImages(images: Locator, count: number) {
  await expect.poll(() => images.count()).toBe(count);
  await expect
    .poll(() =>
      images.evaluateAll((items) =>
        items.every(
          (image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0,
        ),
      ),
    )
    .toBe(true);
}

async function readImageBytes(images: Locator) {
  return images.evaluateAll((items) =>
    Promise.all(
      items.map(async (image) => {
        const bytes = new Uint8Array(
          await (await fetch((image as HTMLImageElement).src)).arrayBuffer(),
        );
        let binary = "";
        for (const byte of bytes) {
          binary += String.fromCharCode(byte);
        }
        return btoa(binary);
      }),
    ),
  );
}

async function observeMockSends(page: Page) {
  return page.evaluateHandle(() => {
    const sends: Array<{
      message: string;
      queueMode?: string;
      sessionKey: string;
      runId: string;
      durableBeforeSend: boolean;
      storedSendState?: string;
      attachments: Array<{ fileName: string; mimeType: string; sizeBytes: number }>;
    }> = [];
    // oxlint-disable-next-line typescript/unbound-method -- Preserve the mock method for call(this, raw) and restore it on teardown.
    const send = WebSocket.prototype.send;
    // Observe the existing mock transport synchronously; storage and admission
    // remain native. Reading after chat.send alone cannot prove admission order.
    WebSocket.prototype.send = function (raw) {
      if (typeof raw === "string") {
        const frame = JSON.parse(raw) as {
          method?: string;
          params: {
            message: string;
            queueMode?: string;
            sessionKey: string;
            idempotencyKey: string;
            attachments?: Array<{ fileName: string; mimeType: string; content: string }>;
          };
        };
        if (frame.method === "chat.send") {
          const params = frame.params;
          const queue = Object.keys(sessionStorage)
            .filter((key) => key.startsWith("openclaw.control.chatComposer.v4:"))
            .flatMap((key) => {
              const stored = JSON.parse(sessionStorage.getItem(key)!) as StoredComposerState;
              return Object.values(stored.sessions).flatMap((session) => session.queue ?? []);
            });
          const persisted = queue.find((item) => item.sendRunId === params.idempotencyKey);
          const attachments = params.attachments ?? [];
          sends.push({
            message: params.message,
            queueMode: params.queueMode,
            sessionKey: params.sessionKey,
            runId: params.idempotencyKey,
            durableBeforeSend:
              persisted?.text === params.message &&
              persisted.queueMode === params.queueMode &&
              persisted.attachments?.length === attachments.length &&
              attachments.every((attachment, index) => {
                const stored = persisted.attachments?.[index];
                return (
                  stored?.fileName === attachment.fileName &&
                  stored.mimeType === attachment.mimeType &&
                  !stored.dataUrl &&
                  Boolean(persisted.attachmentPayload?.key)
                );
              }),
            storedSendState: persisted?.sendState,
            attachments: attachments.map((attachment) => ({
              fileName: attachment.fileName,
              mimeType: attachment.mimeType,
              sizeBytes: atob(attachment.content).length,
            })),
          });
        }
      }
      return send.call(this, raw);
    };
    return {
      sends,
      dispose: () => {
        WebSocket.prototype.send = send;
      },
    };
  });
}

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
  it("releases a retained queued send after the canonical session list records idle", async () => {
    const page = await newChatPage(suite);
    const firstKey = "agent:main:thread:aaaaaaaa-1111-4111-8111-111111111111";
    const secondKey = "agent:main:thread:bbbbbbbb-2222-4222-8222-222222222222";
    const sessions = (idle: boolean) =>
      chatSessionListResponse([
        {
          key: firstKey,
          kind: "direct",
          label: "Instant A",
          updatedAt: idle ? 3 : 2,
          activeRunIds: idle ? [] : ["server-run"],
          hasActiveRun: !idle,
          status: idle ? "done" : "running",
          ...(idle ? { lastRunId: "server-run" } : {}),
        },
        { key: secondKey, kind: "direct", label: "Instant B", updatedAt: 1 },
      ]);
    const activeSessions = sessions(false);
    const idleSessions = sessions(true);
    const title = (name: string) =>
      page.locator(".chat-pane-cache__pane--visible .chat-pane__session-title").getByText(name);
    const switchTo = (key: string) =>
      page
        .locator(
          `.sidebar-recent-session[data-session-key="${key}"] a.sidebar-recent-session__link`,
        )
        .click();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "chat.history": {
          messages: [],
          sessionInfo: { hasActiveRun: false, status: "done" },
          thinkingLevel: null,
        },
        "sessions.list": activeSessions,
      },
      sessionKey: firstKey,
    });

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, firstKey));
    await page.locator(`.sidebar-recent-session[data-session-key="${secondKey}"]`).waitFor();
    await title("Instant A").waitFor();
    await page.waitForTimeout(500);
    const initialListCount = (await gateway.getRequests("sessions.list", rosterMatch)).length;
    const initialMetadataCount = (await gateway.getRequests("chat.metadata")).length;
    await gateway.deferNext("sessions.list", rosterMatch);

    await switchTo(secondKey);
    await title("Instant B").waitFor();
    expect(await gateway.getRequests("sessions.list", rosterMatch)).toHaveLength(initialListCount);
    expect(await gateway.getRequests("chat.metadata")).toHaveLength(initialMetadataCount);

    const owner = await page.locator('openclaw-chat-pane[aria-hidden="false"]').evaluate((pane) => {
      const state = (pane as HTMLElement & { state: OutboxHost }).state;
      const gatewayUrl = state.settings?.gatewayUrl;
      const client = state.client;
      if (!gatewayUrl || !client?.recoveryScopeReady || !client.recoveryScope) {
        throw new Error("Expected an admitted queue owner");
      }
      return { gatewayUrl, recoveryScope: client.recoveryScope };
    });
    const target = storageTargetForGateway(owner.gatewayUrl, owner.recoveryScope);
    const storageScope = outboxStorageScope({
      settings: { gatewayUrl: owner.gatewayUrl },
      client: { recoveryScope: owner.recoveryScope, recoveryScopeReady: true },
      connected: true,
    });
    if (!storageScope) {
      throw new Error("Expected an owned queue stamp");
    }
    const store = {
      version: 4,
      gatewayOwner: target.gatewayOwner,
      recovery: {},
      sessions: {
        [storedChatOutboxScopeKey({ sessionKey: firstKey, agentId: "main" })]: {
          updatedAt: Date.now(),
          queue: [
            {
              id: "queued-before-switch",
              text: "flush after idle reconciliation",
              createdAt: Date.now(),
              sendState: "waiting-idle",
              sendAttempts: 0,
              sessionKey: firstKey,
              agentId: "main",
              storageScope,
            },
          ],
        },
      },
    };
    await page.evaluate(
      ({ key, store: snapshot }) => {
        sessionStorage.setItem(key, JSON.stringify(snapshot));
        window.dispatchEvent(new StorageEvent("storage", { key, storageArea: sessionStorage }));
      },
      { key: target.key, store },
    );
    await switchTo(firstKey);
    await title("Instant A").waitFor();
    await expect
      .poll(async () => (await gateway.getRequests("sessions.list", rosterMatch)).length)
      .toBe(initialListCount + 1);
    const queued = page.locator(".chat-queue").getByText("flush after idle reconciliation");
    await queued.waitFor();
    expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    await gateway.resolveDeferred("sessions.list", idleSessions);
    const send = await gateway.waitForRequest("chat.send");
    expect(requireRecord(send.params)).toMatchObject({
      message: "flush after idle reconciliation",
      sessionKey: firstKey,
    });
    await queued.waitFor({ state: "detached" });
  });
  it.each([
    { name: "one-large", sizes: [largePngBytes] },
    { name: "large-and-small", sizes: [largePngBytes, smallPngBytes] },
    { name: "two-large", sizes: [largePngBytes, largePngBytes] },
  ])(
    "durably admits $name PNG attachments before steering an active run (mock Gateway)",
    ({ name, sizes }) =>
      suite.withPage(
        {
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { width: 1280, height: 900 },
        },
        async ({ page }) => {
          const runId = "mock-active-capacity-run";
          const activeText = "Mock Gateway: the active run is still working.";
          const historyText = "Mock Gateway: inspect the attachment batch.";
          const gateway = await installMockGateway(page, {
            historyMessages: [{ role: "user", content: historyText }],
            inFlightRun: { runId, text: activeText },
            sessionInfo: { activeRunIds: [runId], hasActiveRun: true, key: "main" },
            deferredMethods: ["chat.send"],
          });
          await page.goto(`${suite.server.baseUrl}settings/appearance`);
          await page.locator("[data-settings-follow-up-mode]").selectOption("steer");
          await gateway.waitForRequest("config.patch");
          await page.goto(`${suite.server.baseUrl}chat`);
          const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
          const composer = pane.locator(".agent-chat__composer-combobox textarea");
          const stop = pane.getByRole("button", { name: "Stop generating" });
          const steer = pane.getByRole("button", {
            name: "Steer into the active run",
            exact: true,
          });
          const history = pane.getByText(historyText, { exact: true });
          const active = pane.getByText(activeText, { exact: true });
          await history.waitFor();
          await active.waitFor();
          await stop.waitFor();
          const files = sizes.map((size, index) => ({
            name: `mock-${name}-${index + 1}.png`,
            mimeType: "image/png",
            buffer: sizedOutboxPng(size, 60 + index * 100),
          }));
          const expectedBytes = files.map((file) => file.buffer.toString("base64"));
          expect(files.map((file) => file.buffer.length)).toEqual(sizes);
          const message = `Mock Gateway: steer with ${name} PNG batch.`;
          await composer.fill(message);
          await pane.locator(".agent-chat__file-input").setInputFiles(files);
          const previews = pane.locator(".chat-attachment-thumb img");
          await expectImages(previews, files.length);
          const acceptedBytes = await previews.evaluateAll(async (images) =>
            Promise.all(
              images.map(
                async (image) => (await (await fetch((image as HTMLImageElement).src)).blob()).size,
              ),
            ),
          );
          expect(acceptedBytes).toEqual(sizes);
          await expect.poll(() => steer.isEnabled()).toBe(true);
          expect(await pane.locator(".chat-queue__item").count()).toBe(0);
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
          const observation = await observeMockSends(page);
          try {
            await steer.click();
            const outcomeHandle = await page.waitForFunction(
              ({ proof, error }) => {
                const errorVisible = [...document.querySelectorAll('[role="alert"]')].some(
                  (alert) => alert.textContent?.includes(error),
                );
                return proof.sends.length > 0 ? "sent" : errorVisible ? "storage-rejected" : false;
              },
              { proof: observation, error: storageError },
            );
            const outcome = await outcomeHandle.jsonValue();
            await outcomeHandle.dispose();
            const sends = await observation.evaluate((proof) => proof.sends);
            const requests = await gateway.getRequests("chat.send");
            const evidence = {
              outcome,
              sends,
              draft: await composer.inputValue(),
              attachmentPreviews: await previews.count(),
              queueRows: await pane.locator(".chat-queue__item").count(),
            };
            const captureImages = pane.locator(".chat-attachment-thumb img, .chat-message-image");
            await expectImages(captureImages, files.length);
            await history.waitFor();
            await active.waitFor();

            expect(outcome, JSON.stringify(evidence)).toBe("sent");
            const payload = (await readOutboxQueue(page))[0]?.attachmentPayload;
            assert(payload, "Expected admitted payload reference");
            expect(await countOutboxPayloads(page)).toBe(1);
            expect(await readOutboxPayloadBytes(page, payload.key)).toEqual(expectedBytes);
            expect(requests[0]?.params).toHaveProperty(
              "attachments",
              files.map((file) => ({
                type: "image",
                origin: "file",
                mimeType: file.mimeType,
                fileName: file.name,
                content: file.buffer.toString("base64"),
              })),
            );
            expect(sends).toEqual([
              {
                message,
                queueMode: "steer",
                sessionKey: "agent:main:main",
                runId: expect.any(String),
                durableBeforeSend: true,
                storedSendState: "waiting-reconnect",
                attachments: files.map((file) => ({
                  fileName: file.name,
                  mimeType: file.mimeType,
                  sizeBytes: file.buffer.length,
                })),
              },
            ]);
            await expect.poll(() => composer.inputValue()).toBe("");
            await expect.poll(() => previews.count()).toBe(0);
            await pane.locator(".chat-group.user", { hasText: message }).waitFor();
            expect(await pane.locator(".chat-queue__item").count()).toBe(0);
            await stop.waitFor();
            await expectRequestCountStable(gateway, "chat.send", 1);
            const sent = sends[0];
            assert(sent, "Expected the observed chat.send before emitting its terminal");
            await gateway.resolveDeferred("chat.send");
            await stop.waitFor();
            await gateway.deferNext("chat.history");
            await gateway.emitChatFinal({
              runId: sent.runId,
              text: "Mock Gateway: attachment delivery finished before history persisted.",
            });
            await expect
              .poll(
                async () =>
                  (await readOutboxQueue(page)).filter((item) => item.sendRunId === sent.runId)
                    .length,
              )
              .toBe(0);
            const deliveredImages = pane
              .locator(".chat-group.user", { hasText: message })
              .locator(".chat-message-image");
            await expectImages(deliveredImages, files.length);
            expect(await readImageBytes(deliveredImages)).toEqual(expectedBytes);
            await expect.poll(() => countOutboxPayloads(page)).toBe(0);
            await expectRequestCountStable(gateway, "chat.send", 1);
          } finally {
            await observation.evaluate((proof) => proof.dispose());
            await observation.dispose();
          }
        },
      ),
  );
});
