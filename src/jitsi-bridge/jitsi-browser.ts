import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { chromium, type Browser, type Page } from "playwright-core";
import { REALTIME_AUDIO_SAMPLE_RATE } from "./audio.js";

const execFileAsync = promisify(execFile);

async function resolveChromiumExecutable(explicit?: string): Promise<string> {
  if (explicit?.trim()) {
    return explicit.trim();
  }
  for (const candidate of [
    "chromium",
    "chromium-browser",
    "google-chrome",
    "google-chrome-stable",
  ]) {
    try {
      const { stdout } = await execFileAsync("which", [candidate]);
      const resolved = stdout.trim();
      if (resolved) {
        return resolved;
      }
    } catch {
      // Try the next candidate.
    }
  }
  const browserRoots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(os.homedir(), ".cache", "ms-playwright"),
  ].filter((value): value is string => Boolean(value?.trim()));
  for (const browserRoot of browserRoots) {
    for (const relativePath of [
      "chrome-linux64/chrome",
      "chrome-linux/chrome",
      "chrome-headless-shell-linux64/chrome-headless-shell",
    ]) {
      try {
        const entries = await fs.readdir(browserRoot, { withFileTypes: true });
        const matches = entries
          .filter((entry) => entry.isDirectory() && entry.name.startsWith("chromium"))
          .map((entry) => path.join(browserRoot, entry.name, relativePath));
        for (const candidate of matches.toSorted().toReversed()) {
          await fs.access(candidate);
          return candidate;
        }
      } catch {
        // Try the next root or layout.
      }
    }
  }
  throw new Error(
    "No Chromium executable found. Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to a local Chromium/Chrome binary.",
  );
}

async function waitForJoin(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(1_200);

  const joinPhrases = ["join meeting", "meeting beitreten", "beitreten"];
  const joinSelectors = [
    'button[data-testid="prejoin.joinMeeting"]',
    'button:has-text("Join meeting")',
    'button:has-text("Meeting beitreten")',
    'button:has-text("Beitreten")',
    '[role="button"]:has-text("Join meeting")',
    '[role="button"]:has-text("Beitreten")',
  ];

  const isOnPrejoin = async () =>
    await page.evaluate((phrases) => {
      const text = document.body?.innerText?.toLowerCase() || "";
      return phrases.some((phrase) => text.includes(phrase));
    }, joinPhrases);

  const tryClickJoinButton = async (): Promise<boolean> => {
    const frames = page.frames();
    for (const frame of frames) {
      for (const selector of joinSelectors) {
        const button = frame.locator(selector).first();
        const count = await button.count().catch(() => 0);
        if (count === 0) {
          continue;
        }
        const visible = await button.isVisible().catch(() => false);
        if (!visible) {
          continue;
        }
        const clicked =
          (await button
            .click({ force: true, timeout: 2_500 })
            .then(() => true)
            .catch(() => false)) ||
          (await button
            .evaluate((el) => {
              if (el instanceof HTMLElement) {
                el.click();
                return true;
              }
              return false;
            })
            .catch(() => false));
        if (clicked) {
          return true;
        }
      }
    }
    return false;
  };

  if (!(await isOnPrejoin())) {
    await page.waitForTimeout(2_000);
    return;
  }

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const clicked = await tryClickJoinButton();

    if (!clicked) {
      await page.keyboard.press("Enter").catch(() => {});
      await page.mouse.click(200, 400).catch(() => {});
    }

    await page.waitForTimeout(1_500);
    if (!(await isOnPrejoin())) {
      await page.waitForTimeout(2_000);
      return;
    }
  }

  throw new Error("Failed to join Jitsi room: still on prejoin screen after multiple attempts.");
}

async function ensureMicrophoneUnmuted(page: Page): Promise<void> {
  const unmuteSelectors = [
    'button[data-testid="toolbox.microphoneUnmute"]',
    '[aria-label*="unmute" i]',
    '[aria-label*="stummschaltung aufheben" i]',
    '[aria-label*="mikrofon aktivieren" i]',
  ];

  for (let attempt = 0; attempt < 5; attempt += 1) {
    for (const selector of unmuteSelectors) {
      const button = page.locator(selector).first();
      const count = await button.count().catch(() => 0);
      if (count === 0) {
        continue;
      }
      const visible = await button.isVisible().catch(() => false);
      if (!visible) {
        continue;
      }
      const clicked = await button
        .click({ force: true, timeout: 1500 })
        .then(() => true)
        .catch(() => false);
      if (clicked) {
        return;
      }
    }
    await page.keyboard.press("M").catch(() => {});
    await page.waitForTimeout(600);
  }
}

