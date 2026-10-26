import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { closeChatDetails, openChatDetails } from "./chat-details.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { sessionsListResponse } from "./session-management.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Chat waiting on subagents" });

suite.define(() => {
  it("updates compact Details from observers without reading child histories", async () => {
    const artifactParent = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    const artifactDir = artifactParent
      ? createControlUiE2eArtifactDir("subagent-details-observer", artifactParent)
      : undefined;
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1000, height: 900 } },
      async ({ page }) => {
        const now = Date.now();
        await page.clock.setFixedTime(now);
        await page.addInitScript(
          ({ key }) => {
            localStorage.setItem(key, JSON.stringify({ themeMode: "dark", navCollapsed: true }));
          },
          { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl) },
        );
        const parent = {
          key: "agent:main:dependency-update",
          sessionId: "dependency-update",
          kind: "direct",
          label: "Update dependencies",
          status: "running",
          hasActiveRun: true,
          activeRunIds: ["parent-run"],
          hasActiveSubagentRun: true,
          startedAt: now - 60_000,
        } satisfies GatewaySessionRow;
        const titles = [
          "Update Apple Android and Ruby dependencies",
          "Update Rust and Go dependencies",
          "Update standalone npm and CI dependency pins",
          "Migrate upgraded TypeScript native API imports",
        ];
        const children = titles.map(
          (label, index) =>
            ({
              key: "agent:main:dependency-" + index,
              sessionId: "dependency-" + index,
              kind: "direct",
              label,
              status: "running",
              hasActiveRun: true,
              activeRunIds: ["child-run-" + index],
              parentSessionKey: parent.key,
              spawnedBy: parent.key,
              createdAt: now - 50_000 + index,
              startedAt: now - 50_000 + index,
            }) satisfies GatewaySessionRow,
        );
        const gateway = await installMockGateway(page, {
          sessionKey: parent.key,
          sessions: [{ ...parent, childSessions: children.map((child) => child.key) }, ...children],
          historyMessages: [
            {
              role: "user",
              content: "Update the dependencies and verify compatibility.",
              timestamp: now - 60_000,
            },
            {
              role: "assistant",
              content: "I am checking each dependency group in parallel.",
              timestamp: now - 55_000,
              __openclaw: { id: "delegation", seq: 2, runId: "parent-run" },
            },
          ],
          inFlightRun: { runId: "parent-run", startedAt: parent.startedAt },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, parent.key));
        const pane = page.locator(".chat-pane-cache__pane--active");
        const details = await openChatDetails(pane);
        const group = details.locator('[data-details-group="subagents"]');
        const summary = group.locator(":scope > summary");
        if ((await summary.getAttribute("aria-expanded")) !== "true") {
          await summary.click();
        }
        const activity = group.locator(".chat-subagent-activity");
        const rows = activity.locator(".chat-subagent-activity__row");
        await expect.poll(() => rows.count()).toBe(4);
        const capture = async (name: string) => {
          if (!artifactDir) {
            return;
          }
          const frame = await takeControlUiScreenshotFrame(page, pane, [activity], {
            animations: "disabled",
          });
          await writeFile(path.join(artifactDir, name), frame.png);
        };
        await capture("initial-wide.png");
        const emit = (text: string, runId = "child-run-0", revision = 1) =>
          gateway.emitGatewayEvent("session.observer", {
            sessionKey: children[0]!.key,
            sessionId: children[0]!.sessionId,
            agentId: "main",
            runId,
            revision,
            updatedAt: now + revision,
            health: "on-track",
            headline: text,
          });
        await emit("Verifying the Android dependency graph.");
        await rows
          .first()
          .getByText("Verifying the Android dependency graph.", { exact: true })
          .waitFor();
        await emit("This is from an obsolete run.", "old-run");
        expect(await rows.first().textContent()).not.toContain("obsolete");
        await emit("Checking CocoaPods and Gradle compatibility.", "child-run-0", 2);
        await rows
          .first()
          .getByText("Checking CocoaPods and Gradle compatibility.", { exact: true })
          .waitFor();
        await capture("live-wide.png");
        expect(await activity.locator(".chat-reading-indicator").count()).toBe(0);
        expect(await pane.locator(".chat-thread openclaw-chat-subagent-activity").count()).toBe(0);
        await closeChatDetails(pane);
        for (const child of children) {
          expect(await gateway.getRequests("chat.history", { sessionKey: child.key })).toHaveLength(
            0,
          );
        }
      },
    );
  });

  it("keeps one request clock through subagent waits, navigation, hydration and parent resumption", async () => {
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
        const snapshot = (
          row: GatewaySessionRow,
          offset: number,
          changes: Partial<GatewaySessionRow>,
        ): GatewaySessionRow => ({
          ...row,
          ...changes,
          updatedAt: now + offset,
          snapshotAt: now + offset,
        });
        const changeSession = async (
          session: GatewaySessionRow,
          ancestor: GatewaySessionRow | null,
          reason: "run-start" | "run-settled",
          siblings: GatewaySessionRow[] = [],
        ) => {
          await gateway.setSessionsListResponse(
            sessionsListResponse(ancestor ? [ancestor, session] : [session, ...siblings]),
          );
          await gateway.emitGatewayEvent("sessions.changed", {
            sessionKey: session.key,
            reason,
            ts: session.updatedAt,
            session,
            ancestorSessions: ancestor ? [ancestor] : [],
          });
        };
        const observeChild = (revision: number, offset: number, headline: string) =>
          gateway.emitGatewayEvent("session.observer", {
            sessionKey: child.key,
            agentId: "main",
            sessionId: child.sessionId,
            runId: "backend-run",
            revision,
            updatedAt: now + offset,
            health: "on-track",
            headline,
          });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, parent.key));
        await page
          .getByText("I am delegating the backend implementation.", { exact: true })
          .waitFor();
        const activePane = page.locator(".chat-pane-cache__pane--active");
        const screenshot = async (name: string, targets: ReturnType<typeof page.locator>[]) => {
          if (artifactDir) {
            const frame = await takeControlUiScreenshotFrame(page, activePane, targets, {
              animations: "disabled",
            });
            await writeFile(path.join(artifactDir, name), frame.png);
          }
        };
        const indicator = activePane.locator(".chat-working-indicator");
        await indicator.waitFor();
        expect(await indicator.textContent()).not.toContain("Waiting on subagents");

        const runningChild = snapshot(child, 0, {
          status: "running",
          hasActiveRun: true,
          activeRunIds: ["backend-run"],
          startedAt: now,
        });
        const delegatingParent = snapshot(parent, 0, {
          hasActiveSubagentRun: true,
          childSessions: [child.key],
        });
        await changeSession(runningChild, delegatingParent, "run-start");
        // While the parent still works, its own line counts the running subagents.
        await indicator
          .locator(".chat-working-indicator__subagents")
          .getByText("1 subagent running", { exact: true })
          .waitFor();
        expect(await indicator.textContent()).not.toContain("Waiting on");
        const panel = activePane.locator("openclaw-chat-subagents-panel");
        const panelRow = panel.locator(`[data-session-key="${child.key}"]`);
        const closePanel = async () => {
          await activePane.getByRole("button", { name: "Close Subagents", exact: true }).click();
          await panel.waitFor({ state: "hidden" });
        };
        const childHistoryReads = () =>
          gateway.getRequests("chat.history", { sessionKey: child.key });
        // Only an explicit open loads child metrics. Closed-panel observer updates
        // must not fetch another transcript.
        expect(await panel.isVisible()).toBe(false);
        await selectChatLayoutAction(activePane, "Subagents");
        await panelRow.waitFor();
        await gateway.waitForRequest("chat.history", { match: { sessionKey: child.key } });
        await closePanel();
        const childReadsAfterClose = (await childHistoryReads()).length;
        await observeChild(1, 1, "Verifying the API response");
        expect(await childHistoryReads()).toHaveLength(childReadsAfterClose);
        expect(
          await activePane.locator(".chat-thread openclaw-chat-subagent-activity").count(),
        ).toBe(0);
        expect(await indicator.textContent()).not.toContain("Backend implementation");
        // The ordinary launch tool remains readable and navigable; only the separate
        // transcript activity presentation is gone.
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
        const panelTabHasFocus = () =>
          activePane
            .locator('[data-region-header="side"] .tabstrip-tab[active]')
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
        // Mobile opens the panel in its dock while keeping the conversation
        // and the count that opened it available.
        await activePane.locator(".sidebar-region--narrow").waitFor();
        await runningCount.click();
        await panelRow.waitFor();
        expect(await indicator.isVisible()).toBe(true);
        expect(await activePane.locator(".chat-mobile-host").getAttribute("data-mode")).toBe(
          "dock",
        );
        await expect.poll(countHasFocus).toBe(true);
        // A subagent opened there keeps its own header, with the way back to the list.
        await panelRow.locator(".chat-subagents-mobile__open").click();
        const backToList = panel.getByRole("button", { name: "Back to Subagents", exact: true });
        await backToList.click();
        await panelRow.waitFor();
        // Closing the mobile dock returns to its opener while retaining the tab.
        // Closing the last tab after reopening returns to that same count.
        await selectChatLayoutAction(activePane, "Minimize side panel");
        await indicator.waitFor();
        await panel.waitFor({ state: "hidden" });
        await expect.poll(countHasFocus).toBe(true);
        await runningCount.click();
        await panelRow.waitFor();
        await expect.poll(countHasFocus).toBe(true);
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
        // The mobile dock preserves its last closed choice across desktop use.
        // Reopening it keeps the retained child list and desktop side panel.
        await page.setViewportSize({ width: 390, height: 900 });
        await page.locator(".shell--mobile-nav").waitFor();
        await indicator.waitFor();
        await activePane.locator(".chat-mobile-host").waitFor({ state: "hidden" });
        await runningCount.click();
        await panelRow.waitFor();
        await page.setViewportSize({ width: 1280, height: 900 });
        await indicator.waitFor();
        await panelRow.waitFor();
        await closePanel();
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.locator(".shell:not(.shell--mobile-nav)").waitFor();
        const reportUsage = (usageRunId: string, outputTokens: number, seq = 1) =>
          gateway.emitGatewayEvent("agent", {
            stream: "usage",
            runId: usageRunId,
            seq,
            sessionKey: parent.key,
            data: { outputTokens },
            ts: now,
          });
        const workingTokens = async () =>
          (await indicator.locator(".chat-working-indicator__tokens").textContent())?.trim();
        await reportUsage(runId, 4_100);
        await expect.poll(workingTokens).toBe("4.1k output tokens");
        await screenshot("working-light-1280.png", [indicator]);
        expect(await indicator.locator(".chat-reading-indicator").count()).toBe(1);
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
        const waitingParent = snapshot(delegatingParent, 2, {
          hasActiveRun: false,
          activeRunIds: [],
          endedAt: now + 2,
        });
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
            await screenshot(`waiting-${mode}-${width}.png`, [
              indicator,
              activePane.locator(".agent-chat__composer-combobox"),
            ]);
          }
        };
        await runningCount.waitFor();
        expect(await indicator.count()).toBe(1);
        expect(await indicator.locator(".chat-reading-indicator").count()).toBe(0);
        expect(await indicator.locator("openclaw-working-phrase").count()).toBe(0);
        expect(await indicator.textContent()).not.toContain("Backend implementation");
        expect(await activePane.locator(".agent-chat__composer-run-status--waiting").count()).toBe(
          0,
        );
        const turnTimer = indicator.locator(".chat-working-indicator__elapsed");
        await expect.poll(async () => (await turnTimer.textContent())?.trim()).toBe("1m 13s");
        expect(await turnTimer.count()).toBe(1);
        const childReadsWhileWaiting = (await childHistoryReads()).length;
        await observeChild(2, 63_001, "Running backend regression tests");
        expect(await childHistoryReads()).toHaveLength(childReadsWhileWaiting);
        expect(await activePane.locator(".chat-notice").count()).toBe(0);
        await captureWaiting("light", 1280);
        await captureWaiting("dark", 1280);
        await captureWaiting("dark", 390);
        expect(await childHistoryReads()).toHaveLength(childReadsWhileWaiting);
        expect(
          await indicator.evaluate((element) => element.scrollWidth <= element.clientWidth),
        ).toBe(true);
        await page.setViewportSize({ width: 1280, height: 900 });
        // The full panel reads activity from session snapshots; the compact
        // Details observer stream is covered independently above.
        await changeSession(
          snapshot(runningChild, 63_001, {
            observerDigest: {
              agentId: "main",
              runId: "backend-run",
              revision: 2,
              updatedAt: now + 63_001,
              health: "on-track",
              headline: "Running backend regression tests",
            },
          }),
          waitingParent,
          "run-start",
        );
        // The count opens the collection; opening a child does not navigate the parent.
        const selectedTitle = activePane.locator(".chat-pane__session-title-text").first();
        const detailTitle = panel.locator(".subagents-desktop__child-name");
        await runningCount.click();
        await panelRow.waitFor();
        await expect
          .poll(() => panelRow.textContent())
          .toContain("Running backend regression tests");
        await panelRow.locator(".subagents-desktop__open").click();
        await expect.poll(() => detailTitle.textContent()).toBe("Backend implementation");
        expect(await selectedTitle.textContent()).toBe("Build the implementation");
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
        await indicator.waitFor({ state: "hidden" });
        await page.goBack();
        await expect.poll(() => selectedTitle.textContent()).toBe("Build the implementation");
        const waitLine = activePane.locator(".agent-chat__composer-run-status--waiting");
        await indicator.waitFor();
        await expect.poll(workingTokens).toBe("4.1k output tokens");
        expect(await waitLine.count()).toBe(0);
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
              updatedAt: now + 63_002,
              snapshotAt: now + 63_002,
            },
          ]),
        );
        await runningCount.waitFor();
        const refreshedDetails = await openChatDetails(activePane);
        const refreshedGroup = refreshedDetails.locator('[data-details-group="subagents"]');
        if (
          (await refreshedGroup.locator(":scope > summary").getAttribute("aria-expanded")) !==
          "true"
        ) {
          await refreshedGroup.locator(":scope > summary").click();
        }
        await refreshedGroup
          .getByText("Backend implementation refreshed", { exact: true })
          .waitFor();
        await closeChatDetails(activePane);
        expect(await indicator.count()).toBe(1);
        await expect.poll(async () => (await turnTimer.textContent())?.trim()).toBe("1m 13s");

        const settledChild = snapshot(runningChild, 64_000, {
          status: "done",
          hasActiveRun: false,
          activeRunIds: [],
        });
        const settledParent = snapshot(waitingParent, 64_000, {
          hasActiveSubagentRun: false,
        });
        await changeSession(settledChild, settledParent, "run-settled");
        await indicator.waitFor({ state: "detached" });
        // A later child start must update the selected parent's held row without a reload.
        const restartedChild = snapshot(runningChild, 64_500, {
          activeRunIds: ["backend-review-run"],
        });
        const waitingAgain = snapshot(settledParent, 64_500, {
          hasActiveSubagentRun: true,
        });
        const childReads = (await gateway.getRequests("sessions.list", childRosterQuery)).length;
        await gateway.setSessionsListResponse(sessionsListResponse([waitingAgain, restartedChild]));
        await gateway.deferNext("sessions.list", childRosterQuery);
        await gateway.emitGatewayEvent("sessions.changed", {
          sessionKey: child.key,
          reason: "run-start",
          ts: now + 64_500,
          session: restartedChild,
          ancestorSessions: [waitingAgain],
        });
        // A later batch restores the footer count without reopening the panel.
        // An explicit open still hydrates its independent roster.
        await runningCount.waitFor();
        expect(await indicator.count()).toBe(1);
        expect(await panel.isVisible()).toBe(false);
        await selectChatLayoutAction(activePane, "Subagents");
        await gateway.waitForRequest("sessions.list", {
          after: childReads,
          match: childRosterQuery,
        });
        await gateway.resolveDeferred("sessions.list", sessionsListResponse([restartedChild]));
        const resumedParent = snapshot(waitingAgain, 65_000, {
          hasActiveRun: true,
          activeRunIds: ["parent-resumed-run"],
          startedAt: now + 65_000,
        });
        await changeSession(resumedParent, null, "run-start", [restartedChild]);
        // The resumed run continues the block that handed off. That holds even
        // before its first output, when the pane cannot name the run yet: the
        // claw is already there, on the request's clock, with the tokens so far.
        const block = activePane.locator(".chat-group.assistant", {
          hasText: "Backend work is now delegated.",
        });
        const requestClock = () =>
          block.locator(".chat-working-indicator").locator("openclaw-elapsed-time").textContent();
        await expect.poll(async () => (await requestClock())?.trim()).toBe("1m 13s");
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
        await waitLine.waitFor({ state: "hidden" });
        await page
          .locator(".chat-pane-cache__pane--active .chat-working-indicator")
          .waitFor({ state: "detached" });
        expect(await indicator.count()).toBe(0);
        const visibleAnswer = activePane
          .locator(".chat-text")
          .getByText(answerText, { exact: true });
        expect(await visibleAnswer.count()).toBe(1);
        expect(await activePane.locator(".chat-notice").count()).toBe(0);
        await gateway.emitGatewayEvent("agent", {
          sessionKey: parent.key,
          runId: "parent-resumed-run",
          seq: 2,
          stream: "assistant",
          ts: now + 65_500,
          data: { phase: "commentary", text: "Reviewing the delegated backend result." },
        });
        await indicator.waitFor();
        expect(await indicator.textContent()).not.toContain("Waiting on");
        await screenshot("resumed-dark-1280.png", [
          indicator,
          activePane.locator(".agent-chat__composer-combobox"),
        ]);
        // Still one assistant row once it answers, on the same clock, and both
        // runs' tokens count on its line.
        await block.getByText(answerText, { exact: true }).waitFor();
        expect(await activePane.locator(".chat-group.assistant").count()).toBe(1);
        expect((await requestClock())?.trim()).toBe("1m 13s");
        await reportUsage("parent-resumed-run", 256, 3);
        await expect.poll(workingTokens).toBe("4.4k output tokens");

        const answer = {
          role: "assistant",
          content: answerText,
          stopReason: "stop",
          timestamp: now + 66_000,
          __openclaw: { id: "answer", seq: 7, runId: "parent-resumed-run" },
        };
        const finishedParent = snapshot(resumedParent, 67_000, {
          status: "done",
          hasActiveRun: false,
          hasActiveSubagentRun: false,
          activeRunIds: [],
          lastRunId: "parent-resumed-run",
          runtimeMs: 2_000,
          endedAt: now + 67_000,
        });
        const finishedChild = snapshot(settledChild, 67_000, {
          runtimeMs: 64_000,
        });
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
        await gateway.emitGatewayEvent("sessions.changed", {
          sessionKey: child.key,
          reason: "run-settled",
          ts: now + 67_000,
          session: finishedChild,
          ancestorSessions: [finishedParent],
        });
        // One closing line for the request: 77s since it was asked, not the
        // resumed run's own 2s, with both runs' tokens.
        const recap = activePane.locator(".chat-turn-recap");
        await recap.waitFor();
        expect(
          await recap.locator(":scope > span:not(.chat-turn-recap__claw)").allTextContents(),
        ).toEqual([
          "4.4k output tokens",
          "·",
          expect.stringMatching(/^Done in 1 minute,? 17 seconds$/),
        ]);
        expect(await block.locator(".chat-turn-recap").count()).toBe(1);
        expect(await activePane.locator(".chat-group.assistant").count()).toBe(1);
        // Completed duration and child navigation remain available in Subagents.
        await expect
          .poll(() => panelRow.locator(".subagents-desktop__elapsed").textContent())
          .toBe("1m 4s");
        await expect
          .poll(async () => (await launchState.textContent())?.trim())
          .toMatch(/^1m\s4s$/u);
        expect((await launchName.textContent())?.trim()).toBe("Backend implementation");
        expect(await launchRow.textContent()).not.toContain("Reply with the result only");
        await launchName.click();
        await expect.poll(() => detailTitle.textContent()).toBe("Backend implementation");
        expect(await selectedTitle.textContent()).toBe("Build the implementation");
      },
    );
  });
});
