// Chat widgets size to their content: the in-frame reporter drives the host
// frame, so a tall document must not end up scrolling inside its own row.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { buildWidgetDocument } from "../../../src/canvas/wrap.js";
import type { SessionSnapshotStore } from "../pages/chat/session-snapshot-store.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
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
const trailer = `<div id="primetime-trailer"><video aria-label="Primetime official trailer" controls playsinline preload="auto" style="display:block;width:100%;aspect-ratio:16/9;background:#000;border-radius:12px"><source src="data:video/mp4;base64,${video.toString("base64")}" type="video/mp4"></video><p id="trailer-status" style="font:13px var(--font-body);color:var(--muted)">Press play. <a href="https://www.youtube.com/watch?v=synthetic" target="_blank" rel="noopener noreferrer">Watch on YouTube</a></p></div>`;
// Stored pre-fix shell and body reporter, independent of the current wrapper.
const legacyTrailer = `<!doctype html><html><head><style>
  :root{color-scheme:dark;--font-body:Arial,sans-serif;--muted:#8b8b94}
  html,body{margin:0}body{font:14px/1.5 var(--font-body)}p{margin:0 0 8px}
  a{color:#ff5c5c}
  </style></head><body><script>(()=>{
    const post=window.parent.postMessage.bind(window.parent);
    let last=0;const report=()=>{const b=document.body;if(!b)return;
      const h=Math.ceil(Math.max(b.scrollHeight,b.offsetHeight,b.getBoundingClientRect().height));
      if(h&&h!==last){last=h;post({type:"openclaw:widget-size",height:h},"*");}};
    addEventListener("load",report);new ResizeObserver(report).observe(document.body);
    setTimeout(report,50);setTimeout(report,500);
  })();</script>${trailer}</body></html>`;

type WidgetReloadFrame = {
  scrollTop: number;
  endGap: number;
  previewHeight: number;
  anchorTop: number;
};

declare global {
  interface Window {
    widgetReloadFrames?: WidgetReloadFrame[];
    widgetReloadRecording?: boolean;
  }
}

