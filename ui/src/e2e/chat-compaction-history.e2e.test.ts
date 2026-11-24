import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createSessionGoalFixture } from "../../../src/gateway/session-goal.test-support.js";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Compaction history continuity" });

suite.define(() => {
  it.each(["overlapping tail", "unheld tool result"])(
    "keeps loaded discussion, goal and queued input across %s recovery",
    async (scenario) => {
      await suite.withPage(
        { viewport: { width: 1280, height: 900 }, colorScheme: "light" },
        async ({ page }) => {
          const now = Date.now();
          const sessionKey = "agent:main:dashboard:compaction-history";
          const runId = "goal-run";
          const row = {
            key: sessionKey,
            sessionId: "compaction-history-session",
            kind: "direct",
            label: "Deployment verification",
            updatedAt: now,
            status: "running",
            hasActiveRun: true,
            activeRunIds: [runId],
            activeLeafEntryId: scenario === "overlapping tail" ? "result" : "call",
            effectiveQueueMode: "followup",
            goal: createSessionGoalFixture("verify", "Finish the deployment verification", {
              createdAt: now - 60_000,
              updatedAt: now,
            }),
          };
          const messages = [
            ...Array.from({ length: 8 }, (_, index) => ({
              role: index % 2 ? "assistant" : "user",
              content: `Verification context ${index + 1}. Confirm the deployment checks and keep the recorded results.`,
              timestamp: now - 20000 + index * 1000,
              __openclaw: { id: `context-${index}`, seq: 92 + index },
            })),
            {
              role: "user",
              content: "Keep the verified discussion visible.",
              timestamp: now - 4000,
              __openclaw: { id: "prompt", seq: 100 },
            },
            {
              role: "assistant",
              content: "The earlier verification is complete.",
              stopReason: "stop",
              timestamp: now - 3000,
              __openclaw: { id: "answer", seq: 101, runId: "previous-run" },
            },
            {
              role: "assistant",
              content: [
                { type: "toolCall", id: "inspect", name: "read", arguments: { path: "README.md" } },
              ],
              stopReason: "toolUse",
              timestamp: now - 2000,
              __openclaw: { id: "call", seq: 102, runId },
            },
            {
              role: "toolResult",
              toolCallId: "inspect",
              toolName: "read",
              content: [{ type: "text", text: "Deployment checks ready." }],
              timestamp: now - 1000,
              __openclaw: { id: "result", seq: 103, runId },
            },
          ];
          for (const message of messages) {
            const metadata = message["__openclaw"];
            Object.assign(metadata, {
              transcriptPosition: { source: "browser-history", rawSeq: metadata.seq },
            });
          }
          const held = scenario === "overlapping tail" ? messages : messages.slice(0, -1);
          const tailMessages = messages.slice(scenario === "overlapping tail" ? -2 : -1);
          const initial = {
            messages: held,
            sessionId: row.sessionId,
            sessionInfo: row,
            deltaCursor: "before-compact",
            hasMore: true,
            olderCursor: "older:held",
            nextOffset: held.length,
            totalMessages: scenario === "overlapping tail" ? 103 : 102,
            inFlightRun: { runId, text: "", startedAt: now - 2000 },
          };
          const gateway = await installMockGateway(page, {
            sessionKey,
            sessions: [row],
            historyMessages: held,
            methodResponses: { "chat.startup": initial, "chat.history": initial },
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
          const thread = page.locator(".chat-thread");
          const prompt = thread.getByText("Keep the verified discussion visible.", { exact: true });
          await prompt.waitFor();
          const goal = page.locator(".agent-chat__goal");
          await goal.getByText("Pursuing goal", { exact: true }).waitFor();
          await gateway.emitGatewayEvent("agent", {
            runId,
            sessionKey,
            seq: 1,
            ts: now,
            stream: "compaction",
            data: { phase: "start" },
          });
          await page.locator(".chat-compaction--active").waitFor();
          await gateway.deferNext("chat.send");
          const composer = page.locator(".agent-chat__composer-combobox textarea");
          await composer.fill("Run the final verification next.");
          await composer.press("Enter");
          const sent = await gateway.waitForRequest("chat.send");
          const pendingRunId = (sent.params as { idempotencyKey: string }).idempotencyKey;
          const pendingInputs = {
            items: [
              {
                id: "queued-input",
                runId: pendingRunId,
                state: "queued",
                queued: true,
                acceptedAt: now,
                message: { role: "user", content: "Run the final verification next." },
              },
            ],
            total: 1,
            queuedCount: 1,
          };
          const compact = {
            role: "system",
            timestamp: now,
            __openclaw: {
              id: "compact",
              seq: 104,
              kind: "compaction",
              tokensBefore: 80000,
              tokensAfter: 20000,
              transcriptPosition: { source: "browser-history", rawSeq: 104 },
            },
          };
          const updatedRow = { ...row, activeLeafEntryId: "compact", updatedAt: now + 1 };
          await gateway.setMethodResponse("chat.history", {
            cases: [
              { match: { cursor: "before-compact" }, response: { kind: "reset" } },
              {
                match: { cursor: "older:tail" },
                response: {
                  messages: held,
                  sessionId: row.sessionId,
                  hasMore: true,
                  olderCursor: "older:recovered",
                  nextOffset: messages.length + 1,
                  totalMessages: 104,
                },
              },
              {
                response: {
                  ...initial,
                  messages: [...tailMessages, compact],
                  sessionInfo: updatedRow,
                  pendingInputs,
                  inputReceipts: [{ runId: pendingRunId, state: "pending", queued: true }],
                  deltaCursor: "after-compact",
                  olderCursor: "older:tail",
                  nextOffset: tailMessages.length + 1,
                  totalMessages: 104,
                },
              },
            ],
          });
          await gateway.resolveDeferred("chat.send", { runId: pendingRunId, status: "started" });
          await gateway.emitGatewayEvent("sessions.changed", { ...updatedRow, reason: "compact" });
          const queue = page.locator(".chat-queue__item", {
            hasText: "Run the final verification next.",
          });
          await queue.waitFor();
          await gateway.waitForRequest("chat.history", { match: { cursor: "before-compact" } });
          await expect
            .poll(async () =>
              (await gateway.getRequests("chat.history")).some(
                (request) => !(request.params as { cursor?: string }).cursor,
              ),
            )
            .toBe(true);
          // Wait for the authoritative tail, not merely the request that fetched it.
          await thread.getByText("saved 60k tokens (75%)", { exact: true }).waitFor();
          const frame = await takeControlUiScreenshotFrame(page, thread, [goal, queue], {
            animations: "disabled",
          });
          await writeFile(join(suite.artifactDir, "compaction-history.png"), frame.png);
          console.log("COMPACTION_HISTORY_PROOF", suite.artifactDir);
          expect(await prompt.count()).toBe(1);
          expect(
            await thread
              .getByText("The earlier verification is complete.", { exact: true })
              .count(),
          ).toBe(1);
          expect(await goal.getByText("Pursuing goal", { exact: true }).count()).toBe(1);
          expect(await queue.count()).toBe(1);
          expect(await gateway.getRequests("chat.send")).toHaveLength(1);
        },
      );
    },
  );
});
