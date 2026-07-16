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

let browser: Browser;
let server: ControlUiE2eServer;

const sessionTotals = {
  input: 100,
  output: 50,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 150,
  totalCost: 0.01,
  inputCost: 0.005,
  outputCost: 0.005,
  cacheReadCost: 0,
  cacheWriteCost: 0,
  missingCostEntries: 0,
};

const today = new Date().toISOString().slice(0, 10);

const sessionsUsageResponse = {
  updatedAt: Date.now(),
  startDate: today,
  endDate: today,
  sessions: [
    {
      key: "agent:main:detail-errors",
      label: "Detail errors session",
      agentId: "main",
      modelProvider: "openai",
      model: "gpt-5.5",
      updatedAt: Date.now(),
      scope: "instance",
      usage: {
        ...sessionTotals,
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
            model: "gpt-5.5",
            count: 1,
            totals: sessionTotals,
          },
        ],
      },
    },
  ],
  totals: sessionTotals,
  aggregates: {
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
    byAgent: [],
    byChannel: [],
    daily: [],
  },
};

describeControlUiE2e("Control UI usage detail RPC error surfacing mocked Gateway E2E", () => {
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

  it("shows timeline and conversation error panels when detail RPCs fail", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 1_000, width: 1_440 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      deferredMethods: ["sessions.usage.timeseries", "sessions.usage.logs"],
      methodResponses: {
        "sessions.usage": sessionsUsageResponse,
        "usage.cost": {
          updatedAt: Date.now(),
          days: 1,
          daily: [],
          totals: sessionTotals,
        },
        "usage.status": {
          updatedAt: Date.now(),
          providers: [],
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}usage`);
      await page.locator(".session-bar-row").waitFor({ state: "visible", timeout: 10_000 });
      await page.locator(".session-bar-row").click();

      await expect
        .poll(async () => (await gateway.getRequests("sessions.usage.timeseries")).length)
        .toBe(1);
      await expect
        .poll(async () => (await gateway.getRequests("sessions.usage.logs")).length)
        .toBe(1);

      await gateway.rejectDeferred("sessions.usage.timeseries", {
        code: "UNAVAILABLE",
        message: "Timeline service unavailable",
        retryable: true,
      });
      await gateway.rejectDeferred("sessions.usage.logs", {
        code: "UNAVAILABLE",
        message: "Conversation service unavailable",
        retryable: true,
      });

      await page
        .getByText("Could not load timeline")
        .waitFor({ state: "visible", timeout: 10_000 });
      await page
        .getByText("Could not load conversation")
        .waitFor({ state: "visible", timeout: 10_000 });

      const errorMessages = await page.locator(".usage-error-message").allTextContents();
      expect(errorMessages.map((text) => text.trim())).toEqual(
        expect.arrayContaining([
          "Timeline service unavailable",
          "Conversation service unavailable",
        ]),
      );
    } finally {
      await context.close();
    }
  });
});
