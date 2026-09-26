import path from "node:path";
import { expect, it } from "vitest";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../lib/session-pull-requests.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { captureUiProofEnabled } from "./chat-flow.test-support.ts";
import { showPublicationBranch } from "./chat-github-publication.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Chat keyboard viewport" });

suite.define(() => {
  it("keeps the real composer and context above a visual-only keyboard resize and pan", async () => {
    const proofDir = captureUiProofEnabled ? createControlUiE2eArtifactDir("chat-keyboard") : null;
    await suite.withPage(
      {
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        colorScheme: "dark",
        reducedMotion: "reduce",
      },
      async ({ page }) => {
        // Desktop Chromium cannot open an iOS keyboard. Inject only its viewport
        // contract; boot, routing, chat footer, progress and branch are production UI.
        await page.addInitScript(() => {
          const viewport = Object.assign(new EventTarget(), {
            height: 844,
            width: 390,
            offsetTop: 0,
            offsetLeft: 0,
            scale: 1,
          });
          Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
          window.addEventListener("test-viewport", (event) => {
            Object.assign(viewport, (event as CustomEvent).detail);
            viewport.dispatchEvent(new Event("resize"));
            viewport.dispatchEvent(new Event("scroll"));
          });
        });
        const sessionKey = "agent:main:main";
        const gateway = await installMockGateway(page, {
          sessionKey,
          featureMethods: [
            "chat.metadata",
            "chat.startup",
            "progressCard.get",
            SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
          ],
          historyMessages: [
            { role: "user", content: "Check the mobile chat layout." },
            {
              role: "assistant",
              content: "The task progress and branch stay above the message composer.",
            },
          ],
          methodResponses: {
            [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
            "progressCard.get": {
              card: {
                sessionKey,
                revision: 1,
                updatedAt: 1,
                markdown: "Checking the chat layout.",
                steps: [
                  { step: "Inspect layout", status: "completed" },
                  { step: "Verify keyboard", status: "in_progress" },
                ],
              },
            },
          },
        });
        await page.goto(suite.server.baseUrl + "chat");
        await showPublicationBranch(gateway, "fix/mobile-keyboard");
        await page.locator('.chat-pr[data-state="branch"]').waitFor();
        await page.locator(".session-progress-card--composer").waitFor();
        const input = page.locator(".agent-chat__composer-combobox textarea");
        await input.fill("Keep this draft visible");
        const geometry = () =>
          page.locator(".agent-chat__input").evaluate((element) => {
            const box = element.getBoundingClientRect();
            const viewport = window.visualViewport!;
            const context = document
              .querySelector(".chat-footer__context")!
              .getBoundingClientRect();
            return {
              top: box.top,
              bottom: box.bottom,
              contextBottom: context.bottom,
              viewportBottom: viewport.offsetTop + viewport.height,
              shellHeight: document.querySelector(".shell")!.getBoundingClientRect().height,
              transcriptHeight: document.querySelector(".chat-thread")!.clientHeight,
            };
          });
        const viewport = async (height: number, offsetTop = 0, scale = 1) => {
          await page.evaluate(
            (detail) => window.dispatchEvent(new CustomEvent("test-viewport", { detail })),
            { height, offsetTop, scale },
          );
          await page.evaluate(
            () =>
              new Promise<void>((resolve) => {
                requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
              }),
          );
        };
        const closed = await geometry();
        expect(closed.bottom).toBeLessThanOrEqual(844);
        await viewport(480);
        if (proofDir) {
          await page.screenshot({
            path: path.join(proofDir, "keyboard-visible-region.png"),
            clip: { x: 0, y: 0, width: 390, height: 480 },
            animations: "disabled",
          });
        }
        const opened = await geometry();
        expect(opened.bottom).toBeLessThanOrEqual(opened.viewportBottom);
        expect(opened.contextBottom).toBeLessThanOrEqual(opened.top);
        await viewport(440, 70);
        const panned = await geometry();
        expect(panned.bottom).toBeLessThanOrEqual(510);
        expect(panned.bottom).toBeGreaterThan(440);
        await viewport(844);
        expect((await geometry()).bottom).toBeCloseTo(closed.bottom, 0);
        // Pinch zoom must retain native panning rather than reflow the app to
        // the magnified visual viewport.
        await viewport(422, 50, 2);
        expect((await geometry()).shellHeight).toBeCloseTo(closed.shellHeight, 0);
        await viewport(844);
        await page.setViewportSize({ width: 844, height: 390 });
        await viewport(250);
        const landscape = await geometry();
        expect(landscape.bottom).toBeLessThanOrEqual(250);
        expect(landscape.transcriptHeight).toBeGreaterThanOrEqual(24);
        // Chromium/Android can resize both viewports: do not subtract the
        // keyboard a second time when resizes-content already did the work.
        await page.setViewportSize({ width: 390, height: 480 });
        await viewport(480);
        expect((await geometry()).shellHeight).toBe(480);
        expect((await geometry()).bottom).toBeLessThanOrEqual(480);
        await page.setViewportSize({ width: 1280, height: 900 });
        await viewport(900);
        expect((await geometry()).shellHeight).toBe(900);
        expect(await input.inputValue()).toBe("Keep this draft visible");
        await page.setViewportSize({ width: 390, height: 844 });
        // Desktop Chromium cannot enter iOS standalone mode. Activate the actual
        // standalone rules (including compound mobile conditions), not a second
        // copy of its CSS. Body owns both safe-area insets; the composer removes
        // its duplicate bottom gap only under the compound standalone rule.
        await page.evaluate(() => {
          for (const sheet of document.styleSheets) {
            for (const rule of sheet.cssRules) {
              if (
                rule instanceof CSSMediaRule &&
                rule.conditionText.includes("display-mode: standalone")
              ) {
                rule.media.mediaText = rule.conditionText.replaceAll(
                  "(display-mode: standalone)",
                  "(min-width: 0px)",
                );
              }
            }
          }
          document.documentElement.style.setProperty("--safe-area-top", "47px");
          document.documentElement.style.setProperty("--safe-area-bottom", "34px");
        });
        for (const height of [480, 844]) {
          await viewport(height);
          const standalone = await page.locator(".shell").evaluate((shell) => ({
            top: shell.getBoundingClientRect().top,
            bottom: shell.getBoundingClientRect().bottom,
            bodyTop: getComputedStyle(document.body).paddingTop,
            bodyBottom: getComputedStyle(document.body).paddingBottom,
            composerGap: getComputedStyle(document.querySelector(".agent-chat__composer-shell")!)
              .getPropertyValue("--chat-composer-bottom-gap")
              .trim(),
          }));
          expect(standalone.bodyTop).toBe("47px");
          expect(standalone.bodyBottom).toBe("34px");
          expect(standalone.composerGap).toBe("6px");
          expect(standalone.top).toBe(47);
          expect(standalone.bottom).toBe(height - 34);
          expect((await geometry()).bottom).toBeLessThanOrEqual(height - 34);
        }
        await viewport(422, 50, 2);
        expect((await geometry()).shellHeight).toBe(844 - 47 - 34);
      },
    );
  });
});
