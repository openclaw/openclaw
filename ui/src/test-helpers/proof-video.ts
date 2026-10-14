import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Browser, BrowserContextOptions, Locator } from "playwright";
import {
  type ProofVideoCue,
  type ProofVideoCues,
  validateProofVideoCues,
} from "../../../scripts/lib/proof-video-render.ts";
import { resolveSystemBin } from "../../../src/infra/resolve-system-bin.ts";

type Rect = NonNullable<Awaited<ReturnType<Locator["boundingBox"]>>>;

export async function rasterizeCaptions(browser: Browser, cues: ProofVideoCues, dir: string) {
  validateProofVideoCues(cues);
  const context = await browser.newContext({
    viewport: { width: cues.viewport.width, height: cues.captionHeight },
    deviceScaleFactor: 1,
  });
  try {
    const page = await context.newPage();
    await page.setContent(`<style>
      html,body{margin:0;background:transparent}body{height:100vh;display:flex;
      align-items:center;justify-content:center;font:30px/1.2 system-ui;color:white}
      div{box-sizing:border-box;max-width:calc(100vw - 160px);padding:12px 24px;
      border-radius:16px;background:rgba(12,16,24,.92);text-align:center;white-space:pre-wrap}
      </style><div></div>`);
    for (const cue of cues.cues) {
      if (cue.kind !== "caption") {
        continue;
      }
      await page.locator("div").evaluate((element, text) => {
        element.textContent = text;
      }, cue.text);
      await page.evaluate(() => document.fonts.ready);
      const fits = await page
        .locator("div")
        .evaluate(
          (element) =>
            element.scrollHeight <= innerHeight && element.scrollWidth <= innerWidth - 160,
        );
      if (!fits) {
        throw new Error(`Caption is too long for the card: ${cue.text}`);
      }
      const image = path.join(dir, cue.image);
      await mkdir(path.dirname(image), { recursive: true });
      await page.screenshot({ path: image, omitBackground: true, scale: "css" });
    }
  } finally {
    await context.close();
  }
}

export async function startProofRecording(
  browser: Browser,
  {
    dir,
    viewport = { width: 1280, height: 800 },
    deviceScaleFactor = 2,
    contextOptions,
  }: {
    dir: string;
    viewport?: { width: number; height: number };
    deviceScaleFactor?: number;
    contextOptions?: Omit<BrowserContextOptions, "viewport" | "deviceScaleFactor" | "recordVideo">;
  },
) {
  const ffprobe = resolveSystemBin("ffprobe", { trust: "standard" });
  if (!ffprobe) {
    throw new Error("Install system ffmpeg/ffprobe: brew install ffmpeg or apt install ffmpeg");
  }
  await mkdir(dir, { recursive: true });
  const sidecar: ProofVideoCues = {
    version: 1,
    video: "recording.webm",
    viewport,
    scale: deviceScaleFactor,
    captionHeight: 120,
    cues: [],
  };
  validateProofVideoCues(sidecar);
  const zero = performance.now();
  // Native Chromium device scale comes from its launch flag; emulation pads recordings.
  const context = await browser.newContext({
    ...contextOptions,
    viewport,
    deviceScaleFactor: 1,
    recordVideo: {
      dir,
      size: {
        width: viewport.width * deviceScaleFactor,
        height: viewport.height * deviceScaleFactor,
      },
    },
  });
  let page;
  try {
    page = await context.newPage();
  } catch (error) {
    await context.close();
    throw error;
  }
  const video = page.video()!;
  let finished = false;
  const open = new Map<ProofVideoCue["kind"], ProofVideoCue>();
  const now = () => {
    if (finished) {
      throw new Error("Proof recording is already finished");
    }
    return (performance.now() - zero) / 1000;
  };
  const end = (kind: ProofVideoCue["kind"], time: number) => {
    const cue = open.get(kind);
    if (cue) {
      cue.end = time;
    }
    open.delete(kind);
  };
  const add = (cue: ProofVideoCue) => {
    end(cue.kind, cue.start);
    sidecar.cues.push(cue);
    open.set(cue.kind, cue);
  };
  return {
    page,
    context,
    caption(text: string) {
      const start = now();
      if (!text.trim()) {
        throw new Error("Caption text must not be empty");
      }
      add({
        kind: "caption",
        start,
        end: start,
        text,
        image: `captions/${sidecar.cues.filter((cue) => cue.kind === "caption").length}.png`,
      });
    },
    clearCaption() {
      end("caption", now());
    },
    async zoom(target: Locator | Rect, { factor = 2, padding = 24, ease = 0.5 } = {}) {
      now();
      if (
        ![factor, padding, ease].every(Number.isFinite) ||
        factor < 1 ||
        factor > 10 ||
        padding < 0 ||
        ease < 0
      ) {
        throw new Error("Zoom needs factor 1–10 and nonnegative padding/ease");
      }
      const rect = "boundingBox" in target ? await target.boundingBox() : target;
      if (
        !rect ||
        !Object.values(rect).every(Number.isFinite) ||
        rect.width <= 0 ||
        rect.height <= 0
      ) {
        throw new Error("Zoom target must have a visible, finite rectangle");
      }
      const x = Math.max(0, rect.x - padding),
        y = Math.max(0, rect.y - padding);
      const width = Math.min(viewport.width, rect.x + rect.width + padding) - x;
      const height = Math.min(viewport.height, rect.y + rect.height + padding) - y;
      if (width <= 0 || height <= 0) {
        throw new Error("Zoom target is outside the viewport");
      }
      const start = now();
      add({ kind: "zoom", start, end: start, rect: { x, y, width, height }, factor, ease });
    },
    zoomOut() {
      end("zoom", now());
    },
    speed(factor: number) {
      const start = now();
      if (!Number.isFinite(factor) || factor <= 0) {
        throw new Error("Speed must be positive");
      }
      end("speed", start);
      if (factor !== 1) {
        add({ kind: "speed", start, end: start, factor });
      }
    },
    async finish() {
      now();
      finished = true;
      await context.close();
      const videoPath = await video.path();
      const { stdout } = await promisify(execFile)(ffprobe, [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        videoPath,
      ]);
      const duration = Number(stdout.trim());
      if (!Number.isFinite(duration) || duration <= 0) {
        throw new Error("Recording has no video duration");
      }
      for (const kind of open.keys()) {
        end(kind, duration);
      }
      sidecar.video = path.basename(videoPath);
      validateProofVideoCues(sidecar);
      await rasterizeCaptions(browser, sidecar, dir);
      const cuesPath = path.join(dir, "cues.json");
      await writeFile(cuesPath, `${JSON.stringify(sidecar, null, 2)}\n`, { flag: "wx" });
      return { dir, videoPath, cuesPath };
    },
  };
}