suite.define(() => {
  const canvasView = useCanvasSandboxFixture();
  it("reserves a learned widget height from the first reload frame through delayed content", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const sessionKey = "agent:main:dashboard:widget-reload";
      const html = buildWidgetDocument(
        "Synthetic dashboard preview",
        `<main style="height:700px;box-sizing:border-box;padding:24px;display:grid;grid-template-rows:repeat(7,1fr);background:#e8f0f7;color:#243b53">${Array.from(
          { length: 7 },
          (_, index) =>
            `<div style="display:flex;align-items:center;border-bottom:1px solid #bcccdc">Synthetic dashboard row ${index + 1}${index === 6 ? ": All data in this preview is synthetic." : ""}</div>`,
        ).join("")}</main>`,
      );
      const gateway = await installMockGateway(page, {
        sessionKey,
        authMethod: "trusted-proxy",
        authMode: "trusted-proxy",
        heldMethods: ["canvas.document.view"],
        methodResponses: { "canvas.document.view": canvasView(html) },
        historyMessages: [
          ...Array.from({ length: 12 }, (_, index) => ({
            role: index % 2 ? "assistant" : "user",
            content: `Synthetic context ${index}: ${"Dashboard detail. ".repeat(20)}`,
            timestamp: 1_800_000_000_000 + index * 1000,
            __openclaw: { id: `widget-context-${index}`, seq: index + 1 },
          })),
          {
            role: "assistant",
            content: [
              {
                type: "text",
                text: `[embed ref="${documentId}" title="Synthetic dashboard preview" /]`,
              },
            ],
            timestamp: 1_800_000_012_000,
            __openclaw: { id: "widget-preview", seq: 13 },
          },
          {
            role: "user",
            content: "Keep this reply in place while the preview loads.",
            timestamp: 1_800_000_013_000,
            __openclaw: { id: "widget-reload-anchor", seq: 14 },
          },
        ],
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await gateway.waitForRequest("canvas.document.view");
      await gateway.resolveDeferred("canvas.document.view");
      const frame = page.locator(".chat-tool-card__preview-frame");
      await frame
        .contentFrame()
        .frameLocator("iframe")
        .getByText("All data in this preview is synthetic.", { exact: false })
        .waitFor();
      await page.waitForFunction(
        () =>
          document.querySelector(".chat-tool-card__preview-frame")?.getBoundingClientRect()
            .height === 700,
        undefined,
        { polling: "raf" },
      );
      const preview = page.locator('.chat-tool-card__preview[data-content-kind="canvas-html"]');
      const learnedHeight = (await preview.boundingBox())!.height;
      await page.locator(".chat-pane-cache__pane--active").evaluate(async (element) => {
        const pane = element as HTMLElement & { sessionSnapshotStore?: SessionSnapshotStore };
        if (!pane.sessionSnapshotStore) {
          throw new Error("Missing transcript snapshot owner");
        }
        await pane.sessionSnapshotStore.flush();
      });
      await page.addInitScript(() => {
        window.widgetReloadFrames = [];
        window.widgetReloadRecording = true;
        const sample = () => {
          if (!window.widgetReloadRecording) {
            return;
          }
          const pane = document.querySelector(".chat-pane-cache__pane--active");
          const thread = pane?.querySelector<HTMLElement>(".chat-thread");
          const widget = thread?.querySelector(
            '.chat-tool-card__preview[data-content-kind="canvas-html"]',
          );
          const anchor = thread?.querySelector('[data-entry-id="widget-reload-anchor"]');
          if (thread?.clientHeight && widget && anchor) {
            window.widgetReloadFrames!.push({
              scrollTop: thread.scrollTop,
              endGap: thread.scrollHeight - thread.clientHeight - thread.scrollTop,
              previewHeight: widget.getBoundingClientRect().height,
              anchorTop: anchor.getBoundingClientRect().top,
            });
          }
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      await page.reload();
      await gateway.waitForRequest("canvas.document.view");
      await page.waitForFunction(() => (window.widgetReloadFrames?.length ?? 0) >= 20, undefined, {
        polling: "raf",
      });
      const artifacts = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR
        ? createControlUiE2eArtifactDir("widget-reload")
        : undefined;
      const thread = page.locator(".chat-pane-cache__pane--active .chat-thread");
      const anchor = thread.locator('[data-entry-id="widget-reload-anchor"]');
      if (artifacts) {
        const capture = await takeControlUiScreenshotFrame(page, thread, [anchor], {
          animations: "disabled",
        });
        writeFileSync(path.join(artifacts, "waiting.png"), capture.png);
      }
      await gateway.resolveDeferred("canvas.document.view");
      await frame
        .contentFrame()
        .frameLocator("iframe")
        .getByText("All data in this preview is synthetic.", { exact: false })
        .waitFor();
      const samples = await page.evaluate(async () => {
        for (let index = 0; index < 20; index += 1) {
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          });
        }
        window.widgetReloadRecording = false;
        return window.widgetReloadFrames ?? [];
      });
      if (artifacts) {
        const capture = await takeControlUiScreenshotFrame(page, thread, [anchor], {
          animations: "disabled",
        });
        writeFileSync(path.join(artifacts, "loaded.png"), capture.png);
        writeFileSync(path.join(artifacts, "frames.json"), JSON.stringify(samples));
      }
      expect(samples.length).toBeGreaterThanOrEqual(40);
      expect(samples[0]!.scrollTop).toBeGreaterThan(0);
      for (const sample of samples) {
        expect(Math.abs(sample.previewHeight - learnedHeight)).toBeLessThanOrEqual(1);
        expect(Math.abs(sample.endGap)).toBeLessThanOrEqual(1);
        expect(Math.abs(sample.scrollTop - samples[0]!.scrollTop)).toBeLessThanOrEqual(1);
        expect(Math.abs(sample.anchorTop - samples[0]!.anchorTop)).toBeLessThanOrEqual(1);
      }
    });
  });
  it("fits trailer captions and enables fullscreen for new and saved widget documents", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 800 }, colorScheme: "dark" },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "canvas.document.view": canvasView(buildWidgetDocument("Primetime trailer", trailer)),
          },
          historyMessages: [
            {
              role: "assistant",
              content: [
                { type: "text", text: `[embed ref="${documentId}" title="Primetime trailer" /]` },
              ],
              timestamp: 100,
            },
          ],
        });
        const artifacts = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR
          ? createControlUiE2eArtifactDir("trailer")
          : undefined;
        for (const saved of [false, true]) {
          if (saved) {
            await gateway.setMethodResponse("canvas.document.view", canvasView(legacyTrailer));
          }
          await page.goto(`${suite.server.baseUrl}chat`);
          const frame = page.locator(".chat-tool-card__preview-frame");
          const widget = frame.contentFrame().frameLocator("iframe");
          const player = widget.getByLabel("Primetime official trailer");
          await expect
            .poll(() => player.evaluate((element: HTMLVideoElement) => element.readyState))
            .toBeGreaterThanOrEqual(2);
          await expect
            .poll(() =>
              widget
                .locator("body")
                .evaluate((body) =>
                  Math.abs(Math.ceil(body.getBoundingClientRect().height) - innerHeight),
                ),
            )
            .toBe(0);
          if (artifacts) {
            const preview = page.locator(
              '.chat-tool-card__preview[data-content-kind="canvas-html"]',
            );
            const capture = await takeControlUiScreenshotFrame(page, preview, [frame], {
              elements: [preview],
              scrollTo: preview,
              animations: "disabled",
            });
            const name = saved ? "saved" : "new";
            writeFileSync(path.join(artifacts, `${name}.png`), capture.png);
            writeFileSync(path.join(artifacts, `${name}-widget.png`), capture.elements[0]!.png);
          }
          const measurements = await widget.locator("body").evaluate(() => ({
            overflow: document.scrollingElement!.scrollHeight - innerHeight,
            fullscreenEnabled: document.fullscreenEnabled,
          }));
          expect
            .soft(
              measurements.overflow,
              saved ? "saved document overflow" : "new document overflow",
            )
            .toBeLessThanOrEqual(0);
          expect
            .soft(
              measurements.fullscreenEnabled,
              saved ? "saved document fullscreen" : "new document fullscreen",
            )
            .toBe(true);
        }
      },
    );
  });
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
                const steal = () => {
                  const data = window.event?.data;
                  if (data?.type === "openclaw:widget-board-host") window.stolenScrollNonce = data.nonce;
                };
                document.head.prepend = () => { steal(); throw new Error("Authored DOM override"); };
                new MutationObserver(steal).observe(document, { childList: true, subtree: true });
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
