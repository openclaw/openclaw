import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { pauseVirtualClock, startControlUiE2eServer } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { named } from "./plugins-settings-admin.test-support.ts";

const capture = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const groups = [
  "settings",
  "controls",
  "feedback",
  "icons",
  "loading",
  "skeleton-structure",
  "skeleton-content",
  "skeleton-conversation",
];
const suite = createControlUiE2eSuite({
  name: "presentation primitives",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
});

async function captureGroup(page: Page, name: string) {
  if (!capture) {
    return;
  }
  const surface = page.locator(".presentation-fixture");
  // Keep the responsive width while fitting the complete, bounded gallery group.
  // The loading primitives cap their viewport-dependent minimum at 360px.
  const height = await surface.evaluate(
    (element) => Math.ceil(element.getBoundingClientRect().height) + 32,
  );
  expect(height).toBeLessThan(5000);
  const frame = await takeControlUiScreenshotFrame(page, surface, [surface.locator("h1").first()], {
    viewport: { width: page.viewportSize()!.width, height: Math.max(900, height) },
    elements: [surface],
    animations: "disabled",
  });
  await writeFile(path.join(suite.artifactDir, `${name}.png`), frame.elements[0]!.png);
}

async function assertControlledInputs(page: Page) {
  const accepted = named(page, "switch", "Accept toggle");
  await page
    .locator(".settings-row__title")
    .filter({ hasText: /^Accept toggle$/ })
    .click();
  await expect.poll(() => accepted.isChecked()).toBe(true);
  expect(await page.locator("#fixture-outcome").textContent()).toBe("toggle:true");
  const rejected = named(page, "switch", "Rejected toggle");
  await page.locator(".settings-toggle").filter({ has: rejected }).click();
  expect(await rejected.isChecked()).toBe(false);
  expect(await page.locator("#fixture-outcome").textContent()).toBe("toggle:rejected");
  expect(await named(page, "switch", "Disabled toggle").isDisabled()).toBe(true);

  const quality = page
    .locator(".settings-row")
    .filter({
      has: page.locator(".settings-row__title").filter({ hasText: /^Quality$/ }),
    })
    .locator(".settings-segmented");
  expect(await named(page, "radiogroup", "Quality").count()).toBe(1);
  await quality.locator(".settings-segmented__btn").filter({ hasText: "Fast" }).click();
  await expect.poll(() => named(quality, "radio", "Fast").isChecked()).toBe(true);
  expect(await named(quality, "radio", "Unavailable").isDisabled()).toBe(true);
  const rejectedQuality = page
    .locator(".settings-row")
    .filter({
      has: page.locator(".settings-row__title").filter({ hasText: /^Rejected quality$/ }),
    })
    .locator(".settings-segmented");
  await rejectedQuality.locator(".settings-segmented__btn").filter({ hasText: "Fast" }).click();
  expect(await named(rejectedQuality, "radio", "Balanced").isChecked()).toBe(true);
  expect(await named(rejectedQuality, "radio", "Fast").isChecked()).toBe(false);
  const disabledQuality = page
    .locator(".settings-row")
    .filter({
      has: page.locator(".settings-row__title").filter({ hasText: /^Disabled quality$/ }),
    })
    .locator(".settings-segmented");
  expect(await named(disabledQuality, "radio", "Fast").isDisabled()).toBe(true);
}

async function assertSecretInput(page: Page) {
  const secret = named(page, "textbox", "Secret");
  await named(page, "button", "Toggle secret").click();
  await expect.poll(() => secret.getAttribute("type")).toBe("text");
  await secret.fill("changed-synthetic-token");
  await named(page, "button", "Toggle secret").click();
  expect(await page.locator('input[aria-label="Secret"]').inputValue()).toBe(
    "changed-synthetic-token",
  );
  expect(await page.locator('input[aria-label="Secret"]').getAttribute("type")).toBe("password");
}

async function assertFeedback(page: Page) {
  await named(page, "button", "Add file").click();
  expect(await page.locator("#fixture-outcome").textContent()).toBe("add-file");
  const error = page.locator('[data-example="Lazy error"]');
  await error.getByRole("button", { name: /retry/i }).click();
  expect(await page.locator("#fixture-outcome").textContent()).toBe("retry");
  await named(error, "button", "Close").click();
  expect(await page.locator("#fixture-outcome").textContent()).toBe("close");
  await error.locator("summary").click();
  expect(await error.locator("details").getAttribute("open")).not.toBeNull();
  expect(await error.locator("code").textContent()).toContain("Synthetic module failure");
  expect(
    await page.locator('[data-example="Refresh stale"] [role="status"]').textContent(),
  ).toContain("stale");
  expect(
    await page.locator('[data-example="Refresh failed"] [role="alert"]').textContent(),
  ).toContain("Synthetic refresh failure");
  expect(await named(page, "button", "Busy panel").isDisabled()).toBe(true);
  expect(await named(page, "button", "Busy panel").getAttribute("aria-busy")).toBe("true");
  expect(await page.locator("kbd").last().textContent()).toBe("Ctrl+K");
  const copy = page.locator('[data-example="Actions and shortcuts"] .chat-copy-btn').nth(0);
  await copy.click();
  await expect.poll(() => copy.getAttribute("data-copy-state")).toBe("copied");
  const failedCopy = page.locator('[data-example="Actions and shortcuts"] .chat-copy-btn').nth(1);
  await failedCopy.click();
  await expect.poll(() => failedCopy.getAttribute("data-copy-state")).toBe("error");
}

