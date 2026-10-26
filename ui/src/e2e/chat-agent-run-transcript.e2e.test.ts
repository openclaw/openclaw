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
