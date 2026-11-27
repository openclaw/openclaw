import { expect, it } from "vitest";
import { prepareChatHistoryFixture } from "../test-helpers/chat-activity-fixtures.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Compaction activity" });
const viewport = { width: 1280, height: 900 };
const sessionKey = "agent:main:dashboard:compaction";
const final = "The release notes are ready.";
const session = {
  key: sessionKey,
  sessionId: "compaction",
  label: "Release verification",
  kind: "direct",
  status: "done",
  hasActiveRun: false,
  contextTokens: 32000,
  totalTokens: 6000,
} as const;
const sessionUrl = () => controlUiSessionUrl(suite.server.baseUrl, sessionKey);

suite.define(() => {
  it.each([
    {
      openAI: false,
      timed: false,
      label: "Read and changed files, ran commands, compacted context",
    },
    { openAI: true, timed: false, label: "Worked" },
    { openAI: true, timed: true, label: "Worked for 13s" },
  ])(
    "keeps distinct, ordered compactions under $label before and after reload",
    ({ openAI, timed, label }) =>
      suite.withPage({ viewport, colorScheme: "light" }, async ({ page }) => {
        const now = Date.now();
        const runId = "verification-run";
        const provider = openAI ? { provider: "openai", model: "gpt-4.1-mini" } : {};
        const calls = [
          { id: "read", name: "read", arguments: { path: "notes.md" } },
          {
            id: "edit",
            name: "edit",
            arguments: { path: "notes.md", oldText: "Pending", newText: "Verified" },
          },
          { id: "check", name: "exec", arguments: { command: "pnpm test release-notes" } },
        ];
        const messages: (Record<string, unknown> & { __openclaw?: Record<string, unknown> })[] = [
          { role: "user", content: "Check the release notes." },
          {
            role: "assistant",
            ...provider,
            stopReason: "toolUse",
            content: calls.map((call) => ({ type: "toolCall", ...call })),
          },
          ...calls.map((call) => ({
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            isError: false,
            content: [{ type: "text", text: "Verified." }],
            details: call.name === "exec" ? { status: "completed", exitCode: 0 } : undefined,
          })),
          ...["first", "second"].map((itemId) => ({
            role: "system",
            __openclaw: { kind: "compaction", itemId, tokensBefore: 80000, tokensAfter: 20000 },
          })),
          { role: "assistant", ...provider, content: final, stopReason: "stop" },
        ];
        messages.forEach((message, index) =>
          Object.assign(message, {
            timestamp: now - 10000 + index * 1000,
            __openclaw: {
              ...message["__openclaw"],
              id: String(index),
              seq: index + 1,
              runId,
              ...(timed && index === messages.length - 1 ? { recordTimestampMs: now + 3000 } : {}),
            },
          }),
        );
        await installMockGateway(page, {
          sessionKey,
          sessions: [{ ...session, updatedAt: now }],
          methodResponses: { "chat.history": prepareChatHistoryFixture(messages) },
        });
        await page.goto(sessionUrl());
        const thread = page.locator(".chat-thread");
        const reply = thread.getByText(final, { exact: true });
        const summary = thread.locator(
          openAI ? ".chat-work-group > button" : ".chat-activity-group__summary",
        );
        const summaryLabel = summary.locator(".chat-activity-group__label");
        const rows = thread.locator(".chat-compaction-activity");
        const expand = async () => {
          await reply.waitFor();
          await summary.waitFor();
          expect(await summary.getAttribute("aria-expanded")).toBe("false");
          expect(await rows.count()).toBe(0);
          const collapsedLabel = await summaryLabel.textContent();
          await summary.press("Enter");
          await rows.first().waitFor();
          const activity = await rows.evaluateAll((list) =>
            list.map((row) => ({
              key: row.getAttribute("data-chat-row-key"),
              timestamp: Number(row.getAttribute("data-ts")),
            })),
          );
          const keys = activity.map(({ key }) => key);
          expect([keys.length, new Set(keys).size]).toEqual([2, 2]);
          expect(activity.map(({ timestamp }) => timestamp)).toEqual([now - 5000, now - 4000]);
          expect(await rows.getByText("Compacted context", { exact: true }).count()).toBe(2);
          expect(await summary.getAttribute("aria-expanded")).toBe("true");
          expect([collapsedLabel, await summaryLabel.textContent()]).toEqual([label, label]);
          return keys;
        };
        const keys = await expand();
        if (!openAI) {
          const positions = await thread.locator(".chat-tool-row:visible").evaluateAll((list) =>
            list.map((row) => {
              const { top, bottom } = row.getBoundingClientRect();
              return { top, bottom };
            }),
          );
          expect(positions).toHaveLength(5);
          const gap = (index: number) => positions[index + 1]!.top - positions[index]!.bottom;
          expect(gap(2)).toBeCloseTo(gap(0), 0);
          expect(gap(3)).toBeCloseTo(gap(0), 0);
        }
        expect(await thread.locator(".chat-divider").count()).toBe(0);
        await rows.first().locator("summary").press("Enter");
        await rows.first().getByText("saved 60k tokens (75%)", { exact: true }).waitFor();
        await page.reload();
        expect(await expand()).toEqual(keys);
      }),
  );

  it.each(["context popover", "/compact"])("shows progress during the idle %s request", (entry) =>
    suite.withPage({ viewport, colorScheme: "light" }, async ({ page }) => {
      const now = Date.now();
      const gateway = await installMockGateway(page, {
        sessionKey,
        sessions: [{ ...session, updatedAt: now }],
        historyMessages: [{ role: "assistant", content: final, timestamp: now - 1000 }],
      });
      await page.goto(sessionUrl());
      const thread = page.locator(".chat-thread");
      await thread.getByText(final, { exact: true }).waitFor();
      await gateway.deferNext("sessions.compact");
      if (entry === "context popover") {
        await page.locator(".context-usage summary").click();
        await page.locator(".context-usage__report-skeleton").waitFor({ state: "hidden" });
        await page.getByRole("button", { name: "Compact", exact: true }).click();
      } else {
        await page.locator(".agent-chat__composer-combobox textarea").fill("/compact");
        await page.getByRole("button", { name: "Send message", exact: true }).click();
      }
      await gateway.waitForRequest("sessions.compact");
      const operation = {
        sessionKey,
        agentId: "main",
        operationId: "manual-operation",
        operation: "compact" as const,
        ts: now,
      };
      const row = thread.locator(".chat-compaction-activity");
      try {
        await gateway.emitGatewayEvent("session.operation", { ...operation, phase: "start" });
        await row.getByText("Compacting", { exact: true }).waitFor();
        expect(await row.count()).toBe(1);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      } finally {
        await gateway.emitGatewayEvent("session.operation", {
          ...operation,
          phase: "end",
          completed: true,
        });
        await gateway.resolveDeferred("sessions.compact", { ok: true, compacted: true });
      }
      await row.getByText("Compacted context", { exact: true }).waitFor();
      expect(await row.count()).toBe(1);
      expect(await row.locator(".text-shimmer").count()).toBe(0);
    }),
  );
});
