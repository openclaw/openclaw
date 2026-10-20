import type { Page } from "playwright";
import { expect, it } from "vitest";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
  reconnectMockGateway,
  type MockGatewayWindow,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { seedStorage } from "./sidebar-assertions.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI scoped stream delivery",
});
const first = "agent:main:foreground";
const second = "agent:main:split";
const narrated = "agent:main:narrated";
const unrelated = "agent:main:unrelated";
const subscribe = "sessions.messages.subscribe";
const liveRow = (key: string, index: number, active = true) =>
  sessionRow(key, `Session ${index}`, 100 - index, {
    hasActiveRun: active,
    activeRunIds: active ? [`run-${index}`] : [],
    status: active ? "running" : "done",
  });
const chatDelta = (sessionKey: string, runId: string, text: string) => ({
  sessionKey,
  runId,
  state: "delta",
  message: { role: "assistant", content: [{ type: "text", text }] },
});

async function receivedSessions(page: Page): Promise<unknown[]> {
  // Safe observer headlines also reach broad session-list subscribers; raw
  // messages, tool arguments, and side-chat results remain individually scoped.
  return evaluateControlUiContext(page, (context) => {
    return context.gateway.eventLog.flatMap(({ event, payload }) =>
      ["agent", "chat", "session.tool", "chat.side_result"].includes(event) &&
      payload &&
      typeof payload === "object" &&
      "sessionKey" in payload
        ? [payload.sessionKey]
        : [],
    );
  });
}

