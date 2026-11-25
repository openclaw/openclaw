import { expect, it } from "vitest";
import { buildWidgetDocument } from "../../../src/canvas/wrap.js";
import { augmentChatHistoryWithCanvasBlocks } from "../../../src/gateway/chat-display-projection.canvas.js";
import { useCanvasSandboxFixture } from "./canvas-sandbox.test-support.ts";
import {
  chatMessage,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
  textContent,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();
suite.define(() => {
  const canvasView = useCanvasSandboxFixture();
  it("attaches a file dropped over an inline widget", async () => {
    await suite.withPage(
      { ...createControlUiE2eContextOptions(), viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        const sessionKey = "agent:main:drop-over-widget";
        const docId = "cv_drop_over_widget";
        await installMockGateway(page, {
          sessionKey,
          historyMessages: augmentChatHistoryWithCanvasBlocks([
            {
              role: "toolResult",
              toolName: "show_widget",
              toolCallId: "drop-call",
              __openclaw: { id: "drop-result", seq: 1 },
              content: textContent(
                JSON.stringify({
                  kind: "canvas",
                  view: { id: docId, url: `/__openclaw__/canvas/documents/${docId}/index.html` },
                  presentation: {
                    target: "assistant_message",
                    title: "Synthetic preview",
                    sandbox: "scripts",
                    preferredHeight: 300,
                  },
                }),
              ),
              timestamp: 1_700_000_000_000,
            },
            chatMessage("assistant", "Here is a synthetic preview.", {
              timestamp: 1_700_000_000_001,
              __openclaw: { id: "drop-reply", seq: 2 },
            }),
          ]).slice(-1),
          methodResponses: {
            "canvas.document.view": canvasView(
              buildWidgetDocument("Synthetic preview", "<main><h2>Synthetic preview</h2></main>"),
            ),
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const frame = page.locator(".chat-thread openclaw-canvas-widget-view iframe").first();
        await frame.waitFor();
        const box = await frame.boundingBox();
        expect(box).not.toBeNull();
        const point = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };

        // A desktop drag reaches the chat before the widget. Browsers route the
        // rest of the drag by hit testing, so the widget must not take the drop.
        const drop = await page.evaluate(({ x, y }) => {
          const chat = document.querySelector<HTMLElement>(".chat");
          const transfer = new DataTransfer();
          transfer.items.add(
            new File([new Uint8Array([0x50, 0x4b, 0x05, 0x06])], "handoff.zip", {
              type: "application/zip",
            }),
          );
          const event = (type: string) =>
            new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer });
          chat?.dispatchEvent(event("dragenter"));
          const target = document.elementFromPoint(x, y);
          const hitTag = target?.tagName ?? null;
          target?.dispatchEvent(event("dragover"));
          target?.dispatchEvent(event("drop"));
          return { hitTag, insideChat: Boolean(target && chat?.contains(target)) };
        }, point);

        expect(drop.hitTag).not.toBe("IFRAME");
        expect(drop.insideChat).toBe(true);
        await page.locator(".chat-attachment-file").filter({ hasText: "handoff.zip" }).waitFor();
        await expect
          .poll(() => page.locator(".chat").getAttribute("data-attachment-drop-active"))
          .toBeNull();
      },
    );
  });
});
