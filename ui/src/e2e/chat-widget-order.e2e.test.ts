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
  it.each(["forwarded", "projected", "mixed", "repeated-text"] as const)(
    "preserves %s transcript content through history reload",
    async (representation) => {
      await suite.withPage(
        { viewport: { width: 1280, height: 1000 }, colorScheme: "light", locale: "en-US" },
        async ({ page }) => {
          const startedAt = Date.now();
          const result = {
            role: "toolResult",
            toolName: "show_widget",
            toolCallId: "review-widget-one",
            timestamp: startedAt + 10,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  kind: "canvas",
                  view: {
                    backend: "canvas",
                    id: "cv_review_one",
                    title: "Widget one",
                    url: "/__openclaw__/canvas/documents/cv_review_one/index.html",
                  },
                  presentation: { target: "assistant_message" },
                }),
              },
            ],
          };
          const siblingId = representation === "mixed" ? "cv_review_two" : "cv_review_one";
          const siblingTitle = representation === "mixed" ? "Widget two" : "Widget one";
          const hasBoundary = representation === "forwarded" || representation === "projected";
          const historyMessages = [
            { role: "user", content: "Show the report.", timestamp: startedAt },
            ...(representation === "repeated-text"
              ? [1, 2].map((offset) => ({
                  role: "assistant",
                  content: "Preparing the report.",
                  timestamp: startedAt + offset,
                }))
              : []),
            result,
            ...(hasBoundary
              ? [
                  {
                    role: "assistant",
                    content: "Another turn: show that report again.",
                    timestamp: startedAt + 20,
                    ...(representation === "forwarded"
                      ? { provenance: { kind: "inter_session", sourceTool: "sessions_send" } }
                      : { __openclaw: { id: "review-new-turn", turnBoundary: true } }),
                  },
                ]
              : []),
            {
              role: representation === "repeated-text" ? "Assistant" : "assistant",
              timestamp: startedAt + 30,
              content: [
                ...(representation === "repeated-text"
                  ? [{ type: "text", text: "Report ready." }]
                  : []),
                ...(representation === "mixed"
                  ? [
                      {
                        type: "text",
                        text: '[embed ref="cv_review_one" /][embed ref="cv_review_two" /]',
                      },
                    ]
                  : []),
                {
                  type: "canvas",
                  preview: {
                    kind: "canvas",
                    surface: "assistant_message",
                    render: "url",
                    viewId: siblingId,
                    title: siblingTitle,
                    url: `/__openclaw__/canvas/documents/${siblingId}/index.html`,
                    sandbox: "scripts",
                  },
                },
              ],
            },
          ];
          await installMockGateway(page, {
            historyMessages,
            methodResponses: {
              "canvas.document.view": {
                cases: ["one", "two"].map((suffix) => ({
                  match: { docId: `cv_review_${suffix}` },
                  response: canvasView(
                    buildWidgetDocument(
                      `Widget ${suffix}`,
                      `<section style="padding:16px"><h2>Widget ${suffix}</h2><p>Report contents preserved.</p></section>`,
                    ),
                  ),
                })),
              },
            },
          });
          await page.goto(`${suite.server.baseUrl}chat`);
          for (const stage of ["history", "reload"]) {
            if (stage === "reload") {
              await page.reload();
            }
            const widgets = page.locator(".chat-tool-card__preview-frame");
            const expectedTitles =
              representation === "repeated-text" ? ["Widget one"] : ["Widget one", siblingTitle];
            await expect.poll(() => widgets.count()).toBe(expectedTitles.length);
            expect(
              await widgets.evaluateAll((frames) =>
                frames.map((frame) => frame.getAttribute("title")),
              ),
            ).toEqual(expectedTitles);
            for (const [index, title] of expectedTitles.entries()) {
              await widgets
                .nth(index)
                .contentFrame()
                .frameLocator("iframe")
                .getByRole("heading", { name: title })
                .waitFor();
            }
            if (hasBoundary) {
              const boundary = await page
                .getByText("Another turn: show that report again.", { exact: true })
                .boundingBox();
              const first = await widgets.nth(0).boundingBox();
              const second = await widgets.nth(1).boundingBox();
              expect(first!.y).toBeLessThan(boundary!.y);
              expect(boundary!.y).toBeLessThan(second!.y);
            }
            await page.screenshot({
              path: path.join(suite.artifactDir, `${representation}-${stage}.png`),
            });
            if (representation === "repeated-text") {
              expect(await page.getByText("Report ready.", { exact: true }).count()).toBe(1);
              const badges = page.locator(".chat-duplicate-count");
              expect(await badges.count()).toBe(1);
              expect(await badges.textContent()).toBe("×2");
              expect(await badges.getAttribute("aria-label")).toBe(
                "2 consecutive identical messages collapsed",
              );
            }
          }
        },
      );
    },
  );

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
