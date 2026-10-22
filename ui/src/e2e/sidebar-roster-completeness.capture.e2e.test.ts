import { expect, it } from "vitest";
import { SIDEBAR_SESSION_ROSTER_LIMIT } from "../../../src/shared/session-list-limits.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  captureUiProof,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

const MAIN_KEY = "agent:main:main";
const STALE_CATEGORY = "Papercuts";
const FRESH_CATEGORY = "Automated Issue Fixes";
const BASE_TIME = Date.parse("2026-08-27T12:00:00.000Z");

function rosterMock() {
  const group = (count: number, prefix: string, label: string, age: number, category?: string) =>
    Array.from({ length: count }, (_, index) =>
      sessionRow(
        `agent:main:${prefix}-${index}`,
        `${label} ${index}`,
        BASE_TIME - age - index * 1_000,
        { category },
      ),
    );
  const rows = [
    sessionRow(MAIN_KEY, "Main", BASE_TIME),
    ...group(2, "fresh", "Fresh fix", 1_000, FRESH_CATEGORY),
    // A 50/60-row recency page must miss the categorized tail.
    ...group(80, "filler", "Untitled", 100_000),
    ...group(3, "stale", "Papercut", 900_000, STALE_CATEGORY),
  ];
  const truncated = (limit: number) =>
    sessionsListResponse(rows.slice(0, limit), {
      hasMore: true,
      nextOffset: limit,
      totalCount: rows.length,
    });
  return {
    methodResponses: {
      "sessions.list": {
        cases: [
          // Pre-fix builds asked for these; the shipped roster asks for the define.
          { match: { limit: 50 }, response: truncated(50) },
          { match: { limit: 60 }, response: truncated(60) },
          {
            match: { limit: SIDEBAR_SESSION_ROSTER_LIMIT },
            response: sessionsListResponse(rows),
          },
          { match: {}, response: sessionsListResponse(rows) },
        ],
      },
      "sessions.groups.list": {
        groups: [
          { name: FRESH_CATEGORY, position: 0 },
          { name: STALE_CATEGORY, position: 1 },
        ],
        sectionOrder: [`category:${FRESH_CATEGORY}`, `category:${STALE_CATEGORY}`, "ungrouped"],
      },
      "sessions.patch": {},
    },
    sessionKey: MAIN_KEY,
  } as const;
}

suite.define(() => {
  it("fills every catalog category instead of leaving the out-of-page ones empty", async () => {
    const context = await suite.browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 1000, width: 1280 },
    });
    const page = await context.newPage();
    try {
      await installMockGateway(page, rosterMock());
      await page.goto(`${suite.server.baseUrl}chat`);
      const sidebar = page.locator("openclaw-app-sidebar");
      await sidebar.waitFor({ state: "visible", timeout: 10_000 });
      await sidebar
        .getByText(STALE_CATEGORY, { exact: false })
        .first()
        .waitFor({ timeout: 10_000 });
      // Capture the pre-fix failure before asserting its missing row.
      await captureUiProof(
        suite,
        page,
        `roster-completeness-${process.env.OPENCLAW_ROSTER_PROOF ?? "after"}.png`,
      );
      // Catalog headers alone do not prove that the rows arrived.
      await expect
        .poll(() => sidebar.getByText("Papercut 0", { exact: false }).count(), { timeout: 10_000 })
        .toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  });
});
