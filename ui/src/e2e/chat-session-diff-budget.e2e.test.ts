import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { setDiffView, singleFileDiff } from "./chat-session-diff.test-support.ts";
import {
  activateChatHeaderPanelAction,
  focusChatSidePanel,
} from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { createThemedChatOpener } from "./theme-typography.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "session diff work budget",
  trackBrowserContexts: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});
const openThemedChat = createThemedChatOpener(suite);
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

suite.define(() => {
  it.each(["light", "dark"] as const)("keeps long diffs readable (%s)", async (mode) => {
    let seed = 123456789;
    const identifier = () =>
      Array.from({ length: 680 }, () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"[seed % 52];
      }).join("");
    const lines = (prefix: string) =>
      Array.from({ length: 64 }, (_, i) => `const ${prefix}${i} = "${identifier()}";`);
    const before = lines("before");
    const after = lines("after");
    const patch = [
      "@@ -1,64 +1,64 @@",
      ...before.map((line) => "-" + line),
      ...after.map((line) => "+" + line),
    ].join("\n");
    const { page, gateway } = await openThemedChat("claw", mode, {
      featureMethods: ["chat.metadata", "chat.startup", "sessions.diff"],
      methodResponses: {
        "sessions.diff": singleFileDiff("src/large.ts", patch, 64, 64),
      },
    });
    await page.setViewportSize({ width: 1600, height: 900 });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await page.goto(suite.server.baseUrl + "chat");
    await activateChatHeaderPanelAction(page, "Show session changes");
    await focusChatSidePanel(page);
    const panel = page.locator(".session-diff");
    const readSide = (selector: string) => panel.locator(selector).allTextContents();
    const splitSide = (side: string) =>
      readSide(
        `.session-diff-split__side--${side}.session-diff-split__side--filled .session-diff-split__text`,
      );
    expect(await readSide(".chat-diff__row--del .chat-diff__text")).toEqual(before);
    expect(await readSide(".chat-diff__row--add .chat-diff__text")).toEqual(after);
    await setDiffView(page, "Split");
    await expect.poll(() => splitSide("left")).toEqual(before);
    expect(await splitSide("right")).toEqual(after);
    const lastRow = panel.locator(".session-diff-split__row").last();
    await lastRow.scrollIntoViewIfNeeded();
    expect(await lastRow.textContent()).toContain(after[63]);
    await setDiffView(page, "Unified");
    expect(await readSide(".chat-diff__row--add .chat-diff__text")).toEqual(after);
    const samples: { cpuRate: number; paintMs: number }[] = [];
    for (let i = 0; i < (captureProof ? 10 : 1); i++) {
      const cpuRate = i < 5 ? 4 : 1;
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuRate });
      await gateway.deferNext("sessions.diff");
      await panel.getByRole("button", { name: "Refresh changes" }).click();
      const painted = page.evaluate(
        () =>
          new Promise<number>((resolve) => {
            const start = performance.now();
            const observer = new MutationObserver(() => {
              if (document.querySelector(".session-diff__refresh:not([disabled])")) {
                observer.disconnect();
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => resolve(performance.now() - start)),
                );
              }
            });
            observer.observe(document.body, {
              subtree: true,
              childList: true,
              attributes: true,
              attributeFilter: ["disabled"],
            });
          }),
      );
      await gateway.resolveDeferred("sessions.diff");
      samples.push({ cpuRate, paintMs: await painted });
    }
    if (captureProof) {
      const artifactDir = createControlUiE2eArtifactDir("diff-highlighting");
      console.log("DIFF_BROWSER_REFRESH_PAINT_MS", mode, JSON.stringify(samples));
      const firstRow = panel.locator(".chat-diff__row").first();
      await firstRow.scrollIntoViewIfNeeded();
      const frame = await takeControlUiScreenshotFrame(page, panel, [firstRow], {
        animations: "disabled",
      });
      await writeFile(path.join(artifactDir, "large-unified.png"), frame.png);
      const timing = { mode, refreshResponseToPaint: samples };
      await writeFile(path.join(artifactDir, "timing.json"), JSON.stringify(timing));
    }
  });
});
