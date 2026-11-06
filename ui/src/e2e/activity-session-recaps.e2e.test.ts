import path from "node:path";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { pauseVirtualClock } from "../test-helpers/control-ui-e2e.ts";
import { expectAttribute, expectText } from "./activity-assertions.test-support.ts";
import { chatSessionListResponse, installMockGateway } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Rolling Activity recaps" });
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const ensureMethod = "sessions.activitySummary.ensure";
const key = "agent:main:activity-recap";
const oldText = "Duplicate notification repair needs verification.";
const newText = "Duplicate notification repair verified and merged.";
const session = (state: "current" | "stale" | "updating" | "unavailable", text = oldText) => ({
  key,
  kind: "direct" as const,
  label: "Repair duplicate notifications",
  agentId: "main",
  sessionId: "activity-recap-fixture",
  archived: true,
  updatedAt: Date.now() - 60_000,
  activitySummary: { state, canEnsure: true, text, updatedAt: Date.now() - 120_000 },
});
const ensuring = (text = oldText) => ({
  sessions: [{ key, agentId: "main", activitySummary: session("updating", text).activitySummary }],
});
async function openRecap(page: Page, readOnly = false) {
  const gateway = await installMockGateway(page, {
    sessionKey: key,
    ...(readOnly ? { operatorScopes: ["operator.read"] } : {}),
    methodResponses: {
      "sessions.list": chatSessionListResponse([session("stale")]),
      ...(readOnly ? {} : { [ensureMethod]: ensuring() }),
    },
  });
  await page.goto(`${suite.server.baseUrl}activity`);
  return { gateway, recap: page.locator(`[data-activity-recap="${key}"]`) };
}

suite.define(() => {
  it.each([1440, 390])(
    "keeps the recap visible while updating and publishes the final outcome at %s px",
    async (width) => {
      await suite.withPage(
        { viewport: { width, height: 1000 }, colorScheme: "light", locale: "en-US" },
        async ({ page }) => {
          const { gateway, recap } = await openRecap(page);
          await page.locator(`[data-activity-session="${key}"]`).waitFor();
          if (captureUiProof) {
            await page.screenshot({
              path: path.join(suite.artifactDir, `01-initial-${width}.png`),
            });
          }
          const publishRecap = async (state: "current" | "unavailable") => {
            await gateway.setSessionsListResponse(
              chatSessionListResponse([session(state, newText)]),
            );
            await gateway.emitGatewayEvent("sessions.changed", {
              sessionKey: key,
              reason: "activity-summary",
            });
            // Cross the refresh window and deliver its nested mock response timer.
            await page.clock.runFor(5_001);
          };
          await expectText(recap).toContain(oldText);
          await expectAttribute(recap, "data-state").toBe("updating");
          const requests = await gateway.getRequests(ensureMethod);
          expect(requests.map(({ params }) => asNullableRecord(params)?.sessions)).toEqual([
            [{ key, agentId: "main" }],
          ]);
          expect(
            (await gateway.getRequests("sessions.list")).some(
              (request) => asNullableRecord(request.params)?.includeActivitySummary === true,
            ),
          ).toBe(true);
          if (captureUiProof) {
            await page.screenshot({
              path: path.join(suite.artifactDir, `02-updating-${width}.png`),
            });
          }
          const ordinaryListRequests = async () =>
            (await gateway.getRequests("sessions.list")).filter(
              (request) => asNullableRecord(request.params)?.includeActivitySummary !== true,
            ).length;
          const ordinaryListCount = await ordinaryListRequests();
          await page.clock.install();
          await pauseVirtualClock(page);

          await publishRecap("current");
          await expectText(recap).toContain(newText);
          await expectAttribute(recap, "data-state").toBe("current");
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          ).toBe(true);
          if (captureUiProof) {
            await page.screenshot({
              path: path.join(suite.artifactDir, `03-completed-${width}.png`),
            });
          }
          expect(await ordinaryListRequests()).toBe(ordinaryListCount);

          await publishRecap("unavailable");
          await expectAttribute(recap, "data-state").toBe("unavailable");
          expect(await recap.textContent()).toContain(newText);
          await page.clock.resume();
          await gateway.setMethodResponse(ensureMethod, ensuring(newText));
          await recap.getByRole("button", { name: "Retry recap", exact: true }).click();
          await expect.poll(async () => (await gateway.getRequests(ensureMethod)).length).toBe(2);
          await expectAttribute(recap, "data-state").toBe("updating");
          expect(await recap.textContent()).toContain(newText);
        },
      );
    },
  );

  it("shows cached recaps to read-only viewers without issuing generation requests", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, locale: "en-US" },
      async ({ page }) => {
        const { gateway, recap } = await openRecap(page, true);
        await expectText(recap).toContain(oldText);
        expect(await recap.getByRole("button").count()).toBe(0);
        expect(await gateway.getRequests(ensureMethod)).toEqual([]);
      },
    );
  });
});
