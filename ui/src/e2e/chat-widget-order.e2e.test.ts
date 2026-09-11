import path from "node:path";
import { expect, it } from "vitest";
import { buildWidgetDocument } from "../../../src/canvas/wrap.js";
import {
  appendChatCanvasBlocksToMessage,
  augmentChatHistoryWithCanvasBlocks,
  extractChatToolResultCanvasPreview,
} from "../../../src/gateway/chat-display-projection.canvas.js";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { useCanvasSandboxFixture } from "./canvas-sandbox.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI interleaved widget order",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  const canvasView = useCanvasSandboxFixture();
  it("keeps progress and widgets in order through final and history reload", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 1100 }, colorScheme: "light", locale: "en-US" },
      async ({ page: livePage, context }) => {
        let page = livePage;
        const runId = "run-widget-order";
        const startedAt = Date.now();
        const titles = ["Widget one", "Widget two"];
        const progress = ["Step one: collect readings.", "Step two: compare readings."];
        const user = {
          role: "user",
          content: "Show two visual steps, with a progress message before each widget.",
          timestamp: startedAt,
          __openclaw: { id: "widget-order-user", idempotencyKey: runId, seq: 1 },
        };
        const results = titles.map((title, index) => ({
          role: "toolResult",
          runId,
          toolName: "show_widget",
          toolCallId: `widget-order-${index}`,
          timestamp: startedAt + 20 + index * 20,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                kind: "canvas",
                view: {
                  backend: "canvas",
                  id: `cv_order_${index}`,
                  title,
                  url: `/__openclaw__/canvas/documents/cv_order_${index}/index.html`,
                  preferred_height: 140,
                },
                presentation: { target: "assistant_message", sandbox: "scripts" },
              }),
            },
          ],
        }));
        const scenario = {
          historyMessages: [user],
          inFlightRun: { runId, startedAt, text: "" },
          methodResponses: {
            "canvas.document.view": {
              cases: titles.map((title, index) => ({
                match: { docId: `cv_order_${index}` },
                response: canvasView(
                  buildWidgetDocument(
                    title,
                    `<section style="padding:16px;background:${index === 0 ? "#e8f2ff" : "#eaf8ed"};border-radius:12px"><h2 style="margin:0 0 8px">${title}</h2><p style="margin:0">${index === 0 ? "Readings collected" : "Comparison complete"}</p></section>`,
                  ),
                ),
              })),
            },
          },
        };
        const gateway = await installMockGateway(page, scenario);
        await page.goto(`${suite.server.baseUrl}chat`);
        await page.getByText(user.content, { exact: true }).waitFor();
        let seq = 0;
        for (const [index, result] of results.entries()) {
          await gateway.emitGatewayEvent("agent", {
            runId,
            sessionKey: "main",
            stream: "item",
            seq: ++seq,
            ts: startedAt + 10 + index * 20,
            data: { kind: "preamble", itemId: `progress-${index}`, progressText: progress[index] },
          });
          await page.getByText(progress[index]!, { exact: true }).waitFor();
          await gateway.emitGatewayEvent("agent", {
            runId,
            sessionKey: "main",
            stream: "tool",
            seq: ++seq,
            ts: result.timestamp - 1,
            data: {
              phase: "start",
              name: "show_widget",
              toolCallId: result.toolCallId,
              args: { title: titles[index] },
            },
          });
          await gateway.emitGatewayEvent("agent", {
            runId,
            sessionKey: "main",
            stream: "tool",
            seq: ++seq,
            ts: result.timestamp,
            data: {
              phase: "result",
              name: "show_widget",
              toolCallId: result.toolCallId,
              result: result.content[0]!.text,
            },
          });
          await page
            .locator(`.chat-tool-card__preview-frame[title="${titles[index]}"]`)
            .contentFrame()
            .frameLocator("iframe")
            .getByRole("heading", { name: titles[index] })
            .waitFor();
        }
        const inspectOrder = async (stage: string) => {
          const widgets = page.locator(".chat-tool-card__preview-frame");
          await expect.poll(() => widgets.count()).toBeGreaterThanOrEqual(2);
          const positions = await Promise.all(
            [
              page.getByText(progress[0]!, { exact: true }),
              page.locator(`.chat-tool-card__preview-frame[title="${titles[0]}"]`),
              page.getByText(progress[1]!, { exact: true }),
              page.locator(`.chat-tool-card__preview-frame[title="${titles[1]}"]`),
            ].map(async (locator, index) => ({
              index,
              y: (await locator.first().boundingBox())?.y ?? -1,
            })),
          );
          await page.screenshot({ path: path.join(suite.artifactDir, `${stage}.png`) });
          expect.soft(await widgets.count(), stage).toBe(2);
          expect
            .soft(
              positions.map(({ y }) => y),
              stage,
            )
            .not.toContain(-1);
          expect
            .soft(
              positions.toSorted((a, b) => a.y - b.y).map(({ index }) => index),
              stage,
            )
            .toEqual([0, 1, 2, 3]);
        };
        await inspectOrder("01-streaming");
        const final = appendChatCanvasBlocksToMessage(
          {
            role: "assistant",
            content: [{ type: "text", text: "Both steps are complete." }],
            timestamp: startedAt + 50,
          },
          results.flatMap((result) => extractChatToolResultCanvasPreview(result) ?? []),
        );
        const history = augmentChatHistoryWithCanvasBlocks([
          user,
          ...results.flatMap((result, index) => [
            {
              role: "assistant",
              phase: "commentary",
              content: [{ type: "text", text: progress[index] }],
              timestamp: startedAt + 10 + index * 20,
              __openclaw: { id: `progress-${index}`, runId, seq: 2 + index * 2 },
            },
            result,
          ]),
          {
            role: "assistant",
            content: [{ type: "text", text: "Both steps are complete." }],
            timestamp: startedAt + 50,
          },
        ]);
        await gateway.setHistoryMessages(history);
        await gateway.emitGatewayEvent("chat", {
          runId,
          sessionKey: "main",
          seq: seq + 1,
          state: "final",
          message: final,
        });
        await page
          .getByRole("paragraph")
          .filter({ hasText: /^Both steps are complete\.$/u })
          .waitFor();
        await inspectOrder("02-final");
        // The mock's initial history is immutable across navigations. A fresh
        // page receives the now-durable snapshot, without retaining live state.
        await page.close();
        page = await context.newPage();
        await installMockGateway(page, {
          ...scenario,
          historyMessages: history,
          inFlightRun: null,
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await page
          .getByRole("paragraph")
          .filter({ hasText: /^Both steps are complete\.$/u })
          .waitFor();
        await inspectOrder("03-history");
        await page.reload();
        await page
          .getByRole("paragraph")
          .filter({ hasText: /^Both steps are complete\.$/u })
          .waitFor();
        await inspectOrder("04-reload");
      },
    );
  });
});
