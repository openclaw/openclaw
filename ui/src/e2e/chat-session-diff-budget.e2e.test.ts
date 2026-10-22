import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { singleFileDiff } from "./chat-session-diff.test-support.ts";
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
    const fileToggle = panel.getByRole("button", {
      name: "src/large.ts — Modified",
      exact: true,
    });
    const modeButton = (current: "auto" | "unified" | "split") =>
      panel.getByRole("button", {
        name: "Diff mode: " + current + ". Switch to next mode",
        exact: true,
      });
    await fileToggle.waitFor();
    expect(await fileToggle.getAttribute("aria-expanded")).toBe("false");
    await fileToggle.click();
    await modeButton("auto").click();
    await expect.poll(() => readSide(".chat-diff__row--del .chat-diff__text")).toEqual(before);
    expect(await readSide(".chat-diff__row--add .chat-diff__text")).toEqual(after);
    await modeButton("unified").click();
    await expect
      .poll(() =>
        readSide(
          ".session-diff-split__side--left.session-diff-split__side--filled .session-diff-split__text",
        ),
      )
      .toEqual(before);
    expect(
      await readSide(
        ".session-diff-split__side--right.session-diff-split__side--filled .session-diff-split__text",
      ),
    ).toEqual(after);
    await panel.locator(".session-diff-split__row").last().scrollIntoViewIfNeeded();
    expect(await panel.locator(".session-diff-split__row").last().textContent()).toContain(
      after[63],
    );
    await modeButton("split").click();
    await modeButton("auto").click();
    expect(await readSide(".chat-diff__row--add .chat-diff__text")).toEqual(after);
    const samples: { cpuRate: number; paintMs: number }[] = [];
    for (let i = 0; i < (captureProof ? 10 : 1); i++) {
      const cpuRate = i < 5 ? 4 : 1;
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuRate });
      const previousRequests = (await gateway.getRequests("sessions.diff")).length;
      await gateway.deferNext("sessions.diff");
      await panel.getByRole("button", { name: "Refresh changes" }).click();
      await gateway.waitForRequest("sessions.diff", { after: previousRequests });
      expect(await fileToggle.getAttribute("aria-expanded")).toBe("false");
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
      await fileToggle.click();
      await expect.poll(() => readSide(".chat-diff__row--del .chat-diff__text")).toEqual(before);
      expect(await readSide(".chat-diff__row--add .chat-diff__text")).toEqual(after);
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
