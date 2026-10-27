import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { SessionsUsageResult } from "../api/types.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { pauseVirtualClock, type MockGatewayControls } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installUsageOverviewGateway as installMockGateway } from "./usage-overview-fixture.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI usage proxy reconnect lifecycle",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

// Mirrors the module-private default usage TTL asserted by this flow.
const USAGE_PAYLOAD_TTL_MS = 5 * 60_000;

const messages = { total: 2, user: 1, assistant: 1, toolCalls: 0, toolResults: 0, errors: 0 };

const totals = {
  input: 100,
  output: 20,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 120,
  totalCost: 0.01,
  inputCost: 0.008,
  outputCost: 0.002,
  cacheReadCost: 0,
  cacheWriteCost: 0,
  missingCostEntries: 0,
};

function today(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function sessionsUsage(
  cacheStatus?: SessionsUsageResult["cacheStatus"],
  label = "Proxy proof",
  usageTotals = totals,
) {
  const date = today();
  const day = { date, tokens: usageTotals.totalTokens, cost: usageTotals.totalCost };
  return {
    updatedAt: Date.now(),
    startDate: date,
    endDate: date,
    sessions: [
      {
        key: "agent:main:proxy-proof",
        label,
        agentId: "main",
        modelProvider: "openai",
        model: "gpt-5.5",
        updatedAt: Date.now(),
        usage: {
          ...usageTotals,
          activityDates: [date],
          dailyBreakdown: [{ ...usageTotals, ...day }],
          messageCounts: messages,
        },
      },
    ],
    totals: usageTotals,
    aggregates: {
      messages,
      tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
      byModel: [],
      byProvider: [],
      byAgent: [{ agentId: "main", totals: usageTotals }],
      byChannel: [],
      costDaily: [{ date, ...usageTotals }],
      daily: [{ ...day, messages: 2, toolCalls: 0, errors: 0 }],
    },
    ...(cacheStatus ? { cacheStatus } : {}),
  };
}

const withPage = (run: (fixture: { page: Page }) => Promise<void>) =>
  suite.withPage(
    { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1440 } },
    run,
  );
const refreshButton = (page: Page) =>
  page.locator("openclaw-usage-page").getByRole("button", { name: "Refresh", exact: true });

function installUsage(page: Page, usage: unknown, responses: Record<string, unknown> = {}) {
  return installMockGateway(page, {
    methodResponses: {
      "sessions.usage": usage,
      "usage.status": { updatedAt: Date.now(), providers: [] },
      ...responses,
    },
  });
}

async function setVisibility(page: Page, visible: boolean, advanceMs = 0) {
  if (advanceMs) {
    // Expire the payload without running five minutes of unrelated timers.
    await page.clock.setSystemTime((await page.evaluate(() => Date.now())) + advanceMs);
  }
  await page.evaluate((isVisible) => {
    Object.defineProperties(document, {
      visibilityState: { configurable: true, get: () => (isVisible ? "visible" : "hidden") },
      hasFocus: { configurable: true, value: () => isVisible },
    });
    document.dispatchEvent(new Event("visibilitychange"));
    if (isVisible) {
      window.dispatchEvent(new Event("focus"));
    }
  }, visible);
}

async function requestCount(gateway: MockGatewayControls, method: string): Promise<number> {
  return (await gateway.getRequests(method)).length;
}

async function waitForRequestCount(
  gateway: MockGatewayControls,
  method: string,
  count: number,
): Promise<void> {
  await expect.poll(() => requestCount(gateway, method), { timeout: 10_000 }).toBe(count);
}

async function proxyReconnect(
  page: Page,
  gateway: MockGatewayControls,
  expectedSocketCount: number,
): Promise<void> {
  await pauseVirtualClock(page);
  await gateway.closeLatest(1001, "proxy idle timeout");
  await expect
    .poll(() =>
      evaluateControlUiContext(page, ({ gateway: source }) => source.snapshot.reconnectAt ?? 0),
    )
    .toBeGreaterThan(0);
  const retryDelay = await evaluateControlUiContext(
    page,
    ({ gateway: source }) => (source.snapshot.reconnectAt ?? Number.NaN) - Date.now(),
  );
  expect(retryDelay).toBeGreaterThan(0);
  await page.clock.fastForward(retryDelay);
  await page.clock.resume();
  await expect.poll(() => gateway.getSocketCount(), { timeout: 10_000 }).toBe(expectedSocketCount);
  await waitForControlUiGatewayReady(page);
  await page
    .locator(".sidebar-shell__footer .gateway-status")
    .getByText("Connected", { exact: true })
    .waitFor();
}

