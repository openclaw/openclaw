import type { Locator } from "playwright";
import { expect } from "playwright/test";
import { it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { presentResult } from "./activity-run-inspector.test-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Activity reading layout",
  startServerBeforeBrowser: true,
});
const phone = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const enlargedText = () => ({
  afterInitScript:
    ";localStorage.setItem(" +
    JSON.stringify(controlUiBundledSettingsStorageKey(suite.server.baseUrl)) +
    "," +
    JSON.stringify(JSON.stringify({ textScale: 140 })) +
    ");",
});
async function expectReadableWithin(label: Locator, column: Locator) {
  const bounds = await column.boundingBox();
  expect(bounds).not.toBeNull();
  const lines = await label.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    return [...range.getClientRects()].map(({ left, right }) => ({ left, right }));
  });
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    expect(line.left).toBeGreaterThanOrEqual(bounds!.x - 1);
    expect(line.right).toBeLessThanOrEqual(bounds!.x + bounds!.width + 1);
  }
}
const fontSize = (element: Locator) =>
  element.evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize));
suite.define(() => {
  it("keeps the end of a running session title and key clear of its state", () =>
    suite.withPage(phone, async ({ page }) => {
      const key = "agent:main:regionalaccessibilityandinterpretationserviceintegrationreview01";
      const row = {
        key,
        sessionId: "review-1",
        kind: "direct",
        status: "running",
        hasActiveRun: true,
        updatedAt: Date.now(),
        label: "Regional accessibility and interpretation service rollout — review translations",
      };
      await installMockGateway(page, { sessions: [row] }, enlargedText());
      await page.goto(suite.server.baseUrl + "activity?view=live");
      const link = page.locator(".activity-current-work__row").filter({ hasText: row.label });
      await expect(link).toBeVisible();
      const column = link.locator(".activity-current-work__copy"),
        label = link.locator(".activity-current-work__title");
      await expectReadableWithin(label, column);
      await expectReadableWithin(link.locator(".activity-current-work__agent"), column);
      expect(await fontSize(label)).toBeCloseTo(19.6, 1);
      await expect(link).toContainText("Running");
      await page.getByRole("tab", { name: "Sessions", exact: true }).tap();
      const feedRow = page
        .locator("[data-activity-session]")
        .filter({ hasText: row.label })
        .first();
      const feedTitle = feedRow.locator(".activity-feed__session-title");
      await expect(feedTitle).toHaveText(row.label);
      await expectReadableWithin(feedTitle, feedRow.locator(".activity-feed__session-main"));
      expect(await fontSize(feedTitle)).toBeCloseTo(19.6, 1);
    }));
  it("shows the full person name and address beside the connection status", () =>
    suite.withPage(phone, async ({ page }) => {
      const person = {
        id: "reader",
        name: "Riley Alexandria Montgomery del Rosario — Regional Interpretation Team",
        email: "regionalaccessibilityandinterpretationservices@identity.example.test",
        identity: { type: "profile" as const, id: "reader" },
      };
      await installMockGateway(page, { presenceUsers: [person] }, enlargedText());
      await page.goto(suite.server.baseUrl + "activity/reader");
      const card = page.locator('[data-activity-identity="reader"]'),
        column = card.locator(".activity-feed__identity-copy");
      await expect(column.locator("p")).toHaveText(person.email);
      await expectReadableWithin(column.locator("h2"), column);
      await expectReadableWithin(column.locator("p"), column);
    }));
  it("scales the warning, evidence and selected receipt with the reading preference", () =>
    suite.withPage(phone, async ({ page }) => {
      const run = "activity-reading-proof";
      await installMockGateway(
        page,
        {
          featureMethods: ["audit.run.inspect"],
          methodResponses: { "audit.run.inspect": presentResult(run) },
        },
        enlargedText(),
      );
      await page.goto(suite.server.baseUrl + "activity?view=run&run=" + run);
      const panel = page.locator(".run-inspector");
      await expect(panel.locator(".run-inspector__facts").first()).toBeVisible();
      expect(
        await fontSize(panel.locator(".run-inspector__warning[role=note]").first()),
      ).toBeCloseTo(19.6, 1);
      expect(await fontSize(panel.locator(".run-inspector__ref").first())).toBeCloseTo(19.6, 1);
      await panel.locator(".run-inspector__receipt-list a").first().tap();
      expect(await fontSize(panel.locator(".run-inspector__receipt-detail p").first())).toBeCloseTo(
        19.6,
        1,
      );
    }));
});
