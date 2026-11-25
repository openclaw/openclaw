import type { Page } from "playwright";
import { expect } from "vitest";
import type { ChatPageHost } from "../pages/chat/chat-state-host.ts";

declare global {
  interface Window {
    sessionNavigationFollowProbe?: {
      samples: Array<{ locked: boolean; reading: boolean }>;
      stop: () => void;
    };
  }
}

export async function watchNavigationFollowIntent(page: Page, targetSession: string) {
  await page.evaluate((target) => {
    const samples: Array<{ locked: boolean; reading: boolean }> = [];
    let frame = 0;
    const sample = () => {
      const state = document.querySelector<HTMLElement & { state?: ChatPageHost }>(
        ".chat-pane-cache__pane--active",
      )?.state;
      // Read policy only: geometry reads can themselves change measurement timing.
      if (state?.sessionKey === target && !state.chatLoading) {
        samples.push({ locked: state.chatFollowLocked, reading: state.chatReadingHistory });
      }
      frame = requestAnimationFrame(sample);
    };
    window.sessionNavigationFollowProbe = { samples, stop: () => cancelAnimationFrame(frame) };
    frame = requestAnimationFrame(sample);
  }, targetSession);
  return async (reading: boolean) => {
    const samples = await page.evaluate(async () => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      const probe = window.sessionNavigationFollowProbe;
      if (!probe) {
        throw new Error("Navigation follow probe was not started");
      }
      probe.stop();
      return probe.samples;
    });
    expect(samples.length, "target session was observed while presented").toBeGreaterThan(0);
    expect(samples, "navigation and measurement must not change reader intent").toEqual(
      samples.map(() => ({ locked: reading, reading })),
    );
  };
}
