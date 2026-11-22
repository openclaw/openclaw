import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { usageTotals, buildAggregatesFromSessions } from "../pages/usage/view.test-support.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { rasterizeProofAnnotations } from "../test-helpers/proof-annotations.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installUsageOverviewGateway } from "./usage-overview-fixture.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Usage error definitions proof",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

suite.define(() => {
  it("defines which recorded errors the Usage rate and count include", async () => {
    const errorRateHint =
      "Recorded tool-result errors and assistant messages stopped for error, abort, or timeout ÷ total messages. Failed attempts with no recorded message are not included.";
    const errorsHint =
      "Counts tool-result errors and assistant messages stopped for error, abort, or timeout in this range. Attempts that fail before a message is recorded are excluded.";
    await suite.withPage(
      {
        locale: "en-US",
        timezoneId: "UTC",
        viewport: { width: 1440, height: 1100 },
        serviceWorkers: "block",
      },
      async ({ page }) => {
        const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
        const artifactDir = captureProof
          ? createControlUiE2eArtifactDir("usage-error-rate", suite.artifactDir)
          : null;
        const updatedAt = Date.parse("2026-08-07T12:00:00Z");
        await page.clock.setFixedTime(new Date(updatedAt));
        const sessions = [
          {
            key: "agent:main:user-only",
            label: "User-only session",
            agentId: "main",
            updatedAt,
            usage: {
              ...usageTotals(0, 0),
              firstActivity: updatedAt,
              messageCounts: {
                total: 3,
                user: 3,
                assistant: 0,
                toolCalls: 0,
                toolResults: 0,
                errors: 0,
              },
            },
          },
        ];
        await installUsageOverviewGateway(page, {
          methodResponses: {
            "sessions.usage": {
              updatedAt,
              startDate: "2026-08-07",
              endDate: "2026-08-07",
              totals: usageTotals(0, 0),
              sessions,
              aggregates: buildAggregatesFromSessions(sessions),
            },
            "usage.status": { updatedAt: 1, providers: [] },
          },
        });
        await page.goto(`${suite.server.baseUrl}usage`);
        await waitForControlUiRoute(page, { routeId: "usage" });

        const hintButton = page.locator("#usage-summary-hint-error-rate");
        const card = page.locator(".usage-summary-card").filter({ has: hintButton });
        const tooltipHost = hintButton.locator("xpath=..");
        const tooltip = tooltipHost.locator(".tooltip-surface[popover]");
        const errorRateHintContent = tooltipHost.locator('[slot="content"]');
        await expect.poll(() => card.locator(".usage-summary-value").textContent()).toBe("0.00%");
        await expect
          .poll(() => card.locator(".usage-summary-sub").textContent())
          .toContain("0 errors");
        await card.evaluate((element) =>
          element.scrollIntoView({ block: "center", behavior: "instant" }),
        );
        await hintButton.click();
        await expect
          .poll(() => tooltip.evaluate((element) => element.matches(":popover-open")))
          .toBe(true);

        if (captureProof) {
          const frame = await takeControlUiScreenshotFrame(
            page,
            page.locator("body"),
            [card, tooltip],
            { animations: "disabled", elements: [card, tooltip] },
          );
          const viewport = page.viewportSize()!;
          const scale = await page.evaluate(() => window.devicePixelRatio);
          const annotations = [
            {
              kind: "outline" as const,
              rect: frame.elements[1]!.bounds,
              text: "Error-rate definition",
              labelAt: { x: 600, y: 300 },
              color: "#3B82A0",
            },
          ];
          const annotated = await rasterizeProofAnnotations(suite.browser, {
            viewport,
            scale,
            annotations,
            image: frame.png,
          });
          await writeFile(path.join(artifactDir!, "usage-error-rate.png"), frame.png);
          await writeFile(path.join(artifactDir!, "usage-error-rate-annotated.png"), annotated);
          await writeFile(
            path.join(artifactDir!, "usage-error-rate-frame.json"),
            `${JSON.stringify({ viewport, scale, annotations }, null, 2)}\n`,
          );
        }
        await expect.poll(() => errorRateHintContent.textContent()).toBe(errorRateHint);

        const errorsButton = page.locator("#usage-summary-hint-errors");
        const errorsCard = page.locator(".usage-summary-card").filter({ has: errorsButton });
        const errorsTooltipHost = errorsButton.locator("xpath=..");
        const errorsTooltip = errorsTooltipHost.locator(".tooltip-surface[popover]");
        const errorsHintContent = errorsTooltipHost.locator('[slot="content"]');
        await expect.poll(() => errorsCard.locator(".usage-summary-value").textContent()).toBe("0");
        await errorsButton.click();
        await expect
          .poll(() => errorsTooltip.evaluate((element) => element.matches(":popover-open")))
          .toBe(true);
        await expect.poll(() => errorsHintContent.textContent()).toBe(errorsHint);
        if (captureProof) {
          const frame = await takeControlUiScreenshotFrame(
            page,
            page.locator("body"),
            [errorsCard, errorsTooltip],
            { animations: "disabled", elements: [errorsCard, errorsTooltip] },
          );
          const viewport = page.viewportSize()!;
          const scale = await page.evaluate(() => window.devicePixelRatio);
          const annotations = [
            {
              kind: "outline" as const,
              rect: frame.elements[1]!.bounds,
              text: "Errors count definition",
              labelAt: { x: 600, y: 300 },
              color: "#3B82A0",
            },
          ];
          const annotated = await rasterizeProofAnnotations(suite.browser, {
            viewport,
            scale,
            annotations,
            image: frame.png,
          });
          await writeFile(path.join(artifactDir!, "usage-errors-count.png"), frame.png);
          await writeFile(path.join(artifactDir!, "usage-errors-count-annotated.png"), annotated);
          await writeFile(
            path.join(artifactDir!, "usage-errors-count-frame.json"),
            `${JSON.stringify({ viewport, scale, annotations }, null, 2)}\n`,
          );
        }
      },
    );
  });
});
