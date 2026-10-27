import { assert, expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e-defaults.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { closeChatDetails, openChatDetails } from "./chat-details.test-support.ts";
import { chatEvent } from "./chat-flow-fixtures.test-support.ts";
import { controlUiE2eBuiltModuleRequest } from "./control-ui-built-module.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { sessionsListResponse } from "./session-management.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Chat header and delegated work" });

suite.define(() => {
  it("keeps new batches in Details and opens Subagents manually without duplicate wait status", async () => {
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
          sessions: [parent],
          historyMessages: history,
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            "session.visibility.set",
            "session.members.listEvidence",
          ],
        });
        const detailsChunk = Promise.withResolvers<void>();
        await page.route(
          controlUiE2eBuiltModuleRequest("ui/src/pages/chat/components/chat-details-session.tsx"),
          async (route) => {
            await detailsChunk.promise;
            await route.continue();
          },
        );
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, parent.key));
        const activePane = page.locator(".chat-pane-cache__pane--active");
        const panel = activePane.locator("openclaw-chat-subagents-panel");
        const waitLine = activePane.locator(".agent-chat__composer-run-status--waiting");
        await activePane.getByText("Ready for delegated work.", { exact: true }).waitFor();
        expect(await panel.isVisible()).toBe(false);
        const detailsDialog = await openChatDetails(activePane);
        await detailsDialog.getByRole("status", { name: "Loading…", exact: true }).waitFor();
        expect(
          await detailsDialog
            .getByRole("status", { name: "Loading…", exact: true })
            .getByText("Loading…", { exact: true })
            .count(),
        ).toBe(0);
        detailsChunk.resolve();
        // Optional metadata can be empty; the visible panel and cleared loader prove arrival.
        await detailsDialog.locator(".chat-details-session").waitFor({ state: "attached" });
        expect(
          await detailsDialog.getByRole("status", { name: "Loading…", exact: true }).count(),
        ).toBe(0);
        expect(
          await activePane
            .locator(".chat-main__conversation-frame > openclaw-chat-details")
            .count(),
        ).toBe(0);
        await closeChatDetails(activePane);
        await detailsDialog.waitFor({ state: "hidden" });

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
        await gateway.setSessionsListResponse(sessionsListResponse([runningParent, child]));
        await gateway.emitGatewayEvent("sessions.changed", {
          sessionKey: child.key,
          reason: "run-start",
          ts: now + 1,
          session: child,
          ancestorSessions: [runningParent],
        });
        const detailsWithAgents = await openChatDetails(activePane);
        await detailsWithAgents.getByText("Backend review", { exact: true }).waitFor();
        await closeChatDetails(activePane);
        expect(await panel.isVisible()).toBe(false);
        await selectChatLayoutAction(activePane, "Subagents");
        const panelRow = panel.locator(`[data-session-key="${child.key}"]`);
        await panelRow.getByText("Backend review", { exact: true }).waitFor();
        expect(await panelRow.textContent()).toContain("Backend review");
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
        await gateway.setSessionsListResponse(sessionsListResponse([waitingParent, child]));
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
        await gateway.emitGatewayEvent(
          "chat",
          chatEvent(runId, parent.key, "final", { yielded: true }),
        );
        await activePane
          .locator(".chat-thread p")
          .getByText("Waiting for the backend review.", { exact: true })
          .waitFor();
        const pendingStatus = activePane.locator(".chat-working-indicator");
        const waitingOn = pendingStatus.getByRole("link", { name: "Backend review", exact: true });
        await waitingOn.waitFor();
        expect(await waitingOn.getAttribute("href")).toBe("/chat/main/subagent/backend-review");
        expect(await pendingStatus.count()).toBe(1);
        await expect.poll(() => pendingStatus.locator(".chat-reading-indicator").count()).toBe(0);
        expect(await pendingStatus.locator("openclaw-working-phrase").count()).toBe(0);
        expect(await pendingStatus.locator(".chat-subagent-wait").count()).toBe(1);
        expect(await pendingStatus.locator(".chat-working-indicator__subagents").count()).toBe(0);
        expect(
          await activePane.locator(".chat-thread openclaw-chat-subagent-activity").count(),
        ).toBe(0);
        expect(await activePane.locator('[data-test-id="chat-delegation"]').count()).toBe(0);
        expect(await waitLine.count()).toBe(0);
        expect(await transcriptHeight()).toBe(beforeWaitHeight);
      },
    );
  });
});
