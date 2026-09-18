// Control UI tests protect Usage panel geometry through the routed Gateway flow.
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite, tooltipTitleText } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Usage context layout",
  startServerBeforeBrowser: true,
});

function usageFixture() {
  const now = Date.now();
  const date = new Date(now).toISOString().slice(0, 10);
  const totals = {
    input: 100000,
    output: 20000,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 120000,
    totalCost: 1.2,
    inputCost: 1,
    outputCost: 0.2,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    missingCostEntries: 0,
  };
  const messages = {
    total: 1000,
    user: 500,
    assistant: 500,
    toolCalls: 0,
    toolResults: 0,
    errors: 0,
  };
  const name = (kind: string, i: number) =>
    `${kind}-${String(i).padStart(2, "0")}-extended-context-entry-for-layout-validation`;
  const contextWeight = {
    source: "run",
    generatedAt: now,
    systemPrompt: { chars: 8000, projectContextChars: 2000, nonProjectContextChars: 6000 },
    skills: {
      promptChars: 16000,
      entries: Array.from({ length: 40 }, (_, i) => ({ name: name("skill", i), blockChars: 400 })),
    },
    tools: {
      listChars: 4000,
      schemaChars: 8000,
      entries: Array.from({ length: 50 }, (_, i) => ({
        name: name("tool", i),
        summaryChars: 80,
        schemaChars: 160,
      })),
    },
    injectedWorkspaceFiles: Array.from({ length: 7 }, (_, i) => ({
      name: name("file", i),
      path: `/workspace/${name("file", i)}.md`,
      missing: false,
      rawChars: 800,
      injectedChars: 800,
      truncated: false,
    })),
  };
  const session = {
    key: "agent:main:layout-proof",
    label: "Long conversation",
    agentId: "main",
    updatedAt: now,
    hasContextWeight: true,
    usage: { ...totals, activityDates: [date], messageCounts: messages },
  };
  const snapshot = {
    updatedAt: now,
    startDate: date,
    endDate: date,
    sessions: [session],
    totals,
    aggregates: {
      messages,
      tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
      byModel: [],
      byProvider: [],
      byAgent: [],
      byChannel: [],
      daily: [
        {
          date,
          tokens: totals.totalTokens,
          cost: totals.totalCost,
          messages: 1000,
          toolCalls: 0,
          errors: 0,
        },
      ],
    },
  };
  return {
    "sessions.usage": {
      cases: [
        {
          match: { includeContextWeight: true },
          response: { ...snapshot, sessions: [{ ...session, contextWeight }] },
        },
        { match: {}, response: snapshot },
      ],
    },
    "usage.cost": { updatedAt: now, days: 1, totals, daily: [{ date, ...totals }] },
    "usage.status": { updatedAt: now, providers: [] },
    "sessions.usage.timeseries": { points: [] },
    "sessions.usage.logs": {
      logs: Array.from({ length: 1000 }, (_, i) => ({
        timestamp: now + i,
        role: i % 2 ? "assistant" : "user",
        content: `Synthetic conversation entry ${i + 1}: review the context panel and keep its controls reachable.`,
        tokens: 120,
        cost: 0.0012,
      })),
    },
  };
}

async function openSession(page: Page) {
  await installMockGateway(page, { methodResponses: usageFixture() });
  await page.goto(`${suite.server.baseUrl}usage`);
  await page.getByRole("button", { name: "Long conversation", exact: true }).click();
  await page.locator(".context-breakdown-card").first().waitFor();
  await expect.poll(() => page.locator(".session-log-entry").count()).toBe(1000);
  await page.evaluate(() => document.fonts.ready);
}

async function height(element: Locator) {
  return element.evaluate((node) => node.getBoundingClientRect().height);
}

