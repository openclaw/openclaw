import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  createTalkRegressionSuite,
  installTalkGateway,
} from "./browser-talk-regression.test-support.ts";
import {
  installMicrophoneLossWebRtcFixture,
  type MicrophoneLossE2eProof,
  waitForTalkReady,
} from "./browser-talk-start-stop.fixtures.ts";
const suite = createTalkRegressionSuite("Control UI browser microphone lifetime");

async function installMicrophone(page: Page, voiceSessionId: string) {
  const gateway = await installTalkGateway(page, voiceSessionId);
  await installMicrophoneLossWebRtcFixture(page);
  return gateway;
}

suite.define(() => {
  it("guides a pending microphone request and clears guidance when voice connects", async () => {
    await suite.withPage({ permissions: ["microphone"] }, async ({ page }) => {
      const gateway = await installMicrophone(page, "voice-microphone-access-e2e");
      await page.addInitScript(() => {
        const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        let release = () => {};
        const permission = new Promise<void>((resolve) => {
          release = resolve;
        });
        const proof = { requested: false, release: () => release() };
        Object.defineProperty(window, "openclawMicrophoneAccessE2e", { value: proof });
        navigator.mediaDevices.getUserMedia = (constraints) => {
          proof.requested = true;
          return permission.then(() => getUserMedia(constraints));
        };
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await waitForTalkReady(page);
      await page.getByRole("button", { name: "Start voice input" }).click();
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as Window & { openclawMicrophoneAccessE2e?: { requested: boolean } })
                .openclawMicrophoneAccessE2e?.requested,
          ),
        )
        .toBe(true);
      expect(await gateway.getRequests("talk.client.create")).toHaveLength(0);
      const guidance = page.locator('.agent-chat__talk-status[role="status"]');
      await expect
        .poll(() => guidance.allTextContents())
        .toEqual([
          expect.stringContaining(
            "Waiting for microphone access. Bring this tab to the foreground and allow access if prompted.",
          ),
        ]);
      await expect.poll(() => guidance.isVisible()).toBe(true);
      await page.evaluate(() =>
        (
          window as Window & { openclawMicrophoneAccessE2e?: { release: () => void } }
        ).openclawMicrophoneAccessE2e?.release(),
      );
      await expect
        .poll(() => page.locator('.agent-chat__voice-activity[data-status="listening"]').count())
        .toBe(1);
      await expect.poll(() => guidance.count()).toBe(0);
      expect(await gateway.getRequests("talk.client.create")).toHaveLength(1);
      await page.getByRole("button", { name: "Stop voice input" }).click();
    });
  });

  it("surfaces microphone loss and closes native browser call resources", async () => {
    await suite.withPage({ permissions: ["microphone"] }, async ({ page }) => {
      const gateway = await installMicrophone(page, "voice-microphone-loss-e2e");
      await page.goto(`${suite.server.baseUrl}chat`);
      await waitForTalkReady(page);
      await page.getByRole("button", { name: "Start voice input" }).click();
      await expect
        .poll(() => page.locator(".agent-chat__voice-activity").getAttribute("data-status"))
        .toBe("listening");

      await page.evaluate(() => {
        (
          window as Window & { openclawMicrophoneLossE2e?: MicrophoneLossE2eProof }
        ).openclawMicrophoneLossE2e?.endMicrophone();
      });

      const alert = page.locator('.agent-chat__talk-status[role="alert"]');
      await expect
        .poll(() => alert.textContent())
        .toContain("Microphone input stopped. Choose an available input and start again.");
      await expect
        .poll(() =>
          page.evaluate(() => {
            const proof = (
              window as Window & { openclawMicrophoneLossE2e?: MicrophoneLossE2eProof }
            ).openclawMicrophoneLossE2e;
            return {
              tracksStopped: proof?.tracksStopped,
              peerClosed: proof?.peerClosed,
              trackState: proof?.trackState,
              audioElements: document.querySelectorAll("audio").length,
            };
          }),
        )
        .toEqual({ tracksStopped: 1, peerClosed: true, trackState: "ended", audioElements: 0 });
      await gateway.waitForRequest("talk.client.close");
      await page.getByRole("button", { name: "Dismiss voice input error" }).click();
    });
  });
});
