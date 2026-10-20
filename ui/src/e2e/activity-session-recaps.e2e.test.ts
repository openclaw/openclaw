import path from "node:path";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { chatSessionListResponse, installMockGateway } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Rolling Activity recaps" });
const ensureMethod = "sessions.activitySummary.ensure";
const key = "agent:main:activity-recap";
const oldText =
  "Traced duplicate notifications to reconnect handling. The repair still needs verification.";
const newText =
  "Fixed duplicate notifications after reconnecting. Regression checks passed and the pull request was merged.";
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

suite.define(() => {
  it.each([1440, 390])(
    "keeps the recap visible while updating and publishes the final outcome at %s px",
    async (width) => {
      await suite.withPage(
        { viewport: { width, height: 1000 }, colorScheme: "light", locale: "en-US" },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            sessionKey: key,
            methodResponses: {
              "sessions.list": chatSessionListResponse([session("stale")]),
              [ensureMethod]: {
                sessions: [
                  { key, agentId: "main", activitySummary: session("updating").activitySummary },
                ],
              },
            },
          });
          await page.goto(`${suite.server.baseUrl}activity`);
          await page.locator(`[data-activity-session="${key}"]`).waitFor();
          await page.screenshot({ path: path.join(suite.artifactDir, `01-initial-${width}.png`) });
          const recap = page.locator(`[data-activity-recap="${key}"]`);
          await expect.poll(() => recap.textContent()).toContain(oldText);
          await expect.poll(() => recap.getAttribute("data-state")).toBe("updating");
          const requests = await gateway.getRequests(ensureMethod);
          expect(requests).toHaveLength(1);
          expect(asNullableRecord(requests[0]?.params)?.sessions).toEqual([
            { key, agentId: "main" },
          ]);
          expect(
            (await gateway.getRequests("sessions.list")).some(
              (request) => asNullableRecord(request.params)?.includeActivitySummary === true,
            ),
          ).toBe(true);
          await page.screenshot({ path: path.join(suite.artifactDir, `02-updating-${width}.png`) });
          const ordinaryListRequests = async () =>
            (await gateway.getRequests("sessions.list")).filter(
              (request) => asNullableRecord(request.params)?.includeActivitySummary !== true,
            ).length;
          const ordinaryListCount = await ordinaryListRequests();

          await gateway.setSessionsListResponse(
            chatSessionListResponse([session("current", newText)]),
          );
          await gateway.emitGatewayEvent("sessions.changed", {
            sessionKey: key,
            reason: "activity-summary",
          });
          await expect.poll(() => recap.textContent()).toContain(newText);
          await expect.poll(() => recap.getAttribute("data-state")).toBe("current");
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          ).toBe(true);
          await page.screenshot({
            path: path.join(suite.artifactDir, `03-completed-${width}.png`),
          });
          expect(await ordinaryListRequests()).toBe(ordinaryListCount);

          await gateway.setSessionsListResponse(
            chatSessionListResponse([session("unavailable", newText)]),
          );
          await gateway.emitGatewayEvent("sessions.changed", {
            sessionKey: key,
            reason: "activity-summary",
          });
          await expect.poll(() => recap.getAttribute("data-state")).toBe("unavailable");
          expect(await recap.textContent()).toContain(newText);
          await gateway.setMethodResponse(ensureMethod, {
            sessions: [
              {
                key,
                agentId: "main",
                activitySummary: session("updating", newText).activitySummary,
              },
            ],
          });
          await recap.getByRole("button", { name: "Retry recap", exact: true }).click();
          await expect.poll(async () => (await gateway.getRequests(ensureMethod)).length).toBe(2);
          await expect.poll(() => recap.getAttribute("data-state")).toBe("updating");
          expect(await recap.textContent()).toContain(newText);
        },
      );
    },
  );

  it("shows cached recaps to read-only viewers without issuing generation requests", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, locale: "en-US" },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          operatorScopes: ["operator.read"],
          sessionKey: key,
          methodResponses: { "sessions.list": chatSessionListResponse([session("stale")]) },
        });
        await page.goto(`${suite.server.baseUrl}activity`);
        const recap = page.locator(`[data-activity-recap="${key}"]`);
        await expect.poll(() => recap.textContent()).toContain(oldText);
        expect(await recap.getByRole("button").count()).toBe(0);
        expect(await gateway.getRequests(ensureMethod)).toEqual([]);
      },
    );
  });
});
