// Control UI E2E tests cover browser Talk start and stop through a real page.
import { chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

let server: ControlUiE2eServer;

async function installTalkBrowserFixtures(page: Page) {
  await page.addInitScript(() => {
    type InputProcessor = {
      onaudioprocess:
        | ((event: { inputBuffer: { getChannelData: () => Float32Array } }) => void)
        | null;
    };
    const state = {
      audioContextsClosed: 0,
      tracksStopped: 0,
      constraints: [] as unknown[],
      inputProcessor: null as InputProcessor | null,
      meterLevel: 0,
    };
    const track = { stop: () => (state.tracksStopped += 1) };
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        enumerateDevices: async () => [
          { kind: "audioinput", deviceId: "built-in", label: "Built-in Microphone" },
          { kind: "audioinput", deviceId: "usb", label: "USB Audio Interface" },
          { kind: "videoinput", deviceId: "camera", label: "Camera" },
        ],
        getUserMedia: async (constraints: unknown) => {
          state.constraints.push(constraints);
          return { getTracks: () => [track] };
        },
      },
    });

    class MockAudioContext {
      readonly currentTime = 0;
      readonly destination = {};
      readonly sampleRate: number;

      constructor(options?: { sampleRate?: number }) {
        this.sampleRate = options?.sampleRate ?? 24_000;
      }

      createMediaStreamSource() {
        return { connect() {}, disconnect() {} };
      }

      createScriptProcessor() {
        const processor = { connect() {}, disconnect() {}, onaudioprocess: null };
        state.inputProcessor = processor;
        return processor;
      }

      createAnalyser() {
        return {
          fftSize: 0,
          smoothingTimeConstant: 0,
          disconnect() {},
          getFloatTimeDomainData(samples: Float32Array) {
            samples.fill(state.meterLevel);
          },
        };
      }

      async close() {
        state.audioContextsClosed += 1;
      }
    }

    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: MockAudioContext,
    });
    Object.defineProperty(window, "openclawTalkE2eState", {
      configurable: true,
      value: state,
    });
  });
}

async function installBlockedMicrophoneFixture(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        enumerateDevices: async () => [],
        getUserMedia: async () => {
          throw new DOMException("Permission denied", "NotAllowedError");
        },
      },
    });
  });
}

