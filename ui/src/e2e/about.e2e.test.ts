// Control UI tests cover About artifact identity against a mocked Gateway.
import path from "node:path";
import { expect, it } from "vitest";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { installMockGateway, pauseVirtualClock } from "../test-helpers/control-ui-e2e.ts";
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
          const strip = page.getByRole("group", { name: "Control UI build details" });
          const copy = strip.locator(".about-commit__copy");
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
              const backend = (window as AboutCopyWindow).aboutCopyBackend;
              return {
                writes: backend.writes,
                legacyCalls: backend.legacyCalls,
                pending: backend.pending,
              };
            });
          const firstLabel = firstCopied ? "Commit hash copied" : "Could not copy commit hash";
          const resultLabel = retryCopied ? "Commit hash copied" : "Could not copy commit hash";
          const copying = {
            connected: true,
            label: "Copying commit hash",
            busy: "true",
            disabled: true,
          };
          await pauseVirtualClock(page);
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);

          await copy.click();
          await expect
            .poll(readState)
            .toEqual({ connected: true, label: firstLabel, busy: null, disabled: false });
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
            await expect
              .poll(() => strip.locator(".about-commit > openclaw-tooltip").getAttribute("open"))
              .toBe("");
            await expect
              .poll(() =>
                strip.locator(".about-commit > openclaw-tooltip .tooltip-content").textContent(),
              )
              .toBe(afterOldDeadline.label);
            await page.screenshot({ path: path.join(suite.artifactDir, `${prior}-pending.png`) });
            expect((await readBackend()).pending).toBe(true);
          }
          await page.evaluate(
            (copied) => (window as AboutCopyWindow).aboutCopyBackend.finishRetry?.(copied),
            retryCopied,
          );
          const result = { connected: true, label: resultLabel, busy: null, disabled: false };
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
            await expect
              .poll(() =>
                strip.locator(".about-commit > openclaw-tooltip .tooltip-content").textContent(),
              )
              .toBe(resultLabel);
            await page.screenshot({ path: path.join(suite.artifactDir, `${prior}-result.png`) });
          }
          console.info(
            "[about-copy-proof] " +
              JSON.stringify({
                prior,
                afterOldDeadline,
                result: await readState(),
                backend: await readBackend(),
                pendingAdvanceBeforeSnapshotMs: 1_801,
                mediaInspected: false,
              }),
          );
          await page.clock.runFor(1_799);
          expect(await readState()).toEqual(result);
          await page.clock.runFor(1);
          await expect.poll(readState).toEqual({
            connected: true,
            label: "Copy full commit hash",
            busy: null,
            disabled: false,
          });
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

  it("shows and copies browser artifact identity, separately from the Gateway version", async () => {
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            (globalThis as typeof globalThis & { __openclawCopiedCommit?: string })[
              "__openclawCopiedCommit"
            ] = text;
          },
        },
      });
    });
    const page = await context.newPage();
    await installMockGateway(page);

    try {
      const response = await page.goto(`${suite.server.baseUrl}settings/about`);
      expect(response?.status()).toBe(200);
      await page.getByRole("heading", { name: "Settings" }).waitFor();

      const aboutLink = page.getByRole("link", { name: "About", exact: true });
      await expect.poll(() => aboutLink.getAttribute("aria-current")).toBe("page");

      const strip = page.getByRole("group", { name: "Control UI build details" });
      const items = strip.locator(":scope > dd");
      await expect.poll(() => items.count()).toBe(3);
      await expect.poll(() => items.nth(0).textContent()).toContain("2026.7.10");

      const commit = items.nth(1).locator("code");
      await expect.poll(() => commit.textContent()).toBe(COMMIT.slice(0, 12));
      await expect.poll(() => commit.getAttribute("title")).toBe(COMMIT);

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
      await expect.poll(() => built.textContent()).toBe("Jul 10, 2026");
      await expect.poll(() => built.getAttribute("datetime")).toBe(BUILT_AT);
      await expect.poll(() => built.getAttribute("title")).toBe(BUILT_AT);

      const gatewayRow = page.locator(".settings-row", { hasText: "Connected Gateway version" });
      await expect.poll(() => gatewayRow.textContent()).toContain("e2e");
      await expect
        .poll(() => gatewayRow.textContent())
        .toContain("separate from this Control UI build");

      const hero = page.locator(".about-hero");
      await expect.poll(() => hero.locator(".about-hero__name").textContent()).toBe("OpenClaw");
      await expect
        .poll(() => hero.locator(".about-hero__version").textContent())
        .toBe("v2026.7.10");

      const githubLink = hero.getByRole("link", { name: "GitHub", exact: true });
      await expect
        .poll(() => githubLink.getAttribute("href"))
        .toBe("https://github.com/openclaw/openclaw");
      await expect.poll(() => githubLink.getAttribute("target")).toBe("_blank");
      await expect.poll(() => githubLink.getAttribute("rel")).toContain("noopener");
      const discordLink = hero.getByRole("link", { name: "Discord", exact: true });
      await expect.poll(() => discordLink.getAttribute("href")).toBe("https://discord.gg/clawd");
      const xLink = hero.getByRole("link", { name: "X (Twitter)", exact: true });
      await expect.poll(() => xLink.getAttribute("href")).toBe("https://x.com/openclaw");

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

      await expect.poll(() => page.locator(".about-footer").textContent()).toContain("MIT License");

      const copyButton = strip.locator(".about-commit button");
      await expect.poll(() => copyButton.getAttribute("aria-label")).toBe("Copy full commit hash");
      // COPY_RESULT_VISIBLE_MS clears the copied label after 1800ms. Await both the
      // initial copying render and the async clipboard continuation before reading it.
      const copiedLabel = await copyButton.evaluate(async (element) => {
        const button = element as HTMLButtonElement;
        const owner = element.closest("openclaw-about-page") as
          | (HTMLElement & {
              updateComplete: Promise<unknown>;
            })
          | null;
        if (!owner) {
          throw new Error("About page owner is unavailable");
        }
        let copyObserver: MutationObserver | undefined;
        const copySettled = new Promise<void>((resolve) => {
          copyObserver = new MutationObserver(() => {
            if (button.getAttribute("aria-busy") !== "true") {
              copyObserver?.disconnect();
              resolve();
            }
          });
          copyObserver.observe(button, {
            attributeFilter: ["aria-busy", "aria-label"],
            attributes: true,
          });
        });
        button.click();
        await owner.updateComplete;
        if (button.getAttribute("aria-busy") === "true") {
          await copySettled;
        }
        copyObserver?.disconnect();
        await owner.updateComplete;
        return button.getAttribute("aria-label");
      });
      expect(copiedLabel).toBe("Commit hash copied");
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (globalThis as typeof globalThis & { __openclawCopiedCommit?: string })[
                "__openclawCopiedCommit"
              ],
          ),
        )
        .toBe(COMMIT);

      await page.setViewportSize({ height: 812, width: 375 });
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          ),
        )
        .toBeLessThanOrEqual(1);
      const mobileScreenshot = await page.screenshot({ animations: "disabled", fullPage: true });
      expect(mobileScreenshot.byteLength).toBeGreaterThan(1_000);
    } finally {
      await context.close();
    }
  });
});
