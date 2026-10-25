import type { Page } from "playwright";
import { expect, it } from "vitest";
import { finishElementAnimations } from "../test-helpers/animations.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  captureComposerProof,
  captureMicrophoneLossProof,
  captureVideoTalkProof,
  installBlockedMicrophoneFixture,
  installOpenAiTalkFixture,
  installTalkBrowserFixtures,
  installVideoTalkMediaFixture,
  TALK_READY_HISTORY_MESSAGE,
  videoTalkCatalog,
  waitForTalkReady,
} from "./browser-talk-start-stop.fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI browser Talk",
  browserLaunchOptions: {
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  },
});

const audio = {
  inputEncoding: "pcm16",
  inputSampleRateHz: 16_000,
  outputEncoding: "pcm16",
  outputSampleRateHz: 24_000,
};
const googleSession = (voiceSessionId: string, token = "browser-talk-e2e") => ({
  provider: "google",
  voiceSessionId,
  transport: "provider-websocket",
  protocol: "google-live-bidi",
  clientSecret: ["auth_tokens", token].join("/"),
  websocketUrl:
    "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained",
  audio,
});
const relaySession = (relaySessionId: string) => ({
  provider: "openai",
  transport: "gateway-relay",
  relaySessionId,
  audio,
});
function installTalkGateway(
  page: Page,
  clientSession: unknown,
  options: NonNullable<Parameters<typeof installMockGateway>[1]> = {},
) {
  return installMockGateway(page, {
    historyMessages: [TALK_READY_HISTORY_MESSAGE],
    ...options,
    methodResponses: { "talk.client.create": clientSession, ...options.methodResponses },
  });
}
type TalkWindow = Window & {
  openclawTalkE2eState?: {
    meterLevel: number;
    constraints: unknown[];
    tracksStopped: number;
    inputProcessor?: {
      onaudioprocess?: (event: { inputBuffer: { getChannelData: () => Float32Array } }) => void;
    };
  };
  openclawVideoTalkE2e?: {
    dataChannelCreated: boolean;
    peer: { channel: EventTarget };
  };
  openclawVideoTalkTracks?: MediaStreamTrack[];
};
const inputReady = (page: Page) =>
  page.evaluate(() => (window as TalkWindow).openclawTalkE2eState?.inputProcessor != null);
async function feedAudio(page: Page, level = 0.25, frames = 1) {
  await page.evaluate(
    ({ level: sampleLevel, frames: frameCount }) => {
      const state = (window as TalkWindow).openclawTalkE2eState;
      if (state) {
        state.meterLevel = sampleLevel;
        for (let index = 0; index < frameCount; index += 1) {
          state.inputProcessor?.onaudioprocess?.({
            inputBuffer: { getChannelData: () => new Float32Array(4096).fill(sampleLevel) },
          });
        }
      }
    },
    { level, frames },
  );
}
const trackStates = (page: Page) =>
  page.evaluate(
    () => (window as TalkWindow).openclawVideoTalkTracks?.map((track) => track.readyState) ?? [],
  );
async function expectTalkRequests(gateway: Awaited<ReturnType<typeof installMockGateway>>) {
  expect(
    (await gateway.getRequests())
      .filter((entry) => entry.method.startsWith("talk."))
      .map((entry) => entry.method),
  ).toEqual(["talk.catalog", "talk.config", "talk.config", "talk.catalog", "talk.client.create"]);
}
async function startCamera(page: Page) {
  const button = page.getByRole("button", { name: "Turn camera on" });
  await expect.poll(() => button.isEnabled()).toBe(true);
  await button.click();
  const preview = page.locator('video[aria-label="Camera preview"]');
  await expect.poll(() => preview.isVisible()).toBe(true);
  await expect
    .poll(() => preview.evaluate((video) => (video as HTMLVideoElement).videoWidth))
    .toBeGreaterThan(0);
  return preview;
}
async function openTalk(page: Page, width = 1366, height = 900) {
  await page.setViewportSize({ width, height });
  await page.goto(`${suite.server.baseUrl}chat`);
  await waitForTalkReady(page);
}