suite.define(() => {
  // Default rows show observer headlines only with previews on; roster rows
  // always do.
  it.each(["roster", "preview-on"] as const)(
    "preserves the visible consumers in %s presentation",
    async (mode) => {
      await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
        const keys = [
          first,
          ...Array.from({ length: 6 }, (_, index) => `agent:main:background-${index}`),
        ];
        await seedStorage(page, {
          [controlUiBundledSettingsStorageKey(suite.server.baseUrl)]: JSON.stringify({
            sidebarAgentsMode: mode === "roster" ? "roster" : "chip",
          }),
          "openclaw:sidebar:sessions:show-preview": "true",
        });
        const gateway = await installMockGateway(page, {
          sessionKey: first,
          sessions: keys.map((key, index) => liveRow(key, index)),
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, first));
        if (mode === "roster") {
          await page.locator(".sidebar-agent-roster__row").first().waitFor();
        } else {
          await page.locator(`[data-session-key="${keys[1]}"]`).first().waitFor();
        }
        await gateway.waitForRequest(subscribe, { match: { key: first } });
        if (mode === "roster") {
          const subscriptions = await gateway.getRequests(subscribe);
          expect(subscriptions).toMatchObject([{ params: { key: first } }]);
        } else {
          await gateway.waitForRequest(subscribe, { match: { key: keys[1] } });
          await gateway.emitGatewayEvent("session.observer", {
            sessionKey: keys[1],
            agentId: "main",
            runId: "run-1",
            revision: 1,
            updatedAt: Date.now(),
            health: "waiting-on-user",
            headline: "Waiting for the next instruction",
          });
        }
        await gateway.emitGatewayEvent(
          "chat",
          chatDelta(first, "run-0", "Visible chat stays live"),
        );
        await page
          .locator(".chat-thread-inner")
          .getByText("Visible chat stays live", { exact: true })
          .waitFor();
        if (mode === "preview-on") {
          await page
            .locator(`[data-session-key="${keys[1]}"]`)
            .getByText("Waiting for the next instruction", { exact: true })
            .waitFor();
        }
      });
    },
  );

  it("delivers both split panes and sidebar narration while excluding unrelated streams across reconnect", async () => {
    await suite.withPage(
      { locale: "en-US", viewport: { width: 1440, height: 900 }, serviceWorkers: "block" },
      async ({ page }) => {
        const sessions = [first, second, narrated, unrelated].map((key, index) =>
          liveRow(key, index, key !== unrelated),
        );
        await seedStorage(page, {
          "openclaw:sidebar:sessions:show-preview": "true",
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
        await panes.nth(0).getByText("Attached 0", { exact: true }).waitFor();
        await panes.nth(1).getByText("Attached 1", { exact: true }).waitFor();
        for (const key of [first, second, narrated]) {
          await gateway.waitForRequest(subscribe, { match: { key } });
        }
        await evaluateControlUiContext(page, (context) => {
          // This page-lifetime observer opts the delivery proof into diagnostic capture.
          context.gateway.subscribeEventLog(() => undefined);
        });
        const send = (key: string, runId: string, text: string) =>
          gateway.emitGatewayEvent("chat", chatDelta(key, runId, text));
        await send(first, "run-0", "Foreground is streaming");
        await send(second, "run-1", "Second pane is streaming");
        await panes.nth(0).getByText("Foreground is streaming", { exact: true }).waitFor();
        await panes.nth(1).getByText("Second pane is streaming", { exact: true }).waitFor();
        const narrationRow = page.locator(
          `.sidebar-recent-session[data-session-key="${narrated}"]`,
        );
        await gateway.emitGatewayEvent("session.tool", {
          sessionKey: narrated,
          runId: "run-2",
          stream: "tool",
          data: { name: "read", phase: "start", toolCallId: "sidebar-tool" },
        });
        await gateway.emitGatewayEvent("session.tool", {
          sessionKey: narrated,
          runId: "run-2",
          stream: "item",
          data: {
            kind: "tool",
            itemId: "tool:sidebar-tool",
            toolCallId: "sidebar-tool",
            name: "read",
            phase: "update",
            title: "Read",
            progressText: "Reading the source",
          },
        });
        const tool = narrationRow.getByRole("img", { name: "Tool: read", exact: true });
        await tool.waitFor();
        expect(await narrationRow.locator(".sidebar-recent-session__subtitle").textContent()).toBe(
          "Reading the source",
        );
        expect(await tool.evaluate((element) => getComputedStyle(element).animationName)).toBe(
          "none",
        );
        expect(await narrationRow.getAttribute("class")).toContain("session-row-host--running");
        for (const event of [
          "agent",
          "chat",
          "session.tool",
          "session.observer",
          "chat.side_result",
        ]) {
          await gateway.emitGatewayEvent(event, { sessionKey: unrelated, runId: "other-run" });
        }
        expect(await receivedSessions(page)).not.toContain(unrelated);
        const unrelatedRow = page.locator(
          `.sidebar-recent-session[data-session-key="${unrelated}"]`,
        );
        await gateway.emitGatewayEvent("sessions.changed", {
          sessionKey: unrelated,
          reason: "patch",
          ts: 101,
          session: {
            ...sessions[3],
            unread: true,
            label: "Unrelated completed work",
            updatedAt: 101,
          },
        });
        await unrelatedRow.getByText("Unrelated completed work", { exact: true }).waitFor();
        await unrelatedRow.locator(".session-unread-dot").waitFor();
        expect(await unrelatedRow.getAttribute("class")).not.toContain("session-row-host--running");
        expect(await gateway.getRequests(subscribe, { key: unrelated })).toHaveLength(0);

        const subscriptionsBefore = await gateway.getRequests(subscribe);
        await reconnectMockGateway(page, gateway);
        for (const key of [first, second, narrated]) {
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
        expect(await narrationRow.locator(".sidebar-session-tool").count()).toBe(0);
        await send(second, "run-1", "Second pane resumed");
        await panes.nth(1).getByText("Second pane resumed", { exact: true }).waitFor();
        await send(unrelated, "other-run", "Unrelated must stay off the socket");
        const sessionsAfterReconnect = await receivedSessions(page);
        expect(sessionsAfterReconnect).toContain(second);
        expect(sessionsAfterReconnect).not.toContain(unrelated);
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
      await page
        .locator(".chat-thread-inner")
        .getByText("Fast first token", { exact: true })
        .waitFor();
      const requests = await gateway.getRequests();
      expect(requests.findIndex((request) => request.method === subscribe)).toBeLessThan(
        requests.findIndex((request) => request.method === "chat.send"),
      );
    });
  });
});