describeControlUiE2e("Control UI browser Talk", () => {
  beforeAll(async () => {
    server = await startControlUiE2eServer();
  });

  afterAll(async () => {
    await server?.close();
  });

  it("starts a provider WebSocket session and stops browser audio resources", async () => {
    const browser = await chromium.launch({ executablePath: chromiumExecutablePath });
    const context = await browser.newContext({ permissions: ["microphone"] });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "talk.client.create": {
          provider: "google",
          transport: "provider-websocket",
          protocol: "google-live-bidi",
          clientSecret: "auth_tokens/browser-talk-e2e",
          websocketUrl:
            "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained",
          audio: {
            inputEncoding: "pcm16",
            inputSampleRateHz: 16_000,
            outputEncoding: "pcm16",
            outputSampleRateHz: 24_000,
          },
        },
      },
    });
    await installTalkBrowserFixtures(page);

    try {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(`${server.baseUrl}chat`);
      await page.setViewportSize({ width: 320, height: 720 });
      await expect
        .poll(() => page.getByRole("button", { name: "Microphone input" }).count())
        .toBe(0);
      const settings = page.getByRole("button", { name: "Chat settings" });
      await settings.click();
      const settingsDialog = page.getByRole("dialog", { name: "Chat settings" });
      const microphoneSelect = settingsDialog.locator('[data-talk-select="microphone"] select');
      await expect
        .poll(async () =>
          (await microphoneSelect.locator("option").allTextContents()).map((label) => label.trim()),
        )
        .toEqual(["System default", "Built-in Microphone", "USB Audio Interface"]);
      await microphoneSelect.selectOption("usb");
      await settings.click();
      await expect.poll(() => settingsDialog.isVisible()).toBe(false);
      await page.getByRole("button", { name: "Start voice input" }).click();

      const createRequest = await gateway.waitForRequest("talk.client.create");
      expect(createRequest.params).toMatchObject({ sessionKey: "main" });
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (
                window as Window & {
                  openclawTalkE2eState?: { constraints: unknown[] };
                }
              ).openclawTalkE2eState?.constraints,
          ),
        )
        .toEqual([{ audio: { deviceId: { exact: "usb" } } }]);
      await expect
        .poll(async () =>
          (await gateway.getSocketUrls()).filter((url) => url.includes("BidiGenerateContent")),
        )
        .toEqual([
          "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=auth_tokens%2Fbrowser-talk-e2e",
        ]);

      await expect
        .poll(() => page.locator('.agent-chat__voice-activity[data-status="connecting"]').count())
        .toBe(1);
      await expect
        .poll(() =>
          page
            .locator(".agent-chat__voice-activity-bar")
            .first()
            .evaluate((element) => {
              return getComputedStyle(element).animationName;
            }),
        )
        .toBe("none");
      const connectingReducedMotionTransform = await page
        .locator(".agent-chat__voice-activity-bar")
        .first()
        .evaluate((element) => getComputedStyle(element).transform);

      await gateway.deliverLatest({ setupComplete: {} });
      await expect
        .poll(() => page.locator('.agent-chat__voice-activity[data-status="listening"]').count())
        .toBe(1);
      await expect.poll(() => page.locator(".agent-chat__talk-status-text").count()).toBe(0);
      await expect
        .poll(() => page.locator('[role="status"] .agent-chat__sr-only').textContent())
        .toBe("Listening...");
      const reducedMotionTransform = await page
        .locator(".agent-chat__voice-activity-bar")
        .first()
        .evaluate((element) => getComputedStyle(element).transform);
      expect(reducedMotionTransform).not.toBe(connectingReducedMotionTransform);

      await page.evaluate(() => {
        const state = (
          window as Window & {
            openclawTalkE2eState?: {
              inputProcessor?: {
                onaudioprocess?: (event: {
                  inputBuffer: { getChannelData: () => Float32Array };
                }) => void;
              };
              meterLevel?: number;
            };
          }
        ).openclawTalkE2eState;
        if (state) {
          state.meterLevel = 0.25;
        }
        state?.inputProcessor?.onaudioprocess?.({
          inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.25) },
        });
      });
      await expect
        .poll(async () =>
          Number(await page.locator(".agent-chat__voice-activity").getAttribute("data-level")),
        )
        .toBeGreaterThan(0);
      await expect
        .poll(() =>
          page
            .locator(".agent-chat__voice-activity-bar")
            .first()
            .evaluate((element) => getComputedStyle(element).transform),
        )
        .toBe(reducedMotionTransform);

      await page.getByRole("button", { name: "Stop voice input" }).click();
      await expect
        .poll(() => page.getByRole("button", { name: "Start voice input" }).isVisible())
        .toBe(true);
      await expect.poll(() => page.locator(".agent-chat__voice-activity").count()).toBe(0);
      await expect
        .poll(() =>
          page.evaluate(() => {
            const state = (
              window as Window & {
                openclawTalkE2eState?: { audioContextsClosed: number; tracksStopped: number };
              }
            ).openclawTalkE2eState;
            return state
              ? {
                  audioContextsClosed: state.audioContextsClosed,
                  tracksStopped: state.tracksStopped,
                }
              : null;
          }),
        )
        .toEqual({ audioContextsClosed: 2, tracksStopped: 1 });

      await gateway.deliverLatest({ setupComplete: {} });
      await expect
        .poll(() => page.getByRole("button", { name: "Start voice input" }).isVisible())
        .toBe(true);
    } finally {
      await context.close();
      await browser.close();
    }
  });

  it("renders streamed relay assistant transcript deltas as readable text", async () => {
    const browser = await chromium.launch({ executablePath: chromiumExecutablePath });
    const context = await browser.newContext({ permissions: ["microphone"] });
    const page = await context.newPage();
    const relaySessionId = "relay-e2e-transcript";
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "talk.client.create": {
          provider: "openai",
          transport: "gateway-relay",
          relaySessionId,
          audio: {
            inputEncoding: "pcm16",
            inputSampleRateHz: 16_000,
            outputEncoding: "pcm16",
            outputSampleRateHz: 24_000,
          },
        },
        "talk.session.appendAudio": {},
        "talk.session.close": {},
      },
    });
    await installTalkBrowserFixtures(page);

    try {
      await page.goto(`${server.baseUrl}chat`);
      await page.setViewportSize({ width: 1366, height: 900 });
      await page.getByRole("button", { name: "Start voice input" }).click();
      await gateway.waitForRequest("talk.client.create");
      await gateway.emitGatewayEvent("talk.event", { relaySessionId, type: "ready" });
      await gateway.emitGatewayEvent("talk.event", {
        relaySessionId,
        type: "transcript",
        role: "user",
        text: "Hey, what model are you using?",
        final: true,
      });
      // Assistant audio transcripts stream as verbatim fragments that can split
      // words ("I","'m"," Chat","G","PT"); regression coverage for #102556 where
      // the merge injected spaces mid-word and the turn collapsed while streaming.
      const assistantText =
        "I'm ChatGPT, a conversational AI model designed to help answer questions, brainstorm ideas, and chat about pretty much anything you want to talk about today.";
      for (const char of assistantText) {
        await gateway.emitGatewayEvent("talk.event", {
          relaySessionId,
          type: "transcript",
          role: "assistant",
          text: char,
          final: false,
        });
      }

      const assistantTurnText = page.locator(
        ".agent-chat__voice-turn--assistant .agent-chat__voice-turn-text",
      );
      await expect.poll(() => assistantTurnText.textContent()).toBe(assistantText);

      const turnBounds = await page.locator(".agent-chat__voice-turn--assistant").boundingBox();
      expect(turnBounds).not.toBeNull();
      // A collapsed turn renders one character per line (tall, sliver-wide box).
      expect(turnBounds?.width ?? 0).toBeGreaterThanOrEqual(500);
      expect(turnBounds?.height ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(120);
    } finally {
      await context.close();
      await browser.close();
    }
  });

  it("keeps blocked microphone guidance readable in a narrow viewport", async () => {
    const browser = await chromium.launch({ executablePath: chromiumExecutablePath });
    const context = await browser.newContext();
    const page = await context.newPage();
    await installMockGateway(page);
    await installBlockedMicrophoneFixture(page);

    try {
      await page.setViewportSize({ width: 320, height: 720 });
      await page.goto(`${server.baseUrl}chat`);
      await page.getByRole("button", { name: "Chat settings" }).click();

      const settingsDialog = page.getByRole("dialog", { name: "Chat settings" });
      await settingsDialog.getByRole("button", { name: "Refresh: Microphone input" }).click();
      const permissionAlert = settingsDialog.getByRole("alert");
      await expect.poll(() => permissionAlert.isVisible()).toBe(true);

      const [settingsBounds, alertBounds] = await Promise.all([
        settingsDialog.boundingBox(),
        permissionAlert.boundingBox(),
      ]);
      expect(settingsBounds).not.toBeNull();
      expect(alertBounds).not.toBeNull();
      expect(settingsBounds?.width ?? 0).toBeGreaterThanOrEqual(280);
      expect(settingsBounds?.x ?? 0).toBeGreaterThanOrEqual(8);
      expect((settingsBounds?.x ?? 0) + (settingsBounds?.width ?? 0)).toBeLessThanOrEqual(312);
      expect(alertBounds?.x ?? 0).toBeGreaterThanOrEqual(settingsBounds?.x ?? 0);
      expect((alertBounds?.x ?? 0) + (alertBounds?.width ?? 0)).toBeLessThanOrEqual(
        (settingsBounds?.x ?? 0) + (settingsBounds?.width ?? 0),
      );
      expect(alertBounds?.y ?? 0).toBeGreaterThanOrEqual(settingsBounds?.y ?? 0);
      expect((alertBounds?.y ?? 0) + (alertBounds?.height ?? 0)).toBeLessThanOrEqual(
        (settingsBounds?.y ?? 0) + (settingsBounds?.height ?? 0),
      );
      await expect
        .poll(() => permissionAlert.textContent())
        .toContain("Microphone access is blocked.");
    } finally {
      await context.close();
      await browser.close();
    }
  });
});
