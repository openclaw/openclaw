import { writeFile } from "node:fs/promises";
import path from "node:path";
import { assert, expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e-defaults.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
  navigateToControlUiSession,
} from "../test-helpers/control-ui-e2e.ts";
import { closeChatDetails } from "./chat-details.test-support.ts";
import { controlUiE2eBuiltModuleRequest } from "./control-ui-built-module.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { sessionsListResponse } from "./session-management.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Chat header and delegated work" });

suite.define(() => {
  it.each([1440, 390])(
    "opens the Subagents list from header status by pointer and keyboard at %ipx",
    async (width) => {
      await suite.withPage(
        { viewport: { width, height: 900 }, colorScheme: "dark", locale: "en-US" },
        async ({ page }) => {
          const now = 1_800_000_000_000;
          await page.clock.setFixedTime(now);
          const parent = {
            key: "agent:main:header-shortcut",
            sessionId: "header-shortcut",
            kind: "direct",
            label: "Review the backend",
            updatedAt: now,
            hasActiveSubagentRun: true,
          } satisfies GatewaySessionRow;
          const child = {
            key: "agent:main:subagent:backend-review",
            sessionId: "backend-review",
            kind: "direct",
            classification: "subagent",
            label: "Backend review",
            parentSessionKey: parent.key,
            spawnedBy: parent.key,
            updatedAt: now,
            startedAt: now - 18_000,
            status: "running",
            hasActiveRun: true,
            activeRunIds: ["backend-run"],
          } satisfies GatewaySessionRow;
          const gateway = await installMockGateway(page, {
            sessionKey: parent.key,
            communityInvite: false,
            sessions: [parent, child],
            historyMessages: [{ role: "assistant", content: "The backend review is underway." }],
            sessionTranscripts: {
              [child.key]: {
                messages: [{ role: "assistant", content: "Checking request validation." }],
              },
            },
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, parent.key));
          const pane = page.locator(".chat-pane-cache__pane--active");
          const status = pane.locator(".chat-pane__subagents-running");
          const panel = pane.locator("openclaw-chat-subagents-panel");
          const message = pane.getByText("The backend review is underway.", { exact: true });
          await message.waitFor();
          await status.waitFor();
          const capture = async (stage: string) => {
            if (!process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR) {
              return;
            }
            const frame = await takeControlUiScreenshotFrame(
              page,
              pane,
              [
                status,
                ...((await message.isVisible()) ? [message] : []),
                ...((await panel.isVisible())
                  ? [panel.getByRole("button", { name: child.label, exact: true })]
                  : []),
              ],
              { animations: "disabled" },
            );
            await writeFile(
              path.join(suite.artifactDir, "header-" + width + "-" + stage + ".png"),
              frame.png,
            );
          };
          await capture("closed");
          expect(await panel.isVisible()).toBe(false);
          await status.click();
          // The status must lead to the existing list, not just look interactive.
          await panel
            .getByRole("button", { name: child.label, exact: true })
            .waitFor({ timeout: 5_000 });
          await capture("opened");
          await panel.getByRole("button", { name: child.label, exact: true }).click();
          await panel.getByText("Checking request validation.", { exact: true }).waitFor();
          await status.focus();
          await page.keyboard.press("Enter");
          await panel.getByRole("button", { name: child.label, exact: true }).waitFor();
          const tab = pane.locator(
            '[data-region-header="side"] .tabstrip-tab[aria-selected="true"]',
          );
          await expect
            .poll(() => tab.evaluate((node) => node === document.activeElement))
            .toBe(true);
          await pane.getByRole("button", { name: "Close Subagents", exact: true }).click();
          await panel.waitFor({ state: "hidden" });
          await status.focus();
          await page.keyboard.press("Space");
          await panel.getByRole("button", { name: child.label, exact: true }).waitFor();
          await expect
            .poll(() => tab.evaluate((node) => node === document.activeElement))
            .toBe(true);
          expect(page.url()).toBe(controlUiSessionUrl(suite.server.baseUrl, parent.key));
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        },
      );
    },
  );

  it.each([
    { key: "agent:main:acp:coder", mixed: false },
    { key: "agent:main:acp:coder", mixed: true },
    { key: "agent:main:worker:unknown", mixed: false },
  ])("keeps unlisted child counts static for $key (mixed: $mixed)", async ({ key, mixed }) => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const now = Date.now();
      const parent = {
        key: "agent:main:unlisted-parent",
        sessionId: "unlisted-parent",
        kind: "direct",
        label: "Review delegated work",
        updatedAt: now,
        hasActiveSubagentRun: true,
      } satisfies GatewaySessionRow;
      const child = {
        key,
        sessionId: "unlisted-child",
        kind: "direct",
        label: "External worker",
        parentSessionKey: parent.key,
        spawnedBy: parent.key,
        updatedAt: now,
        status: "running",
        hasActiveRun: true,
        activeRunIds: ["external-run"],
      } satisfies GatewaySessionRow;
      const listed = {
        ...child,
        key: "agent:main:subagent:listed",
        sessionId: "listed-child",
        classification: "subagent",
        label: "Listed worker",
      } satisfies GatewaySessionRow;
      await installMockGateway(page, {
        sessionKey: parent.key,
        communityInvite: false,
        sessions: [parent, child, ...(mixed ? [listed] : [])],
        historyMessages: [{ role: "assistant", content: "Delegated work is underway." }],
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, parent.key));
      const pane = page.locator(".chat-pane-cache__pane--active");
      await pane.getByText("Delegated work is underway.", { exact: true }).waitFor();
      const status = pane.locator(".chat-pane__subagents-running");
      await status.waitFor();
      expect(await status.textContent()).toContain(mixed ? "2 running" : "1 running");
      expect(await status.evaluate((node) => node.tagName)).toBe("SPAN");
      await status.click();
      expect(await pane.locator("openclaw-chat-subagents-panel").isVisible()).toBe(false);
    });
  });

  it("keeps new batches collapsed until Subagents is opened manually without duplicate wait status", async () => {
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
        const activityModule = controlUiE2eBuiltModuleRequest(
          "ui/src/pages/chat/components/chat-subagent-activity-live.tsx",
        );
        const detailsChunk = Promise.withResolvers<void>();
        await page.route(
          controlUiE2eBuiltModuleRequest("ui/src/pages/chat/components/chat-details-session.tsx"),
          async (route) => {
            await detailsChunk.promise;
            await route.continue();
          },
        );
        const activityChunk = Promise.withResolvers<void>();
        const activityRequested = Promise.withResolvers<void>();
        await page.route(activityModule, async (route) => {
          activityRequested.resolve();
          await activityChunk.promise;
          await route.continue();
        });
        const activityRequests: string[] = [];
        page.on("request", (request) => {
          if (activityModule.test(request.url())) {
            activityRequests.push(request.url());
          }
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, parent.key));
        const activePane = page.locator(".chat-pane-cache__pane--active");
        const panel = activePane.locator("openclaw-chat-subagents-panel");
        const waitLine = activePane.locator(".agent-chat__composer-run-status--waiting");
        await activePane.getByText("Ready for delegated work.", { exact: true }).waitFor();
        expect(activityRequests).toEqual([]);
        expect(await panel.isVisible()).toBe(false);
        expect(await activePane.locator(".chat-pane__actions").getByRole("button").count()).toBe(3);

        const details = activePane.locator(".chat-pane__header-trailing > openclaw-chat-details");
        const detailsDialog = activePane.getByRole("dialog", { name: "Details", exact: true });
        await details.getByRole("button", { name: "Details", exact: true }).click();
        await detailsDialog.waitFor();
        await detailsDialog.getByRole("status").filter({ hasText: "Loading…" }).waitFor();
        detailsChunk.resolve();
        await detailsDialog.locator(".chat-details-session").waitFor();
        expect(
          await detailsDialog.getByRole("status").filter({ hasText: "Loading…" }).count(),
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
        await gateway.setSessionsListResponse(sessionsListResponse([runningParent, child, next]));
        await gateway.emitGatewayEvent("sessions.changed", {
          sessionKey: child.key,
          reason: "run-start",
          ts: now + 1,
          session: child,
          ancestorSessions: [runningParent],
        });
        const runningCount = activePane.locator(".chat-pane__subagents-running");
        await runningCount.waitFor();
        expect(await panel.isVisible()).toBe(false);
        await selectChatLayoutAction(activePane, "Subagents");
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
        await activityRequested.promise;
        const pendingStatus = activePane.locator(".chat-working-indicator");
        await pendingStatus.locator(".chat-reading-indicator").waitFor();
        expect(await pendingStatus.isVisible()).toBe(true);
        expect(await pendingStatus.textContent()).toContain("Working");
        expect(await activePane.locator(".chat-subagent-activity").count()).toBe(0);
        activityChunk.resolve();
        await activePane
          .locator(".chat-subagent-activity")
          .getByText("Backend review", { exact: true })
          .waitFor();
        expect(activityRequests).toHaveLength(1);
        await pendingStatus.waitFor({ state: "hidden" });
        expect(await waitLine.count()).toBe(0);
        expect(await activePane.locator(".chat-working-indicator--subagents").count()).toBe(0);
        expect(await transcriptHeight()).toBe(beforeWaitHeight);
        const mountedPanel = await panel.elementHandle();
        await selectChatLayoutAction(activePane, "Expand Subagents");
        await activePane.locator(".sidebar-region--expanded-side").waitFor();
        await selectChatLayoutAction(activePane, "Restore split");
        await activePane.locator(".sidebar-region--expanded-side").waitFor({ state: "hidden" });
        expect(await mountedPanel?.evaluate((element) => element.isConnected)).toBe(true);
        await selectChatLayoutAction(activePane, "Expand Subagents");
        const activeSubagentsTab = activePane.locator(
          '[data-region-header="side"] .tabstrip-tab[aria-selected="true"]',
        );
        await activeSubagentsTab.focus();
        await page.keyboard.press("Enter");
        expect(await activePane.locator(".sidebar-region--expanded-side").isVisible()).toBe(true);
        await selectChatLayoutAction(activePane, "Restore split");
        await activePane.locator(".sidebar-region--expanded-side").waitFor({ state: "hidden" });
        expect(await mountedPanel?.evaluate((element) => element.isConnected)).toBe(true);
        await mountedPanel?.dispose();
        await activePane.getByRole("button", { name: "Close Subagents", exact: true }).click();
        await panel.waitFor({ state: "hidden" });
        await selectChatLayoutAction(activePane, "Subagents");
        await panelRow.waitFor();

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
        expect(await activePane.locator(".agent-chat__composer-run-status").count()).toBe(0);
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
