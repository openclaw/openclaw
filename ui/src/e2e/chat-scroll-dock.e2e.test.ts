import { writeFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../src/gateway/control-ui-contract.js";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../lib/session-pull-requests.ts";
import { CHAT_TRANSCRIPT_END_THRESHOLD_PX } from "../pages/chat/scroll.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  chatThreadDistanceFromBottom,
  captureUiProofEnabled,
  createChatFlowE2eSuite,
  installMockGateway,
  scrollChatThreadToTop,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";
import { waitForWatchedSessionKey } from "./chat-github-publication.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();
type DockGeometry = {
  distance: number;
  overhang: number;
  rowKey: string | null;
  rowHeight: number;
  sizerHeight: number;
  latestVisible: string | null;
};

async function dockGeometry(page: Page): Promise<DockGeometry> {
  return page.locator(".chat-pane-cache__pane--active").evaluate((pane) => {
    const thread = pane.querySelector<HTMLElement>(".chat-thread");
    const rows = pane.querySelectorAll<HTMLElement>(".chat-virtual-row");
    const row = rows.item(rows.length - 1);
    const sizer = pane.querySelector<HTMLElement>(".chat-virtual-sizer");
    const dock = pane.querySelector<HTMLElement>(".chat-prs, .agent-chat__composer-shell");
    if (!thread || !row || !sizer || !dock) {
      throw new Error("Expected a transcript row, sizer, and composer dock");
    }
    return {
      distance: Math.round(thread.scrollHeight - thread.scrollTop - thread.clientHeight),
      overhang: Math.round(row.getBoundingClientRect().bottom - dock.getBoundingClientRect().top),
      rowKey: row.getAttribute("data-virtual-row-key"),
      rowHeight: row.offsetHeight,
      sizerHeight: sizer.offsetHeight,
      latestVisible:
        pane.querySelector(".chat-scroll-to-bottom")?.getAttribute("data-visible") ?? null,
    };
  });
}

function expectDockClear(report: Record<string, DockGeometry>): void {
  for (const [stage, { distance, overhang }] of Object.entries(report)) {
    expect(
      distance,
      `${stage} distance from bottom: ${JSON.stringify(report[stage])}`,
    ).toBeLessThanOrEqual(CHAT_TRANSCRIPT_END_THRESHOLD_PX);
    expect(overhang, `${stage} last row overhang into the dock`).toBeLessThanOrEqual(0);
  }
}

suite.define(() => {
  it("keeps the transcript end visible when the composer dock grows", async () => {
    const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const baseTs = Date.now() - 100_000;
    const historyMessages = Array.from({ length: 40 }, (_, index) => ({
      content: [{ text: `Dock history ${index}\n${"transcript line\n".repeat(3)}`, type: "text" }],
      role: index % 2 === 0 ? "assistant" : "user",
      timestamp: baseTs + index,
    }));
    const gateway = await installMockGateway(page, {
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "config.get",
        "progressCard.get",
        SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
      ],
      historyMessages,
      methodResponses: {
        [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
        "progressCard.get": { card: null },
      },
    });
    const report: Record<string, DockGeometry> = {};
    const proofDir = captureUiProofEnabled
      ? createControlUiE2eArtifactDir("chat-scroll-dock")
      : null;
    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.getByText("Dock history 39").waitFor({ timeout: 10_000 });
      await expect
        .poll(() => chatThreadDistanceFromBottom(page), { timeout: 10_000 })
        .toBeLessThanOrEqual(CHAT_TRANSCRIPT_END_THRESHOLD_PX);
      await waitForChatScrollIdle(page);
      report.initial = await dockGeometry(page);

      const watchedKey = await waitForWatchedSessionKey(gateway);
      await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
        sessions: {
          [watchedKey]: {
            pullRequests: [
              {
                number: 144615,
                owner: "openclaw",
                repo: "openclaw",
                branch: "fix/clawhub-publish-metadata-2026-9-4",
                title: "fix: publish ClawHub metadata",
                url: "https://github.com/openclaw/openclaw/pull/144615",
                state: "open",
                additions: 295,
                deletions: 57,
                checks: { state: "failing", passed: 60, failed: 1, skipped: 0, running: 0 },
                checksUrl: "https://github.com/openclaw/openclaw/pull/144615/checks",
              },
            ],
            rateLimited: false,
            status: "ready",
          },
        },
      });
      await page.locator(".chat-pr").first().waitFor();
      await waitForChatScrollIdle(page);
      report.afterPr = await dockGeometry(page);

      const card = page.locator('[data-progress-card-placement="composer"]');
      await gateway.setMethodResponse("progressCard.get", {
        card: {
          markdown:
            "Core npm and Docker publication verified.\n\n- 90 npm plugins + 3 companions verified; core install and Docker digests passed.\n- ClawHub repair CI found a native-Node import regression; owner-boundary fix underway.\n- Repair PR must land before selected-package recovery.\n- 58 ClawHub uploads await owner recovery; selector sync pending.\n- Telegram/Parallels skipped; Vercel mirror advisory failed.",
          revision: 1,
          sessionKey: watchedKey,
          steps: [
            { status: "completed", step: "Verify signed tag and frozen release evidence" },
            { status: "in_progress", step: "Publish core, plugins, and prepared macOS artifacts" },
            { status: "pending", step: "Verify registries, release assets, and stable closeout" },
          ],
          updatedAt: Date.now(),
        },
      });
      await gateway.emitGatewayEvent("progressCard.changed", {
        revision: 1,
        sessionKey: watchedKey,
      });
      await expect.poll(() => card.count()).toBe(1);
      await waitForChatScrollIdle(page);
      report.afterCard = await dockGeometry(page);

      await scrollChatThreadToTop(page);
      const button = page.locator(".chat-scroll-to-bottom[data-visible='true']");
      await button.waitFor();
      await button.click();
      await waitForChatScrollIdle(page);
      report.afterButton = await dockGeometry(page);
      expectDockClear(report);
    } finally {
      if (proofDir) {
        writeFileSync(path.join(proofDir, "geometry.json"), JSON.stringify(report, null, 2));
      }
      await context.close();
    }
  });

  it("keeps a growing run frame above the PR chip through committed end-follow", async () => {
    const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const baseTs = Date.now() - 100_000;
    const historyMessages = Array.from({ length: 30 }, (_, index) => ({
      content: [
        { text: `Stream history ${index}\n${"transcript line\n".repeat(3)}`, type: "text" },
      ],
      role: index % 2 === 0 ? "assistant" : "user",
      timestamp: baseTs + index,
    }));
    const runId = "dock-growing-run";
    const runHistory: unknown[] = [
      ...historyMessages,
      {
        role: "user",
        content: "Inspect the workspace",
        timestamp: baseTs + 50,
        __openclaw: { id: "dock-user", idempotencyKey: `${runId}:user`, seq: 31 },
      },
      {
        role: "assistant",
        phase: "commentary",
        content:
          "I will inspect the workspace.\n\n" + "Initial commentary paragraph.\n\n".repeat(20),
        timestamp: baseTs + 51,
        __openclaw: { id: "dock-commentary", runId, seq: 32 },
      },
      {
        role: "toolResult",
        toolCallId: "dock-seed-tool",
        toolName: "exec",
        content: [{ type: "text", text: "Initial check complete" }],
        timestamp: baseTs + 52,
        __openclaw: { id: "dock-seed-tool", runId, seq: 33 },
      },
    ];
    const gateway = await installMockGateway(page, {
      featureMethods: [
        "chat.metadata",
        "chat.send",
        "chat.startup",
        "config.get",
        SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
      ],
      historyMessages: runHistory,
      inFlightRun: { runId, text: "" },
      sessionInfo: { activeRunIds: [runId], hasActiveRun: true, key: "agent:main:main" },
      methodResponses: {
        [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
      },
    });
    const report: Record<string, DockGeometry> = {};
    const proofDir = captureUiProofEnabled
      ? createControlUiE2eArtifactDir("chat-scroll-dock")
      : null;
    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.getByText("Stream history 29").waitFor({ timeout: 10_000 });
      const watchedKey = await waitForWatchedSessionKey(gateway);
      await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
        sessions: {
          [watchedKey]: {
            pullRequests: [
              {
                number: 144615,
                owner: "openclaw",
                repo: "openclaw",
                branch: "fix/clawhub-publish-metadata-2026-9-4",
                title: "fix: publish ClawHub metadata",
                url: "https://github.com/openclaw/openclaw/pull/144615",
                state: "open",
                additions: 295,
                deletions: 57,
              },
            ],
            rateLimited: false,
            status: "ready",
          },
        },
      });
      await page.locator(".chat-pr").first().waitFor();
      await expect
        .poll(() => chatThreadDistanceFromBottom(page), { timeout: 10_000 })
        .toBeLessThanOrEqual(CHAT_TRANSCRIPT_END_THRESHOLD_PX);
      await waitForChatScrollIdle(page);

      const runRow = page.locator('.chat-virtual-row[data-virtual-row-key^="agent-run:"]').last();
      const rowKey = await runRow.getAttribute("data-virtual-row-key");
      let sequence = 0;
      let text = "";
      for (let step = 1; step <= 4; step += 1) {
        const before = await dockGeometry(page);
        text =
          `Commentary stage ${step}.\n\n` +
          "Additional findings with enough detail to occupy another paragraph.\n\n".repeat(
            step * 4,
          );
        await gateway.emitGatewayEvent("agent", {
          data: { kind: "preamble", itemId: `dock-progress-${step}`, progressText: text },
          runId,
          seq: ++sequence,
          sessionKey: "agent:main:main",
          stream: "item",
          ts: Date.now(),
        });
        await runRow.getByText(`Commentary stage ${step}.`, { exact: true }).waitFor();
        await waitForChatScrollIdle(page);
        const preamble = await dockGeometry(page);
        report[`preamble${step}`] = preamble;
        expect(preamble.rowKey).toBe(rowKey);
        expect(preamble.rowHeight).toBeGreaterThan(before.rowHeight);
        expect(preamble.sizerHeight - before.sizerHeight).toBe(
          preamble.rowHeight - before.rowHeight,
        );
        await gateway.emitGatewayEvent("agent", {
          data: {
            phase: "start",
            name: "exec",
            toolCallId: `dock-tool-${step}`,
            args: { command: `echo check-${step}` },
          },
          runId,
          seq: ++sequence,
          sessionKey: "agent:main:main",
          stream: "tool",
          ts: Date.now(),
        });
        await gateway.emitGatewayEvent("agent", {
          data: {
            phase: "result",
            name: "exec",
            toolCallId: `dock-tool-${step}`,
            result: { content: [{ type: "text", text: "Check complete." }] },
          },
          runId,
          seq: ++sequence,
          sessionKey: "agent:main:main",
          stream: "tool",
          ts: Date.now(),
        });
        runHistory.push(
          {
            role: "assistant",
            content: [{ type: "text", text }],
            openclawStreamFallback: {
              replacementText: text,
              source: "segment",
              itemId: `dock-progress-${step}`,
            },
            timestamp: Date.now(),
            __openclaw: { id: `dock-progress-${step}`, runId, seq: 34 + step * 2 },
          },
          {
            role: "toolResult",
            toolCallId: `dock-tool-${step}`,
            toolName: "exec",
            content: [{ type: "text", text: "Check complete." }],
            timestamp: Date.now(),
            __openclaw: { id: `dock-result-${step}`, runId, seq: 35 + step * 2 },
          },
        );
        await runRow.getByText(`Commentary stage ${step}.`, { exact: true }).waitFor();
        await waitForChatScrollIdle(page);
        const after = await dockGeometry(page);
        report[`commentary${step}`] = after;
        expect(after.rowKey).toBe(rowKey);
        expect(after.rowHeight).toBeGreaterThan(before.rowHeight);
        expect(after.sizerHeight - before.sizerHeight).toBe(after.rowHeight - before.rowHeight);
        expect(after.latestVisible).toBe("false");
      }
      // Completed items are checkpointed before the terminal clears transient activity.
      const activeSession = { key: "agent:main:main", activeRunIds: [runId], hasActiveRun: true };
      await gateway.setMethodResponse("chat.history", {
        messages: runHistory,
        sessionInfo: activeSession,
        inFlightRun: { runId, text: "" },
      });
      const historyRequests = (await gateway.getRequests("chat.history")).length;
      await gateway.emitGatewayEvent("sessions.changed", {
        phase: "message",
        session: activeSession,
      });
      await gateway.waitForRequest("chat.history", { after: historyRequests });
      await waitForChatScrollIdle(page);
      report.checkpoint = await dockGeometry(page);

      const finalMessage = {
        role: "assistant",
        phase: "final_answer",
        content: "Workspace checks complete.",
        timestamp: Date.now(),
        __openclaw: { id: "dock-final", runId, seq: 44 },
      };
      await gateway.setMethodResponse("chat.history", {
        messages: [...runHistory, finalMessage],
        sessionInfo: { key: "agent:main:main", activeRunIds: [], hasActiveRun: false },
        inFlightRun: null,
      });
      await gateway.emitGatewayEvent("session.message", {
        message: finalMessage,
        messageId: "dock-final",
        messageSeq: 44,
        session: {
          key: "agent:main:main",
          activeRunIds: [],
          hasActiveRun: false,
          status: "done",
          kind: "direct",
          updatedAt: Date.now(),
        },
        runId,
        clientRunId: runId,
        activeRunIds: [],
        hasActiveRun: false,
        sessionKey: "agent:main:main",
      });
      await page.getByText("Workspace checks complete.", { exact: true }).waitFor();
      await waitForChatScrollIdle(page);
      report.final = await dockGeometry(page);
      expectDockClear(report);
    } finally {
      if (proofDir) {
        writeFileSync(path.join(proofDir, "geometry.json"), JSON.stringify(report, null, 2));
      }
      await context.close();
    }
  });
});
