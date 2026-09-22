// Control UI E2E coverage for relay playout capacity through a real browser
// audio graph: the fixtures used by the other browser Talk specs replace
// AudioContext with a stub that has no buffer API and a frozen clock, so only
// this spec exercises RealtimeTalkPcmOutputQueue against real Web Audio.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

// 960 bytes of PCM16 == 480 samples == 20ms at 24kHz: one relay browser event
// (RELAY_OUTPUT_AUDIO_FRAME_BYTES in src/gateway/talk/relay/session-create.ts).
const RELAY_FRAME_BASE64 = "AAAA".repeat(320);
const RELAY_FRAME_SECONDS = 0.02;
// 8s of speech: past the 320 pending sources that used to cap the queue at
// 6.4s, and inside the 10s queued-seconds budget, so only a frame count can
// reject it. Raising the seconds budget (#149317) is what unlocks replies
// longer than this.
const RELAY_FRAME_COUNT = 400;

type PlayoutProbe = {
  bufferSources: number;
  microphoneRequests: number;
  outputSampleRates: number[];
};
type PlayoutProbeWindow = Window & { openclawTalkPlayoutE2e?: PlayoutProbe };

/**
 * Leaves both the microphone and the AudioContext real: Chromium runs with
 * `--use-fake-device-for-media-stream`, so `getUserMedia` yields a genuine
 * MediaStream that a real AudioContext will accept, and relay frames reach a
 * real output graph. Only `getUserMedia` and `createBufferSource` are wrapped,
 * to observe setup and count the sources the queue owns.
 */
function installRealOutputAudioTalkFixture() {
  const probe: PlayoutProbe = {
    bufferSources: 0,
    microphoneRequests: 0,
    outputSampleRates: [],
  };
  Object.defineProperty(window, "openclawTalkPlayoutE2e", { configurable: true, value: probe });

  const nativeGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
    configurable: true,
    value: async (constraints: MediaStreamConstraints) => {
      probe.microphoneRequests += 1;
      return await nativeGetUserMedia(constraints);
    },
  });

  const NativeAudioContext = window.AudioContext;
  class ProbedAudioContext extends NativeAudioContext {
    constructor(options?: AudioContextOptions) {
      super(options);
      if (options?.sampleRate) {
        probe.outputSampleRates.push(options.sampleRate);
      }
    }
    override createBufferSource(): AudioBufferSourceNode {
      probe.bufferSources += 1;
      return super.createBufferSource();
    }
  }
  Object.defineProperty(window, "AudioContext", {
    configurable: true,
    value: ProbedAudioContext,
  });
}

const suite = createControlUiE2eSuite({
  name: "Control UI browser Talk playout cap",
  browserLaunchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
  },
});

suite.define(() => {
  it("plays a long relay reply without cancelling it as playback-overflow", async () => {
    const artifactDir = createControlUiE2eArtifactDir("talk-playout-cap");
    await suite.withPage(
      { permissions: ["microphone"], viewport: { width: 1366, height: 900 } },
      async ({ page }) => {
        const relaySessionId = "relay-e2e-playout-cap";
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
            "talk.session.cancelOutput": {},
            "talk.session.close": {},
          },
        });
        await page.addInitScript(installRealOutputAudioTalkFixture);

        await page.goto(`${suite.server.baseUrl}chat`);
        await page.getByRole("button", { name: "Start voice input" }).click();
        await gateway.waitForRequest("talk.client.create");
        await expect
          .poll(() =>
            page.evaluate(
              () => (window as PlayoutProbeWindow).openclawTalkPlayoutE2e?.microphoneRequests,
            ),
          )
          .toBe(1);
        await gateway.emitGatewayEvent("talk.event", { relaySessionId, type: "ready" });
        await expect
          .poll(() => page.locator('.agent-chat__voice-activity[data-status="listening"]').count())
          .toBe(1);

        // The relay splits each provider chunk into 20ms frames and emits them
        // back to back, so deliver the reply as one burst rather than paced by
        // the page's own clock.
        await page.evaluate(
          ({ audioBase64, count, sessionId }) => {
            const mock = (
              window as Window & {
                openclawControlUiE2eGateway?: { emit: (event: string, payload: unknown) => void };
              }
            ).openclawControlUiE2eGateway;
            if (!mock) {
              throw new Error("Mock Gateway is not installed");
            }
            for (let index = 0; index < count; index += 1) {
              mock.emit("talk.event", {
                relaySessionId: sessionId,
                type: "audio",
                audioBase64,
                talkEvent: { turnId: "turn-playout-cap" },
              });
            }
          },
          {
            audioBase64: RELAY_FRAME_BASE64,
            count: RELAY_FRAME_COUNT,
            sessionId: relaySessionId,
          },
        );

        // Not asserted here (transcript rendering is browser-talk-ordering's
        // job): this only gives the retained capture a visible reply.
        await gateway.emitGatewayEvent("talk.event", {
          relaySessionId,
          type: "transcript",
          role: "assistant",
          text: "Here is the long answer you asked for, all fifteen seconds of it.",
          final: true,
        });

        // Scoped to this reason on purpose. Chromium's fake capture device emits
        // a tone loud enough to clear the client-side barge-in thresholds, and
        // that detector (a separate known defect, #140172) cancels output for
        // its own reason once the microphone pump has delivered two frames.
        // Asserting "no cancelOutput at all" would make this spec a race
        // against that unrelated path.
        expect(
          await gateway.getRequests("talk.session.cancelOutput", {
            reason: "playback-overflow",
          }),
        ).toEqual([]);
        const probe = await page.evaluate(
          () => (window as PlayoutProbeWindow).openclawTalkPlayoutE2e,
        );
        expect(probe?.outputSampleRates).toContain(24_000);
        // Every relay frame took a real AudioBufferSourceNode: the queue
        // accepted 8s of speech instead of stopping at 6.4s.
        expect(probe?.bufferSources).toBe(RELAY_FRAME_COUNT);
        console.info(
          `[talk-playout-cap-e2e] frames=${RELAY_FRAME_COUNT} seconds=${(
            RELAY_FRAME_COUNT * RELAY_FRAME_SECONDS
          ).toFixed(2)} sources=${probe?.bufferSources} playbackOverflowCancels=0`,
        );

        await writeFile(
          path.join(artifactDir, "relay-reply-playing.png"),
          await takeControlUiViewportScreenshot(page, page.locator(".shell"), [
            page.locator(".agent-chat__voice-activity").first(),
          ]),
        );
      },
    );
  });
});
