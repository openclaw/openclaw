import type { Page } from "playwright";
import { expect, it } from "vitest";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../src/gateway/control-ui-contract.js";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../lib/session-pull-requests.ts";
import { CHAT_TRANSCRIPT_END_THRESHOLD_PX } from "../pages/chat/scroll.ts";
import {
  closeChatDetails,
  openChatDetails,
  openChatTaskProgress,
  openDetailsPullRequests,
} from "./chat-details.test-support.ts";
import {
  chatThreadDistanceFromBottom,
  createChatFlowE2eSuite,
  installMockGateway,
  newChatPage,
  scrollChatThreadToTop,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";
import { waitForWatchedSessionKey } from "./chat-github-publication.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();
const dockMethods = [
  "chat.metadata",
  "chat.startup",
  "config.get",
  SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
];
type DockGeometry = Awaited<ReturnType<typeof dockGeometry>>;

async function dockGeometry(page: Page) {
  return page.locator(".chat-pane-cache__pane--active").evaluate((pane) => {
    const thread = pane.querySelector<HTMLElement>(".chat-thread");
    const rows = pane.querySelectorAll<HTMLElement>(".chat-virtual-row");
    const row = rows.item(rows.length - 1);
    const dock = pane.querySelector<HTMLElement>(".chat-footer");
    if (!thread || !row || !dock) {
      throw new Error("Expected a transcript row and composer dock");
    }
    return {
      distance: Math.round(thread.scrollHeight - thread.scrollTop - thread.clientHeight),
      overhang: Math.round(row.getBoundingClientRect().bottom - dock.getBoundingClientRect().top),
      rowKey: row.getAttribute("data-virtual-row-key"),
      rowHeight: row.offsetHeight,
      scrollHeight: thread.scrollHeight,
      latestVisible:
        pane.querySelector(".chat-scroll-to-bottom")?.getAttribute("data-visible") ?? null,
    };
  });
}

function expectDockClear(report: Record<string, DockGeometry>): void {
  for (const [stage, { distance, overhang }] of Object.entries(report)) {
    expect(distance, `${stage} distance from bottom`).toBeLessThanOrEqual(
      CHAT_TRANSCRIPT_END_THRESHOLD_PX,
    );
    expect(overhang, `${stage} last row overhang into the dock`).toBeLessThanOrEqual(0);
  }
}

type Gateway = Awaited<ReturnType<typeof installMockGateway>>;

function history(
  prefix: string,
  length: number,
  timestamp: number,
  detail = "transcript line\n",
  assistantFirst = true,
) {
  return Array.from({ length }, (_, index) => ({
    content: [{ text: prefix + " " + index + "\n" + detail.repeat(3), type: "text" }],
    role: (index % 2 === 0) === assistantFirst ? "assistant" : "user",
    timestamp: timestamp + index,
  }));
}

function progressCard(sessionKey: string, markdown: string) {
  return {
    card: {
      sessionKey,
      revision: 1,
      updatedAt: Date.now(),
      markdown,
      steps: [
        { step: "Inspect the workspace", status: "completed" },
        { step: "Verify the findings", status: "in_progress" },
        { step: "Summarize the result", status: "pending" },
      ],
    },
  };
}

async function publishPr(gateway: Gateway, key: string, withChecks = false) {
  await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
    sessions: {
      [key]: {
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
            ...(withChecks
              ? {
                  checks: { state: "failing", passed: 60, failed: 1, skipped: 0, running: 0 },
                  checksUrl: "https://github.com/openclaw/openclaw/pull/144615/checks",
                }
              : {}),
          },
        ],
        rateLimited: false,
        status: "ready",
      },
    },
  });
}

