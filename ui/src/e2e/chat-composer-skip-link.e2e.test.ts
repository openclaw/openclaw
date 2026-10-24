import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiSessionUrl,
  createNewSessionPageE2eSuite,
  installMockGateway,
} from "./new-session-page.test-support.ts";

// Forward Tab must reach a composer bypass before the transcript's focusable
// message controls (issue #180815).
const suite = createNewSessionPageE2eSuite();
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

suite.define(() => {
  it("reaches the composer skip link before transcript controls and focuses the composer on activation", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      await installMockGateway(page, {
        sessionTranscripts: {
          "agent:main:main": {
            messages: [
              {
                role: "assistant",
                content: '```js\nconsole.log("loaded history");\n```',
                timestamp: 1,
              },
            ],
          },
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
      const composer = page.locator(".agent-chat__composer-combobox > textarea");
      await composer.waitFor();
      // Wait until the transcript exposes a focusable code-block control.
      await page.locator(".chat-thread pre").waitFor();

      const describeActiveElement = async () =>
        page.evaluate(() => {
          const active = document.activeElement;
          if (!active || active === document.body || active === document.documentElement) {
            return "body";
          }
          if (active.matches(".chat-skip-link")) {
            return "skip-link";
          }
          if (active.closest(".chat-thread")) {
            return "transcript";
          }
          if (active.matches(".agent-chat__composer-combobox > textarea")) {
            return "composer";
          }
          return "chrome";
        });

      // Walk the forward tab order from the top of the document until the
      // transcript region itself takes focus.
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      const sequence: string[] = [];
      for (let stop = 0; stop < 40; stop += 1) {
        await page.keyboard.press("Tab");
        const where = await describeActiveElement();
        sequence.push(where);
        if (where === "transcript" || where === "composer") {
          break;
        }
      }
      expect(sequence).toContain("skip-link");
      expect(sequence).toContain("transcript");
      expect(sequence.indexOf("skip-link")).toBeLessThan(sequence.indexOf("transcript"));

      const skipLink = page.locator("button.chat-skip-link");
      await skipLink.focus();
      await expect
        .poll(() =>
          skipLink.evaluate((element) => {
            // The bypass stays off-screen until focused.
            const rect = element.getBoundingClientRect();
            return element === document.activeElement && rect.top >= 0;
          }),
        )
        .toBe(true);
      expect(await skipLink.textContent()).toBe("Skip to message composer");
      if (captureUiProof) {
        await fs.writeFile(
          path.join(suite.artifactDir, "composer-skip-link-focused.png"),
          await takeControlUiViewportScreenshot(page, skipLink, [skipLink]),
        );
      }

      // Activating the bypass moves focus to the composer without traversing
      // the transcript's controls.
      await page.keyboard.press("Enter");
      await expect
        .poll(() => composer.evaluate((element) => element === document.activeElement))
        .toBe(true);
      if (captureUiProof) {
        await fs.writeFile(
          path.join(suite.artifactDir, "composer-focused-after-skip.png"),
          await takeControlUiViewportScreenshot(page, composer, [composer]),
        );
      }
    });
  });

  it("lands on the recovery surface when the composer is unavailable (archived session)", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      await installMockGateway(page, {
        featureMethods: [
          "agent.wait",
          "chat.metadata",
          "chat.startup",
          "sessions.create",
          "sessions.dispatch",
          "sessions.patch",
        ],
        sessions: [
          {
            key: "agent:main:main",
            sessionId: "session:main",
            label: "Archived Session",
            kind: "direct",
            updatedAt: 2,
            archived: true,
          },
        ],
        sessionTranscripts: {
          "agent:main:main": {
            messages: [
              {
                role: "assistant",
                content: '```js\nconsole.log("loaded history");\n```',
                timestamp: 1,
              },
            ],
          },
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
      const banner = page.locator(".agent-chat__disabled-banner");
      await banner.waitFor();
      // The replacement banner removes the composer textarea, so the bypass
      // cannot land on the composer in this state.
      expect(await page.locator(".agent-chat__composer-combobox > textarea").count()).toBe(0);
      await page.locator(".chat-thread pre").waitFor();

      const skipLink = page.locator("button.chat-skip-link");
      await skipLink.focus();
      const recovery = banner.getByRole("button", { name: "Unarchive", exact: true });
      // Activating the bypass moves focus to the banner recovery surface
      // instead of leaving focus on the bypass; its Unarchive action stays
      // reachable as the next tab stop.
      await page.keyboard.press("Enter");
      await expect
        .poll(() =>
          banner.evaluate(
            (element) =>
              element === document.activeElement && element.getAttribute("tabindex") === "-1",
          ),
        )
        .toBe(true);
      await page.keyboard.press("Tab");
      await expect
        .poll(() => recovery.evaluate((element) => element === document.activeElement))
        .toBe(true);
      if (captureUiProof) {
        await fs.writeFile(
          path.join(suite.artifactDir, "composer-skip-link-archived-recovery-focused.png"),
          await takeControlUiViewportScreenshot(page, recovery, [recovery, banner, skipLink]),
        );
      }
    });
  });
});
