import { readFileSync } from "node:fs";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { buildWidgetDocument } from "../../../src/canvas/wrap.js";
import type { SessionSnapshotStore } from "../pages/chat/session-snapshot-store.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { useCanvasSandboxFixture } from "./canvas-sandbox.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI chat widget autosizing",
  startServerBeforeBrowser: true,
});

const documentId = "widget-autosize-proof";
const tallContentHeight = 2520; // Exceeds every viewport, forcing reported-height sizing.
const scrollTop = (target: Locator) => target.evaluate((element) => element.scrollTop);
const widgetFrame = (page: Page) => page.locator(".chat-tool-card__preview-frame");
const innerWidget = (page: Page) => widgetFrame(page).contentFrame().frameLocator("iframe");
const readyMedia = (player: Locator) =>
  expect
    .poll(() => player.evaluate((element: HTMLVideoElement) => element.readyState))
    .toBeGreaterThanOrEqual(2);
const assistant = (content: unknown, timestamp: number) => ({
  role: "assistant",
  content,
  timestamp,
});
const embed = (title: string) => [
  { type: "text", text: `[embed ref="${documentId}" title="${title}" /]` },
];

const video = readFileSync(new URL("./fixtures/video-poster.mp4", import.meta.url)).toString(
  "base64",
);
const trailer = `<div id="primetime-trailer"><video aria-label="Primetime official trailer" controls playsinline preload="auto" style="display:block;width:100%;aspect-ratio:16/9;background:#000;border-radius:12px"><source src="data:video/mp4;base64,${video}" type="video/mp4"></video><p id="trailer-status" style="font:13px var(--font-body);color:var(--muted)">Press play. <a href="https://www.youtube.com/watch?v=synthetic" target="_blank" rel="noopener noreferrer">Watch on YouTube</a></p></div>`;
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
        '<main style="height:700px">All data in this preview is synthetic.</main>',
      );
      const gateway = await installMockGateway(page, {
        sessionKey,
        authMethod: "trusted-proxy",
        authMode: "trusted-proxy",
        heldMethods: ["connect", "canvas.document.view"],
        methodResponses: { "canvas.document.view": canvasView(html) },
        historyMessages: [
          ...Array.from({ length: 12 }, (_, index) => ({
            role: index % 2 ? "assistant" : "user",
            content: `Synthetic context ${index}: ${"Dashboard detail. ".repeat(20)}`,
            timestamp: 1_800_000_000_000 + index * 1000,
            __openclaw: { id: `widget-context-${index}`, seq: index + 1 },
          })),
          {
            ...assistant(embed("Synthetic dashboard preview"), 1_800_000_012_000),
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
      await gateway.waitForRequest("connect");
      await gateway.resolveDeferred("connect");
      await gateway.waitForRequest("canvas.document.view");
      await gateway.resolveDeferred("canvas.document.view");
      const ready = innerWidget(page).getByText("All data in this preview is synthetic.");
      await ready.waitFor();
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
        const pane = element as HTMLElement & {
          sessionSnapshotStore?: SessionSnapshotStore;
        };
        if (!pane.sessionSnapshotStore) {
          throw new Error("Missing measured widget snapshot");
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
      await gateway.waitForRequest("connect");
      await preview.waitFor();
      await gateway.resolveDeferred("connect");
      await gateway.waitForRequest("canvas.document.view");
      await page.waitForFunction(
        () => {
          const frames = window.widgetReloadFrames ?? [];
          const sample = frames.at(-1);
          return (
            frames.length >= 20 && sample && sample.scrollTop > 0 && Math.abs(sample.endGap) <= 1
          );
        },
        undefined,
        { polling: "raf" },
      );
      const loadedStart = await page.evaluate(() => window.widgetReloadFrames!.length - 1);
      await gateway.resolveDeferred("canvas.document.view");
      await ready.waitFor();
      const samples = await page.evaluate(async () => {
        for (let index = 0; index < 20; index += 1) {
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          });
        }
        window.widgetReloadRecording = false;
        return window.widgetReloadFrames ?? [];
      });
      expect(samples.length).toBeGreaterThanOrEqual(40);
      for (const sample of samples) {
        expect(Math.abs(sample.previewHeight - learnedHeight)).toBeLessThanOrEqual(1);
      }
      const anchored = samples[loadedStart]!;
      for (const sample of samples.slice(loadedStart)) {
        expect(Math.abs(sample.endGap)).toBeLessThanOrEqual(1);
        expect(Math.abs(sample.scrollTop - anchored.scrollTop)).toBeLessThanOrEqual(1);
        expect(Math.abs(sample.anchorTop - anchored.anchorTop)).toBeLessThanOrEqual(1);
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
          historyMessages: [assistant(embed("Primetime trailer"), 100)],
        });
        for (const saved of [false, true]) {
          if (saved) {
            await gateway.setMethodResponse("canvas.document.view", canvasView(legacyTrailer));
          }
          await page.goto(`${suite.server.baseUrl}chat`);
          const widget = innerWidget(page);
          const player = widget.getByLabel("Primetime official trailer");
          await readyMedia(player);
          await expect
            .poll(() =>
              widget
                .locator("body")
                .evaluate((body) =>
                  Math.abs(Math.ceil(body.getBoundingClientRect().height) - innerHeight),
                ),
            )
            .toBe(0);
          const measurements = await widget.locator("body").evaluate(() => ({
            overflow: document.scrollingElement!.scrollHeight - innerHeight,
            fullscreenEnabled: document.fullscreenEnabled,
          }));
          const label = saved ? "saved document" : "new document";
          expect.soft(measurements.overflow, `${label} overflow`).toBeLessThanOrEqual(0);
          expect.soft(measurements.fullscreenEnabled, `${label} fullscreen`).toBe(true);
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
              </script><div style="height:${tallContentHeight / 2}px"></div>
                      <video aria-label="Synthetic video" controls loop playsinline preload="auto"
                        style="display:block;width:320px;height:180px"
                        src="data:video/mp4;base64,${video}"></video>
                      <div aria-label="Scrollable widget details" style="height:160px;overflow-y:auto">
                        <div style="height:640px">Nested details remain independently scrollable</div>
                      </div>
                      <div aria-label="Wheel-controlled widget" style="height:80px">Wheel changes this control</div>
              <div style="height:${tallContentHeight / 2}px"></div><script>
                document.querySelector('[aria-label="Wheel-controlled widget"]').addEventListener('wheel', event => {
                  event.preventDefault();
                  event.currentTarget.textContent = 'Wheel handled';
                }, {passive:false});
              </script>`,
            ),
          ),
        },
        historyMessages: [assistant(embed("Autosize proof"), 100)],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      const frame = widgetFrame(page);
      await frame.waitFor();
      await expect
        .poll(async () => Math.round((await frame.boundingBox())?.height ?? 0))
        .toBeGreaterThanOrEqual(tallContentHeight);
      const widget = innerWidget(page);
      const overflow = await widget
        .locator("body")
        .evaluate((body) => body.scrollHeight - innerHeight);
      expect(overflow).toBeLessThanOrEqual(0);

      const player = widget.getByLabel("Synthetic video");
      const thread = page.locator(".chat-thread");
      await readyMedia(player);
      // Media readiness does not mean the trusted bridge has received host state.
      // This deferred style is inserted only after receipt, without exposing its nonce.
      await expect
        .poll(() =>
          widget
            .locator("head style")
            .evaluateAll((styles) =>
              styles.some((style) => style.textContent === ":where(body){display:flow-root}"),
            ),
        )
        .toBe(true);
      await player.hover();
      await thread.evaluate((element) => {
        Reflect.set(window, "widgetScrollInputs", 0);
        element.addEventListener("wheel", () => {
          Reflect.set(window, "widgetScrollInputs", Reflect.get(window, "widgetScrollInputs") + 1);
        });
      });
      const beforeDown = await scrollTop(thread);
      await page.mouse.wheel(0, 100);
      await expect.poll(() => scrollTop(thread)).toBeGreaterThan(beforeDown);
      await expect
        .poll(() => page.evaluate(() => Reflect.get(window, "widgetScrollInputs")))
        .toBe(1);
      expect(await player.evaluate(() => Boolean(Reflect.get(window, "stolenScrollNonce")))).toBe(
        false,
      );
      await player.hover();
      const beforeUp = await scrollTop(thread);
      await page.mouse.wheel(0, -100);
      await expect.poll(() => scrollTop(thread)).toBeLessThan(beforeUp);

      // Playback uses the browser's own focused video controls after scrolling.
      for (const paused of [false, true]) {
        await player.press("Space");
        await expect
          .poll(() => player.evaluate((element: HTMLVideoElement) => element.paused))
          .toBe(paused);
      }

      const details = widget.getByLabel("Scrollable widget details");
      await details.hover();
      const beforeNested = await scrollTop(thread);
      await page.mouse.wheel(0, 100);
      await expect.poll(() => scrollTop(details)).toBeGreaterThan(0);
      expect(await scrollTop(thread)).toBe(beforeNested);
      await details.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await page.mouse.wheel(0, 100);
      await expect.poll(() => scrollTop(thread)).toBeGreaterThan(beforeNested);

      const control = widget.getByLabel("Wheel-controlled widget");
      await control.hover();
      const beforeControl = await scrollTop(thread);
      await page.mouse.wheel(0, 100);
      await expect.poll(() => control.textContent()).toBe("Wheel handled");
      expect(await scrollTop(thread)).toBe(beforeControl);
    });
  });
});
