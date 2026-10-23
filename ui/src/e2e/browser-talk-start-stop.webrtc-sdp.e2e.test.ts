import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  createTalkRegressionSuite,
  installTalkGateway,
} from "./browser-talk-regression.test-support.ts";
import {
  captureWebRtcSdpAlertProof,
  installOversizedWebRtcSdpFixture,
  installWebRtcSdpFailureFixture,
  type WebRtcSdpE2eProof,
  waitForTalkReady,
} from "./browser-talk-start-stop.fixtures.ts";
const suite = createTalkRegressionSuite("Control UI browser Talk WebRTC SDP responses");

async function waitForWebRtcSdpFetch(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as Window & { openclawWebRtcSdpE2e?: WebRtcSdpE2eProof }).openclawWebRtcSdpE2e
            ?.fetchCount ?? 0,
      ),
    )
    .toBe(1);
}

suite.define(() => {
  it.each([
    {
      name: "failed",
      status: 502,
      install: installWebRtcSdpFailureFixture,
      message: "Realtime WebRTC setup failed (502)",
      screenshot: "01-http-failure-alert.png",
    },
    {
      name: "oversized",
      status: 200,
      install: installOversizedWebRtcSdpFixture,
      message: "Realtime WebRTC SDP answer: text response exceeds 262144 bytes",
      screenshot: "02-oversized-answer-alert.png",
    },
  ])("cancels a $name OpenAI SDP response before peer setup", async (scenario) => {
    await suite.withPage({ permissions: ["microphone"] }, async ({ page }) => {
      await installTalkGateway(page, `voice-openai-sdp-${scenario.name}-e2e`, {
        offerUrl: "https://api.openai.com/v1/realtime/calls",
        offerResponseMaxBytes: 256 * 1024,
      });
      await scenario.install(page);

      await page.goto(`${suite.server.baseUrl}chat`);
      await waitForTalkReady(page);
      await expect
        .poll(() => page.locator('[data-chat-talk-capability="realtime"]').count())
        .toBe(0);
      // The oversized response completes without navigation; don't wait for one.
      await page
        .getByRole("button", { name: "Start voice input" })
        .click({ noWaitAfter: scenario.status === 200 });
      await waitForWebRtcSdpFetch(page);

      const alert = page.locator('.agent-chat__talk-status[role="alert"]');
      await expect.poll(() => alert.textContent()).toContain(scenario.message);
      await captureWebRtcSdpAlertProof(suite, page, scenario.screenshot);
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
          statuses: [scenario.status],
        });
    });
  });
});
