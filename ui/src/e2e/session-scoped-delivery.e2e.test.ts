import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
  reconnectMockGateway,
  type MockGatewayWindow,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { waitForSessionText as waitText } from "./session-ui.test-support.ts";
import { seedStorage } from "./sidebar-assertions.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI scoped stream delivery",
});
const first = "agent:main:foreground";
const second = "agent:main:split";
const subscribe = "sessions.messages.subscribe";
const liveRow = (key: string, index: number) =>
  sessionRow(key, `Session ${index}`, 100 - index, {
    hasActiveRun: true,
    activeRunIds: [`run-${index}`],
    status: "running",
  });
const chatDelta = (sessionKey: string, runId: string, text: string) => ({
  sessionKey,
  runId,
  state: "delta",
  message: { role: "assistant", content: [{ type: "text", text }] },
});

suite.define(() => {
  it("keeps both split panes streaming across reconnect", async () => {
    await suite.withPage(
      { locale: "en-US", viewport: { width: 1440, height: 900 }, serviceWorkers: "block" },
      async ({ page }) => {
        const sessions = [first, second].map((key, index) => liveRow(key, index));
        await seedStorage(page, {
          [controlUiBundledSettingsStorageKey(suite.server.baseUrl)]: JSON.stringify({
            chatSplitLayout: {
              activePaneId: "first",
              columns: [
                ["left", "first", first],
                ["right", "second", second],
              ].map(([id, paneId, sessionKey]) => ({
                id,
                panes: [{ id: paneId, sessionKey }],
                paneWeights: [1],
              })),
              columnWeights: [0.5, 0.5],
            },
          }),
        });
        const gateway = await installMockGateway(page, {
          sessions,
          sessionKey: first,
          sessionTranscripts: Object.fromEntries(
            [first, second].map((key, index) => [
              key,
              { messages: [], inFlightRun: { runId: `run-${index}`, text: `Attached ${index}` } },
            ]),
          ),
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, first));
        const panes = page.locator(".chat-split-view__cell");
        await waitText(panes.nth(0), "Attached 0");
        await waitText(panes.nth(1), "Attached 1");
        for (const key of [first, second]) {
          await gateway.waitForRequest(subscribe, { match: { key } });
        }
        const send = (key: string, runId: string, text: string) =>
          gateway.emitGatewayEvent("chat", chatDelta(key, runId, text));
        await send(first, "run-0", "Foreground is streaming");
        await send(second, "run-1", "Second pane is streaming");
        await waitText(panes.nth(0), "Foreground is streaming");
        await waitText(panes.nth(1), "Second pane is streaming");
        const subscriptionsBefore = await gateway.getRequests(subscribe);
        await reconnectMockGateway(page, gateway);
        for (const key of [first, second]) {
          await gateway.waitForRequest(subscribe, {
            match: { key },
            after: subscriptionsBefore.filter(
              (request) =>
                typeof request.params === "object" &&
                request.params !== null &&
                "key" in request.params &&
                request.params.key === key,
            ).length,
          });
        }
        await send(second, "run-1", "Second pane resumed");
        await waitText(panes.nth(1), "Second pane resumed");
      },
    );
  });

  it("subscribes before a first-turn response can arrive ahead of its acknowledgement", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, { sessionKey: first, historyMessages: [] });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, first));
      await page.evaluate(() => {
        const mockGateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
        if (!mockGateway) {
          throw new Error("Mock Gateway is unavailable");
        }
        mockGateway.setRequestHandler("chat.send", ({ params, respond, emit }) => {
          if (!params || typeof params !== "object" || !("idempotencyKey" in params)) {
            throw new Error("Missing chat send parameters");
          }
          emit("chat", {
            sessionKey: "sessionKey" in params ? params.sessionKey : undefined,
            runId: params.idempotencyKey,
            state: "delta",
            message: { role: "assistant", content: [{ type: "text", text: "Fast first token" }] },
          });
          respond({ runId: params.idempotencyKey, status: "started" });
        });
      });
      await page.locator(".agent-chat__composer-combobox textarea").fill("Respond immediately");
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      await waitText(page.locator(".chat-thread-inner"), "Fast first token");
      const requests = await gateway.getRequests();
      expect(requests.findIndex((request) => request.method === subscribe)).toBeLessThan(
        requests.findIndex((request) => request.method === "chat.send"),
      );
    });
  });
});
