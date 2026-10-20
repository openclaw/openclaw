import { writeFileSync } from "node:fs";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { buildWidgetDocument } from "../../../src/canvas/wrap.js";
import { createNestedToolActivity } from "../../../src/sessions/nested-tool-activity.js";
import { prepareChatHistoryFixture } from "../test-helpers/chat-activity-fixtures.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { clickBoardWidgetControl } from "../test-helpers/control-ui-e2e-widget.ts";
import { useCanvasSandboxFixture } from "./canvas-sandbox.test-support.ts";
import {
  captureUiProofEnabled,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();
const canvasPreview = (viewId: string, url: string, title: string) => ({
  kind: "canvas",
  surface: "assistant_message",
  render: "url",
  viewId,
  url,
  title,
  sandbox: "scripts",
});
const text = (value: string) => ({ type: "text", text: value });
const toolResult = <T>(details: T) => ({ content: [text(JSON.stringify(details))], details });

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
            text("Preparing the interactive preview."),
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
              ...canvasPreview(docId, documentUrl, "Interactive preview"),
              preferredHeight: 240,
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

  it("shows one nested widget while its wrapper enters saved history and after reload", async () => {
    const artifactDir = suite.artifactDir;
    const viewport = { width: 1280, height: 900 };
    await suite.withPage(
      {
        ...createControlUiE2eContextOptions(),
        viewport,
        ...(captureUiProofEnabled ? { recordVideo: { dir: artifactDir, size: viewport } } : {}),
      },
      async ({ page }) => {
        const sessionKey = "agent:main:dashboard:nested-widget";
        const docId = "cv_nested_counter";
        const parentToolCallId = "call_widget|fc_widget";
        const nestedToolCallId = "tool_call:call_widget_fc_widget:scope:show_widget:1";
        const documentUrl = `/__openclaw__/canvas/documents/${docId}/index.html`;
        const result = {
          kind: "canvas",
          view: { backend: "canvas", id: docId, url: documentUrl, title: "Counter" },
          presentation: { target: "assistant_message", sandbox: "scripts" },
        };
        const nestedResult = toolResult(result);
        const wrapperResult = toolResult({ output: [text(JSON.stringify(result))], value: result });
        const gateway = await installMockGateway(page, {
          sessionKey,
          agentModel: "openai/gpt-4.1",
          models: [{ id: "gpt-4.1", name: "GPT-4.1", provider: "openai" }],
          historyMessages: [],
          methodResponses: {
            "canvas.document.view": canvasView(
              buildWidgetDocument(
                "Counter",
                '<main style="padding:16px"><h2>Counter</h2><button onclick="this.nextElementSibling.textContent=Number(this.nextElementSibling.textContent)+1">Add one</button> <output>0</output></main>',
              ),
            ),
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await page
          .locator(".agent-chat__composer-combobox textarea")
          .fill("Show a tiny interactive counter.");
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        const request = await gateway.waitForRequest("chat.send");
        const runId = String(asOptionalRecord(request.params)?.idempotencyKey);
        const startedAt = Date.now() - 1_000;
        let seq = 0;
        const tool = (data: Record<string, unknown>) =>
          gateway.emitGatewayEvent("agent", {
            sessionKey,
            agentId: "main",
            runId,
            seq: ++seq,
            ts: startedAt + (data.toolCallId === nestedToolCallId ? 900 : 1),
            stream: "tool",
            data,
          });
        await tool({
          phase: "start",
          toolCallId: parentToolCallId,
          name: "exec",
          args: { code: "await tools.show_widget({ title: 'Counter' })" },
        });
        const nestedTool = (data: Record<string, unknown>) =>
          tool({
            toolCallId: nestedToolCallId,
            parentToolCallId,
            name: "show_widget",
            ...data,
          });
        await nestedTool({ phase: "start", args: { title: "Counter" } });
        await nestedTool({ phase: "result", result: nestedResult });
        const widgets = page.locator(".chat-thread openclaw-canvas-widget-view");
        const capture = async (name: string, anchors: Locator[]) => {
          if (!captureUiProofEnabled) {
            return;
          }
          const frame = await takeControlUiScreenshotFrame(
            page,
            page.locator("section.chat"),
            anchors,
            { animations: "disabled" },
          );
          writeFileSync(path.join(artifactDir, name + ".png"), frame.png);
          console.info(
            "Nested widget proof",
            JSON.stringify({ artifactDir, widgets: await widgets.count() }),
          );
        };
        const pauseForProof = async () => {
          if (captureUiProofEnabled) {
            await page.waitForTimeout(2_000);
          }
        };
        await expect.poll(() => widgets.count()).toBe(1);
        const inner = widgets.first().locator("iframe").contentFrame().frameLocator("iframe");
        await clickBoardWidgetControl(
          page,
          inner.getByRole("button", { name: "Add one", exact: true }),
        );
        await expect.poll(() => inner.locator("output").textContent()).toBe("1");
        await pauseForProof();
        const userMessage = {
          role: "user",
          content: "Show a tiny interactive counter.",
          timestamp: startedAt - 1,
          __openclaw: { id: "nested-prompt", seq: 1, idempotencyKey: `${runId}:user` },
        };
        const nested = {
          ...createNestedToolActivity({
            runId,
            scopeId: "widget-scope",
            afterEntryId: null,
            startOrder: 0,
            parentToolCallId,
            toolCallId: nestedToolCallId,
            toolName: "show_widget",
            input: { title: "Counter" },
            result: nestedResult,
            isError: false,
            startedAt: startedAt + 900,
            timestamp: startedAt + 901,
          }),
          __openclaw: { id: "nested-result", seq: 2, runId },
        };
        const wrapper = {
          role: "toolResult",
          toolCallId: parentToolCallId,
          toolName: "exec",
          ...wrapperResult,
          timestamp: startedAt + 1,
          __openclaw: { id: "wrapper-result", seq: 3, runId },
        };
        const canvasBlock = {
          type: "canvas",
          preview: canvasPreview(docId, documentUrl, "Counter"),
        };
        const finalMessage = {
          role: "assistant",
          content: [text("Your counter is ready."), canvasBlock],
          openclawDisplayContent: [canvasBlock],
          timestamp: startedAt + 901,
          idempotencyKey: runId,
          stopReason: "stop",
          __openclaw: { id: "nested-final", seq: 4, runId, runTerminal: true },
        };
        const history = prepareChatHistoryFixture([userMessage, nested, wrapper, finalMessage]);
        const persist = (message: Record<string, unknown>, messageId: string, messageSeq: number) =>
          gateway.emitGatewayEvent("session.message", {
            sessionKey,
            runId,
            message,
            messageId,
            messageSeq,
          });
        await gateway.setMethodResponse(
          "chat.history",
          prepareChatHistoryFixture([userMessage, nested]),
        );
        await persist(history.messages[1]!, "nested-result", 2);
        await expect.poll(() => widgets.count()).toBe(1);
        await tool({
          phase: "result",
          toolCallId: parentToolCallId,
          name: "exec",
          result: wrapperResult,
        });
        await gateway.setMethodResponse(
          "chat.history",
          prepareChatHistoryFixture([userMessage, nested, wrapper]),
        );
        await persist(wrapper, "wrapper-result", 3);
        await capture("persisted", [widgets.first().locator("iframe")]);
        expect(await widgets.count()).toBe(1);
        expect(await inner.locator("output").textContent()).toBe("1");
        await pauseForProof();
        await gateway.setMethodResponse("chat.history", history);
        await persist(finalMessage, "nested-final", 4);
        await gateway.emitGatewayEvent("chat", {
          sessionKey,
          runId,
          seq: ++seq,
          state: "final",
          message: {
            role: "assistant",
            content: finalMessage.content,
            openclawDisplayContent: finalMessage.openclawDisplayContent,
            timestamp: startedAt + 902,
          },
        });
        const finalText = page
          .locator(".chat-text")
          .getByText("Your counter is ready.", { exact: true });
        await finalText.waitFor();
        await page
          .getByRole("button", { name: "Stop generating", exact: true })
          .waitFor({ state: "hidden" });
        await capture("settled", [finalText, widgets.first().locator("iframe")]);
        expect(await widgets.count()).toBe(1);
        expect(await inner.locator("output").textContent()).toBe("1");
        await pauseForProof();
        await page.reload();
        await finalText.waitFor();
        await expect.poll(() => widgets.count()).toBe(1);
        await inner.getByRole("button", { name: "Add one", exact: true }).waitFor();
        await clickBoardWidgetControl(
          page,
          inner.getByRole("button", { name: "Add one", exact: true }),
        );
        await expect.poll(() => inner.locator("output").textContent()).toBe("1");
        await pauseForProof();
      },
    );
  });
});
