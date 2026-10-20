import path from "node:path";
import { expect, it } from "vitest";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { installMockGateway, pauseVirtualClock } from "../test-helpers/control-ui-e2e.ts";
import {
  expectAttribute,
  expectCount,
  expectText,
  showHeading,
} from "./activity-assertions.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI About mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

type AboutCopyBackend = {
  writes: string[];
  legacyCalls: number;
  pending: boolean;
  finishRetry: ((copied: boolean) => void) | null;
};

type AboutCopyWindow = typeof window & { aboutCopyBackend: AboutCopyBackend };

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const BUILT_AT = "2026-07-10T12:34:56.000Z";

suite.define(() => {
  it.each([
    { prior: "success", firstCopied: true, retryCopied: false },
    { prior: "failure", firstCopied: false, retryCopied: true },
  ])(
    "keeps commit-copy retries busy after earlier $prior feedback expires",
    async ({ prior, firstCopied, retryCopied }) => {
      let clockInstalled = false;
      await suite.withPage(
        { ...createControlUiE2eContextOptions(), reducedMotion: "reduce" },
        async ({ page }) => {
          await page.addInitScript((initialCopySucceeds) => {
            const backend: AboutCopyBackend = {
              writes: [],
              legacyCalls: 0,
              pending: false,
              finishRetry: null,
            };
            Object.defineProperty(window, "aboutCopyBackend", { value: backend });
            Object.defineProperty(navigator, "clipboard", {
              configurable: true,
              value: {
                writeText: async (text: string) => {
                  backend.writes.push(text);
                  if (backend.writes.length === 1) {
                    if (!initialCopySucceeds) {
                      throw new DOMException("Controlled clipboard rejection", "NotAllowedError");
                    }
                    return;
                  }
                  backend.pending = true;
                  return new Promise<void>((resolve, reject) => {
                    backend.finishRetry = (copied) => {
                      backend.finishRetry = null;
                      backend.pending = false;
                      if (copied) {
                        resolve();
                      } else {
                        reject(
                          new DOMException("Controlled clipboard rejection", "NotAllowedError"),
                        );
                      }
                    };
                  });
                },
              },
            });
            document.execCommand = ((command: string) => {
              if (command === "copy") {
                backend.legacyCalls += 1;
              }
              return false;
            }) as typeof document.execCommand;
          }, firstCopied);
          await page.clock.install();
          clockInstalled = true;
          const gateway = await installMockGateway(page);
          await page.goto(`${suite.server.baseUrl}settings/about`);
          await waitForControlUiGatewayReady(page);
          const strip = page.locator('dl[aria-label="Control UI build details"]');
          const copy = strip.locator(".about-commit__copy");
          const tooltip = strip.locator(".about-commit > openclaw-tooltip");
          await copy.waitFor();
          const original = await copy.elementHandle();
          if (!original) {
            throw new Error("About copy button is missing");
          }
          const readState = () =>
            original.evaluate(async (element) => {
              const owner = element.closest("openclaw-about-page") as
                | (HTMLElement & { updateComplete: Promise<unknown> })
                | null;
              if (!owner) {
                throw new Error("About copy button lost its rendered owner");
              }
              await owner.updateComplete;
              return {
                connected: element.isConnected,
                label: element.getAttribute("aria-label"),
                busy: element.getAttribute("aria-busy"),
                disabled: (element as HTMLButtonElement).disabled,
              };
            });
          const readBackend = () =>
            page.evaluate(() => {
              const { writes, legacyCalls, pending } = (window as AboutCopyWindow).aboutCopyBackend;
              return { writes, legacyCalls, pending };
            });
          const firstLabel = firstCopied ? "Commit hash copied" : "Could not copy commit hash";
          const resultLabel = retryCopied ? "Commit hash copied" : "Could not copy commit hash";
          const state = (label: string, busy: string | null = null, disabled = false) => ({
            connected: true,
            label,
            busy,
            disabled,
          });
          const copying = state("Copying commit hash", "true", true);
          await pauseVirtualClock(page);

          await copy.click();
          await expect.poll(readState).toEqual(state(firstLabel));
          expect((await readBackend()).writes).toEqual([COMMIT]);
          await copy.click();
          await expect.poll(readState).toEqual(copying);
          expect(await readBackend()).toMatchObject({ writes: [COMMIT, COMMIT], pending: true });
          await page.clock.runFor(1_801);
          const afterOldDeadline = await readState();
          expect(await readBackend()).toMatchObject({ writes: [COMMIT, COMMIT], pending: true });
          expect.soft(afterOldDeadline).toEqual(copying);

          const capture = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
          if (capture) {
            await page.mouse.move(0, 0);
            await copy.hover();
            await page.clock.runFor(200);
            await expectAttribute(tooltip, "open").toBe("");
            await expectText(tooltip.locator(".tooltip-content")).toBe(afterOldDeadline.label);
            await page.screenshot({ path: path.join(suite.artifactDir, `${prior}-pending.png`) });
            expect((await readBackend()).pending).toBe(true);
          }
          await page.evaluate(
            (copied) => (window as AboutCopyWindow).aboutCopyBackend.finishRetry?.(copied),
            retryCopied,
          );
          const result = state(resultLabel);
          await expect.poll(readState).toEqual(result);
          expect(await readBackend()).toEqual({
            writes: [COMMIT, COMMIT],
            legacyCalls: 1,
            pending: false,
          });
          expect(await copy.evaluate((element, retained) => element === retained, original)).toBe(
            true,
          );
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
          if (capture) {
            await expectText(tooltip.locator(".tooltip-content")).toBe(resultLabel);
            await page.screenshot({ path: path.join(suite.artifactDir, `${prior}-result.png`) });
          }
          await page.clock.runFor(1_799);
          expect(await readState()).toEqual(result);
          await page.clock.runFor(1);
          await expect.poll(readState).toEqual(state("Copy full commit hash"));
        },
        async ({ page }) => {
          await page.evaluate(
            (copied) => (window as AboutCopyWindow).aboutCopyBackend?.finishRetry?.(copied),
            retryCopied,
          );
          if (clockInstalled) {
            await page.clock.resume();
          }
        },
      );
    },
  );

  it("shows browser artifact identity separately from the Gateway version", async () => {
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    await installMockGateway(page);

    try {
      const response = await page.goto(`${suite.server.baseUrl}settings/about`);
      expect(response?.status()).toBe(200);
      await showHeading(page, "Settings");

      const aboutLink = page.getByRole("link", { name: "About", exact: true });
      await expectAttribute(aboutLink, "aria-current").toBe("page");

      const strip = page.locator('dl[aria-label="Control UI build details"]');
      const items = strip.locator(":scope > dd");
      await expectCount(items).toBe(3);
      await expectText(items.nth(0)).toContain("2026.7.10");

      const commit = items.nth(1).locator("code");
      await expectText(commit).toBe(COMMIT.slice(0, 12));
      await expectAttribute(commit, "title").toBe(COMMIT);

      const [versionLabelBox, versionValueBox, commitBox, commitAgeBox] = await Promise.all([
        strip.locator(":scope > dt").first().boundingBox(),
        items.first().boundingBox(),
        commit.boundingBox(),
        items.nth(1).locator(".about-commit__age").boundingBox(),
      ]);
      expect(versionLabelBox).not.toBeNull();
      expect(versionValueBox).not.toBeNull();
      expect(commitBox).not.toBeNull();
      expect(commitAgeBox).not.toBeNull();
      expect(versionValueBox!.x - (versionLabelBox!.x + versionLabelBox!.width)).toBeLessThan(32);
      expect(commitAgeBox!.x - (commitBox!.x + commitBox!.width)).toBeLessThan(12);

      const built = items.nth(2).locator("time");
      await expectText(built).toBe("Jul 10, 2026");
      await expectAttribute(built, "datetime").toBe(BUILT_AT);
      await expectAttribute(built, "title").toBe(BUILT_AT);

      const gatewayRow = page.locator(".settings-row", { hasText: "Connected Gateway version" });
      await expectText(gatewayRow).toContain("e2e");
      await expectText(gatewayRow).toContain("separate from this Control UI build");

      const clawd = page.getByRole("button", { name: "Wave hello to Clawd" });
      // CLAWD_WAVE_MS clears the class after 1400ms, so click and read it in one browser step.
      const clawdWaving = await clawd.evaluate(async (element) => {
        const button = element as HTMLButtonElement;
        const owner = element.closest("openclaw-about-page") as
          | (HTMLElement & {
              updateComplete: Promise<unknown>;
            })
          | null;
        if (!owner) {
          throw new Error("About page owner is unavailable");
        }
        button.click();
        await owner.updateComplete;
        return button.classList.contains("about-hero__clawd--wave");
      });
      expect(clawdWaving).toBe(true);

      await page.setViewportSize({ height: 812, width: 375 });
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          ),
        )
        .toBeLessThanOrEqual(1);
    } finally {
      await context.close();
    }
  });
});
