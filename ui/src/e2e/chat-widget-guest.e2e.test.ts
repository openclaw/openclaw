import { expect, it } from "vitest";
import { buildWidgetDocument } from "../../../src/canvas/wrap.js";
import { augmentChatHistoryWithCanvasBlocks } from "../../../src/gateway/chat-display-projection.canvas.js";
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
  it("renders a saved inline widget for a conversation reader", async () => {
    await suite.withPage(
      {
        ...createControlUiE2eContextOptions(),
        viewport: { width: 1440, height: 1000 },
      },
      async ({ page }) => {
        const sessionKey = "agent:main:saved-widget";
        const docId = "cv_saved_widget";
        const html = buildWidgetDocument(
          "Saved preview",
          "<main style=\"padding:24px\"><h2>Saved conversation preview</h2><p>This widget was saved before the viewer signed in.</p><button onclick=\"document.querySelector('output').textContent='Updated'\">Try the preview</button><output>Ready</output></main>",
        );
        const gateway = await installMockGateway(page, {
          sessionKey,
          operatorScopes: ["operator.sessions.read"],
          // A history page can contain the saved embed without its earlier tool result.
          historyMessages: augmentChatHistoryWithCanvasBlocks([
            {
              role: "toolResult",
              toolName: "show_widget",
              toolCallId: "saved-call",
              __openclaw: { id: "saved-result", seq: 1 },
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    kind: "canvas",
                    view: { id: docId, url: `/__openclaw__/canvas/documents/${docId}/index.html` },
                    presentation: {
                      target: "assistant_message",
                      title: "Saved preview",
                      sandbox: "scripts",
                      preferredHeight: 300,
                    },
                  }),
                },
              ],
              timestamp: 1_700_000_000_000,
            },
            {
              role: "assistant",
              content: [{ type: "text", text: "Here is the saved conversation preview." }],
              timestamp: 1_700_000_000_001,
              __openclaw: { id: "saved-reply", seq: 2 },
            },
          ]).slice(-1),
          methodResponses: { "canvas.document.view": canvasView(html) },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const widget = page.locator(".chat-thread openclaw-canvas-widget-view");
        await widget.waitFor();
        const inner = widget.locator("iframe").contentFrame().frameLocator("iframe");
        await inner.getByRole("heading", { name: "Saved conversation preview" }).waitFor();
        await inner.getByRole("button", { name: "Try the preview" }).click();
        await expect.poll(() => inner.locator("output").textContent()).toBe("Updated");
        expect((await gateway.getRequests("canvas.document.view"))[0]?.params).toEqual({
          docId,
          sessionKey,
        });
      },
    );
  });
});