async function usageBadges(page: Page): Promise<string[]> {
  return (await page.locator(".usage-metric-badge").allTextContents()).map((value) =>
    value.replace(/\s+/gu, " ").trim(),
  );
}

suite.define(() => {
  it("automatically replaces incomplete usage snapshots after a rebuild", async () => {
    await withPage(async ({ page }) => {
      const partialTotals = { ...totals, input: 80, totalTokens: 100 };
      const freshTotals = { ...totals, input: 300, totalTokens: 320 };
      const refreshing = {
        status: "refreshing" as const,
        cachedFiles: 1,
        pendingFiles: 1,
        staleFiles: 1,
      };
      const fresh = { status: "fresh" as const, cachedFiles: 2, pendingFiles: 0, staleFiles: 0 };
      const partialSessions = sessionsUsage(refreshing, "Historical lineage", partialTotals);
      const freshSessions = sessionsUsage(fresh, "Historical lineage", freshTotals);
      // Reproduce the original API response separately from the fixed stale-rollup response.
      const originalResponse = {
        ...partialSessions,
        totals: Object.fromEntries(Object.keys(totals).map((key) => [key, 0])),
        sessions: partialSessions.sessions.map((session) => ({ ...session, usage: null })),
        aggregates: { ...partialSessions.aggregates, daily: [], costDaily: [] },
      };
      let usageUpdatedAt = Date.now();
      const metadata = (agentId = "main", usageRefreshFailed?: true) => ({
        agentId,
        usageUpdatedAt: ++usageUpdatedAt,
        usageRefreshFailed,
        modelCatalogChanged: false,
        authChanged: false,
      });
      const gateway = await installUsage(page, originalResponse, {
        "agents.list": {
          agents: [
            { id: "main", name: "Main" },
            { id: "other", name: "Other" },
          ],
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
        },
      });

      expect((await page.goto(`${suite.server.baseUrl}usage`))?.status()).toBe(200);
      const agentScope = page.locator(".agent-scope-control openclaw-agent-select");
      await agentScope.locator(".agent-select__trigger").click();
      await agentScope
        .locator(".agent-select__option[data-agent-option]")
        .filter({ hasText: "All agents" })
        .click();
      await gateway.waitForRequest("sessions.usage", { match: { agentScope: "all" } });
      await expect
        .poll(() =>
          page.evaluate(() => ({
            visibility: document.visibilityState,
            focused: document.hasFocus(),
          })),
        )
        .toEqual({ visibility: "visible", focused: true });
      await expect.poll(() => page.locator(".usage-loading-card").count()).toBe(1);
      const beforeFailure = await requestCount(gateway, "sessions.usage");
      await gateway.emitGatewayEvent("chat.metadata.changed", metadata("main", true));
      await expect
        .poll(() => page.locator(".usage-cache-warning.warning").textContent())
        .toContain("Automatic checks paused");
      expect(await page.locator(".usage-loading-card").count()).toBe(0);
      expect(await requestCount(gateway, "sessions.usage")).toBe(beforeFailure);
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await waitForRequestCount(gateway, "sessions.usage", beforeFailure + 1);
      await expect.poll(() => page.locator(".usage-loading-card").count()).toBe(0);
      await expect.poll(() => page.locator(".usage-cache-warning.warning").count()).toBe(1);
      await gateway.emitGatewayEvent("chat.metadata.changed", metadata("other"));
      expect((await gateway.getRequests("sessions.usage")).at(-1)?.params).toMatchObject({
        agentScope: "all",
      });
      await waitForRequestCount(gateway, "sessions.usage", beforeFailure + 2);
      await expect.poll(() => page.locator(".usage-loading-card").count()).toBe(0);
      await expect.poll(() => page.locator(".usage-cache-warning.warning").count()).toBe(1);
      const refresh = refreshButton(page);
      await gateway.setMethodResponse("sessions.usage", partialSessions);
      await refresh.click();
      for (const entry of ["route", "manual"] as const) {
        if (entry === "manual") {
          await gateway.setMethodResponse("sessions.usage", partialSessions);
          await refresh.click();
        }
        await expect
          .poll(() => usageBadges(page))
          .toEqual(["100 Tokens", "$0.01 Cost", "1 Sessions"]);
        await expect.poll(() => refresh.isEnabled()).toBe(true);
        expect(await page.locator(".usage-callout.danger").count()).toBe(0);

        const sessionsBefore = await requestCount(gateway, "sessions.usage");
        const catalogsBefore = await requestCount(gateway, "models.list");
        await gateway.setMethodResponse("sessions.usage", freshSessions);
        const publication = metadata();
        await gateway.emitGatewayEvent("chat.metadata.changed", publication);
        await gateway.emitGatewayEvent("chat.metadata.changed", publication);
        await expect
          .poll(() => requestCount(gateway, "sessions.usage"), { timeout: 10_000 })
          .toBe(sessionsBefore + 1);
        expect(await requestCount(gateway, "models.list")).toBe(catalogsBefore);
        await expect
          .poll(() => usageBadges(page))
          .toEqual(["320 Tokens", "$0.01 Cost", "1 Sessions"]);
        await expect.poll(() => refresh.isEnabled()).toBe(true);
        expect(await page.locator(".usage-callout.danger").count()).toBe(0);
      }
    });
  });

  it("avoids a reload storm but retries Usage work interrupted by a proxy drop", async () => {
    await withPage(async ({ page }) => {
      await page.clock.install();
      const gateway = await installUsage(page, sessionsUsage());

      expect((await page.goto(`${suite.server.baseUrl}chat`))?.status()).toBe(200);
      const sidebar = page.locator("openclaw-app-sidebar");
      await sidebar.locator(".sidebar-identity-card").click();
      await sidebar.locator('.sidebar-identity-menu [data-value="command:usage"]').click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/usage");
      await waitForRequestCount(gateway, "sessions.usage", 1);
      await page.locator(".daily-chart-compact").waitFor({ timeout: 10_000 });
      await expect
        .poll(() => usageBadges(page))
        .toEqual(["120 Tokens", "$0.01 Cost", "1 Sessions"]);

      for (const socketCount of [2, 3, 4]) {
        await proxyReconnect(page, gateway, socketCount);
        expect(await requestCount(gateway, "sessions.usage")).toBe(1);
      }

      await setVisibility(page, false, USAGE_PAYLOAD_TTL_MS);
      await proxyReconnect(page, gateway, 5);
      expect(await requestCount(gateway, "sessions.usage")).toBe(1);

      await setVisibility(page, true);
      await waitForRequestCount(gateway, "sessions.usage", 2);

      await gateway.deferNext("sessions.usage");
      await refreshButton(page).click();
      await waitForRequestCount(gateway, "sessions.usage", 3);

      await proxyReconnect(page, gateway, 6);
      await waitForRequestCount(gateway, "sessions.usage", 4);
      await page.locator(".daily-chart-compact").waitFor({ timeout: 10_000 });
      await expect
        .poll(() => usageBadges(page))
        .toEqual(["120 Tokens", "$0.01 Cost", "1 Sessions"]);
    });
  });

  it("keeps results aligned when scope changes during a refresh", async () => {
    await withPage(async ({ page }) => {
      const staleFamilyResult = sessionsUsage(undefined, "Family stale result");
      const currentInstanceResult = sessionsUsage(undefined, "Current instance result");
      const gateway = await installUsage(page, staleFamilyResult);

      expect((await page.goto(`${suite.server.baseUrl}usage`))?.status()).toBe(200);
      await waitForRequestCount(gateway, "sessions.usage", 1);
      await page.getByText("Family stale result", { exact: true }).waitFor();

      await gateway.deferNext("sessions.usage");
      await refreshButton(page).click();
      await waitForRequestCount(gateway, "sessions.usage", 2);

      await gateway.setMethodResponse("sessions.usage", currentInstanceResult);
      await page.getByRole("button", { name: "Current instance", exact: true }).click();
      await gateway.resolveDeferred("sessions.usage", staleFamilyResult);
      await expect.poll(() => refreshButton(page).isEnabled()).toBe(true);

      const requests = await gateway.getRequests("sessions.usage");
      const currentResult = page.getByText("Current instance result", { exact: true });
      const staleResult = page.getByText("Family stale result", { exact: true });
      await expect
        .poll(async () => (await currentResult.count()) + (await staleResult.count()))
        .toBe(1);
      expect(requests).toHaveLength(3);
      expect(requests[2]?.params).toMatchObject({ groupBy: "instance" });
      expect(await currentResult.count()).toBe(1);
      expect(await staleResult.count()).toBe(0);
    });
  });
});