async function expectContextContained(page: Page) {
  const panel = await page.locator(".context-details-panel").boundingBox();
  expect(panel).not.toBeNull();
  for (const selector of [
    ".context-details-panel",
    ".context-breakdown-grid",
    ".context-breakdown-card",
    ".context-breakdown-list",
  ]) {
    const overflow = await page
      .locator(selector)
      .evaluateAll((nodes) => nodes.map((node) => node.scrollWidth - node.clientWidth));
    expect(
      overflow.every((pixels) => pixels <= 1),
      selector,
    ).toBe(true);
  }
  const edges = await page
    .locator(".context-breakdown-header button, .context-breakdown-item .muted")
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        left: node.getBoundingClientRect().left,
        right: node.getBoundingClientRect().right,
      })),
    );
  for (const edge of edges) {
    expect(edge.left).toBeGreaterThanOrEqual(panel!.x);
    expect(edge.right).toBeLessThanOrEqual(panel!.x + panel!.width);
  }
}

suite.define(() => {
  it("keeps collapsed context at its own height beside a long conversation", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      await openSession(page);
      const panel = page.locator(".context-details-panel");
      const initial = await height(panel);
      const button = await page.locator(".context-breakdown-header button").boundingBox();
      const header = await page.locator(".context-breakdown-header").boundingBox();
      expect(button!.height).toBeGreaterThan(0);
      // The empty-query control provides an independent intrinsic-height reference.
      await page.getByRole("textbox", { name: "Search conversation" }).fill("no matching message");
      await expect.poll(() => page.locator(".session-log-entry").count()).toBe(0);
      expect(initial).toBeCloseTo(await height(panel), 0);
      expect(header!.height).toBeLessThan(initial / 2);
    });
  });

  it("keeps a filtered-empty conversation at its own height beside expanded context", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      await openSession(page);
      await page.getByRole("textbox", { name: "Search conversation" }).fill("no matching message");
      await expect.poll(() => page.locator(".session-log-entry").count()).toBe(0);
      const logs = page.locator(".session-logs-compact");
      const collapsedHeight = await height(logs);
      // Native keyboard activation also reaches the offscreen baseline control.
      await page.locator(".context-breakdown-header button").press("Enter");
      await expect.poll(() => page.locator(".context-breakdown-item").count()).toBe(97);
      expect(await height(logs)).toBeCloseTo(collapsedHeight, 0);
    });
  });

  it.each([390, 640, 641, 900, 901, 1440])(
    "keeps expanded context and controls inside the column at %ipx",
    async (width) => {
      await suite.withPage({ viewport: { width, height: 900 } }, async ({ page }) => {
        await openSession(page);
        const logs = page.locator(".session-logs-compact");
        const logsHeight = await height(logs);
        const logsText = await logs.textContent();
        const button = page.locator(".context-breakdown-header button");
        await button.press("Enter");
        await expect.poll(() => page.locator(".context-breakdown-item").count()).toBe(97);
        await expectContextContained(page);
        expect(await height(logs)).toBeCloseTo(logsHeight, 0);
        expect(await logs.textContent()).toBe(logsText);
        expect(await button.evaluate((node) => document.activeElement === node)).toBe(true);
        const names = page.locator(".context-breakdown-item .mono");
        for (const name of await names.all()) {
          expect(await tooltipTitleText(name)).toBe(await name.textContent());
        }
        const cards = page.locator(".context-breakdown-card");
        const first = await cards.nth(0).boundingBox();
        const second = await cards.nth(1).boundingBox();
        if (width > 640 && width <= 900) {
          expect(second!.y).toBeCloseTo(first!.y, 0);
          expect(second!.x).toBeGreaterThan(first!.x);
        } else {
          expect(second!.y).toBeGreaterThan(first!.y);
        }
        await button.press("Space");
        await expect.poll(() => page.locator(".context-breakdown-item").count()).toBe(12);
        expect(await button.evaluate((node) => document.activeElement === node)).toBe(true);
        await expectContextContained(page);
        // Pointer activation must work without scrolling the page horizontally.
        await button.click();
        await expect.poll(() => page.locator(".context-breakdown-item").count()).toBe(97);
      });
    },
  );
});
