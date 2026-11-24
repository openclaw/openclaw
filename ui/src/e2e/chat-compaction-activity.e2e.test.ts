import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { prepareChatHistoryFixture } from "../test-helpers/chat-activity-fixtures.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Idle compaction activity" });

suite.define(() => {
  it.each([false, true])(
    "keeps compaction visible after reload (OpenAI rollup: %s)",
    async (openAI) => {
      await suite.withPage(
        { viewport: { width: 1280, height: 900 }, colorScheme: "light" },
        async ({ page }) => {
          const sessionKey = "agent:main:dashboard:grouped-compaction";
          const runId = "verification-run";
          const now = Date.now();
          const metadata = (id: string, seq: number) => ({ id, seq, runId });
          const operations = [
            { id: "read-file", name: "read", arguments: { path: "release-notes.md" } },
            {
              id: "edit-file",
              name: "edit",
              arguments: { path: "release-notes.md", oldText: "Pending", newText: "Verified" },
            },
            { id: "check", name: "exec", arguments: { command: "pnpm test release-notes" } },
          ];
          const messages = [
            {
              role: "user",
              content: "Review the release notes and run the focused check.",
              timestamp: now - 10000,
              __openclaw: metadata("prompt", 1),
            },
            {
              role: "assistant",
              content: operations.map((operation) => ({ type: "toolCall", ...operation })),
              stopReason: "toolUse",
              provider: openAI ? "openai" : undefined,
              model: openAI ? "gpt-4.1-mini" : undefined,
              timestamp: now - 9000,
              __openclaw: metadata("calls", 2),
            },
            ...operations.map((operation, index) => ({
              role: "toolResult",
              toolCallId: operation.id,
              toolName: operation.name,
              isError: false,
              details: operation.name === "exec" ? { status: "completed", exitCode: 0 } : undefined,
              content: [{ type: "text", text: "Verified." }],
              timestamp: now - 8000 + index * 1000,
              __openclaw: metadata(operation.id, 3 + index),
            })),
            ...[0, 1].map((index) => ({
              role: "system",
              timestamp: now - 5000 + index * 1000,
              __openclaw: {
                ...metadata("compaction-" + index, 6 + index),
                kind: "compaction",
                itemId: "same-run-item-" + index,
                tokensBefore: 80000,
                tokensAfter: 20000,
              },
            })),
            {
              role: "assistant",
              content: "The release notes are ready and the check passed.",
              stopReason: "stop",
              provider: openAI ? "openai" : undefined,
              model: openAI ? "gpt-4.1-mini" : undefined,
              timestamp: now - 2000,
              __openclaw: metadata("final", 8),
            },
          ];
          await installMockGateway(page, {
            sessionKey,
            sessions: [
              {
                key: sessionKey,
                sessionId: "verification",
                label: "Release verification",
                kind: "direct",
                status: "done",
                hasActiveRun: false,
                updatedAt: now,
              },
            ],
            methodResponses: { "chat.history": prepareChatHistoryFixture(messages) },
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
          const thread = page.locator(".chat-thread");
          const reply = thread.getByText("The release notes are ready and the check passed.", {
            exact: true,
          });
          const summary = thread.locator(".chat-activity-group__summary").filter({
            hasText: openAI
              ? "Worked, compacted context"
              : "Read and changed files, ran commands, compacted context",
          });
          const collapsed = summary.and(page.locator('[aria-expanded="false"]'));
          await reply.waitFor();
          await collapsed.waitFor();
          await writeFile(
            join(suite.artifactDir, openAI ? "openai-collapsed.png" : "count-free-collapsed.png"),
            (
              await takeControlUiScreenshotFrame(page, thread, [summary, reply], {
                animations: "disabled",
              })
            ).png,
          );
          const rows = openAI
            ? thread.locator(".chat-compaction-activity")
            : summary.locator("..").locator(".chat-compaction-activity");
          const expand = async () => {
            await collapsed.click();
            await rows.first().waitFor();
            expect(await rows.count()).toBe(2);
            const keys = await rows.evaluateAll((elements) =>
              elements.map((row) => row.getAttribute("data-chat-row-key")),
            );
            expect(new Set(keys).size).toBe(2);
            return keys;
          };
          const keys = await expand();
          if (!openAI) {
            const visibleRows = summary.locator("..").locator(".chat-tool-row:visible");
            const boxes = await visibleRows.evaluateAll((elements) =>
              elements.map((element) => {
                const rect = element.getBoundingClientRect();
                return { top: rect.top, bottom: rect.bottom };
              }),
            );
            expect(boxes).toHaveLength(5);
            const normalGap = boxes[1]!.top - boxes[0]!.bottom;
            expect(boxes[3]!.top - boxes[2]!.bottom).toBeCloseTo(normalGap, 0);
            expect(boxes[4]!.top - boxes[3]!.bottom).toBeCloseTo(normalGap, 0);
          }
          expect(await thread.locator(".chat-divider").count()).toBe(0);
          await rows.first().locator("summary").press("Enter");
          const metrics = rows.first().getByText("saved 60k tokens (75%)", { exact: true });
          await metrics.waitFor();
          await writeFile(
            join(suite.artifactDir, openAI ? "openai-expanded.png" : "count-free-expanded.png"),
            (
              await takeControlUiScreenshotFrame(page, thread, [metrics, reply], {
                animations: "disabled",
                scrollTo: metrics,
              })
            ).png,
          );
          await page.reload();
          await reply.waitFor();
          expect(await expand()).toEqual(keys);
          console.log("COUNT_FREE_COMPACTION_PROOF", suite.artifactDir);
        },
      );
    },
  );
  it.each(["context popover", "/compact"])(
    "shows live activity before the %s request settles",
    async (entry) => {
      await suite.withPage(
        { viewport: { width: 1280, height: 900 }, colorScheme: "light" },
        async ({ page }) => {
          const sessionKey = "agent:main:dashboard:manual-compaction";
          const now = Date.now();
          const gateway = await installMockGateway(page, {
            sessionKey,
            sessions: [
              {
                key: sessionKey,
                label: "Manual compaction",
                kind: "direct",
                hasActiveRun: false,
                status: "done",
                updatedAt: now,
                contextTokens: 32000,
                totalTokens: 6000,
              },
            ],
            historyMessages: [
              { role: "user", content: "Check the release notes.", timestamp: now - 3000 },
              { role: "assistant", content: "Checked.", timestamp: now - 2000 },
            ],
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
          await page.getByText("Checked.", { exact: true }).waitFor();
          await gateway.deferNext("sessions.compact");
          if (entry === "context popover") {
            await page.locator(".context-usage summary").click();
            await page.locator(".context-usage__report-skeleton").waitFor({ state: "hidden" });
            await page.getByRole("button", { name: "Compact", exact: true }).click();
          } else {
            const composer = page.locator(".agent-chat__composer-combobox textarea");
            await composer.fill("/compact");
            await page.getByRole("button", { name: "Send message", exact: true }).click();
          }
          await gateway.waitForRequest("sessions.compact");
          try {
            await gateway.emitGatewayEvent("session.operation", {
              sessionKey,
              agentId: "main",
              operationId: "manual-operation",
              operation: "compact",
              phase: "start",
              ts: now,
            });
            await page.locator(".chat-thread").getByText("Compacting", { exact: true }).waitFor();
            expect(
              await page.locator(".chat-thread").getByText("Compacting", { exact: true }).count(),
            ).toBe(1);
            if (entry === "/compact") {
              const active = page.locator(".chat-compaction-activity > summary");
              await active.waitFor();
              await writeFile(
                join(suite.artifactDir, "layers-active.png"),
                (
                  await takeControlUiScreenshotFrame(page, page.locator(".chat-thread"), [active], {
                    animations: "disabled",
                  })
                ).png,
              );
              console.log("LAYERS_ACTIVE_PROOF", suite.artifactDir);
            }
            expect(await gateway.getRequests("chat.send")).toHaveLength(0);
            expect(
              await page.locator(".chat-thread").getByText("Checked.", { exact: true }).count(),
            ).toBe(1);
          } finally {
            await gateway.emitGatewayEvent("session.operation", {
              sessionKey,
              agentId: "main",
              operationId: "manual-operation",
              operation: "compact",
              phase: "end",
              completed: true,
              ts: now + 1000,
            });
            await gateway.resolveDeferred("sessions.compact", { ok: true, compacted: true });
          }
          const compact = page.locator(".chat-compaction-activity");
          await compact.getByText("Compacted context", { exact: true }).waitFor();
          expect(await compact.count()).toBe(1);
          expect(await compact.locator(".chat-tool-row__title.text-shimmer").count()).toBe(0);
        },
      );
    },
  );
});
