import { expect, it } from "vitest";
import { outboxStorageScope } from "../lib/chat/outbox-payload-store.runtime.ts";
import { storageTargetForGateway, storedChatOutboxScopeKey } from "../lib/chat/outbox-store.ts";
import {
  chatSessionListResponse,
  createChatFlowE2eSuite,
  controlUiSessionUrl,
  installMockGateway,
  newChatPage,
  requireRecord,
} from "./chat-flow.test-support.ts";
const suite = createChatFlowE2eSuite();
const rosterMatch = { includeGlobal: true };
type OutboxHost = Parameters<typeof outboxStorageScope>[0];
suite.define(() => {
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
});