suite.define(() => {
  it("keeps reduced-motion voice activity readable in a narrow viewport", async () => {
    await suite.withPage({ permissions: ["microphone"] }, async ({ page }) => {
      const gateway = await installTalkGateway(page, googleSession("voice-browser-talk-e2e"));
      await installTalkBrowserFixtures(page);

      await page.emulateMedia({ reducedMotion: "reduce" });
      const tapToTalk = page.getByRole("button", { name: "Tap to talk" });
      const activity = page.locator(".agent-chat__voice-activity");
      const firstBar = page.locator(".agent-chat__voice-activity-bar").first();
      const barTransform = () =>
        firstBar.evaluate((element) => getComputedStyle(element).transform);
      await openTalk(page, 320, 720);
      await tapToTalk.click();

      await expect
        .poll(() => page.locator('.agent-chat__voice-activity[data-status="connecting"]').count())
        .toBe(1);
      await expect
        .poll(() =>
          page.locator('button[aria-label="Stop voice input"] .agent-chat__voice-activity').count(),
        )
        .toBe(1);
      const pillBox = await page.getByRole("button", { name: "Stop voice input" }).boundingBox();
      expect(pillBox?.width ?? 0).toBeGreaterThanOrEqual(60);
      await expect
        .poll(() => firstBar.evaluate((element) => getComputedStyle(element).animationName))
        .toBe("none");
      const connectingReducedMotionTransform = await barTransform();

      await gateway.deliverLatest({ setupComplete: {} });
      await expect
        .poll(() => page.locator('.agent-chat__voice-activity[data-status="listening"]').count())
        .toBe(1);
      const reducedMotionTransform = await barTransform();
      expect(reducedMotionTransform).not.toBe(connectingReducedMotionTransform);

      await feedAudio(page);
      await expect
        .poll(async () => Number(await activity.getAttribute("data-level")))
        .toBeGreaterThan(0);
      await expect.poll(barTransform).toBe(reducedMotionTransform);

      await page.getByRole("button", { name: "Stop voice input" }).click();
      await expect.poll(() => tapToTalk.isVisible()).toBe(true);
      await expect.poll(() => activity.count()).toBe(0);
    });
  });

  it("keeps stop-voice and stop-run controls visually distinct while both are active", async () => {
    await suite.withPage({ permissions: ["microphone"] }, async ({ page }) => {
      const gateway = await installTalkGateway(page, googleSession("voice-controls-e2e"), {
        inFlightRun: { runId: "active-run", text: "Working on it." },
        sessionInfo: { activeRunIds: ["active-run"], hasActiveRun: true, key: "agent:main:main" },
      });
      await installTalkBrowserFixtures(page);

      await openTalk(page);
      await page.getByRole("button", { name: "Start voice input" }).click();
      await gateway.waitForRequest("talk.client.create");
      await gateway.deliverLatest({ setupComplete: {} });
      const stopVoice = page.getByRole("button", { name: "Stop voice input" });
      await expect.poll(() => stopVoice.isVisible()).toBe(true);
      await page.mouse.move(0, 0);
      await stopVoice.evaluate(finishElementAnimations);
      const voiceAppearance = await stopVoice.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const meter = element.querySelector(".agent-chat__voice-activity")?.getBoundingClientRect();
        return {
          width: bounds.width,
          background: getComputedStyle(element).backgroundColor,
          meterContained: meter != null && meter.left >= bounds.left && meter.right <= bounds.right,
        };
      });
      expect(voiceAppearance.width).toBeGreaterThanOrEqual(64);
      expect(voiceAppearance.background).toBe("rgba(0, 0, 0, 0)");
      expect(voiceAppearance.meterContained).toBe(true);
      const stopRun = page.getByRole("button", { name: "Stop generating" });
      await expect.poll(() => stopRun.isVisible()).toBe(true);
      await expect.poll(() => stopVoice.isVisible()).toBe(true);

      expect(await stopVoice.locator(".agent-chat__voice-activity").count()).toBe(1);
      expect(await page.locator(".chat-send-btn--stop").count()).toBe(1);

      await stopVoice.click();
      await expect.poll(() => stopVoice.count()).toBe(0);
      await expect.poll(() => stopRun.isVisible()).toBe(true);
      expect(await gateway.getRequests("chat.abort")).toHaveLength(0);
    });
  });

  it("shows a decoded camera preview during OpenAI Talk and removes it on stop", async () => {
    await suite.withPage({ permissions: ["camera", "microphone"] }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        historyMessages: [TALK_READY_HISTORY_MESSAGE],
        methodResponses: {
          "talk.catalog": videoTalkCatalog("openai"),
          "talk.client.create": {
            provider: "openai",
            voiceSessionId: "voice-openai-video-e2e",
            transport: "webrtc",
            clientSecret: "test-client-secret",
            offerUrl: "https://api.openai.com/v1/realtime/calls",
          },
        },
      });
      await installOpenAiTalkFixture(page);

      await openTalk(page);

      await page.getByRole("button", { name: "Start voice input" }).click();
      await expect
        .poll(() =>
          page.evaluate(() =>
            Boolean((window as TalkWindow).openclawVideoTalkE2e?.dataChannelCreated),
          ),
        )
        .toBe(true);
      await page.evaluate(() => {
        const channel = (window as TalkWindow).openclawVideoTalkE2e?.peer.channel;
        channel?.dispatchEvent(new Event("open"));
      });
      const preview = await startCamera(page);
      const dimensions = await preview.evaluate((video) => ({
        height: (video as HTMLVideoElement).videoHeight,
        width: (video as HTMLVideoElement).videoWidth,
      }));
      expect(dimensions.height).toBeGreaterThan(0);
      expect(dimensions.width).toBeGreaterThan(0);
      await captureVideoTalkProof(suite, page, "live-camera-preview.png");
      await expectTalkRequests(gateway);

      await page.getByRole("button", { name: "Stop voice input" }).click();
      await expect.poll(() => preview.count()).toBe(0);
    });
  });

  it("starts Gemini Live Talk, enables a fake camera, and handles describe_view", async () => {
    await suite.withPage({ permissions: ["camera", "microphone"] }, async ({ page }) => {
      const gateway = await installTalkGateway(
        page,
        googleSession("voice-google-video-e2e", "browser-video-e2e"),
        {
          methodResponses: {
            "talk.catalog": videoTalkCatalog("google"),
          },
        },
      );
      const googleLiveMessages: unknown[] = [];
      const findMessage = (field: string, fragment: string) =>
        googleLiveMessages.find(
          (message) =>
            typeof message === "object" &&
            message !== null &&
            field in message &&
            JSON.stringify(message).includes(fragment),
        );
      let describeViewSent = false;
      await page.routeWebSocket("wss://generativelanguage.googleapis.com/**", (ws) => {
        ws.onMessage((message) => {
          const parsed = JSON.parse(typeof message === "string" ? message : message.toString()) as {
            setup?: unknown;
            realtimeInput?: { video?: unknown };
          };
          googleLiveMessages.push(parsed);
          if (parsed.setup) {
            ws.send(JSON.stringify({ setupComplete: {} }));
            return;
          }
          if (parsed.realtimeInput?.video && !describeViewSent) {
            describeViewSent = true;
            ws.send(
              JSON.stringify({
                toolCall: {
                  functionCalls: [{ id: "call-camera", name: "describe_view", args: {} }],
                },
              }),
            );
          }
        });
      });
      await installVideoTalkMediaFixture(page, { camera: "native" });

      await page.setViewportSize({ width: 1366, height: 900 });
      await page.goto(`${suite.server.baseUrl}chat`);
      await waitForTalkReady(page);
      await page.getByRole("button", { name: "Start voice input" }).click();
      const request = await gateway.waitForRequest("talk.client.create");
      expect(request.params).toMatchObject({
        sessionKey: "agent:main:main",
      });
      const preview = await startCamera(page);
      await expect.poll(() => findMessage("realtimeInput", '"video"')).toBeDefined();
      await expect
        .poll(() => findMessage("toolResponse", '"cameraStreamActive":true'))
        .toBeDefined();
      const videoMessage = findMessage("realtimeInput", '"video"');
      expect(new TextEncoder().encode(JSON.stringify(videoMessage)).length).toBeLessThanOrEqual(
        512 * 1024,
      );
      await expectTalkRequests(gateway);
      await captureVideoTalkProof(suite, page, "05-gemini-live-camera-preview.png");

      await page.getByRole("button", { name: "Stop voice input" }).click();
      await expect.poll(() => preview.count()).toBe(0);
      expect(await trackStates(page)).toEqual(["ended", "ended"]);
    });
  });

  it("shows actionable guidance when Video Talk camera permission is blocked", async () => {
    await suite.withPage(undefined, async ({ page }) => {
      const gateway = await installTalkGateway(
        page,
        googleSession("voice-blocked-camera-e2e", "browser-video-denied"),
        {
          methodResponses: {
            "talk.catalog": videoTalkCatalog("google"),
          },
        },
      );
      await page.routeWebSocket("wss://generativelanguage.googleapis.com/**", (ws) => {
        ws.onMessage((message) => {
          const parsed = JSON.parse(typeof message === "string" ? message : message.toString()) as {
            setup?: unknown;
          };
          if (parsed.setup) {
            ws.send(JSON.stringify({ setupComplete: {} }));
          }
        });
      });
      await installVideoTalkMediaFixture(page, { camera: "blocked" });

      await page.setViewportSize({ width: 1366, height: 900 });
      await page.goto(`${suite.server.baseUrl}chat`);
      await waitForTalkReady(page);
      await page.getByRole("button", { name: "Start voice input" }).click();
      await gateway.waitForRequest("talk.client.create");
      const turnCameraOn = page.getByRole("button", { name: "Turn camera on" });
      await expect.poll(() => turnCameraOn.isEnabled()).toBe(true);
      await turnCameraOn.click();

      const alert = page.getByRole("alert");
      await expect.poll(() => alert.textContent()).toContain("Camera access is blocked.");
      await expect.poll(() => page.locator('video[aria-label="Camera preview"]').count()).toBe(0);
      await expect
        .poll(() => page.getByRole("button", { name: "Turn camera on" }).isVisible())
        .toBe(true);
      await captureVideoTalkProof(suite, page, "03-camera-permission-blocked.png");
      await page.getByRole("button", { name: "Stop voice input" }).click();
      expect(await trackStates(page)).toEqual(["ended"]);
    });
  });

  it("renders streamed relay assistant transcript deltas as readable text", async () => {
    await suite.withPage({ permissions: ["microphone"] }, async ({ page }) => {
      const relaySessionId = "relay-e2e-transcript";
      const gateway = await installTalkGateway(page, relaySession(relaySessionId), {
        deferredMethods: ["talk.client.create"],
        methodResponses: {
          "talk.session.appendAudio": {},
          "talk.session.close": {},
        },
      });
      await installTalkBrowserFixtures(page);

      await openTalk(page);
      await page.getByRole("button", { name: "Start voice input" }).click();
      await gateway.waitForRequest("talk.client.create");
      await gateway.resolveDeferred("talk.client.create");
      await expect.poll(() => inputReady(page)).toBe(true);
      await gateway.emitGatewayEvent("talk.event", { relaySessionId, type: "ready" });
      await expect
        .poll(() => page.locator('.agent-chat__voice-activity[data-status="listening"]').count())
        .toBe(1);
      await gateway.emitGatewayEvent("talk.event", {
        relaySessionId,
        type: "transcript",
        role: "user",
        text: "Hey, what model are you using?",
        final: true,
      });
      await expect
        .poll(() =>
          page.locator(".agent-chat__voice-turn--user .agent-chat__voice-turn-text").textContent(),
        )
        .toBe("Hey, what model are you using?");
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
    });
  });

  it("keeps the call alive while relay microphone appends stall", async () => {
    await suite.withPage({ permissions: ["microphone"] }, async ({ page }) => {
      const relaySessionId = "relay-e2e-input-backpressure";
      const gateway = await installTalkGateway(page, relaySession(relaySessionId), {
        methodResponses: {
          "talk.session.appendAudio": {},
          "talk.session.close": {},
        },
      });
      await installTalkBrowserFixtures(page);

      await page.goto(`${suite.server.baseUrl}chat`);
      await waitForTalkReady(page);
      for (let index = 0; index < 4; index += 1) {
        await gateway.deferNext("talk.session.appendAudio");
      }
      await page.getByRole("button", { name: "Start voice input" }).click();
      await gateway.waitForRequest("talk.client.create");
      await expect.poll(() => inputReady(page)).toBe(true);
      await gateway.emitGatewayEvent("talk.event", { relaySessionId, type: "ready" });

      await feedAudio(page, 0.1, 5);

      // Five 256 ms frames stay inside the 3 s in-flight budget, so every frame is
      // sent while the deferred appends stall and the session is not torn down.
      await expect
        .poll(() =>
          gateway.getRequests("talk.session.appendAudio").then((requests) => requests.length),
        )
        .toBe(5);
      expect(await page.getByRole("alert").count()).toBe(0);
      expect(await gateway.getRequests("talk.session.close")).toHaveLength(0);
      await captureComposerProof(suite, page, "relay-input-backpressure-alive.png");
    });
  });

  it("closes a stale relay when stop and restart race its create response", async () => {
    await suite.withPage({ locale: "en-US", permissions: ["microphone"] }, async ({ page }) => {
      const currentRelaySessionId = "relay-current-e2e";
      const staleRelaySessionId = "relay-stale-e2e";
      const gateway = await installTalkGateway(page, relaySession(currentRelaySessionId), {
        featureCapabilities: ["talk-session-close-disposition"],
        methodResponses: {
          "talk.session.appendAudio": {},
          "talk.session.close": {},
        },
      });
      await installTalkBrowserFixtures(page);

      await page.goto(`${suite.server.baseUrl}chat`);
      await waitForTalkReady(page);
      await gateway.deferNext("talk.client.create");

      await page.getByRole("button", { name: "Start voice input" }).click();
      await expect
        .poll(() => gateway.getRequests("talk.client.create").then((requests) => requests.length))
        .toBe(1);
      await page.getByRole("button", { name: "Stop voice input" }).click();
      await page.getByRole("button", { name: "Start voice input" }).click();
      await expect
        .poll(() => gateway.getRequests("talk.client.create").then((requests) => requests.length))
        .toBe(2);

      await expect
        .poll(() =>
          page.evaluate(() => {
            const state = (window as TalkWindow).openclawTalkE2eState;
            return {
              captures: state?.constraints.length,
              stopped: state?.tracksStopped,
              relayReady: state?.inputProcessor != null,
            };
          }),
        )
        .toEqual({ captures: 2, stopped: 1, relayReady: true });
      await gateway.emitGatewayEvent("talk.event", {
        relaySessionId: currentRelaySessionId,
        type: "ready",
      });
      await expect
        .poll(() => page.locator('.agent-chat__voice-activity[data-status="listening"]').count())
        .toBe(1);

      await gateway.resolveDeferred("talk.client.create", relaySession(staleRelaySessionId));
      await expect
        .poll(() => gateway.getRequests("talk.session.close"))
        .toEqual([
          expect.objectContaining({
            params: { sessionId: staleRelaySessionId },
          }),
        ]);

      await feedAudio(page, 0.1);
      await expect
        .poll(() => gateway.getRequests("talk.session.appendAudio"))
        .toEqual([
          expect.objectContaining({
            params: expect.objectContaining({ sessionId: currentRelaySessionId }),
          }),
        ]);
      await expect
        .poll(() => page.getByRole("button", { name: "Stop voice input" }).isVisible())
        .toBe(true);

      await page.getByRole("button", { name: "Stop voice input" }).click();
      await expect
        .poll(() =>
          gateway
            .getRequests("talk.session.close")
            .then((requests) => requests.map((request) => request.params)),
        )
        .toEqual([
          { sessionId: staleRelaySessionId },
          { sessionId: currentRelaySessionId, disposition: "abort" },
        ]);
    });
  });

  it("shows actionable guidance when Talk microphone permission is blocked", async () => {
    await suite.withPage(undefined, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        historyMessages: [TALK_READY_HISTORY_MESSAGE],
      });
      await installBlockedMicrophoneFixture(page);

      await page.setViewportSize({ width: 320, height: 720 });
      await page.goto(`${suite.server.baseUrl}chat`);
      await waitForTalkReady(page);
      await page.getByRole("button", { name: "Tap to talk" }).click();
      await expect
        .poll(() => page.getByRole("alert").locator(".agent-chat__talk-status-text").textContent())
        .toBe("Microphone access is blocked. Allow it in browser site settings to list inputs.");
      expect(await gateway.getRequests("talk.client.create")).toHaveLength(0);
      expect(await gateway.getRequests("talk.session.close")).toHaveLength(0);
      await expect
        .poll(() => page.getByRole("button", { name: "Tap to talk" }).isVisible())
        .toBe(true);
    });
  });

  it("keeps blocked microphone guidance readable in a narrow viewport", async () => {
    await suite.withPage(undefined, async ({ page }) => {
      await installMockGateway(page);
      await installBlockedMicrophoneFixture(page);

      await page.setViewportSize({ width: 320, height: 720 });
      await page.goto(`${suite.server.baseUrl}settings/appearance`);
      const microphonePicker = page.getByRole("combobox", { name: "Microphone input" });
      await microphonePicker.press("ArrowDown");
      await microphonePicker.press("Escape");

      const permissionAlert = page.getByRole("alert");
      await expect.poll(() => permissionAlert.isVisible()).toBe(true);
      const alertBounds = await permissionAlert.boundingBox();
      expect(alertBounds).not.toBeNull();
      expect(alertBounds?.x ?? 0).toBeGreaterThanOrEqual(0);
      expect((alertBounds?.x ?? 0) + (alertBounds?.width ?? 0)).toBeLessThanOrEqual(320);
      await expect
        .poll(() => permissionAlert.textContent())
        .toContain("Microphone access is blocked.");
      await captureMicrophoneLossProof(suite, page, "blocked-microphone.png");
    });
  });
});
