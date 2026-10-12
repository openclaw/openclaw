import { assert, expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e-defaults.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
  navigateToControlUiSession,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { sessionsListResponse } from "./session-management.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Chat header and delegated work" });

suite.define(() => {
  it("opens Subagents for a batch, explains the yielded wait, and leaves the next empty conversation collapsed", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        colorScheme: "dark",
        viewport: { width: 1440, height: 900 },
        serviceWorkers: "block",
      },
      async ({ page }) => {
        const now = 1_800_000_000_000;
        await page.clock.setFixedTime(now);
        await page.addInitScript(
          (key) => localStorage.setItem(key, JSON.stringify({ themeMode: "dark" })),
          controlUiBundledSettingsStorageKey(suite.server.baseUrl),
        );
        const parent = {
          key: "agent:main:delegation-parent",
          sessionId: "delegation-parent",
          kind: "direct",
          sharingRole: "owner",
          label: "Review the backend",
          status: "done",
          hasActiveRun: false,
          hasActiveSubagentRun: false,
          activeRunIds: [],
          updatedAt: now - 5_000,
        } satisfies GatewaySessionRow;
        const next = {
          ...parent,
          key: "agent:main:next-conversation",
          sessionId: "next-conversation",
          label: "Another conversation",
        } satisfies GatewaySessionRow;
        const history = [
          {
            role: "assistant",
            content: "Ready for delegated work.",
            timestamp: now - 5_000,
            __openclaw: { id: "ready", seq: 1 },
          },
        ];
        const gateway = await installMockGateway(page, {
          sessionKey: parent.key,
          sessions: [parent, next],
          historyMessages: history,
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            "session.visibility.set",
            "session.members.listEvidence",
          ],
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, parent.key));
        const activePane = page.locator(".chat-pane-cache__pane--active");
        const panel = activePane.locator("openclaw-chat-subagents-panel");
        const waitLine = activePane.locator(".agent-chat__composer-run-status--waiting");
        await activePane.getByText("Ready for delegated work.", { exact: true }).waitFor();
        expect(await panel.isVisible()).toBe(false);
        expect(await activePane.locator(".chat-pane__actions").getByRole("button").count()).toBe(3);

        const details = activePane.locator(".chat-pane__header-trailing > openclaw-chat-details");
        await details.getByRole("button", { name: "Details", exact: true }).click();
        await details.getByRole("dialog", { name: "Details", exact: true }).waitFor();
        expect(
          await activePane
            .locator(".chat-main__conversation-frame > openclaw-chat-details")
            .count(),
        ).toBe(0);
        await details.getByRole("button", { name: "Close details", exact: true }).click();
        await details
          .getByRole("dialog", { name: "Details", exact: true })
          .waitFor({ state: "hidden" });

        const prompt = "Review the backend in a subagent.";
        await activePane.locator(".agent-chat__composer-combobox textarea").fill(prompt);
        await activePane.getByRole("button", { name: "Send message", exact: true }).click();
        const send = await gateway.waitForRequest("chat.send");
        assert(send.params && typeof send.params === "object" && "idempotencyKey" in send.params);
        const runId = send.params.idempotencyKey;
        assert(typeof runId === "string");
        const runningParent: GatewaySessionRow = {
          ...parent,
          status: "running",
          hasActiveRun: true,
          hasActiveSubagentRun: true,
          activeRunIds: [runId],
          startedAt: now,
          updatedAt: now + 1,
          snapshotAt: now + 1,
          childSessions: ["agent:main:subagent:backend-review"],
        };
        const child: GatewaySessionRow = {
          key: "agent:main:subagent:backend-review",
          sessionId: "backend-review",
          kind: "direct",
          classification: "subagent",
          label: "Backend review",
          spawnedBy: parent.key,
          parentSessionKey: parent.key,
          status: "running",
          hasActiveRun: true,
          activeRunIds: ["backend-run"],
          startedAt: now,
          updatedAt: now + 1,
          snapshotAt: now + 1,
        };
        await gateway.setSessionsListResponse(sessionsListResponse([runningParent, child, next]));
        await gateway.emitGatewayEvent("sessions.changed", {
          sessionKey: child.key,
          reason: "run-start",
          ts: now + 1,
          session: child,
          ancestorSessions: [runningParent],
        });
        const panelRow = panel.locator(`[data-session-key="${child.key}"]`);
        await panelRow.getByText("Backend review", { exact: true }).waitFor();
        expect(await activePane.locator(".chat-pane__subagents-running").textContent()).toContain(
          "1 running",
        );
        expect(await waitLine.isVisible()).toBe(false);
        const transcriptHeight = () =>
          activePane.locator(".chat-thread").evaluate((element) => element.clientHeight);
        const beforeWaitHeight = await transcriptHeight();

        const yieldCall = {
          role: "assistant",
          content: [
            { type: "text", text: "Waiting for the backend review." },
            { type: "toolCall", id: "yield", name: "sessions_yield", arguments: {} },
          ],
          timestamp: now + 2,
          __openclaw: { id: "yield-call", seq: 3, runId },
        };
        const yieldResult = {
          role: "toolResult",
          toolCallId: "yield",
          toolName: "sessions_yield",
          content: [{ type: "text", text: '{"status":"yielded"}' }],
          timestamp: now + 3,
          __openclaw: { id: "yield-result", seq: 4, runId },
        };
        const waitingParent: GatewaySessionRow = {
          ...runningParent,
          hasActiveRun: false,
          activeRunIds: [],
          endedAt: now + 3,
          updatedAt: now + 3,
          snapshotAt: now + 3,
        };
        await gateway.setSessionsListResponse(sessionsListResponse([waitingParent, child, next]));
        await gateway.setMethodResponse("chat.history", {
          messages: [
            ...history,
            { role: "user", content: prompt, timestamp: now, __openclaw: { id: "prompt", seq: 2 } },
            yieldCall,
            yieldResult,
          ],
          sessionId: parent.sessionId,
          sessionInfo: waitingParent,
          inFlightRun: null,
        });
        await gateway.emitGatewayEvent("session.message", {
          sessionKey: parent.key,
          message: yieldResult,
          messageId: "yield-result",
          messageSeq: 4,
          hasActiveRun: true,
          session: runningParent,
        });
        await page.clock.setFixedTime(now + 65_000);
        await gateway.emitGatewayEvent("chat", {
          sessionKey: parent.key,
          runId,
          state: "final",
          yielded: true,
        });
        await waitLine.waitFor();
        await expect
          .poll(async () => (await waitLine.textContent())?.replace(/\s+/g, " ").trim())
          .toBe("Waiting on 1 subagent · Backend review · running 1m 5s View");
        expect(await waitLine.count()).toBe(1);
        expect(await activePane.locator(".chat-working-indicator--subagents").count()).toBe(0);
        expect(await transcriptHeight()).toBe(beforeWaitHeight);
        const mountedPanel = await panel.elementHandle();
        await selectChatLayoutAction(activePane, "Expand Subagents");
        await activePane.locator(".sidebar-region--expanded-side").waitFor();
        await selectChatLayoutAction(activePane, "Restore split");
        await activePane.locator(".sidebar-region--expanded-side").waitFor({ state: "hidden" });
        expect(await mountedPanel?.evaluate((element) => element.isConnected)).toBe(true);
        await selectChatLayoutAction(activePane, "Expand Subagents");
        const activeSubagentsTab = activePane.locator('[data-region-header="side"] wa-tab[active]');
        await activeSubagentsTab.focus();
        await page.keyboard.press("Enter");
        await activePane.locator(".sidebar-region--expanded-side").waitFor({ state: "hidden" });
        expect(await mountedPanel?.evaluate((element) => element.isConnected)).toBe(true);
        await mountedPanel?.dispose();
        await activePane.getByRole("button", { name: "Close Subagents", exact: true }).click();
        await panel.waitFor({ state: "hidden" });
        await waitLine.getByRole("button", { name: "View", exact: true }).click();
        await panelRow.waitFor();
        await expect
          .poll(() =>
            activePane
              .locator('[data-region-header="side"] wa-tab[active]')
              .evaluate((element) => element.matches(":focus")),
          )
          .toBe(true);

        const settledChild: GatewaySessionRow = {
          ...child,
          status: "done",
          hasActiveRun: false,
          activeRunIds: [],
          endedAt: now + 66_000,
          updatedAt: now + 66_000,
          snapshotAt: now + 66_000,
        };
        const settledParent: GatewaySessionRow = {
          ...waitingParent,
          hasActiveSubagentRun: false,
          updatedAt: now + 66_000,
          snapshotAt: now + 66_000,
        };
        await gateway.setSessionsListResponse(
          sessionsListResponse([settledParent, settledChild, next]),
        );
        await gateway.emitGatewayEvent("sessions.changed", {
          sessionKey: child.key,
          reason: "run-settled",
          ts: now + 66_000,
          session: settledChild,
          ancestorSessions: [settledParent],
        });
        await waitLine.waitFor({ state: "hidden" });
        const resumedParent: GatewaySessionRow = {
          ...settledParent,
          status: "running",
          hasActiveRun: true,
          activeRunIds: ["parent-resumed"],
          startedAt: now + 67_000,
          updatedAt: now + 67_000,
          snapshotAt: now + 67_000,
        };
        await gateway.setSessionsListResponse(
          sessionsListResponse([resumedParent, settledChild, next]),
        );
        await gateway.emitGatewayEvent("sessions.changed", {
          sessionKey: parent.key,
          reason: "run-start",
          ts: now + 67_000,
          session: resumedParent,
          ancestorSessions: [],
        });
        await activePane.locator(".chat-working-indicator").waitFor();
        await activePane.locator(".agent-chat__composer-run-status--working").waitFor();
        expect(await waitLine.count()).toBe(0);
        expect(await panel.isVisible()).toBe(true);
        await activePane.getByRole("button", { name: "Close Subagents", exact: true }).click();
        await panel.waitFor({ state: "hidden" });

        await gateway.setMethodResponse("chat.history", {
          messages: [{ role: "assistant", content: "A separate conversation.", timestamp: now }],
          sessionId: next.sessionId,
          sessionInfo: next,
          inFlightRun: null,
        });
        await navigateToControlUiSession(page, next.key);
        await activePane.getByText("A separate conversation.", { exact: true }).waitFor();
        expect(await panel.isVisible()).toBe(false);
        expect(await activePane.locator(".agent-chat__composer-run-status").isVisible()).toBe(
          false,
        );
      },
    );
  });
});
