// Control UI E2E tests cover WebRTC SDP response handling through a real page.
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import {
  installOversizedWebRtcSdpFixture,
  installWebRtcSdpFailureFixture,
  type WebRtcSdpE2eProof,
  videoTalkCatalog,
} from "./browser-talk-start-stop.fixtures.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

let server: ControlUiE2eServer;
let browser: Browser;

describeControlUiE2e("Control UI browser Talk WebRTC SDP responses", () => {
  beforeAll(async () => {
    browser = await chromium.launch({
      executablePath: chromiumExecutablePath,
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    });
    try {
      server = await startControlUiE2eServer();
    } catch (error) {
      await browser.close();
      throw error;
    }
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("cancels a failed OpenAI WebRTC SDP response body in the live Control UI", async () => {
    const context = await browser.newContext({ permissions: ["microphone"] });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "talk.catalog": videoTalkCatalog("openai"),
        "talk.client.create": {
          provider: "openai",
          voiceSessionId: "voice-openai-sdp-error-e2e",
          transport: "webrtc",
          clientSecret: "test-client-secret",
          offerUrl: "https://api.openai.com/v1/realtime/calls",
        },
      },
    });
    await installWebRtcSdpFailureFixture(page);

    try {
      await page.goto(`${server.baseUrl}chat`);
      await page.getByRole("button", { name: "Start voice input" }).click();
      await gateway.waitForRequest("talk.client.create");

      const alert = page.locator('.agent-chat__talk-status[role="alert"]');
      await expect.poll(() => alert.textContent()).toContain("Realtime WebRTC setup failed (502)");
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as Window & { openclawWebRtcSdpE2e?: WebRtcSdpE2eProof })
                .openclawWebRtcSdpE2e,
          ),
        )
        .toEqual({
          bodyCancelCount: 1,
          bodyCancelResolvedCount: 1,
          fetchCount: 1,
          remoteDescriptionCount: 0,
          statuses: [502],
        });
      console.info(
        `[webrtc-sdp-e2e] trigger=OpenAI WebRTC offer; transition=status:error+502; ` +
          `body.cancel=1/resolved; outcome=visible setup failure`,
      );
    } finally {
      await context.close();
    }
  });

  it("rejects and cancels an oversized OpenAI SDP answer before peer setup", async () => {
    const context = await browser.newContext({ permissions: ["microphone"] });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "talk.catalog": videoTalkCatalog("openai"),
        "talk.client.create": {
          provider: "openai",
          voiceSessionId: "voice-openai-sdp-oversized-e2e",
          transport: "webrtc",
          clientSecret: "test-client-secret",
          offerUrl: "https://api.openai.com/v1/realtime/calls",
        },
      },
    });
    await installOversizedWebRtcSdpFixture(page);

    try {
      await page.goto(`${server.baseUrl}chat`);
      await page.getByRole("button", { name: "Start voice input" }).click();
      await gateway.waitForRequest("talk.client.create");

      const alert = page.locator('.agent-chat__talk-status[role="alert"]');
      await expect
        .poll(() => alert.textContent())
        .toContain("Realtime WebRTC SDP answer: text response exceeds 262144 bytes");
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as Window & { openclawWebRtcSdpE2e?: WebRtcSdpE2eProof })
                .openclawWebRtcSdpE2e,
          ),
        )
        .toEqual({
          bodyCancelCount: 1,
          bodyCancelResolvedCount: 1,
          fetchCount: 1,
          remoteDescriptionCount: 0,
          statuses: [200],
        });
      console.info(
        `[webrtc-sdp-e2e] trigger=oversized OpenAI SDP answer; ` +
          `body.cancel=1/resolved; remote-description=0; outcome=visible size failure`,
      );
    } finally {
      await context.close();
    }
  });
});
