import path from "node:path";
import { expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { sessionsListResponse } from "./session-management.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Chat waiting on subagents" });

suite.define(() => {
  it("shows child activity without a redundant wait line and restores the parent's working indicator", async () => {
    const artifactParent = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    const artifactDir = artifactParent
      ? createControlUiE2eArtifactDir("chat-subagent-waiting", artifactParent)
      : undefined;
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        const now = Date.now();
        await page.clock.setFixedTime(now);
        await page.addInitScript(
          ({ key }) => {
            localStorage.setItem(key, JSON.stringify({ themeMode: "light" }));
          },
          { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl) },
        );
        const runId = "parent-delegation-run";
        const parent = {
          key: "agent:main:implementation-parent",
          sessionId: "implementation-parent",
          kind: "direct",
          label: "Build the implementation",
          status: "running",
          hasActiveRun: true,
          hasActiveSubagentRun: false,
          activeRunIds: [runId],
          startedAt: now - 10_000,
          updatedAt: now - 10_000,
        } satisfies GatewaySessionRow;
        const child = {
          key: "agent:main:implementation-child",
          sessionId: "implementation-child",
          kind: "direct",
          classification: "subagent",
          label: "Backend implementation",
          spawnedBy: parent.key,
          parentSessionKey: parent.key,
          status: "done",
          hasActiveRun: false,
          activeRunIds: [],
          updatedAt: now - 10_000,
        } satisfies GatewaySessionRow;
        const history = [
          {
            role: "user",
            content: "Implement the backend and report the result.",
            timestamp: now - 10_000,
            __openclaw: { id: "request", seq: 1, idempotencyKey: `${runId}:user` },
          },
          {
            role: "assistant",
            content: "I am delegating the backend implementation.",
            timestamp: now - 9_000,
            __openclaw: { id: "delegation", seq: 2, runId },
          },
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "launch",
                name: "sessions_spawn",
                arguments: {
                  label: "Backend implementation",
                  task: "Implement the backend. Reply with the result only.",
                },
              },
            ],
            timestamp: now - 8_500,
            __openclaw: { id: "launch-call", seq: 3, runId },
          },
          {
            role: "toolResult",
            toolCallId: "launch",
            toolName: "sessions_spawn",
            content: [
              {
                type: "text",
                text: JSON.stringify({ status: "accepted", childSessionKey: child.key }, null, 2),
              },
            ],
            timestamp: now - 8_400,
            __openclaw: { id: "launch-result", seq: 4, runId },
          },
        ];
        const gateway = await installMockGateway(page, {
          sessionKey: parent.key,
          sessions: [parent, child],
          historyMessages: history,
          inFlightRun: { runId, startedAt: parent.startedAt },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, parent.key));
        await page
          .getByText("I am delegating the backend implementation.", { exact: true })
          .waitFor();
        const activePane = page.locator(".chat-pane-cache__pane--active");
        const indicator = activePane.locator(".chat-working-indicator");
        await indicator.waitFor();
        expect(await indicator.textContent()).not.toContain("Waiting on subagents");

        const runningChild: GatewaySessionRow = {
          ...child,
          status: "running",
          hasActiveRun: true,
          activeRunIds: ["backend-run"],
          startedAt: now,
          updatedAt: now,
          snapshotAt: now,
        };
        const delegatingParent: GatewaySessionRow = {
          ...parent,
          hasActiveSubagentRun: true,
          childSessions: [child.key],
          updatedAt: now,
          snapshotAt: now,
        };
        await gateway.setSessionsListResponse(
          sessionsListResponse([delegatingParent, runningChild]),
        );
        await gateway.emitGatewayEvent("sessions.changed", {
          sessionKey: child.key,
          reason: "run-start",
          ts: now,
          session: runningChild,
          ancestorSessions: [delegatingParent],
        });
        // While the parent still works, its own line counts the running subagents.
        await indicator
          .locator(".chat-working-indicator__subagents")
          .getByText("1 subagent running", { exact: true })
          .waitFor();
        expect(await indicator.textContent()).not.toContain("Waiting on");
        // Its launch row reads as the subagent: its name, not its assignment, and its state.
        const activityRow = activePane.locator(`[data-subagent-session-key="${child.key}"]`);
        await activityRow.getByText("Backend implementation", { exact: true }).waitFor();
        const childHistoryReads = () =>
          gateway.getRequests("chat.history", { sessionKey: child.key });
        expect(await childHistoryReads()).toHaveLength(0);
        await gateway.emitGatewayEvent("session.observer", {
          sessionKey: child.key,
          agentId: "main",
          sessionId: child.sessionId,
          runId: "backend-run",
          revision: 1,
          updatedAt: now + 1,
          health: "on-track",
          headline: "Verifying the API response",
        });
        await activityRow.getByText("Verifying the API response", { exact: true }).waitFor();
        expect(await childHistoryReads()).toHaveLength(0);
        const launchRow = activePane.locator(".chat-tool-row--subagent");
        const launchName = launchRow.locator(".chat-tool-row__subagent-link");
        const launchState = launchRow.locator(".chat-tool-row__subagent-state");
        await launchState.getByText("running", { exact: true }).waitFor();
        expect((await launchName.textContent())?.trim()).toBe("Backend implementation");
        expect(await launchRow.textContent()).not.toContain("Reply with the result only");
        // The count leads to the list of them, beside the conversation.
        const runningCount = indicator.getByRole("button", {
          name: "1 subagent running",
          exact: true,
        });
        const panel = activePane.locator("openclaw-chat-subagents-panel");
        const panelRow = panel.locator(`[data-session-key="${child.key}"]`);
        const closePanel = async () => {
          await activePane.getByRole("button", { name: "Close Subagents", exact: true }).click();
          await panel.waitFor({ state: "hidden" });
        };
        const panelTabHasFocus = () =>
          activePane
            .locator('[data-region-header="side"] wa-tab[active]')
            .first()
            .evaluate((element) => element.matches(":focus"));
        const countHasFocus = () => runningCount.evaluate((element) => element.matches(":focus"));
        // Measure the phone layout itself, not the frame before the shell collapses.
        await page.setViewportSize({ width: 390, height: 900 });
        await page.locator(".shell--mobile-nav").waitFor();
        await indicator.locator(".chat-working-indicator__subagents").waitFor();
        expect(
          await indicator.evaluate((element) => element.scrollWidth <= element.clientWidth),
        ).toBe(true);
        // With no room beside the conversation the panel takes its place, and focus
        // goes with it, also when this is the first side panel the page loads.
        await activePane.locator(".sidebar-region--narrow").waitFor();
        await runningCount.click();
        await panelRow.waitFor();
        expect(await indicator.isVisible()).toBe(false);
        await expect.poll(panelTabHasFocus).toBe(true);
        // A subagent opened there keeps its own header, with the way back to the list.
        await panelRow.getByRole("button", { name: "Backend implementation", exact: true }).click();
        const backToList = panel.getByRole("button", { name: "Back to Subagents", exact: true });
        await backToList.click();
        await panelRow.waitFor();
        // Closing returns to the conversation and focus to the count, whether the
        // side panel is closed or its last tab is.
        await activePane
          .locator('[data-region-header="side"]')
          .getByRole("button", { name: "Close", exact: true })
          .click();
        await indicator.waitFor();
        await expect.poll(countHasFocus).toBe(true);
        await runningCount.click();
        await expect.poll(panelTabHasFocus).toBe(true);
        await closePanel();
        await indicator.waitFor();
        await expect.poll(countHasFocus).toBe(true);
        // With room, the panel opens beside the conversation and leaves focus alone.
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.locator(".shell:not(.shell--mobile-nav)").waitFor();
        await runningCount.click();
        await panelRow.waitFor();
        expect(await indicator.isVisible()).toBe(true);
        expect(await panelTabHasFocus()).toBe(false);
        // The same open panel replaces the conversation while the pane is narrow,
        // and sits beside it again afterwards: nothing about that is saved.
        await page.setViewportSize({ width: 390, height: 900 });
        await page.locator(".shell--mobile-nav").waitFor();
        await indicator.waitFor({ state: "hidden" });
        await panelRow.waitFor();
        await page.setViewportSize({ width: 1280, height: 900 });
        await indicator.waitFor();
        await panelRow.waitFor();
        await closePanel();
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.locator(".shell:not(.shell--mobile-nav)").waitFor();
        const reportUsage = (usageRunId: string, outputTokens: number) =>
          gateway.emitGatewayEvent("agent", {
            stream: "usage",
            runId: usageRunId,
            seq: 1,
            sessionKey: parent.key,
            data: { outputTokens },
            ts: now,
          });
        const workingTokens = async () =>
          (await indicator.locator(".chat-working-indicator__tokens").textContent())?.trim();
        await reportUsage(runId, 4_100);
        await expect.poll(workingTokens).toBe("4.1k output tokens");
        const yieldCall = {
          role: "assistant",
          content: [
            { type: "text", text: "Backend work is now delegated." },
            { type: "toolCall", id: "handoff", name: "sessions_yield", arguments: {} },
          ],
          timestamp: now + 1,
          __openclaw: { id: "yield-call", seq: 5, runId },
        };
        const yieldResult = {
          role: "toolResult",
          toolCallId: "handoff",
          toolName: "sessions_yield",
          content: [{ type: "text", text: '{"status":"yielded"}' }],
          timestamp: now + 2,
          __openclaw: { id: "yield-result", seq: 6, runId },
        };
        const yieldedHistory = [...history, yieldCall, yieldResult];
        const waitingParent: GatewaySessionRow = {
          ...delegatingParent,
          hasActiveRun: false,
          activeRunIds: [],
          updatedAt: now + 2,
          snapshotAt: now + 2,
        };
        await gateway.setSessionsListResponse(sessionsListResponse([waitingParent, runningChild]));
        await gateway.setMethodResponse("chat.history", {
          messages: yieldedHistory,
          sessionId: parent.sessionId,
          sessionInfo: waitingParent,
          inFlightRun: null,
        });
        await gateway.emitGatewayEvent("session.message", {
          sessionKey: parent.key,
          message: yieldResult,
          messageId: "yield-result",
          messageSeq: 6,
          hasActiveRun: true,
          session: delegatingParent,
        });
        const historyReads = (await gateway.getRequests("chat.history")).length;
        await page.clock.setFixedTime(now + 63_000);
        await gateway.emitGatewayEvent("chat", {
          sessionKey: parent.key,
          runId,
          state: "final",
          yielded: true,
        });
        await gateway.waitForRequest("chat.history", { after: historyReads });
        // Both before and after captures follow the same committed transcript boundary.
        await page
          .locator(".chat-thread p")
          .getByText("Backend work is now delegated.", { exact: true })
          .waitFor();
        const captureWaiting = async (mode: "light" | "dark", width: number) => {
          await page.setViewportSize({ width, height: 900 });
          await page.evaluate((themeMode) => {
            document.documentElement.dataset.themeMode = themeMode;
            document.documentElement.style.colorScheme = themeMode;
          }, mode);
          if (artifactDir) {
            await page.screenshot({
              path: path.join(artifactDir, `waiting-${mode}-${width}.png`),
              animations: "disabled",
            });
          }
        };
        const childLink = activityRow.getByRole("button");
        await childLink.waitFor();
        expect(await indicator.count()).toBe(0);
        // Individual activity stays in the handed-off reply, without another status row.
        expect(
          await activePane
            .locator(".chat-group.assistant", { hasText: "Backend work is now delegated." })
            .locator(".chat-subagent-activity")
            .count(),
        ).toBe(1);
        await gateway.emitGatewayEvent("session.observer", {
          sessionKey: child.key,
          agentId: "main",
          sessionId: child.sessionId,
          runId: "backend-run",
          revision: 2,
          updatedAt: now + 63_001,
          health: "on-track",
          headline: "Running backend regression tests",
        });
        await activityRow.getByText("Running backend regression tests", { exact: true }).waitFor();
        expect(await activePane.locator(".chat-notice").count()).toBe(0);
        await captureWaiting("light", 1280);
        await captureWaiting("dark", 1280);
        await captureWaiting("dark", 390);
        expect(
          await activityRow.evaluate((element) => element.scrollWidth <= element.clientWidth),
        ).toBe(true);
        await page.setViewportSize({ width: 1280, height: 900 });
        // Its name shows that subagent in the panel; the conversation stays where it was.
        const selectedTitle = page.locator(
          ".chat-pane-cache__pane--active .chat-pane__session-title-text",
        );
        const detailTitle = panel.locator(".chat-subagent-detail__title");
        await activityRow.getByRole("button").click();
        await expect.poll(() => detailTitle.textContent()).toBe("Backend implementation");
        expect(await selectedTitle.textContent()).toBe("Build the implementation");
        await childLink.waitFor();
        await backToList.click();
        await panelRow.waitFor();
        await closePanel();
        // Leaving the conversation and coming back restores the wait from a fresh roster.
        const childRosterQuery = { spawnedBy: parent.key, limit: 10_000 };
        await gateway.waitForRequest("sessions.list", { match: childRosterQuery });
        const childRosterReads = (await gateway.getRequests("sessions.list", childRosterQuery))
          .length;
        await gateway.deferNext("sessions.list", childRosterQuery);
        await page.locator(".sidebar-new-session").first().click();
        await childLink.waitFor({ state: "hidden" });
        await page.goBack();
        await expect.poll(() => selectedTitle.textContent()).toBe("Build the implementation");
        await activePane.locator(".chat-working-indicator--subagents").waitFor();
        expect(await indicator.textContent()).toContain("Waiting on subagents");
        await gateway.waitForRequest("sessions.list", {
          after: childRosterReads,
          match: childRosterQuery,
        });
        // Await the restored pane's hydration before measuring event-only updates.
        await gateway.resolveDeferred(
          "sessions.list",
          sessionsListResponse([
            {
              ...runningChild,
              label: "Backend implementation refreshed",
              updatedAt: now + 63_000,
              snapshotAt: now + 63_000,
            },
          ]),
        );
        await activityRow.getByText("Backend implementation refreshed", { exact: true }).waitFor();
        expect(await indicator.count()).toBe(0);

        const settledChild: GatewaySessionRow = {
          ...runningChild,
          status: "done",
          hasActiveRun: false,
          activeRunIds: [],
          updatedAt: now + 64_000,
          snapshotAt: now + 64_000,
        };
        const settledParent: GatewaySessionRow = {
          ...waitingParent,
          hasActiveSubagentRun: false,
          updatedAt: now + 64_000,
          snapshotAt: now + 64_000,
        };
        await gateway.setSessionsListResponse(sessionsListResponse([settledParent, settledChild]));
        await gateway.emitGatewayEvent("sessions.changed", {
          sessionKey: child.key,
          reason: "run-settled",
          ts: now + 64_000,
          session: settledChild,
          ancestorSessions: [settledParent],
        });
        await activityRow.waitFor({ state: "detached" });
        // A later child start must update the selected parent's held row without a reload.
        const restartedChild: GatewaySessionRow = {
          ...runningChild,
          activeRunIds: ["backend-review-run"],
          updatedAt: now + 64_500,
          snapshotAt: now + 64_500,
        };
        const waitingAgain: GatewaySessionRow = {
          ...settledParent,
          hasActiveSubagentRun: true,
          updatedAt: now + 64_500,
          snapshotAt: now + 64_500,
        };
        const childReads = (await gateway.getRequests("sessions.list", { spawnedBy: parent.key }))
          .length;
        await gateway.setSessionsListResponse(sessionsListResponse([waitingAgain, restartedChild]));
        await gateway.emitGatewayEvent("sessions.changed", {
          sessionKey: child.key,
          reason: "run-start",
          ts: now + 64_500,
          session: restartedChild,
          ancestorSessions: [waitingAgain],
        });
        await activityRow.waitFor();
        expect(await indicator.count()).toBe(0);
        expect(await gateway.getRequests("sessions.list", { spawnedBy: parent.key })).toHaveLength(
          childReads,
        );
        const resumedParent: GatewaySessionRow = {
          ...waitingAgain,
          hasActiveRun: true,
          activeRunIds: ["parent-resumed-run"],
          startedAt: now + 65_000,
          updatedAt: now + 65_000,
          snapshotAt: now + 65_000,
        };
        await gateway.setSessionsListResponse(
          sessionsListResponse([resumedParent, restartedChild]),
        );
        await gateway.emitGatewayEvent("sessions.changed", {
          sessionKey: parent.key,
          reason: "run-start",
          ts: now + 65_000,
          session: resumedParent,
          ancestorSessions: [],
        });
        // The resumed run continues the block that handed off. That holds even
        // before its first output, when the pane cannot name the run yet: the
        // claw is already there, on the request's clock, with the tokens so far.
        const block = activePane.locator(".chat-group.assistant", {
          hasText: "Backend work is now delegated.",
        });
        const requestClock = () =>
          block
            .locator(".chat-working-indicator:not(.chat-working-indicator--subagents)")
            .locator("openclaw-elapsed-time")
            .evaluate((element) => Reflect.get(element, "startMs"));
        await expect.poll(requestClock).toBe(history[0]!.timestamp);
        expect(await activePane.locator(".chat-group.assistant").count()).toBe(1);
        expect(await workingTokens()).toBe("4.1k output tokens");
        const answerText = "The backend is complete. I am reviewing the result.";
        await gateway.emitGatewayEvent("chat", {
          sessionKey: parent.key,
          runId: "parent-resumed-run",
          state: "delta",
          deltaText: answerText,
          message: { role: "assistant", content: answerText, timestamp: now + 65_000 },
        });
        await page.locator(".chat-working-indicator--subagents").waitFor({ state: "detached" });
        await page
          .locator(
            ".chat-pane-cache__pane--active .chat-working-indicator:not(.chat-working-indicator--subagents)",
          )
          .waitFor();
        expect(await indicator.textContent()).not.toContain("Waiting on");
        expect(await activePane.locator(".chat-notice").count()).toBe(0);
        if (artifactDir) {
          await page.screenshot({
            path: path.join(artifactDir, "resumed-dark-1280.png"),
            animations: "disabled",
          });
        }
        // Still one assistant row once it answers, on the same clock, and both
        // runs' tokens count on its line.
        await block.getByText(answerText, { exact: true }).waitFor();
        expect(await activePane.locator(".chat-group.assistant").count()).toBe(1);
        expect(await requestClock()).toBe(history[0]!.timestamp);
        await reportUsage("parent-resumed-run", 256);
        await expect.poll(workingTokens).toBe("4.4k output tokens");

        const answer = {
          role: "assistant",
          content: answerText,
          stopReason: "stop",
          timestamp: now + 66_000,
          __openclaw: { id: "answer", seq: 7, runId: "parent-resumed-run" },
        };
        const finishedParent: GatewaySessionRow = {
          ...resumedParent,
          status: "done",
          hasActiveRun: false,
          hasActiveSubagentRun: false,
          activeRunIds: [],
          lastRunId: "parent-resumed-run",
          runtimeMs: 2_000,
          endedAt: now + 67_000,
          updatedAt: now + 67_000,
          snapshotAt: now + 67_000,
        };
        const finishedChild = {
          ...settledChild,
          runtimeMs: 64_000,
          updatedAt: now + 67_000,
          snapshotAt: now + 67_000,
        };
        await gateway.setSessionsListResponse(
          sessionsListResponse([finishedParent, finishedChild]),
        );
        await gateway.setMethodResponse("chat.history", {
          messages: [...yieldedHistory, answer],
          sessionId: parent.sessionId,
          sessionInfo: finishedParent,
          inFlightRun: null,
        });
        await gateway.emitGatewayEvent("chat", {
          sessionKey: parent.key,
          runId: "parent-resumed-run",
          state: "final",
          message: answer,
        });
        await gateway.emitGatewayEvent("sessions.changed", {
          sessionKey: parent.key,
          reason: "run-settled",
          ts: now + 67_000,
          session: finishedParent,
          ancestorSessions: [],
        });
        // One closing line for the request: 77s since it was asked, not the
        // resumed run's own 2s, with both runs' tokens.
        const recap = activePane.locator(".chat-turn-recap");
        await recap.waitFor();
        expect((await recap.textContent())?.replace(/\s+/g, " ").trim()).toMatch(
          /^Done in 1 minute,? 17 seconds · 4\.4k output tokens$/,
        );
        expect(await block.locator(".chat-turn-recap").count()).toBe(1);
        expect(await activePane.locator(".chat-group.assistant").count()).toBe(1);
        // The finished subagent's row shows how long it took, and its name shows it in the panel.
        await expect
          .poll(async () => (await launchState.textContent())?.trim())
          .toMatch(/^1m\s4s$/u);
        await launchName.click();
        await expect.poll(() => detailTitle.textContent()).toBe("Backend implementation");
        expect(await selectedTitle.textContent()).toBe("Build the implementation");
      },
    );
  });
});
