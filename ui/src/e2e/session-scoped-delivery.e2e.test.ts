import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
  reconnectMockGateway,
  type MockGatewayWindow,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI scoped stream delivery",
});
const first = "agent:main:foreground";
const second = "agent:main:split";
const narrated = "agent:main:narrated";
const unrelated = "agent:main:unrelated";

async function receivedSessions(page: Page): Promise<unknown[]> {
  return page.evaluate(() => {
    const app = document.querySelector<HTMLElement & { runtime: { context: ApplicationContext } }>(
      "openclaw-app",
    );
    return (app?.runtime.context.gateway.eventLog ?? []).flatMap(({ event, payload }) =>
      ["agent", "chat", "session.tool", "session.observer", "chat.side_result"].includes(event) &&
      payload &&
      typeof payload === "object" &&
      "sessionKey" in payload
        ? [payload.sessionKey]
        : [],
    );
  });
}

suite.define(() => {
  it("delivers both split panes and sidebar narration while excluding unrelated streams across reconnect", async () => {
    await suite.withPage(
      { locale: "en-US", viewport: { width: 1440, height: 900 }, serviceWorkers: "block" },
      async ({ page }) => {
        await page.addInitScript(
          ({ settingsKey, first: foregroundKey, second: splitKey }) => {
            localStorage.setItem("openclaw:sidebar:sessions:show-preview", "true");
            localStorage.setItem(
              settingsKey,
              JSON.stringify({
                chatSplitLayout: {
                  activePaneId: "first",
                  columns: [
                    {
                      id: "left",
                      panes: [{ id: "first", sessionKey: foregroundKey }],
                      paneWeights: [1],
                    },
                    {
                      id: "right",
                      panes: [{ id: "second", sessionKey: splitKey }],
                      paneWeights: [1],
                    },
                  ],
                  columnWeights: [0.5, 0.5],
                },
              }),
            );
          },
          { settingsKey: controlUiBundledSettingsStorageKey(suite.server.baseUrl), first, second },
        );
        const sessions = [first, second, narrated, unrelated].map((key, index) =>
          sessionRow(key, key.split(":").at(-1)!, 100 - index, {
            hasActiveRun: key !== unrelated,
            activeRunIds: key !== unrelated ? [`run-${index}`] : [],
            status: key !== unrelated ? "running" : "done",
          }),
        );
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
          await gateway.waitForRequest("sessions.messages.subscribe", { match: { key } });
        }
        await page.evaluate(() => {
          const app = document.querySelector<
            HTMLElement & { runtime: { context: ApplicationContext } }
          >("openclaw-app");
          if (!app) {
            throw new Error("Control UI app is unavailable");
          }
          // This page-lifetime observer opts the delivery proof into diagnostic capture.
          app.runtime.context.gateway.subscribeEventLog(() => undefined);
        });
        const send = async (key: string, runId: string, text: string) => {
          await gateway.emitGatewayEvent("chat", {
            sessionKey: key,
            runId,
            state: "delta",
            message: { role: "assistant", content: [{ type: "text", text }] },
          });
        };
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
        await narrationRow.getByText("Using read", { exact: true }).waitFor();
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
        expect(
          await gateway.getRequests("sessions.messages.subscribe", { key: unrelated }),
        ).toHaveLength(0);

        const subscriptionsBefore = await gateway.getRequests("sessions.messages.subscribe");
        await reconnectMockGateway(page, gateway);
        for (const key of [first, second, narrated]) {
          await gateway.waitForRequest("sessions.messages.subscribe", {
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
      expect(
        requests.findIndex((request) => request.method === "sessions.messages.subscribe"),
      ).toBeLessThan(requests.findIndex((request) => request.method === "chat.send"));
    });
  });
});