const INJECTED_BRIDGE_SCRIPT = `
(() => {
  const OriginalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  const trackedElements = new WeakSet();
  let audioContext = null;
  let captureGain = null;
  let micDestination = null;
  let processor = null;
  let monitorGain = null;
  let playbackCursor = 0;
  const activeSources = new Set();

  function pcm16BytesToBase64(bytes) {
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
  }

  function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  async function ensureAudioBridge() {
    if (!audioContext) {
      audioContext = new AudioContext({ sampleRate: ${REALTIME_AUDIO_SAMPLE_RATE} });
      captureGain = audioContext.createGain();
      captureGain.gain.value = 1;
      micDestination = audioContext.createMediaStreamDestination();
      processor = audioContext.createScriptProcessor(4096, 1, 1);
      monitorGain = audioContext.createGain();
      monitorGain.gain.value = 0;
      captureGain.connect(processor);
      processor.connect(monitorGain);
      monitorGain.connect(audioContext.destination);
      processor.onaudioprocess = (event) => {
        const channel = event.inputBuffer.getChannelData(0);
        const bytes = new Uint8Array(channel.length * 2);
        const view = new DataView(bytes.buffer);
        for (let i = 0; i < channel.length; i += 1) {
          const sample = Math.max(-1, Math.min(1, channel[i]));
          view.setInt16(i * 2, Math.round(sample * 32767), true);
        }
        const base64 = pcm16BytesToBase64(bytes);
        if (base64 && typeof window.__openclawPushCapturedAudio === "function") {
          void window.__openclawPushCapturedAudio(base64, audioContext.sampleRate);
        }
      };
    }
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }
    return { audioContext, captureGain, micDestination };
  }

  async function attachRemoteMediaElements() {
    const bridge = await ensureAudioBridge();
    for (const element of document.querySelectorAll("audio,video")) {
      if (trackedElements.has(element)) {
        continue;
      }
      const stream = element.srcObject;
      if (!(stream instanceof MediaStream) || stream.getAudioTracks().length === 0) {
        continue;
      }
      try {
        const source = bridge.audioContext.createMediaStreamSource(stream);
        source.connect(bridge.captureGain);
        trackedElements.add(element);
      } catch (_error) {
        // Ignore elements that cannot be captured.
      }
    }
  }

  async function playPcm16Base64(base64, sampleRate = ${REALTIME_AUDIO_SAMPLE_RATE}) {
    const bridge = await ensureAudioBridge();
    const bytes = base64ToBytes(base64);
    const sampleCount = Math.floor(bytes.length / 2);
    if (sampleCount === 0) {
      return;
    }
    const audioBuffer = bridge.audioContext.createBuffer(1, sampleCount, sampleRate);
    const channel = audioBuffer.getChannelData(0);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < sampleCount; i += 1) {
      channel[i] = view.getInt16(i * 2, true) / 32768;
    }
    const source = bridge.audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(bridge.micDestination);
    activeSources.add(source);
    source.onended = () => activeSources.delete(source);
    const startAt = Math.max(bridge.audioContext.currentTime + 0.02, playbackCursor);
    source.start(startAt);
    playbackCursor = startAt + audioBuffer.duration;
  }

  function clearPlayback() {
    playbackCursor = audioContext ? audioContext.currentTime : 0;
    for (const source of Array.from(activeSources)) {
      try {
        source.stop();
      } catch (_error) {
        // Ignore already-finished sources.
      }
      activeSources.delete(source);
    }
  }

  window.__openclawJitsiBridge = {
    attachRemoteMediaElements,
    playPcm16Base64,
    clearPlayback,
  };

  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const bridge = await ensureAudioBridge();
    const tracks = [...bridge.micDestination.stream.getAudioTracks()];
    if (constraints && typeof constraints === "object" && constraints.video) {
      try {
        const videoStream = await OriginalGetUserMedia({ ...constraints, audio: false });
        tracks.push(...videoStream.getVideoTracks());
      } catch (_error) {
        // Ignore camera acquisition failures for the bot path.
      }
    }
    return new MediaStream(tracks);
  };

  const intervalId = window.setInterval(() => {
    void attachRemoteMediaElements();
  }, 1000);
  window.addEventListener("beforeunload", () => window.clearInterval(intervalId), { once: true });
})();
`;

export async function joinJitsiRoom(params: {
  roomUrl: string;
  displayName: string;
  headless: boolean;
  stateDir: string;
  executablePath?: string;
  onCapturedAudioChunk?: (audioBase64: string, sampleRate: number) => Promise<void>;
  onPageReady?: (page: Page) => Promise<void>;
}): Promise<void> {
  const executablePath = await resolveChromiumExecutable(params.executablePath);
  const browser: Browser = await chromium.launch({
    executablePath,
    headless: params.headless,
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--disable-dev-shm-usage",
      "--disable-infobars",
      "--disable-features=DialMediaRouteProvider",
    ],
  });

  try {
    const page = await browser.newPage({
      permissions: ["camera", "microphone"],
    });
    if (params.onCapturedAudioChunk) {
      await page.exposeFunction("__openclawPushCapturedAudio", params.onCapturedAudioChunk);
    }
    await page.addInitScript(INJECTED_BRIDGE_SCRIPT);
    await page.goto(params.roomUrl, { waitUntil: "domcontentloaded" });
    await waitForJoin(page);
    await ensureMicrophoneUnmuted(page);
    await page.evaluate(() => {
      void (
        window as unknown as {
          __openclawJitsiBridge?: { attachRemoteMediaElements?: () => Promise<void> };
        }
      ).__openclawJitsiBridge?.attachRemoteMediaElements?.();
    });
    await params.onPageReady?.(page);
    await fs.mkdir(params.stateDir, { recursive: true });
    const screenshotPath = path.join(params.stateDir, `${Date.now()}-jitsi-joined.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await new Promise<void>(() => {
      // Keep the bot in the room until the process is terminated.
    });
  } finally {
    await browser.close();
  }
}

export async function pushPcm16AudioToPage(page: Page, audioBase64: string): Promise<void> {
  await page.evaluate((payload) => {
    void (
      window as unknown as {
        __openclawJitsiBridge?: { playPcm16Base64?: (audio: string) => Promise<void> };
      }
    ).__openclawJitsiBridge?.playPcm16Base64?.(payload);
  }, audioBase64);
}

export async function clearPagePlayback(page: Page): Promise<void> {
  await page.evaluate(() => {
    (
      window as unknown as { __openclawJitsiBridge?: { clearPlayback?: () => void } }
    ).__openclawJitsiBridge?.clearPlayback?.();
  });
}
