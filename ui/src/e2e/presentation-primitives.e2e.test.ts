import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { pauseVirtualClock, startControlUiE2eServer } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

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
  if (!capture) return;
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
  const accepted = page.getByRole("switch", { name: "Accept toggle", exact: true });
  await page
    .locator(".settings-row__title")
    .filter({ hasText: /^Accept toggle$/ })
    .click();
  await expect.poll(() => accepted.isChecked()).toBe(true);
  expect(await page.locator("#fixture-outcome").textContent()).toBe("toggle:true");
  const rejected = page.getByRole("switch", { name: "Rejected toggle", exact: true });
  await rejected.click();
  expect(await rejected.isChecked()).toBe(false);
  expect(await page.locator("#fixture-outcome").textContent()).toBe("toggle:rejected");
  expect(
    await page.getByRole("switch", { name: "Disabled toggle", exact: true }).isDisabled(),
  ).toBe(true);

  const quality = page.getByRole("radiogroup", { name: "Quality", exact: true });
  await quality.getByRole("radio", { name: "Fast", exact: true }).click();
  await expect
    .poll(() => quality.getByRole("radio", { name: "Fast", exact: true }).isChecked())
    .toBe(true);
  expect(await quality.getByRole("radio", { name: "Unavailable", exact: true }).isDisabled()).toBe(
    true,
  );
  const rejectedQuality = page.getByRole("radiogroup", { name: "Rejected quality", exact: true });
  await rejectedQuality.getByRole("radio", { name: "Fast", exact: true }).click();
  expect(
    await rejectedQuality.getByRole("radio", { name: "Balanced", exact: true }).isChecked(),
  ).toBe(true);
  expect(await rejectedQuality.getByRole("radio", { name: "Fast", exact: true }).isChecked()).toBe(
    false,
  );
  const disabledQuality = page.getByRole("radiogroup", { name: "Disabled quality", exact: true });
  expect(await disabledQuality.getByRole("radio", { name: "Fast", exact: true }).isDisabled()).toBe(
    true,
  );
  const secret = page.getByRole("textbox", { name: "Secret", exact: true });
  await page.getByRole("button", { name: "Toggle secret", exact: true }).click();
  await expect.poll(() => secret.getAttribute("type")).toBe("text");
  await secret.fill("changed-synthetic-token");
  await page.getByRole("button", { name: "Toggle secret", exact: true }).click();
  expect(await page.locator('input[aria-label="Secret"]').inputValue()).toBe(
    "changed-synthetic-token",
  );
  expect(await page.locator('input[aria-label="Secret"]').getAttribute("type")).toBe("password");
}

async function assertFeedback(page: Page) {
  await page.getByRole("button", { name: "Add file", exact: true }).click();
  expect(await page.locator("#fixture-outcome").textContent()).toBe("add-file");
  const error = page.locator('[data-example="Lazy error"]');
  await error.getByRole("button", { name: /retry/i }).click();
  expect(await page.locator("#fixture-outcome").textContent()).toBe("retry");
  await error.getByRole("button", { name: "Close", exact: true }).click();
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
  expect(await page.getByRole("button", { name: "Busy panel", exact: true }).isDisabled()).toBe(
    true,
  );
  expect(
    await page.getByRole("button", { name: "Busy panel", exact: true }).getAttribute("aria-busy"),
  ).toBe("true");
  expect(await page.locator("kbd").last().textContent()).toBe("Ctrl+K");
  const copy = page.locator('[data-example="Actions and shortcuts"] .chat-copy-btn').nth(0);
  await copy.click();
  await expect.poll(() => copy.getAttribute("data-copy-state")).toBe("copied");
  const failedCopy = page.locator('[data-example="Actions and shortcuts"] .chat-copy-btn').nth(1);
  await failedCopy.click();
  await expect.poll(() => failedCopy.getAttribute("data-copy-state")).toBe("error");
}

suite.define(() => {
  for (const renderer of ["Lit", "Solid"]) {
    for (const theme of ["light", "dark"] as const) {
      for (const viewport of [
        { width: 1280, height: 900, name: "desktop" },
        { width: 390, height: 844, name: "mobile" },
      ]) {
        it(`${renderer} preserves presentation contracts in ${theme} ${viewport.name}`, async () => {
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
                  `${suite.server.baseUrl}src/test-helpers/presentation-primitives-fixture.html?renderer=${renderer.toLowerCase()}&group=${group}&theme=${theme}`,
                );
                const surface = page.locator('.presentation-fixture[data-ready="true"]');
                await surface.waitFor();
                expect(await surface.locator("h1").first().textContent()).toBe(group);
                if (group === "settings") {
                  expect(
                    await page
                      .getByRole("heading", { name: "Presentation settings", exact: true })
                      .count(),
                  ).toBe(1);
                  expect(
                    await page
                      .getByRole("status", { name: "Loading settings", exact: true })
                      .getAttribute("aria-busy"),
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
                await captureGroup(page, `${renderer}-${theme}-${viewport.name}-${group}`);
                if (group === "controls") {
                  await assertControlledInputs(page);
                  await captureGroup(
                    page,
                    `${renderer}-${theme}-${viewport.name}-controls-changed`,
                  );
                  await page.evaluate(() => {
                    document.documentElement.dir = "rtl";
                  });
                  await captureGroup(page, `${renderer}-${theme}-${viewport.name}-controls-rtl`);
                } else if (group === "feedback") {
                  await assertFeedback(page);
                  await captureGroup(page, `${renderer}-${theme}-${viewport.name}-feedback-active`);
                }
              }
            },
          );
        });
      }
    }
  }
});