async function assertShadowParentStyles(page: Page, tag: string, selector: string) {
  const styles = await page
    .locator(tag)
    .first()
    .evaluate(async (host, childSelector) => {
      const parent = host.parentNode!;
      const next = host.nextSibling;
      const read = () => {
        const child = (host.shadowRoot ?? host).querySelector(childSelector)!;
        const style = getComputedStyle(child);
        return {
          background: style.backgroundColor,
          color: style.color,
          fontSize: style.fontSize,
          height: style.height,
          radius: style.borderRadius,
          overflow: style.overflow,
        };
      };
      const before = read();
      const container = document.createElement("div");
      container.style.width = `${host.getBoundingClientRect().width}px`;
      parent.insertBefore(container, host);
      container.attachShadow({ mode: "open" }).append(host);
      try {
        await (host as HTMLElement & { updateComplete: Promise<unknown> }).updateComplete;
        return { before, after: read() };
      } finally {
        parent.insertBefore(host, next);
        container.remove();
      }
    }, selector);
  expect(styles.after).toEqual(styles.before);
}

suite.define(() => {
  for (const theme of ["light", "dark"] as const) {
    for (const viewport of [
      { width: 1280, height: 900, name: "desktop" },
      { width: 390, height: 844, name: "mobile" },
    ]) {
      it(`Solid preserves presentation contracts in ${theme} ${viewport.name}`, async () => {
        await suite.withPage(
          {
            colorScheme: theme,
            viewport,
            locale: "en-US",
            reducedMotion: "reduce",
            serviceWorkers: "block",
          },
          async ({ page }) => {
            await page.clock.install();
            await pauseVirtualClock(page);
            await page.addInitScript(() => {
              Object.defineProperty(navigator, "clipboard", {
                configurable: true,
                value: { writeText: async () => {} },
              });
            });
            for (const group of groups) {
              await page.goto(
                `${suite.server.baseUrl}src/test-helpers/presentation-primitives-fixture.html?group=${group}&theme=${theme}`,
              );
              const surface = page.locator('.presentation-fixture[data-ready="true"]');
              await surface.waitFor();
              const brightness = await surface.evaluate((element) => {
                const channels = getComputedStyle(element).backgroundColor.match(/\d+/g)!;
                return channels.slice(0, 3).reduce((sum, value) => sum + Number(value), 0) / 3;
              });
              expect(theme === "light" ? brightness > 200 : brightness < 70).toBe(true);
              expect(await surface.locator("h1").first().textContent()).toBe(group);
              if (group === "settings") {
                expect(await named(page, "heading", "Presentation settings").count()).toBe(1);
                expect(
                  await named(page, "status", "Loading settings").getAttribute("aria-busy"),
                ).toBe("true");
                await page.getByRole("button", { name: /Advanced/ }).click();
                expect(await page.locator("#fixture-outcome").textContent()).toBe("advanced");
              } else if (group === "icons") {
                expect(
                  await surface
                    .locator("svg")
                    .evaluateAll((icons) =>
                      icons.every(
                        (icon) =>
                          icon.namespaceURI === "http://www.w3.org/2000/svg" &&
                          icon.getBoundingClientRect().width > 0 &&
                          icon.childElementCount > 0,
                      ),
                    ),
                ).toBe(true);
                expect(await surface.locator('[data-provider-icon="gemini"]').count()).toBe(1);
                expect(await surface.locator('[data-provider-icon="gcp"]').count()).toBe(1);
              } else if (group.startsWith("skeleton-")) {
                const skeletons = surface.locator("openclaw-panel-loading-skeleton");
                expect(await skeletons.count()).toBe(
                  group === "skeleton-content" ? 4 : group === "skeleton-conversation" ? 5 : 3,
                );
                expect(await skeletons.first().getAttribute("aria-busy")).toBe("true");
              }
              await captureGroup(page, `Solid-${theme}-${viewport.name}-${group}`);
              if (group === "controls") {
                await assertControlledInputs(page);
                await assertSecretInput(page);
                await captureGroup(page, `Solid-${theme}-${viewport.name}-controls-changed`);
                await page.evaluate(() => {
                  document.documentElement.dir = "rtl";
                });
                await captureGroup(page, `Solid-${theme}-${viewport.name}-controls-rtl`);
              } else if (group === "feedback") {
                await assertFeedback(page);
                await captureGroup(page, `Solid-${theme}-${viewport.name}-feedback-active`);
                await assertShadowParentStyles(
                  page,
                  "openclaw-panel-empty-state",
                  ".empty-state__title",
                );
              } else if (group === "skeleton-content") {
                await assertShadowParentStyles(
                  page,
                  "openclaw-panel-loading-skeleton",
                  ".skeleton.line",
                );
              }
            }
          },
        );
      });
    }
  }
});