suite.define(() => {
  it.each([
    { reducedMotion: "reduce", paragraphs: 1 },
    { reducedMotion: "no-preference", paragraphs: 1 },
    { reducedMotion: "reduce", paragraphs: 48 },
    { reducedMotion: "no-preference", paragraphs: 48 },
  ] as const)(
    "keeps a Details progress reader stable through streaming newlines ($reducedMotion, $paragraphs paragraphs)",
    async ({ reducedMotion, paragraphs }) => {
      const page = await newChatPage(suite, {
        ...createControlUiE2eContextOptions(),
        reducedMotion,
      });
      const sessionKey = "agent:main:main";
      const runId = "progress-stream-run";
      const initialText = "Current findings.\n\n".repeat(paragraphs).trimEnd();
      const gateway = await installMockGateway(page, {
        sessionKey,
        featureMethods: ["chat.metadata", "chat.startup", "progressCard.get"],
        historyMessages: history("Reading context", 30, 1, "Earlier findings.\n", false),
        inFlightRun: { runId, text: initialText },
        sessionInfo: { key: sessionKey, activeRunIds: [runId], hasActiveRun: true },
        methodResponses: {
          "progressCard.get": progressCard(
            sessionKey,
            "Reviewing the synthetic workspace.\n\n" +
              "- A detailed finding to verify before finishing the task.\n".repeat(8),
          ),
        },
      });
      const card = page.locator('[data-progress-card-placement="details"]');
      const thread = page.locator(".chat-pane-cache__pane--active .chat-thread");
      let text = initialText;
      const streamLine = async (line: number) => {
        text += "\n\nStreaming finding " + line + ".";
        await gateway.emitGatewayEvent("chat", {
          sessionKey,
          runId,
          state: "delta",
          message: { role: "assistant", content: [{ type: "text", text }] },
        });
      };
      await page.goto(suite.server.baseUrl + "chat");
      await openChatDetails(page);
      await card.locator(".task-progress-details__body").waitFor();
      await waitForChatScrollIdle(page);
      expect(await card.getAttribute("open")).toBe("");
      expect(
        await card.evaluate((element) => element.getBoundingClientRect().height),
      ).toBeGreaterThan(200);
      const threadBounds = await thread.boundingBox();
      if (!threadBounds) {
        throw new Error("Expected a visible transcript");
      }
      await page.mouse.move(threadBounds.x + 8, threadBounds.y + threadBounds.height / 2);
      await page.mouse.wheel(0, -32);
      await expect.poll(() => chatThreadDistanceFromBottom(page)).toBeGreaterThan(0);
      await openChatDetails(page);
      await card.locator("summary").click();
      await expect.poll(() => card.getAttribute("open")).toBeNull();
      for (let line = 1; line <= 12; line++) {
        await streamLine(line);
        await page.waitForTimeout(40);
        expect(await card.getAttribute("open")).toBeNull();
      }
      await expect.poll(() => thread.textContent()).toContain("Streaming finding 12.");
      await waitForChatScrollIdle(page);
      const settledTop = await thread.evaluate((element) => element.scrollTop);
      for (let line = 13; line <= 16; line++) {
        await streamLine(line);
        await expect.poll(() => thread.textContent()).toContain(`Streaming finding ${line}.`);
        await waitForChatScrollIdle(page);
        expect(await card.getAttribute("open")).toBeNull();
        expect(await thread.evaluate((element) => element.scrollTop)).toBe(settledTop);
      }
      await page.locator('.chat-scroll-to-bottom[data-visible="true"]').click();
      await waitForChatScrollIdle(page);
      expect(await card.getAttribute("open")).toBeNull();
      await openChatDetails(page);
      await card.locator("summary").click();
      await waitForChatScrollIdle(page);
      expect(await card.getAttribute("open")).toBe("");
      for (let line = 17; line <= 20; line++) {
        await streamLine(line);
        await expect.poll(() => thread.textContent()).toContain(`Streaming finding ${line}.`);
        await waitForChatScrollIdle(page);
        expect(await card.getAttribute("open")).toBe("");
        expect(await chatThreadDistanceFromBottom(page)).toBeLessThanOrEqual(
          CHAT_TRANSCRIPT_END_THRESHOLD_PX,
        );
      }
    },
  );

  it.each([
    { width: 1280, height: 900 },
    { width: 1540, height: 1348 },
    { width: 375, height: 812 },
  ])("keeps replies above the dock ($width x $height)", async ({ width, height }) => {
    const page = await newChatPage(suite, {
      ...createControlUiE2eContextOptions(),
      viewport: { width, height },
    });
    const baseTs = Date.now() - 100_000;
    const historyMessages = history("Dock history", 41, baseTs);
    const gateway = await installMockGateway(page, {
      featureMethods: [...dockMethods, "progressCard.get"],
      historyMessages,
      methodResponses: {
        [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
        "progressCard.get": { card: null },
      },
    });
    const report: Record<string, DockGeometry> = {};
    await page.goto(`${suite.server.baseUrl}chat`);
    await page.getByText("Dock history 40").waitFor({ timeout: 10_000 });
    await expect
      .poll(() => chatThreadDistanceFromBottom(page), { timeout: 10_000 })
      .toBeLessThanOrEqual(CHAT_TRANSCRIPT_END_THRESHOLD_PX);
    await waitForChatScrollIdle(page);
    report.initial = await dockGeometry(page);

    const watchedKey = await waitForWatchedSessionKey(gateway);
    await publishPr(gateway, watchedKey, true);
    const pullRequests = await openDetailsPullRequests(page);
    await pullRequests.getByText("fix: publish ClawHub metadata", { exact: true }).waitFor();
    await waitForChatScrollIdle(page);
    report.afterPr = await dockGeometry(page);
    if (width <= 900) {
      await closeChatDetails(page);
    }

    // A late media/markdown layout can grow the mounted reply in the same
    // task as the final wheel event, before ResizeObserver publishes its size.
    await page.locator(".chat-thread").evaluate((thread) => {
      thread.dispatchEvent(new WheelEvent("wheel", { deltaY: 120 }));
      const reply = thread.querySelector(".chat-virtual-row:last-child .chat-text")!;
      for (let index = 0; index < 6; index++) {
        const paragraph = document.createElement("p");
        paragraph.textContent = `Verification result ${index + 1}: the complete final reply remains readable above the pull request and composer.`;
        reply.append(paragraph);
      }
    });
    await waitForChatScrollIdle(page);
    report.afterLateLayout = await dockGeometry(page);
    expectDockClear({ afterLateLayout: report.afterLateLayout });

    const card = page.locator('[data-progress-card-placement="details"]');
    await gateway.setMethodResponse(
      "progressCard.get",
      progressCard(
        watchedKey,
        "Core npm and Docker publication verified.\n\n- 90 npm plugins + 3 companions verified; core install and Docker digests passed.\n- ClawHub repair CI found a native-Node import regression; owner-boundary fix underway.\n- Repair PR must land before selected-package recovery.\n- 58 ClawHub uploads await owner recovery; selector sync pending.\n- Telegram/Parallels skipped; Vercel mirror advisory failed.",
      ),
    );
    await gateway.emitGatewayEvent("progressCard.changed", {
      revision: 1,
      sessionKey: watchedKey,
    });
    if (width <= 900) {
      const progress = await openChatTaskProgress(page);
      await progress.getByText("Verify the findings", { exact: true }).waitFor();
      await waitForChatScrollIdle(page);
      report.afterCard = await dockGeometry(page);
      await closeChatDetails(page);
      await scrollChatThreadToTop(page);
      await openChatTaskProgress(page);
      await progress.getByText("Verify the findings", { exact: true }).waitFor();
      expect(await page.locator(".chat-thread").evaluate((thread) => thread.scrollTop)).toBe(0);
      await closeChatDetails(page);
      const button = page.getByRole("button", { name: "Scroll to latest", exact: true });
      await button.click();
      await waitForChatScrollIdle(page);
      report.afterButton = await dockGeometry(page);
      expect(await page.locator(".chat-mobile-host").isVisible()).toBe(false);
      await openChatTaskProgress(page);
      await progress.getByText("Verify the findings", { exact: true }).waitFor();
      await waitForChatScrollIdle(page);
      report.afterManualOpen = await dockGeometry(page);
      expectDockClear(report);

      // The mobile sheet owns dismissal; Latest must not reopen it.
      await closeChatDetails(page);
      // The hidden sheet's grid row still animates the transcript viewport.
      await waitForChatScrollIdle(page);
      const thread = page.locator(".chat-thread");
      await thread.press("Home");
      await waitForChatScrollIdle(page);
      await button.press("Enter");
      await openChatTaskProgress(page);
      await page
        .locator(".chat-mobile-host__header")
        .getByRole("button", { name: "Close", exact: true })
        .press("Escape");
      await page.locator(".chat-mobile-host").waitFor({ state: "hidden" });
      await waitForChatScrollIdle(page);
      await thread.press("Home");
      await button.press("Enter");
      await waitForChatScrollIdle(page);
      expect(await page.locator(".chat-mobile-host").isVisible()).toBe(false);
      return;
    }
    await expect.poll(() => card.count()).toBe(1);
    await openChatDetails(page);
    await waitForChatScrollIdle(page);
    report.afterCard = await dockGeometry(page);
    if ((await card.getAttribute("open")) === null) {
      await openChatDetails(page);
      await card.locator("summary").click();
      await waitForChatScrollIdle(page);
    }
    await expect.poll(() => card.getAttribute("open")).toBe("");

    await closeChatDetails(page);
    await scrollChatThreadToTop(page);
    expect(await card.getAttribute("open")).toBe("");
    await openChatDetails(page);
    await card.locator("summary").click();
    await expect.poll(() => card.getAttribute("open")).toBeNull();
    await waitForChatScrollIdle(page);
    expect(await page.locator(".chat-thread").evaluate((thread) => thread.scrollTop)).toBe(0);
    const button = page.locator(".chat-scroll-to-bottom[data-visible='true']");
    await button.waitFor();
    await button.click();
    await waitForChatScrollIdle(page);
    report.afterButton = await dockGeometry(page);
    expect(await card.getAttribute("open")).toBeNull();
    await openChatDetails(page);
    await card.locator("summary").click();
    await expect.poll(() => card.getAttribute("open")).toBe("");
    await waitForChatScrollIdle(page);
    report.afterManualOpen = await dockGeometry(page);
    expectDockClear(report);

    // Interrupt an active Latest return with an explicit keyboard close.
    const thread = page.locator(".chat-thread");
    await thread.press("Home");
    await waitForChatScrollIdle(page);
    await button.press("Enter");
    await openChatDetails(page);
    await card.locator("summary").press("Enter");
    await thread.press("Home");
    await button.press("Enter");
    await waitForChatScrollIdle(page);
    expect(await card.getAttribute("open")).toBeNull();
    await thread.press("Home");
    await openChatDetails(page);
    await card.locator("summary").click();
    await button.press("Enter");
    await waitForChatScrollIdle(page);
    await thread.press("Home");
    expect(await card.getAttribute("open")).toBe("");
  });

  it("keeps a growing run frame above the footer with PRs in Details through committed end-follow", async () => {
    const page = await newChatPage(suite);
    const baseTs = Date.now() - 100_000;
    const historyMessages = history("Stream history", 30, baseTs);
    const runId = "dock-growing-run";
    const runMessage = (id: string, seq: number, fields: Record<string, unknown>) => ({
      timestamp: Date.now(),
      __openclaw: { id, runId, seq },
      ...fields,
    });
    const runHistory: unknown[] = [
      ...historyMessages,
      {
        role: "user",
        content: "Inspect the workspace",
        timestamp: baseTs + 50,
        __openclaw: { id: "dock-user", idempotencyKey: `${runId}:user`, seq: 31 },
      },
      runMessage("dock-commentary", 32, {
        role: "assistant",
        phase: "commentary",
        content:
          "I will inspect the workspace.\n\n" + "Initial commentary paragraph.\n\n".repeat(20),
        timestamp: baseTs + 51,
      }),
      runMessage("dock-seed-tool", 33, {
        role: "toolResult",
        toolCallId: "dock-seed-tool",
        toolName: "exec",
        content: [{ type: "text", text: "Initial check complete" }],
        timestamp: baseTs + 52,
      }),
    ];
    const gateway = await installMockGateway(page, {
      featureMethods: [...dockMethods, "chat.send"],
      historyMessages: runHistory,
      inFlightRun: { runId, text: "" },
      sessionInfo: { activeRunIds: [runId], hasActiveRun: true, key: "agent:main:main" },
      methodResponses: {
        [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
      },
    });
    const report: Record<string, DockGeometry> = {};
    await page.goto(`${suite.server.baseUrl}chat`);
    await page.getByText("Stream history 29").waitFor({ timeout: 10_000 });
    const watchedKey = await waitForWatchedSessionKey(gateway);
    await publishPr(gateway, watchedKey);
    await openDetailsPullRequests(page);
    await page.locator(".chat-pr").first().waitFor();
    await expect
      .poll(() => chatThreadDistanceFromBottom(page), { timeout: 10_000 })
      .toBeLessThanOrEqual(CHAT_TRANSCRIPT_END_THRESHOLD_PX);
    await waitForChatScrollIdle(page);

    const runRow = page.locator('.chat-virtual-row[data-virtual-row-key^="agent-run:"]').last();
    const rowKey = await runRow.getAttribute("data-virtual-row-key");
    const expectGrowth = async (stage: string, before: DockGeometry, text: string) => {
      await expect.poll(() => runRow.locator(".chat-text").last().textContent()).toContain(text);
      await waitForChatScrollIdle(page);
      const after = (report[stage] = await dockGeometry(page));
      expect(after.rowKey).toBe(rowKey);
      expect(after.rowHeight).toBeGreaterThan(before.rowHeight);
      expect(after.scrollHeight - before.scrollHeight).toBe(after.rowHeight - before.rowHeight);
      return after;
    };
    let sequence = 0;
    const emitAgent = (stream: string, data: Record<string, unknown>) =>
      gateway.emitGatewayEvent("agent", {
        data,
        runId,
        seq: ++sequence,
        sessionKey: "agent:main:main",
        stream,
        ts: Date.now(),
      });
    for (let step = 1; step <= 4; step += 1) {
      const before = await dockGeometry(page);
      const text =
        `Commentary stage ${step}.\n\n` +
        "Additional findings with enough detail to occupy another paragraph.\n\n".repeat(step * 4);
      await emitAgent("item", {
        kind: "preamble",
        itemId: `dock-progress-${step}`,
        progressText: text,
      });
      await expectGrowth(`preamble${step}`, before, `Commentary stage ${step}.`);
      await emitAgent("tool", {
        phase: "start",
        name: "exec",
        toolCallId: `dock-tool-${step}`,
        args: { command: `echo check-${step}` },
      });
      await emitAgent("tool", {
        phase: "result",
        name: "exec",
        toolCallId: `dock-tool-${step}`,
        result: { content: [{ type: "text", text: "Check complete." }] },
      });
      runHistory.push(
        runMessage(`dock-progress-${step}`, 34 + step * 2, {
          role: "assistant",
          content: [{ type: "text", text }],
          openclawStreamFallback: {
            replacementText: text,
            source: "segment",
            itemId: `dock-progress-${step}`,
          },
        }),
        runMessage(`dock-result-${step}`, 35 + step * 2, {
          role: "toolResult",
          toolCallId: `dock-tool-${step}`,
          toolName: "exec",
          content: [{ type: "text", text: "Check complete." }],
        }),
      );
      const after = await expectGrowth(`commentary${step}`, before, `Commentary stage ${step}.`);
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

    const finalMessage = runMessage("dock-final", 44, {
      role: "assistant",
      phase: "final_answer",
      content: "Workspace checks complete.",
    });
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
  });
});
