import { expect, it } from "vitest";
import { outboxStorageScope } from "../lib/chat/outbox-payload-store.runtime.ts";
import { storageTargetForGateway, storedChatOutboxScopeKey } from "../lib/chat/outbox-store.ts";
import {
  captureUiProof,
  chatSessionListResponse,
  createChatFlowE2eSuite,
  controlUiSessionUrl,
  installMockGateway,
  requireRecord,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
const suite = createChatFlowE2eSuite();
const rosterMatch = { includeGlobal: true };
suite.define(() => {
  it("releases a retained queued send after the canonical session list records idle", async () => {
    const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const firstKey = "agent:main:thread:aaaaaaaa-1111-4111-8111-111111111111";
    const secondKey = "agent:main:thread:bbbbbbbb-2222-4222-8222-222222222222";
    const activeSessions = chatSessionListResponse([
      {
        key: firstKey,
        kind: "direct",
        label: "Instant A",
        updatedAt: 2,
        activeRunIds: ["server-run"],
        hasActiveRun: true,
        status: "running",
      },
      { key: secondKey, kind: "direct", label: "Instant B", updatedAt: 1 },
    ]);
    const idleSessions = chatSessionListResponse([
      {
        key: firstKey,
        kind: "direct",
        label: "Instant A",
        updatedAt: 3,
        activeRunIds: [],
        hasActiveRun: false,
        lastRunId: "server-run",
        status: "done",
      },
      { key: secondKey, kind: "direct", label: "Instant B", updatedAt: 1 },
    ]);
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

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, firstKey));
      await page.locator(`.sidebar-recent-session[data-session-key="${secondKey}"]`).waitFor();
      await page
        .locator(".chat-pane-cache__pane--visible .chat-pane__session-title")
        .getByText("Instant A")
        .waitFor();
      await page.waitForTimeout(500);
      const initialListCount = (await gateway.getRequests("sessions.list", rosterMatch)).length;
      const initialMetadataCount = (await gateway.getRequests("chat.metadata")).length;
      await gateway.deferNext("sessions.list", rosterMatch);

      await page
        .locator(
          `.sidebar-recent-session[data-session-key="${secondKey}"] a.sidebar-recent-session__link`,
        )
        .click();
      await page
        .locator(".chat-pane-cache__pane--visible .chat-pane__session-title")
        .getByText("Instant B")
        .waitFor();
      const emptyOutboxListRequests = (
        await gateway.getRequests("sessions.list", rosterMatch)
      ).slice(initialListCount);
      expect(emptyOutboxListRequests).toHaveLength(0);
      expect(await gateway.getRequests("chat.metadata")).toHaveLength(initialMetadataCount);
      const emptyOutboxListCount = initialListCount + emptyOutboxListRequests.length;

      const owner = await page
        .locator('openclaw-chat-pane[aria-hidden="false"]')
        .evaluate((pane) => {
          const state = (
            pane as HTMLElement & {
              state: {
                settings?: { gatewayUrl?: string };
                client?: { recoveryScope?: string; recoveryScopeReady?: boolean };
              };
            }
          ).state;
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
      await page.evaluate(
        ({ key, gatewayOwner, scopeKey, storageScope: admittedScope, targetKey }) => {
          sessionStorage.setItem(
            key,
            JSON.stringify({
              version: 4,
              gatewayOwner,
              recovery: {},
              sessions: {
                [scopeKey]: {
                  updatedAt: Date.now(),
                  queue: [
                    {
                      id: "queued-before-switch",
                      text: "flush after idle reconciliation",
                      createdAt: Date.now(),
                      sendState: "waiting-idle",
                      sendAttempts: 0,
                      sessionKey: targetKey,
                      agentId: "main",
                      storageScope: admittedScope,
                    },
                  ],
                },
              },
            }),
          );
          window.dispatchEvent(new StorageEvent("storage", { key, storageArea: sessionStorage }));
        },
        {
          key: target.key,
          gatewayOwner: target.gatewayOwner,
          scopeKey: storedChatOutboxScopeKey({ sessionKey: firstKey, agentId: "main" }),
          storageScope,
          targetKey: firstKey,
        },
      );
      await page
        .locator(
          `.sidebar-recent-session[data-session-key="${firstKey}"] a.sidebar-recent-session__link`,
        )
        .click();
      await page
        .locator(".chat-pane-cache__pane--visible .chat-pane__session-title")
        .getByText("Instant A")
        .waitFor();
      await expect
        .poll(async () => (await gateway.getRequests("sessions.list", rosterMatch)).length)
        .toBe(emptyOutboxListCount + 1);
      const queued = page.locator(".chat-queue").getByText("flush after idle reconciliation");
      await queued.waitFor();
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      await captureUiProof(suite, page, "queued-idle-release", "01-queued-before-idle.png");
      await gateway.resolveDeferred("sessions.list", idleSessions);
      const send = await gateway.waitForRequest("chat.send");
      expect(requireRecord(send.params)).toMatchObject({
        message: "flush after idle reconciliation",
        sessionKey: firstKey,
      });
      await queued.waitFor({ state: "detached" });
      await captureUiProof(suite, page, "queued-idle-release", "02-sent-after-idle.png");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
