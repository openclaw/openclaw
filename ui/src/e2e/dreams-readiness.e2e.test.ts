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
const suite = createControlUiE2eSuite({ name: "Dreams review read readiness" });
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
  it("does not infer empty review lists from a failed initial status read", async () => {
    await suite.withPage(
      {
        viewport: { width: 1280, height: 1000 },
        locale: "en-US",
        colorScheme: "dark",
        reducedMotion: "reduce",
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          deferredMethods: ["doctor.memory.status"],
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            "doctor.memory.status",
            "doctor.memory.dreamDiary",
            "wiki.overview",
            "wiki.importInsights",
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
              "dream-readiness",
            ),
            "config.schema.lookup": { children: [{ key: "dreaming" }] },
            "doctor.memory.status": memoryStatus,
            "doctor.memory.dreamDiary": {
              found: true,
              path: "DREAMS.md",
              content: "Synthetic diary: keep genuine review data.",
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
        await page.goto(suite.server.baseUrl + "settings/memory/dreams");
        await gateway.waitForRequest("doctor.memory.status");
        const surface = page.locator("openclaw-agent-memory-panel");
        await surface
          .getByText("Synthetic diary: keep genuine review data.", { exact: true })
          .waitFor();
        const waiting = surface.locator('button[aria-controls="dreams-review-waiting"]');
        expect(await waiting.count()).toBe(0);
        await gateway.rejectDeferred("doctor.memory.status", {
          code: "UNAVAILABLE",
          message: "Synthetic dreaming status read failed",
        });
        const error = surface
          .locator(".dreams__controls-error")
          .filter({ hasText: "Synthetic dreaming status read failed" });
        await error.waitFor();
        if (await waiting.count()) {
          await waiting.click();
        }
        const falseEmpty = await surface
          .getByText("No short-term entries to inspect.", { exact: true })
          .count();
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const frame = await takeControlUiScreenshotFrame(page, surface, [error], {
            animations: "disabled",
            viewport: { width: 1280, height: 1400 },
            scrollTo: surface,
          });
          await writeFile(path.join(suite.artifactDir, "first-status-error.png"), frame.png);
        }
        await surface.getByRole("button", { name: "Refresh", exact: true }).click();
        await expect.poll(() => error.count()).toBe(0);
        await waiting.waitFor();
        if ((await waiting.getAttribute("aria-expanded")) !== "true") {
          await waiting.click();
        }
        await surface.getByText("No short-term entries to inspect.", { exact: true }).waitFor();
        const reads = (await gateway.getRequests("doctor.memory.status")).length;
        await gateway.deferNext("doctor.memory.status");
        await surface.getByRole("button", { name: "Refresh", exact: true }).click();
        await gateway.waitForRequest("doctor.memory.status", { after: reads });
        await gateway.rejectDeferred("doctor.memory.status", {
          code: "UNAVAILABLE",
          message: "Synthetic dreaming status read failed",
        });
        await error.waitFor();
        await surface.getByText("No short-term entries to inspect.", { exact: true }).waitFor();
        expect(await waiting.getAttribute("aria-expanded")).toBe("true");
        expect(await gateway.getRequests("config.patch")).toHaveLength(0);
        expect(falseEmpty, "A failed first status read cannot prove the review list is empty").toBe(
          0,
        );
      },
    );
  });
});
