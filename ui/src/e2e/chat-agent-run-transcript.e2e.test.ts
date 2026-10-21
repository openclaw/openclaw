import type { BrowserContextOptions, Locator } from "playwright";
import { expect, it } from "vitest";
import { projectChatDisplayMessages } from "../../../src/gateway/chat-display-projection.js";
import { createNestedToolActivity } from "../../../src/sessions/nested-tool-activity.js";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI agent run transcript",
  startServerBeforeBrowser: true,
  trackBrowserContexts: true,
});

function transcriptMessage(
  role: "assistant" | "toolResult" | "user",
  content: unknown,
  runId: string,
  id: string,
  seq: number,
) {
  return {
    role,
    content,
    timestamp: Date.UTC(2026, 7, 19, 12, 0, seq),
    __openclaw: role === "user" ? { id, idempotencyKey: runId, seq } : { id, runId, seq },
  };
}

async function expectCount(target: Locator, count: number) {
  expect(await target.count()).toBe(count);
}

function toolResult(
  runId: string,
  id: string,
  seq: number,
  toolCallId: string,
  toolName: string,
  text: string,
) {
  return {
    ...transcriptMessage("toolResult", [{ type: "text", text }], runId, id, seq),
    toolCallId,
    toolName,
  };
}

function activeRun(runId: string, text = "") {
  return {
    inFlightRun: { runId, text },
    sessionInfo: { activeRunIds: [runId], hasActiveRun: true, key: "agent:main:main" },
  };
}

async function openTranscript(
  scenario: Parameters<typeof installMockGateway>[1],
  options: BrowserContextOptions = {},
) {
  const context = await suite.newBrowserContext({
    viewport: { height: 900, width: 1200 },
    ...options,
  });
  const page = await context.newPage();
  const gateway = await installMockGateway(page, scenario);
  await page.goto(`${suite.server.baseUrl}chat`);
  return { page, gateway };
}

