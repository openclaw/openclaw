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
  it("keeps a yielded parent visibly waiting until its child settles and its next run resumes", async () => {
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
        const indicator = page.locator(".chat-pane-cache__pane--active .chat-working-indicator");
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
        const yieldCall = {
          role: "assistant",
          content: [
            { type: "text", text: "Backend work is now delegated." },
            { type: "toolCall", id: "handoff", name: "sessions_yield", arguments: {} },
          ],
          timestamp: now + 1,
          __openclaw: { id: "yield-call", seq: 3, runId },
        };
        const yieldResult = {
          role: "toolResult",
          toolCallId: "handoff",
          toolName: "sessions_yield",
          content: [{ type: "text", text: '{"status":"yielded"}' }],
          timestamp: now + 2,
          __openclaw: { id: "yield-result", seq: 4, runId },
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
          messageSeq: 4,
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
        expect(await indicator.textContent()).toContain("Waiting on subagents");
        const childLink = indicator.getByRole("button", {
          name: "Backend implementation",
          exact: true,
        });
        await childLink.waitFor();
        expect(await indicator.locator("openclaw-elapsed-time").count()).toBe(1);
        expect(await indicator.textContent()).not.toContain("output tokens");
        await page.getByText("Handed off and waiting", { exact: true }).waitFor();
        await captureWaiting("light", 1280);
        await captureWaiting("dark", 1280);
        await captureWaiting("dark", 390);
        expect(
          await indicator.evaluate((element) => element.scrollWidth <= element.clientWidth),
        ).toBe(true);
        await page.setViewportSize({ width: 1280, height: 900 });
        await childLink.click();
        const selectedTitle = page.locator(
          ".chat-pane-cache__pane--active .chat-pane__session-title-text",
        );
        await expect.poll(() => selectedTitle.textContent()).toBe("Backend implementation");
        await page.goBack();
        await expect.poll(() => selectedTitle.textContent()).toBe("Build the implementation");
        await page.getByText("Handed off and waiting", { exact: true }).waitFor();

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
        await indicator.waitFor({ state: "detached" });
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
        await indicator.getByText("Waiting on subagents", { exact: true }).waitFor();
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
        await gateway.emitGatewayEvent("chat", {
          sessionKey: parent.key,
          runId: "parent-resumed-run",
          state: "delta",
          deltaText: "The backend is complete. I am reviewing the result.",
          message: {
            role: "assistant",
            content: "The backend is complete. I am reviewing the result.",
            timestamp: now + 65_000,
          },
        });
        await page.locator(".chat-working-indicator--subagents").waitFor({ state: "detached" });
        await page
          .locator(
            ".chat-pane-cache__pane--active .chat-working-indicator:not(.chat-working-indicator--subagents)",
          )
          .waitFor();
        expect(await indicator.textContent()).not.toContain("Waiting on subagents");
        await page.getByText("Resumed", { exact: true }).waitFor();
        if (artifactDir) {
          await page.screenshot({
            path: path.join(artifactDir, "resumed-dark-1280.png"),
            animations: "disabled",
          });
        }
      },
    );
  });
});
