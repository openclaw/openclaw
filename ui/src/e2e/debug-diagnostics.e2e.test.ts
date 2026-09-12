import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Debug diagnostics mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let proofDir: string;
beforeEach(() => {
  if (captureUiProof) {
    proofDir = createControlUiE2eArtifactDir("control-ui-debug-diagnostics");
  }
});

suite.define(() => {
  it("renders Gateway diagnostics and current work independently of session history", async () => {
    if (captureUiProof) {
      await mkdir(path.join(proofDir, "video"), { recursive: true });
    }
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1000, width: 1280 },
        ...(captureUiProof
          ? {
              recordVideo: {
                dir: path.join(proofDir, "video"),
                size: { height: 1000, width: 1280 },
              },
            }
          : {}),
      },
      async ({ page }) => {
        const activeRows = Array.from({ length: 101 }, (_, index) => ({
          key: index === 0 ? "global" : index === 1 ? "unknown" : `agent:main:older-${index}`,
          agentId: "main",
          sessionId: `active-session-${index}`,
          kind: index === 0 ? "global" : index === 1 ? "unknown" : "direct",
          updatedAt: 1000 - index,
          hasActiveRun: true,
          status: index === 1 ? "queued" : "running",
          activeRunIds: [`active-run-${index}`],
          archived: index === 2,
        }));
        const recentIdleRows = Array.from({ length: 100 }, (_, index) => ({
          key: `agent:main:recent-${index}`,
          sessionId: `idle-session-${index}`,
          kind: "direct",
          updatedAt: 2000 + index,
          hasActiveRun: false,
        }));
        const listing = (sessions: object[], totalCount = sessions.length) => ({
          ts: 3000,
          path: "",
          count: sessions.length,
          totalCount,
          limitApplied: 100,
          nextOffset: sessions.length < totalCount ? sessions.length : null,
          hasMore: sessions.length < totalCount,
          sessions,
          defaults: { model: null, modelProvider: null, contextTokens: null },
        });
        const currentWorkQuery = {
          activeOnly: true,
          archived: "all",
          includeGlobal: true,
          includeUnknown: true,
        };
        const gateway = await installMockGateway(page, {
          sessionScope: "global",
          sessions: [...activeRows, ...recentIdleRows],
          methodResponses: {
            "sessions.list": {
              cases: [
                { match: currentWorkQuery, response: listing(activeRows.slice(0, 100), 101) },
                { match: {}, response: listing(recentIdleRows, 198) },
              ],
            },
            status: {
              runtime: "diagnostics-e2e",
              securityAudit: { summary: { critical: 0, warn: 1, info: 2 } },
            },
            health: { ok: true, gateway: "healthy" },
            "models.list": {
              models: [
                {
                  available: true,
                  id: "gpt-5.6-luna",
                  name: "GPT-5.6 Luna",
                  provider: "openai",
                },
              ],
            },
            "last-heartbeat": { ageMs: 1250, source: "gateway-heartbeat" },
            "diagnostics.lanes": {
              lanes: [
                {
                  lane: "main",
                  queuedCount: 0,
                  activeCount: 0,
                  maxConcurrent: 16,
                  draining: false,
                  generation: 1,
                },
              ],
              dynamic: null,
            },
          },
        });

        const response = await page.goto(`${suite.server.baseUrl}debug`);
        expect(response?.status()).toBe(200);
        await page.locator(".page-title", { hasText: "Debug" }).waitFor();
        const snapshots = page.locator(".settings-section", {
          has: page.getByRole("heading", { name: "Snapshots" }),
        });
        await snapshots.waitFor();
        await expect.poll(() => snapshots.textContent()).toContain("1 warning");
        await expect.poll(() => snapshots.textContent()).toContain("diagnostics-e2e");
        await expect.poll(() => snapshots.textContent()).toContain("healthy");
        await expect.poll(() => snapshots.textContent()).toContain("gateway-heartbeat");
        const models = page.locator(".settings-section", {
          has: page.getByRole("heading", { name: "Models" }),
        });
        await expect.poll(() => models.textContent()).toContain("gpt-5.6-luna");

        for (const method of [
          "status",
          "health",
          "models.list",
          "last-heartbeat",
          "diagnostics.lanes",
        ]) {
          const requests = await gateway.getRequests(method);
          expect(requests.length).toBeGreaterThanOrEqual(1);
          expect(requests[0]?.params).toEqual(
            method === "models.list" ? { agentId: "main", view: "default" } : {},
          );
        }

        if (captureUiProof) {
          await writeFile(
            path.join(proofDir, "diagnostic-snapshots.png"),
            await takeControlUiViewportScreenshot(page, snapshots, [
              snapshots.getByRole("heading", { name: "Snapshots" }),
            ]),
          );
          await models.scrollIntoViewIfNeeded();
          await page.screenshot({
            animations: "disabled",
            path: path.join(proofDir, "models-snapshot.png"),
          });
        }

        await page.getByRole("button", { name: /^Open overlay/u }).click();
        const overlay = page.getByRole("complementary", { name: "System busyness" });
        const activeRuns = overlay.locator("section", {
          has: page.getByRole("heading", { name: "Active runs", exact: true }),
        });
        const activeCount = activeRuns.locator(".debug-overlay__count").first();
        await activeCount.waitFor();
        await activeCount.scrollIntoViewIfNeeded();
        if (captureUiProof) {
          await page.screenshot({ path: path.join(proofDir, "active-runs.png") });
        }
        expect((await activeCount.textContent())?.trim()).toBe("101 active");
        expect(await activeRuns.getByText("Showing 100 of 101", { exact: true }).count()).toBe(1);
        expect(await activeRuns.locator("li").count()).toBe(100);
        expect(await activeRuns.getByText("active-session-100", { exact: true }).count()).toBe(0);
        for (const sessionId of ["active-session-0", "active-session-1", "active-session-2"]) {
          expect(await activeRuns.getByText(sessionId, { exact: true }).count()).toBe(1);
        }
        expect(
          await gateway.getRequests("sessions.list", { ...currentWorkQuery, offset: 100 }),
        ).toHaveLength(0);
        await gateway.setMethodResponse("sessions.list", listing([]));
        await activeRuns.getByText("No active runs.", { exact: true }).waitFor();
        expect((await activeCount.textContent())?.trim()).toBe("0 active");
        expect(await activeRuns.locator("li").count()).toBe(0);
        expect(await activeRuns.getByText("Showing 100 of 101", { exact: true }).count()).toBe(0);
        if (captureUiProof) {
          await page.screenshot({ path: path.join(proofDir, "active-runs-idle.png") });
        }
        await overlay.getByRole("button", { name: "Close", exact: true }).click();

        const refresh = snapshots.getByRole("button", { name: "Refresh" });
        const statusRequestCount = (await gateway.getRequests("status")).length;
        await gateway.deferNext("status");
        await refresh.click();
        await gateway.waitForRequest("status", { after: statusRequestCount });
        await expect
          .poll(() => snapshots.textContent())
          .toContain("Refreshing Gateway diagnostics.");
        await expect.poll(() => snapshots.textContent()).toContain("diagnostics-e2e");
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        if (captureUiProof) {
          await page.screenshot({
            animations: "disabled",
            path: path.join(proofDir, "refreshing-desktop.png"),
          });
        }

        await gateway.resolveDeferred("status");
        await expect.poll(() => refresh.textContent()).toMatch(/^\s*Refresh\s*$/u);
        await gateway.setOnline(false);
        await expect
          .poll(() => snapshots.textContent())
          .toMatch(/Offline\s+Connect to the Gateway/u);
        expect(await refresh.isDisabled()).toBe(true);
        await expect.poll(() => snapshots.textContent()).toContain("diagnostics-e2e");
        await page.setViewportSize({ height: 844, width: 390 });
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        if (captureUiProof) {
          await page.screenshot({
            animations: "disabled",
            path: path.join(proofDir, "offline-mobile.png"),
          });
        }
      },
    );
  });
});
