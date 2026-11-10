import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { DoctorMemoryStatusPayload } from "../../../packages/gateway-protocol/src/doctor-memory.ts";
import { sourceConfigSnapshot } from "../lib/config/config-snapshot.test-support.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Settings failure occupied space" });
const memoryStatus: DoctorMemoryStatusPayload = {
  agentId: "main",
  provider: "none",
  embedding: { ok: false, checked: false },
  dreaming: {
    enabled: true,
    verboseLogging: false,
    storageMode: "inline",
    separateReports: false,
    phases: {
      light: {
        enabled: true,
        cron: "0 * * * *",
        limit: 10,
        managedCronPresent: true,
        lookbackDays: 1,
      },
      rem: {
        enabled: true,
        cron: "0 2 * * *",
        limit: 10,
        managedCronPresent: true,
        lookbackDays: 7,
        minPatternStrength: 2,
      },
      deep: {
        enabled: true,
        cron: "0 3 * * *",
        limit: 10,
        managedCronPresent: true,
        minScore: 1,
        minRecallCount: 1,
        minUniqueQueries: 1,
        recencyHalfLifeDays: 7,
      },
    },
    shortTermCount: 0,
    recallSignalCount: 0,
    dailySignalCount: 0,
    groundedSignalCount: 0,
    totalSignalCount: 0,
    phaseSignalCount: 0,
    lightPhaseHitCount: 0,
    remPhaseHitCount: 0,
    promotedTotal: 0,
    promotedToday: 0,
    shortTermEntries: [],
    signalEntries: [],
    promotedEntries: [],
  },
};

suite.define(() => {
  it("keeps the last Settings action reachable while a failed save and its long reason remain", async () => {
    await suite.withPage(
      {
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        colorScheme: "dark",
        reducedMotion: "reduce",
        serviceWorkers: "block",
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            "doctor.memory.status",
            "doctor.memory.dreamDiary",
            "wiki.overview",
            "wiki.importInsights",
            "config.patch",
          ],
          methodResponses: {
            "config.get": sourceConfigSnapshot(
              {
                plugins: {
                  entries: {
                    "memory-wiki": { enabled: true },
                    "memory-core": { enabled: true, config: { dreaming: { enabled: true } } },
                  },
                },
              },
              "settings-layout",
            ),
            "config.schema.lookup": { children: [{ key: "dreaming" }] },
            "doctor.memory.status": memoryStatus,
            "doctor.memory.dreamDiary": {
              found: true,
              path: "DREAMS.md",
              content: "Synthetic review: keep controls reachable.",
            },
            "wiki.overview": {
              totalItems: 0,
              totalPages: 0,
              pageCounts: { entity: 0, concept: 0, source: 0, synthesis: 0, report: 0 },
              totalClaims: 0,
              totalQuestions: 0,
              totalContradictions: 0,
              truncated: false,
              clusters: [],
            },
            "wiki.importInsights": {
              sourceType: "chatgpt",
              totalItems: 0,
              totalClusters: 0,
              clusters: [],
              truncated: false,
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/memory/dreams`);
        await page.getByRole("switch", { name: "Dreaming", exact: true }).click();
        const confirm = page.getByRole("dialog");
        await gateway.deferNext("config.patch");
        await confirm.getByRole("button", { name: "Turn off dreaming", exact: true }).click();
        await gateway.waitForRequest("config.patch");
        await gateway.rejectDeferred("config.patch", {
          code: "UNAVAILABLE",
          message: "Synthetic write rejected",
        });
        await confirm.getByRole("alert").waitFor();
        await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
        const card = page.locator(".settings-save-indicator--failure");
        const wiki = page.locator('button[aria-controls="dreams-review-wiki"]');
        const main = page.locator("main.content");
        for (const short of [false, true]) {
          if (short) {
            await wiki.click();
            await page.setViewportSize({ width: 390, height: 500 });
            await gateway.deferNext("config.patch");
            await card.getByRole("button", { name: "Retry", exact: true }).click();
            await gateway.waitForRequest("config.patch", { after: 1 });
            await gateway.rejectDeferred("config.patch", {
              code: "UNAVAILABLE",
              message:
                "Synthetic failure. " + "Keep the file writable before retrying. ".repeat(80),
            });
            const reason = card.locator(".settings-save-indicator__reason");
            await expect.poll(() => reason.textContent()).toContain("Synthetic failure.");
            await reason.hover();
            await page.mouse.wheel(0, 500);
            await expect.poll(() => reason.evaluate((e) => e.scrollTop)).toBeGreaterThan(0);
          }
          await card.waitFor();
          await main.evaluate((e) => {
            e.scrollTop = e.scrollHeight;
          });
          const frame = await takeControlUiScreenshotFrame(page, main, [wiki, card], {
            animations: "disabled",
            elements: [wiki, card],
          });
          if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
            await writeFile(
              path.join(suite.artifactDir, short ? "short.png" : "phone.png"),
              frame.png,
            );
          }
          expect(
            await wiki.evaluate((e) => {
              const r = e.getBoundingClientRect();
              return e.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
            }),
          ).toBe(true);
          await wiki.click();
          await expect.poll(() => wiki.getAttribute("aria-expanded")).toBe("true");
          expect(await card.isVisible()).toBe(true);
        }
      },
    );
  });
});
