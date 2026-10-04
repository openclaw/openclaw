// Chat widgets size to their content: the in-frame reporter drives the host
// frame, so a tall document must not end up scrolling inside its own row.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { buildWidgetDocument } from "../../../src/canvas/wrap.js";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { useCanvasSandboxFixture } from "./canvas-sandbox.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI chat widget autosizing",
  startServerBeforeBrowser: true,
});

const documentId = "widget-autosize-proof";
const documentPath = `/__openclaw__/canvas/documents/${documentId}/index.html`;
// Taller than any viewport this suite uses, so a frame that fits the content
// can only come from the reported height rather than from the layout box.
const rowCount = 90;
const rowHeight = 28;
const video = readFileSync(new URL("./fixtures/video-poster.mp4", import.meta.url));

suite.define(() => {
  const canvasView = useCanvasSandboxFixture();
  it("fits tall widgets and passes media wheel input to chat without taking nested scrolls", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 800 } }, async ({ page }) => {
      await installMockGateway(page, {
        methodResponses: {
          "canvas.document.view": canvasView(
            buildWidgetDocument(
              "Autosize proof",
              `<script>
                const nativeData = Object.getOwnPropertyDescriptor(MessageEvent.prototype, "data").get;
                Object.defineProperty(MessageEvent.prototype, "data", { get() {
                  const data = nativeData.call(this);
                  if (data?.type === "openclaw:widget-board-host") window.stolenScrollNonce = data.nonce;
                  return data;
                }});
              </script><div style="display:grid">${Array.from(
                { length: rowCount },
                (_, index) =>
                  `${
                    index === rowCount / 2
                      ? `<video aria-label="Synthetic video" controls loop playsinline preload="auto"
                        style="display:block;width:320px;height:180px"
                        src="data:video/mp4;base64,${video.toString("base64")}"></video>
                      <div aria-label="Scrollable widget details" style="height:160px;overflow-y:auto">
                        <div style="height:640px">Nested details remain independently scrollable</div>
                      </div>
                      <div aria-label="Wheel-controlled widget" style="height:80px">Wheel changes this control</div>`
                      : ""
                  }<div style="height:${rowHeight}px;line-height:${rowHeight}px">Row ${index + 1}</div>`,
              ).join("")}</div><script>
                document.querySelector('[aria-label="Wheel-controlled widget"]').addEventListener('wheel', event => {
                  event.preventDefault();
                  event.currentTarget.textContent = 'Wheel handled';
                }, {passive:false});
              </script>`,
            ),
          ),
        },
        historyMessages: [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "autosize-widget",
                name: "canvas_render",
                arguments: { title: "Autosize proof" },
              },
              {
                type: "tool_result",
                id: "autosize-widget",
                name: "canvas_render",
                text: JSON.stringify({
                  kind: "canvas",
                  view: {
                    backend: "canvas",
                    id: documentId,
                    url: documentPath,
                    title: "Autosize proof",
                  },
                  presentation: { target: "assistant_message", sandbox: "scripts" },
                }),
              },
            ],
            timestamp: 100,
          },
        ],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      const frame = page.locator(".chat-tool-card__preview-frame");
      await frame.waitFor();
      const contentHeight = rowCount * rowHeight;
      await expect
        .poll(async () => Math.round((await frame.boundingBox())?.height ?? 0))
        .toBeGreaterThanOrEqual(contentHeight);
      // The document is fully laid out inside the frame, so nothing is hidden
      // behind a nested scrollbar the transcript cannot reach. The frame is
      // sandboxed and cross-origin, so measure from inside it.
      const overflow = await frame
        .contentFrame()
        .frameLocator("iframe")
        .locator("body")
        .evaluate((body) => body.scrollHeight - window.innerHeight);
      expect(overflow).toBeLessThanOrEqual(0);

      const widget = frame.contentFrame().frameLocator("iframe");
      const player = widget.getByLabel("Synthetic video");
      const thread = page.locator(".chat-thread");
      await expect
        .poll(() => player.evaluate((element: HTMLVideoElement) => element.readyState))
        .toBeGreaterThanOrEqual(2);
      await player.hover();
      await thread.evaluate((element) => {
        Reflect.set(window, "widgetScrollInputs", 0);
        element.addEventListener("wheel", () => {
          Reflect.set(window, "widgetScrollInputs", Reflect.get(window, "widgetScrollInputs") + 1);
        });
      });
      const beforeDown = await thread.evaluate((element) => element.scrollTop);
      await page.mouse.wheel(0, 100);
      await expect
        .poll(() => thread.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(beforeDown);
      await expect
        .poll(() => page.evaluate(() => Reflect.get(window, "widgetScrollInputs")))
        .toBe(1);
      expect(await player.evaluate(() => Boolean(Reflect.get(window, "stolenScrollNonce")))).toBe(
        false,
      );
      await player.hover();
      const beforeUp = await thread.evaluate((element) => element.scrollTop);
      await page.mouse.wheel(0, -100);
      await expect
        .poll(() => thread.evaluate((element) => element.scrollTop))
        .toBeLessThan(beforeUp);

      // Playback uses the browser's own focused video controls after scrolling.
      await player.press("Space");
      await expect
        .poll(() => player.evaluate((element: HTMLVideoElement) => element.paused))
        .toBe(false);
      await player.press("Space");
      await expect
        .poll(() => player.evaluate((element: HTMLVideoElement) => element.paused))
        .toBe(true);

      const details = widget.getByLabel("Scrollable widget details");
      await details.hover();
      const beforeNested = await thread.evaluate((element) => element.scrollTop);
      await page.mouse.wheel(0, 100);
      await expect.poll(() => details.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      expect(await thread.evaluate((element) => element.scrollTop)).toBe(beforeNested);
      await details.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await page.mouse.wheel(0, 100);
      await expect
        .poll(() => thread.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(beforeNested);

      const control = widget.getByLabel("Wheel-controlled widget");
      await control.hover();
      const beforeControl = await thread.evaluate((element) => element.scrollTop);
      await page.mouse.wheel(0, 100);
      await expect.poll(() => control.textContent()).toBe("Wheel handled");
      expect(await thread.evaluate((element) => element.scrollTop)).toBe(beforeControl);
    });
  });
});