suite.define(() => {
  it("collapses nested tool activity after commentary across history reload", async () => {
    const runId = "nested-run";
    const commentary = "I’ll inspect the workspace first.";
    const calls = ["read", "exec", "sessions_history"].flatMap((name, index) => {
      const seq = 3 + index * 2;
      const parentId = `parent-${index}`;
      const childId = `child-${index}`;
      const idempotencyKey = `attempt:${childId}`;
      const parentContent = [
        { type: "toolCall", id: parentId, name: "exec", arguments: {} },
        { type: "toolResult", toolCallId: parentId, name: "exec", content: "Done" },
      ];
      return [
        transcriptMessage("assistant", parentContent, runId, parentId, seq),
        {
          ...createNestedToolActivity({
            runId,
            scopeId: "attempt",
            afterEntryId: parentId,
            startOrder: index,
            parentToolCallId: parentId,
            toolCallId: childId,
            toolName: name,
            input: {},
            result: { content: [{ type: "text", text: "Done" }] },
            isError: false,
            startedAt: Date.UTC(2026, 7, 19, 12, 0, seq + 1),
            timestamp: Date.UTC(2026, 7, 19, 12, 0, seq + 1),
          }),
          idempotencyKey,
          __openclaw: { id: childId, seq: seq + 1, idempotencyKey },
        },
      ];
    });
    const { page } = await openTranscript(
      {
        historyMessages: [
          transcriptMessage("user", "Inspect the workspace.", `${runId}:user`, "user", 1),
          transcriptMessage("assistant", commentary, runId, "commentary", 2),
          ...projectChatDisplayMessages(calls),
        ],
      },
      { colorScheme: "light" },
    );
    await page.getByText(commentary, { exact: true }).waitFor();
    const activity = page.locator(".chat-activity-group:not(.chat-work-group)");
    await expect.poll(() => activity.count()).toBe(1);
    const summary = activity.locator(".chat-activity-group__summary");
    expect(await summary.getAttribute("aria-expanded")).toBe("false");
    expect(await activity.locator(".chat-activity-group__body").isVisible()).toBe(false);
    await summary.click();
    expect(await summary.getAttribute("aria-expanded")).toBe("true");
    expect(await activity.locator(".chat-activity-group__body").isVisible()).toBe(true);
    await page.reload();
    await expect.poll(() => activity.count()).toBe(1);
    expect(await summary.getAttribute("aria-expanded")).toBe("false");
    await expectCount(page.getByText(commentary, { exact: true }), 1);
  });

  it("keeps restart-recovered live tool batches in one transcript row", async () => {
    const runId = "run-restart-recovery";
    const result = (id: string, seq: number, name: string) =>
      toolResult(runId, id, seq, id, name, `${name} completed`);
    const { page } = await openTranscript({
      historyMessages: [
        {
          ...transcriptMessage(
            "user",
            "[System] Continue the interrupted turn.",
            `${runId}:user`,
            "restart-recovery",
            1,
          ),
          provenance: {
            kind: "internal_system",
            sourceSessionKey: "main",
            sourceTool: "main_session_restart_recovery",
          },
        },
        result("process-1", 2, "process"),
        result("process-2", 3, "process"),
        transcriptMessage("assistant", "Checking the next batch.", runId, "gap-1", 4),
        result("exec-1", 5, "exec"),
        result("exec-2", 6, "exec"),
        transcriptMessage("assistant", "Checking the final batch.", runId, "gap-2", 7),
        result("process-3", 8, "process"),
        result("process-4", 9, "process"),
      ],
      ...activeRun(runId),
    });
    const summaries = page.locator(".chat-activity-group__summary");
    await expect.poll(() => summaries.count()).toBe(3);
    const rowKeys = await summaries.evaluateAll((elements) =>
      elements.map(
        (element) => element.closest<HTMLElement>(".chat-virtual-row")?.dataset.virtualRowKey,
      ),
    );

    expect(rowKeys[0]).toMatch(/^agent-run:/u);
    expect(rowKeys).toEqual([rowKeys[0], rowKeys[0], rowKeys[0]]);
  });

  it.each([
    { viewport: "desktop-dark", width: 1200, height: 900, theme: "dark" },
    { viewport: "mobile-dark", width: 390, height: 844, theme: "dark" },
    { viewport: "mobile-light", width: 390, height: 844, theme: "light" },
  ] as const)(
    "renders each run as one linear response on $viewport",
    async ({ viewport, width, height, theme }) => {
      const isMobile = viewport.startsWith("mobile");
      const firstRunId = "run-composed-first";
      const secondRunId = "run-composed-second";
      const toolOnlyRunId = "run-tool-only";
      const commentaryToolRunId = "run-commentary-tool-only";
      const firstNarrationText = "I’ll create the launch card and check the existing style first.";
      const caption = "Caption ready for the second run.";
      const entryCounts = { assistant: 0, user: 0, call: 0, result: 0 };
      const message = (role: "assistant" | "user", text: string, seq: number, run = firstRunId) =>
        transcriptMessage(
          role,
          text,
          role === "user" ? `${run}:user` : run,
          `${role}-${++entryCounts[role]}`,
          seq,
        );
      const call = (id: string, name: string, args: Record<string, string>, seq: number) =>
        transcriptMessage(
          "assistant",
          [{ type: "toolCall", id, name, arguments: args }],
          firstRunId,
          `tool-call-${++entryCounts.call}`,
          seq,
        );
      const result = (text: string, seq: number, id: string, name = "read", run = firstRunId) =>
        toolResult(run, `tool-result-${++entryCounts.result}`, seq, id, name, text);
      const { page } = await openTranscript(
        {
          historyMessages: [
            message("user", "Create the launch card.", 1),
            message("assistant", firstNarrationText, 2),
            call("call-read", "read", { path: "ui/src/styles/chat.css" }, 3),
            result("Existing card styles loaded.", 4, "call-read"),
            message(
              "assistant",
              "The first draft matches the transcript rhythm. I’ll render the asset now.",
              5,
            ),
            call("call-render", "exec", { command: "render launch-card.svg" }, 6),
            result("Rendered launch-card.svg", 7, "call-render", "exec"),
            message("assistant", "The launch card is ready: MEDIA:./launch-card.svg", 8),
            message("user", "Now write the caption.", 9, secondRunId),
            message("assistant", caption, 10, secondRunId),
            message("user", "Check without replying.", 11, toolOnlyRunId),
            result("Tool-only result", 12, "call-tool-only", "read", toolOnlyRunId),
            message("user", "Inspect and stop after the tool.", 13, commentaryToolRunId),
            message("assistant", "I’ll inspect the current state first.", 14, commentaryToolRunId),
            result(
              "Commentary-led tool-only result",
              15,
              "call-commentary-tool-only",
              "read",
              commentaryToolRunId,
            ),
          ],
        },
        { colorScheme: theme, hasTouch: isMobile, isMobile, viewport: { height, width } },
      );
      const transcript = page.locator(".chat-thread-inner");
      await transcript.getByText(caption, { exact: true }).waitFor();

      const assistantGroups = page.locator(".chat-group.assistant");
      await expectCount(assistantGroups, 4);
      const firstRun = assistantGroups.filter({ hasText: firstNarrationText });
      await expectCount(firstRun, 1);
      await expectCount(firstRun.locator(".chat-sender-name"), 1);
      await expectCount(firstRun.locator(".chat-group-footer-actions"), 1);
      await expectCount(firstRun.locator(".chat-message-actions-row"), 0);
      await expectCount(firstRun.locator(".chat-group-footer-actions button"), 2);
      expect(
        await firstRun
          .locator(".chat-group-footer-actions button")
          .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label"))),
      ).toEqual(["Reply to message", "Copy as markdown"]);

      const orderedContent = await firstRun
        .locator(".chat-bubble")
        .evaluateAll((bubbles) =>
          bubbles.map((bubble) => bubble.textContent?.replace(/\s+/gu, " ").trim()),
        );
      expect(orderedContent).toEqual(
        [
          "I’ll create the launch card",
          "Read",
          "The first draft matches",
          "render launch-card.svg",
          "The launch card is ready",
        ].map((text) => expect.stringContaining(text)),
      );
      await expectCount(firstRun.getByText(caption, { exact: true }), 0);
      const toolOnlyRun = page.locator(
        `.chat-group.assistant[data-chat-row-key*="${toolOnlyRunId}"]`,
      );
      await expectCount(toolOnlyRun, 1);
      await expectCount(toolOnlyRun.locator(".chat-group-footer-actions"), 0);
      const commentaryToolRun = page.locator(
        `.chat-group.assistant[data-chat-row-key*="${commentaryToolRunId}"]`,
      );
      await expectCount(commentaryToolRun, 1);
      await expectCount(
        commentaryToolRun.getByText("I’ll inspect the current state first.", { exact: true }),
        1,
      );
      await expectCount(commentaryToolRun.locator(".chat-group-footer-actions"), 0);
    },
  );

  it("keeps the run row identity when a hidden heartbeat boundary reaches history", async () => {
    const runId = "run-heartbeat-browser-handoff";
    const { page, gateway } = await openTranscript({
      historyMessages: [],
      ...activeRun(runId),
    });
    const liveRow = page.locator(".chat-virtual-row", {
      has: page.locator(".chat-reading-indicator"),
    });
    await liveRow.waitFor();
    const liveKey = await liveRow.getAttribute("data-virtual-row-key");
    expect(liveKey).not.toBeNull();

    const finalText = "Heartbeat handoff complete.";
    const persistedMessage = {
      role: "assistant",
      api: "cli",
      content: finalText,
      idempotencyKey: `cli-assistant:${runId}`,
      timestamp: Date.UTC(2026, 7, 19, 12, 1),
      __openclaw: {
        id: "assistant-after-hidden-heartbeat",
        seq: 1,
        turnBoundary: true,
      },
    };
    await gateway.setHistoryMessages([persistedMessage]);
    const historyRequestsBeforeFinal = (await gateway.getRequests("chat.history")).length;
    await gateway.emitGatewayEvent("session.message", {
      activeRunIds: [],
      clientRunId: runId,
      hasActiveRun: false,
      message: persistedMessage,
      messageId: "assistant-after-hidden-heartbeat",
      messageSeq: 1,
      session: {
        activeRunIds: [],
        hasActiveRun: false,
        key: "agent:main:main",
        kind: "direct",
        status: "done",
        updatedAt: Date.now(),
      },
      sessionKey: "agent:main:main",
    });
    await expect
      .poll(async () => (await gateway.getRequests("chat.history")).length)
      .toBeGreaterThan(historyRequestsBeforeFinal);

    const settledRow = page.locator(".chat-virtual-row", {
      has: page.getByText(finalText, { exact: true }),
    });
    await settledRow.waitFor();
    await expect.poll(() => settledRow.getAttribute("data-virtual-row-key")).toBe(liveKey);
    await expectCount(settledRow, 1);
  });

  it("keeps same-run events from another session out of the selected transcript", async () => {
    const runId = "run-shared-across-session-events";
    const selectedText = "Selected session stream stays in its own row.";
    const wrongSessionText = "Wrong session content must never enter this transcript. ".repeat(12);
    const { page, gateway } = await openTranscript({
      historyMessages: [
        transcriptMessage("user", "Earlier prompt", "run-earlier:user", "user-earlier", 1),
        transcriptMessage("assistant", "Earlier answer", "run-earlier", "assistant-earlier", 2),
      ],
      ...activeRun(runId, selectedText),
    });
    await page.getByText(selectedText, { exact: true }).waitFor();
    const inactiveSessionKey = "agent:main:inactive-session";
    const event = {
      message: { role: "assistant", content: [{ type: "text", text: wrongSessionText }] },
      runId,
      sessionKey: inactiveSessionKey,
    };
    await gateway.emitGatewayEvent("chat", {
      ...event,
      deltaText: wrongSessionText,
      state: "delta",
    });
    await gateway.emitGatewayEvent("chat", { ...event, state: "final" });

    await expect.poll(() => page.getByText(wrongSessionText, { exact: true }).count()).toBe(0);
    await expect.poll(() => page.getByText(selectedText, { exact: true }).count()).toBe(1);
    const hasOverlap = await page.locator(".chat-virtual-row").evaluateAll((rows) => {
      const bounds = rows
        .map((row) => row.getBoundingClientRect())
        .filter((rect) => rect.bottom > rect.top)
        .toSorted((left, right) => left.top - right.top);
      return bounds.slice(1).some((current, index) => {
        const previous = bounds[index];
        return previous !== undefined && current.top < previous.bottom - 0.5;
      });
    });
    expect(hasOverlap).toBe(false);
  });
});
