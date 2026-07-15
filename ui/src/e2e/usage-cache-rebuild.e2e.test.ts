import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const artifactDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "usage-cache-rebuild");

let browser: Browser;
let server: ControlUiE2eServer;

function localDate(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function totals(totalTokens: number) {
  return {
    input: totalTokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    totalCost: totalTokens / 100,
    inputCost: totalTokens / 100,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    missingCostEntries: 0,
  };
}

function cacheStatus(status: "fresh" | "refreshing") {
  return {
    status,
    cachedFiles: status === "fresh" ? 32 : 1,
    pendingFiles: status === "fresh" ? 0 : 32,
    staleFiles: status === "fresh" ? 0 : 32,
  };
}

function sessionsUsage(status: "fresh" | "refreshing", totalTokens: number) {
  const usageTotals = totals(totalTokens);
  const date = localDate();
  const includedSessionIds = Array.from({ length: 32 }, (_, index) => `lineage-${index + 1}`);
  return {
    updatedAt: Date.now(),
    startDate: date,
    endDate: date,
    sessions: [
      {
        key: "family:historical-lineage",
        label: "Historical lineage",
        agentId: "main",
        modelProvider: "openai",
        model: "gpt-5.6-luna",
        scope: "family",
        sessionFamilyKey: "family:historical-lineage",
        currentSessionId: includedSessionIds.at(-1),
        includedSessionIds,
        historicalInstanceCount: includedSessionIds.length,
        updatedAt: Date.now(),
        usage: {
          ...usageTotals,
          activityDates: [date],
          dailyBreakdown: [{ date, tokens: totalTokens, cost: usageTotals.totalCost }],
          messageCounts: {
            total: 2,
            user: 1,
            assistant: 1,
            toolCalls: 0,
            toolResults: 0,
            errors: 0,
          },
          modelUsage: [
            {
              provider: "openai",
              model: "gpt-5.6-luna",
              count: 1,
              totals: usageTotals,
            },
          ],
        },
      },
    ],
    totals: usageTotals,
    aggregates: {
      sessionCount: 1,
      messages: {
        total: 2,
        user: 1,
        assistant: 1,
        toolCalls: 0,
        toolResults: 0,
        errors: 0,
      },
      tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
      byModel: [],
      byProvider: [],
      byAgent: [{ agentId: "main", totals: usageTotals }],
      byChannel: [],
      daily: [
        {
          date,
          tokens: totalTokens,
          cost: usageTotals.totalCost,
          messages: 2,
          toolCalls: 0,
          errors: 0,
        },
      ],
    },
    cacheStatus: cacheStatus(status),
  };
}

function costUsage(status: "fresh" | "refreshing", totalTokens: number) {
  const usageTotals = totals(totalTokens);
  return {
    updatedAt: Date.now(),
    days: 1,
    daily: [{ date: localDate(), ...usageTotals }],
    totals: usageTotals,
    cacheStatus: cacheStatus(status),
  };
}

describeControlUiE2e("Control UI usage cache rebuild mocked Gateway E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is not available at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("keeps partial totals usable and converges from rebuilding to fresh without overlapping polls", async () => {
    if (captureProof) {
      await mkdir(artifactDir, { recursive: true });
    }
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 1_000, width: 1_440 },
      ...(captureProof
        ? { recordVideo: { dir: artifactDir, size: { height: 1_000, width: 1_440 } } }
        : {}),
    });
    const page = await context.newPage();
    const rebuildingSessions = sessionsUsage("refreshing", 100);
    const freshSessions = sessionsUsage("fresh", 320);
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.usage": rebuildingSessions,
        "usage.cost": costUsage("refreshing", 100),
        "usage.status": { updatedAt: Date.now(), providers: [] },
      },
    });

    try {
      await page.goto(`${server.baseUrl}usage`);
      const notice = page.locator(".usage-cache-notice");
      await notice.waitFor({ state: "visible", timeout: 10_000 });
      const initialSessionRequests = (await gateway.getRequests("sessions.usage")).length;
      const initialProviderRequests = (await gateway.getRequests("usage.status")).length;
      await gateway.deferNext("sessions.usage");
      await gateway.setMethodResponse("sessions.usage", freshSessions);
      await gateway.setMethodResponse("usage.cost", costUsage("fresh", 320));

      await expect.poll(() => notice.textContent()).toContain("Rebuilding usage data");
      await expect.poll(() => page.locator(".session-bar-row").count()).toBe(1);
      await expect.poll(() => page.locator(".settings-status").count()).toBe(0);
      expect(await notice.textContent()).not.toContain("32 pending");
      expect(await notice.textContent()).not.toContain("32 stale");
      expect(await page.locator(".usage-metric-badge strong").first().textContent()).toBe("100");

      if (captureProof) {
        await page.locator(".usage-page").screenshot({
          path: path.join(artifactDir, "rebuilding.png"),
        });
      }

      await expect
        .poll(async () => (await gateway.getRequests("sessions.usage")).length, {
          timeout: 10_000,
        })
        .toBe(initialSessionRequests + 1);
      await page.waitForTimeout(2_300);
      expect((await gateway.getRequests("sessions.usage")).length).toBe(initialSessionRequests + 1);
      expect((await gateway.getRequests("usage.status")).length).toBe(initialProviderRequests);

      await gateway.resolveDeferred("sessions.usage", freshSessions);
      await notice.waitFor({ state: "detached", timeout: 10_000 });
      await expect
        .poll(() => page.locator(".usage-metric-badge strong").first().textContent())
        .toBe("320");
      await page.waitForTimeout(2_300);
      expect((await gateway.getRequests("sessions.usage")).length).toBe(initialSessionRequests + 1);

      if (captureProof) {
        await page.locator(".usage-page").screenshot({
          path: path.join(artifactDir, "fresh.png"),
        });
      }
    } finally {
      const video = page.video();
      if (captureProof && video) {
        await page.close();
        await video.saveAs(path.join(artifactDir, "rebuilding-to-fresh.webm"));
      }
      await context.close();
    }
  });
});
