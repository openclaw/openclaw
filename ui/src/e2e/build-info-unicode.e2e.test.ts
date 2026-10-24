// Control UI tests keep build identity readable at UTF-16 truncation boundaries.
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway, startControlUiE2eServer } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const BUILD_ID = "build-info-unicode-e2e";

const suite = createControlUiE2eSuite({
  name: "Control UI Unicode build identity mocked Gateway E2E",
  startServer: () =>
    startControlUiE2eServer({
      version: "2026.7.10",
      commit: "0123456789abcdef0123456789abcdef01234567",
      commitAt: "2026-07-10T11:22:33.000Z",
      builtAt: "2026-07-10T12:34:56.000Z",
      branch: RAW_BRANCH,
      dirty: true,
      release: false,
      buildId: BUILD_ID,
    }),
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const RAW_BRANCH = `${"a".repeat(12)}😀${"b".repeat(85)}😀suffix`;
const NORMALIZED_BRANCH = `${"a".repeat(12)}😀${"b".repeat(85)}`;
const COMPACT_BRANCH = `${"a".repeat(12)}😀…`;

async function openBuildDetails(page: Page) {
  const sidebar = page.locator("openclaw-app-sidebar");
  await sidebar.getByRole("button", { name: /^Identity and app menu for / }).click();
  const buildLink = sidebar.getByRole("menuitem", {
    name: "Control UI build details",
    exact: true,
  });
  await buildLink.waitFor();
  const compactText = (await buildLink.textContent()) ?? "";
  expect(compactText).toContain(`${COMPACT_BRANCH}@0123456`);
  // Unicode mode consumes valid surrogate pairs as one code point.
  expect(compactText).not.toMatch(/�|[\uD800-\uDFFF]/u);

  await buildLink.hover();
  const tooltip = sidebar.locator(
    "openclaw-sidebar-build-chip openclaw-tooltip .tooltip-surface[popover]",
  );
  await expect
    .poll(() => tooltip.evaluate((element) => element.matches(":popover-open")))
    .toBe(true);
  const buildLinkHandle = await buildLink.elementHandle();
  if (!buildLinkHandle) {
    throw new Error("Expected the identity-menu build link to be attached");
  }
  const afterHideMarker = "data-openclaw-test-after-hide";
  await tooltip.evaluate((element, marker) => {
    element.removeAttribute(marker);
    element.addEventListener("overlay-after-hide", () => element.setAttribute(marker, ""), {
      once: true,
    });
  }, afterHideMarker);
  await page.mouse.down();
  await expect
    .poll(() =>
      tooltip.evaluate((element, marker) => element.hasAttribute(marker), afterHideMarker),
    )
    .toBe(true);
  expect(await buildLinkHandle.evaluate((element) => element.isConnected)).toBe(true);
  await tooltip.evaluate((element, marker) => element.removeAttribute(marker), afterHideMarker);
  await page.mouse.up();
  await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/about");
}

async function assertFullBranchLabel(page: Page) {
  const branchValue = page
    .locator(".settings-kv dt", { hasText: "Branch" })
    .locator("xpath=following-sibling::dd[1]/code");
  await branchValue.waitFor();
  expect(await branchValue.textContent()).toBe(`${NORMALIZED_BRANCH}*`);
}

suite.define(() => {
  it("keeps slow build-link navigation intact across Unicode boundaries and reload", async () =>
    suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      await installMockGateway(page, { serverBuildId: BUILD_ID, serverVersion: "2026.7.10" });

      const response = await page.goto(`${suite.server.baseUrl}chat`);
      expect(response?.status()).toBe(200);
      const identityCard = page.locator(".sidebar-identity-card");
      await expect
        .poll(async () => {
          const ariaLabel = (await identityCard.getAttribute("aria-label")) ?? "";
          const detail = ariaLabel.split(": ").slice(1).join(": ");
          const [gitIdentity, relativeAge] = detail.trim().split(" · ", 2);
          return { gitIdentity, hasRelativeAge: Boolean(relativeAge?.trim()) };
        })
        .toEqual({
          gitIdentity: `${COMPACT_BRANCH}@0123456*`,
          hasRelativeAge: true,
        });

      await openBuildDetails(page);
      await assertFullBranchLabel(page);
      await page.reload();
      await assertFullBranchLabel(page);
    }));
});
