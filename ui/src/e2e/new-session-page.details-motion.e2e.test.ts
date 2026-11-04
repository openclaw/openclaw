import path from "node:path";
import { expect, it } from "vitest";
import { timedText } from "./chat-flow-fixtures.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import { createPageOpener } from "./new-session-page.scenario.test-support.ts";
import {
  captureUiProofEnabled,
  createNewSessionPageE2eSuite,
  installMockGateway,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const openPage = createPageOpener(suite);

suite.define(() => {
  it.each([
    { label: "fresh reveal", reducedMotion: "no-preference", width: 1700, animate: true },
    { label: "reduced motion", reducedMotion: "reduce", width: 1700, animate: false },
    { label: "later resize", reducedMotion: "no-preference", width: 1100, animate: false },
  ] as const)(
    "reveals Details after session creation: $label",
    async ({ label, reducedMotion, width: initialWidth, animate }) => {
      const page = await openPage({
        ...createControlUiE2eContextOptions(),
        viewport: { width: initialWidth, height: 1000 },
        reducedMotion,
        ...(captureUiProofEnabled
          ? { recordVideo: { dir: suite.artifactDir, size: { width: 1700, height: 1000 } } }
          : {}),
      });
      const gateway = await installMockGateway(page, {
        heldMethods: ["sessions.create"],
        historyMessages: [timedText("user", "Check the session layout")],
      });
      await page.goto(`${suite.server.baseUrl}new`);
      await page.locator(".new-session-page__message").fill("Check the session layout");
      await page.locator(".new-session-page__message").press("Control+Enter");
      await gateway.waitForRequest("sessions.create");
      await page.locator("openclaw-pending-session-create").waitFor();
      if (captureUiProofEnabled) {
        await page.screenshot({
          path: path.join(suite.artifactDir, reducedMotion + "-before.png"),
        });
      }
      if (initialWidth < 1700) {
        await gateway.resolveDeferred("sessions.create");
        await page.locator(".chat-details-toggle").waitFor();
      }
      const initialLeft = await page
        .locator(".chat-footer textarea")
        .evaluate((element) => element.getBoundingClientRect().left);
      const motion = page.evaluate(async () => {
        const samples: number[] = [];
        const positions: number[] = [];
        const deadline = performance.now() + 5000;
        while (performance.now() < deadline) {
          await new Promise(requestAnimationFrame);
          const frame = document.querySelector(".chat-main__conversation-frame");
          const width = frame
            ? Number.parseFloat(getComputedStyle(frame).getPropertyValue("--chat-details-space")) ||
              0
            : 0;
          samples.push(width);
          const composer = document.querySelector(".chat-footer textarea");
          if (composer) {
            positions.push(composer.getBoundingClientRect().left);
          }
          if (width >= 313) {
            break;
          }
        }
        return { samples, positions };
      });
      if (initialWidth < 1700) {
        await page.setViewportSize({ width: 1700, height: 1000 });
      } else {
        await gateway.resolveDeferred("sessions.create");
      }
      const { samples, positions } = await motion;
      if (captureUiProofEnabled) {
        await page.screenshot({ path: path.join(suite.artifactDir, reducedMotion + "-after.png") });
      }
      expect(samples.at(-1)).toBe(313);
      expect(
        samples.some((width) => width > 1 && width < 312),
        JSON.stringify(samples),
      ).toBe(animate);
      if (animate) {
        const finalLeft = positions.at(-1)!;
        expect(finalLeft).toBeLessThan(initialLeft);
        expect(positions.some((left) => left > finalLeft + 1 && left < initialLeft - 1)).toBe(true);
      }
      if (captureUiProofEnabled) {
        const video = page.video();
        await page.context().close();
        await video?.saveAs(path.join(suite.artifactDir, label.replaceAll(" ", "-") + ".webm"));
      }
    },
  );
});
