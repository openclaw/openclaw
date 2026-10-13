import { expect, it } from "vitest";
import { buildWidgetDocument } from "../../../src/canvas/wrap.js";
import { clickBoardWidgetControl } from "../test-helpers/control-ui-e2e-widget.ts";
import { useCanvasSandboxFixture } from "./canvas-sandbox.test-support.ts";
import {
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  const canvasView = useCanvasSandboxFixture();

  it("hands an interactive widget from live tool output to its completed reply without reloading", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const sessionKey = "agent:main:dashboard:widget-retention";
      const runId = "widget-run";
      const docId = "cv_retained_counter";
      const documentUrl = `/__openclaw__/canvas/documents/${docId}/index.html`;
      const startedAt = Date.now() - 1_000;
      const messages = [
        {
          role: "user",
          content: "Show an interactive preview.",
          timestamp: startedAt,
          __openclaw: { id: "widget-prompt", seq: 1, idempotencyKey: `${runId}:user` },
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Preparing the interactive preview." },
            { type: "toolCall", id: "show-preview", name: "show_widget", arguments: {} },
          ],
          timestamp: startedAt + 1,
          __openclaw: { id: "widget-call", seq: 2, runId },
        },
        {
          role: "toolResult",
          toolCallId: "show-preview",
          toolName: "show_widget",
          timestamp: startedAt + 2,
          __openclaw: { id: "widget-result", seq: 3, runId },
          content: JSON.stringify({
            kind: "canvas",
            view: { backend: "canvas", id: docId, url: documentUrl },
            presentation: {
              target: "assistant_message",
              title: "Interactive preview",
              preferred_height: 240,
              sandbox: "scripts",
            },
          }),
        },
      ];
      const html = buildWidgetDocument(
        "Interactive preview",
        `<main style="height:240px">
          <button onclick="document.querySelector('output').textContent=String(++window.clicks)">Count</button>
          <output>0</output>
        </main><script>window.clicks=0;</script>`,
      );
      const gateway = await installMockGateway(page, {
        sessionKey,
        historyMessages: messages,
        inFlightRun: { runId, startedAt, text: "" },
        sessionInfo: { hasActiveRun: true, activeRunIds: [runId] },
        methodResponses: { "canvas.document.view": canvasView(html) },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      expect(await page.evaluate(() => typeof Reflect.get(Element.prototype, "moveBefore"))).toBe(
        "function",
      );
      await page.getByRole("button", { name: "Stop generating", exact: true }).waitFor();

      const widgets = page.locator(".chat-thread openclaw-canvas-widget-view");
      const outer = widgets.locator("iframe");
      const inner = outer.contentFrame().frameLocator("iframe");
      await clickBoardWidgetControl(
        page,
        inner.getByRole("button", { name: "Count", exact: true }),
      );
      await expect.poll(() => inner.locator("output").textContent()).toBe("1");
      const retainedFrame = await outer.elementHandle();
      expect(retainedFrame).not.toBeNull();
      const originalRow = await widgets.evaluate((element) =>
        element.closest("[data-virtual-row-key]")?.getAttribute("data-virtual-row-key"),
      );
      expect(await gateway.getRequests("canvas.document.view")).toHaveLength(1);

      const finalText = "The interactive preview is ready.";
      const finalMessage = {
        role: "assistant",
        idempotencyKey: runId,
        stopReason: "stop",
        content: [
          {
            type: "text",
            // Leave enough transcript below the widget to exercise forwarded wheel input.
            text: `[embed](${documentUrl})\n\n${finalText}\n\n${Array.from(
              { length: 12 },
              (_, index) => `Preview detail ${index + 1}.`,
            ).join("\n\n")}`,
          },
          // The Gateway's reply finalizer appends the run's canvas blocks.
          {
            type: "canvas",
            preview: {
              kind: "canvas",
              surface: "assistant_message",
              render: "url",
              viewId: docId,
              url: documentUrl,
              title: "Interactive preview",
              preferredHeight: 240,
              sandbox: "scripts",
            },
          },
        ],
        timestamp: startedAt + 3,
        __openclaw: { id: "widget-final", seq: 4, runId, runTerminal: true },
      };
      await gateway.setHistoryMessages([...messages, finalMessage]);
      await gateway.emitGatewayEvent("session.message", {
        sessionKey,
        runId,
        message: finalMessage,
        messageId: "widget-final",
        messageSeq: 4,
        session: { key: sessionKey, hasActiveRun: true, activeRunIds: [runId], status: "running" },
        hasActiveRun: true,
        activeRunIds: [runId],
      });
      await page
        .locator('.chat-bubble[data-entry-id="widget-final"]')
        .getByText(finalText, { exact: true })
        .waitFor();
      await gateway.emitGatewayEvent("chat", {
        sessionKey,
        runId,
        seq: 1,
        state: "final",
        message: finalMessage,
      });
      await gateway.emitGatewayEvent("sessions.changed", {
        sessionKey,
        reason: "lifecycle",
        session: {
          key: sessionKey,
          hasActiveRun: false,
          activeRunIds: [],
          lastRunId: runId,
          status: "done",
          updatedAt: startedAt + 3,
        },
      });

      const finalReply = page.locator('.chat-bubble[data-entry-id="widget-final"]');
      await finalReply.getByText(finalText, { exact: true }).waitFor();
      await page.locator(".chat-work-group").waitFor();
      await expect.poll(() => widgets.count()).toBe(1);
      await expect.poll(() => finalReply.locator("openclaw-canvas-widget-view").count()).toBe(1);
      expect(
        await widgets.evaluate((element) =>
          element.closest("[data-virtual-row-key]")?.getAttribute("data-virtual-row-key"),
        ),
      ).not.toBe(originalRow);
      expect(await outer.evaluate((frame, original) => frame === original, retainedFrame)).toBe(
        true,
      );
      expect(await inner.locator("output").textContent()).toBe("1");
      expect(await inner.locator("body").evaluate(() => Reflect.get(window, "clicks"))).toBe(1);
      expect(await gateway.getRequests("canvas.document.view")).toHaveLength(1);

      const thread = page.locator(".chat-pane-cache__pane--active .chat-thread");
      await clickBoardWidgetControl(
        page,
        inner.getByRole("button", { name: "Count", exact: true }),
      );
      await expect.poll(() => inner.locator("output").textContent()).toBe("2");
      const scrollBefore = await thread.evaluate((element) => element.scrollTop);
      await page.mouse.wheel(0, 120);
      await expect
        .poll(() => thread.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(scrollBefore);
      expect(await retainedFrame!.evaluate((frame) => frame.closest(".chat-thread") !== null)).toBe(
        true,
      );
      expect(await gateway.getRequests("canvas.document.view")).toHaveLength(1);
    });
  });
});
