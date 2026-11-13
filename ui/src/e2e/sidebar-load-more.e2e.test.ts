import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { SIDEBAR_SESSION_ROSTER_LIMIT } from "../../../src/shared/session-list-limits.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
  controlUiSessionUrl,
} from "./session-management.test-support.ts";
import { captureFrame, expectAttribute, expectCount } from "./sidebar-assertions.test-support.ts";
import { seedSidebarSettings, sidebarSessionList } from "./sidebar-contract.test-support.ts";

const dotStyle = (dot: Locator) =>
  dot.evaluate((element) => {
    const style = getComputedStyle(element);
    return [style.width, style.height, style.backgroundColor, style.borderRadius, style.boxShadow];
  });

// Real layout and observer delivery settle before a request can be ruled out.
const observerDelivery = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );

const suite = createSessionManagementE2eSuite();
suite.define(() => {
  it.each([false, true])("gets past hidden-only pages (retry=%s)", async (retry) => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const limit = SIDEBAR_SESSION_ROSTER_LIMIT;
      const rows = Array.from({ length: limit * 2 + 1 }, (_, index) =>
        sessionRow(
          index >= 7 && index < limit * 2
            ? "agent:main:cron:hidden-" + index
            : "agent:main:thread-" + index,
          "Conversation " + index,
          1000 - index,
        ),
      );
      const response = (offset: number) =>
        sessionsListResponse(rows.slice(offset, offset + limit), {
          offset,
          totalCount: rows.length,
          hasMore: offset + limit < rows.length,
          nextOffset: offset + limit < rows.length ? offset + limit : null,
        });
      const gateway = await installMockGateway(page, {
        sessions: rows,
        sessionKey: rows[0]!.key,
        methodResponses: {
          "sessions.list": {
            cases: [
              { match: { offset: limit * 2 }, response: response(limit * 2) },
              { match: { offset: limit }, response: response(limit) },
              { response: response(0) },
            ],
          },
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, rows[0]!.key));
      const sidebar = page.locator("openclaw-app-sidebar");
      const more = sidebar.getByRole("button", { name: "Load more sessions", exact: true });
      if (retry) {
        // Child lists share these cursors; keep their competing read ahead of the roster request.
        await gateway.deferNext("sessions.list", { offset: limit * 2, includeGlobal: true });
        await gateway.waitForRequest("sessions.list", {
          match: { offset: limit * 2, includeGlobal: false },
        });
      }
      await more.click();
      await gateway.waitForRequest("sessions.list", {
        match: { offset: limit, includeGlobal: true },
      });
      await gateway.waitForRequest("sessions.list", {
        match: { offset: limit * 2, includeGlobal: true },
      });
      if (retry) {
        await gateway.resolveDeferred("sessions.list", {
          __mockError: { code: "UNAVAILABLE", message: "Older sessions temporarily unavailable" },
        });
        await sidebar
          .getByText("Older sessions temporarily unavailable", { exact: false })
          .waitFor();
        expect(await sidebar.locator(".sidebar-recent-session").count()).toBe(7);
        await more.click();
      }
      await sidebar.locator('[data-session-key="agent:main:thread-' + limit * 2 + '"]').waitFor();
      expect(await more.count()).toBe(0);
      expect(await sidebar.locator(".sidebar-recent-session").count()).toBe(8);
    });
  });

  it.each([
    ["none", true],
    ["category", false],
  ] as const)(
    "advances at the list end only in flat view, loaded rows first (%s)",
    async (grouping, flat) => {
      await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        // One page holds more rows than a section first shows.
        const pageSize = 45;
        // The chat pane follows the mocked cursor too; only sidebar pages count here.
        const sidebarOlderPage = { offset: pageSize, source: "sidebar" };
        const rows = Array.from({ length: pageSize + 1 }, (_, index) =>
          sessionRow("agent:main:thread-" + index, "Conversation " + index, 1000 - index),
        );
        const gateway = await installMockGateway(page, {
          sessions: rows,
          sessionKey: rows[0]!.key,
          methodResponses: {
            "sessions.list": {
              cases: [
                {
                  match: { offset: pageSize },
                  response: sessionsListResponse(rows.slice(pageSize), {
                    offset: pageSize,
                    totalCount: rows.length,
                    hasMore: false,
                    nextOffset: null,
                  }),
                },
                {
                  response: sessionsListResponse(rows.slice(0, pageSize), {
                    offset: 0,
                    totalCount: rows.length,
                    hasMore: true,
                    nextOffset: pageSize,
                  }),
                },
              ],
            },
          },
        });
        await page.addInitScript((value) => {
          localStorage.setItem("openclaw:sidebar:sessions:grouping", value);
        }, grouping);
        await page.setViewportSize({ width: 1280, height: 600 });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, rows[0]!.key));
        const sidebar = page.locator("openclaw-app-sidebar");
        const showMore = sidebar.getByRole("button", { name: "Show more", exact: true });
        const more = sidebar.getByRole("button", { name: "Load more sessions", exact: true });
        const olderPageRequests = () => gateway.getRequests("sessions.list", sidebarOlderPage);
        await showMore.waitFor();
        expect(await olderPageRequests()).toEqual([]);

        if (!flat) {
          // A page feeds every group, so grouped views keep the explicit action.
          await more.scrollIntoViewIfNeeded();
          await observerDelivery(page);
          expect(await olderPageRequests()).toEqual([]);
          await more.click();
          await gateway.waitForRequest("sessions.list", { match: sidebarOlderPage });
          return;
        }
        // The list end first shows rows the sidebar already holds.
        expect(await more.count()).toBe(0);
        await showMore.scrollIntoViewIfNeeded();
        await more.waitFor({ state: "attached" });
        expect(await showMore.count()).toBe(0);
        await observerDelivery(page);
        expect(await olderPageRequests()).toEqual([]);
        // Only the end of the loaded rows asks the Gateway for older sessions.
        await more.scrollIntoViewIfNeeded();
        await gateway.waitForRequest("sessions.list", { match: sidebarOlderPage });
        await more.waitFor({ state: "detached" });
      });
    },
  );

  it("keeps older-session loading inside the flat list that a collapsed Other hides", async () => {
    await suite.withPage(
      { viewport: { width: 1100, height: 500 }, reducedMotion: "reduce" },
      async ({ page }) => {
        const now = Date.now();
        const current = "agent:main:current";
        const sessions = [
          sessionRow(current, "Sidebar review", now),
          sessionRow("agent:main:notes", "Release notes", now - 1, { unread: true }),
          sessionRow("agent:main:attention", "Review needed", now - 2, {
            status: "failed",
            endedAt: now - 2,
          }),
          ...Array.from({ length: 13 }, (_, i) =>
            sessionRow("agent:main:task-" + i, "Project discussion " + (i + 1), now - 10 - i),
          ),
        ];
        const last = sessionRow("agent:main:older", "Earlier planning", now - 100);
        await seedSidebarSettings(page, suite.server.baseUrl, { sidebarAgentsMode: "chip" });
        await page.addInitScript(() => {
          localStorage.setItem("openclaw:sidebar:sessions:grouping", "none");
          localStorage.setItem("openclaw:sidebar:sessions:sort-mode", "updated");
        });
        const gateway = await installMockGateway(page, {
          sessionKey: current,
          sessions,
          methodResponses: {
            "sessions.list": {
              cases: [
                {
                  match: { offset: 16 },
                  response: {
                    ...sidebarSessionList([last], {}, []),
                    hasMore: false,
                    nextOffset: null,
                  },
                },
                {
                  response: {
                    ...sidebarSessionList(sessions, {}, []),
                    hasMore: true,
                    nextOffset: 16,
                  },
                },
              ],
            },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, current));
        await evaluateControlUiContext(page, ({ navigation }) =>
          navigation.update({ sidebarEntries: ["session:agent:main:notes"] }),
        );
        const sidebar = page.locator("openclaw-app-sidebar");
        const other = sidebar.locator('[data-session-section="ungrouped"]');
        const toggle = other.locator(".sidebar-session-group-toggle").first();
        const pagination = sidebar.locator(".sidebar-session-pagination");
        // The accessible name changes while a page loads.
        const more = other.locator(".sidebar-session-pagination--roster button[aria-busy]");
        const unread = sidebar.locator('[data-session-section="pinned"] .session-unread-dot');
        await expectAttribute(toggle, "aria-expanded", "true");
        await unread.waitFor();
        await expect
          .poll(() => more.evaluate((element) => element.getBoundingClientRect().top > innerHeight))
          .toBe(true);
        const sidebarPage = { offset: 16, source: "sidebar" };
        await gateway.deferNext("sessions.list", sidebarPage);
        expect(await gateway.getRequests("sessions.list", sidebarPage)).toEqual([]);

        await toggle.click();
        await expectAttribute(toggle, "aria-expanded", "false");
        const attention = other.locator(".sidebar-session-group-attention");
        await attention.waitFor();
        await observerDelivery(page);
        for (const colorScheme of ["dark", "light"] as const) {
          await page.emulateMedia({ colorScheme });
          await page.mouse.move(900, 400);
          if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
            await captureFrame(
              suite.artifactDir,
              colorScheme + ".png",
              sidebar.locator(".sidebar"),
              [attention, unread],
            );
          }
          expect.soft(await dotStyle(attention)).toEqual(await dotStyle(unread));
        }
        // A collapsed list has no end to continue from.
        expect.soft(await pagination.count()).toBe(0);
        expect(await gateway.getRequests("sessions.list", sidebarPage)).toEqual([]);

        await toggle.click();
        await more.scrollIntoViewIfNeeded();
        await gateway.waitForRequest("sessions.list", { match: sidebarPage });
        await expectAttribute(more, "aria-busy", "true");
        expect(await more.isDisabled()).toBe(true);
        expect(await more.textContent()).toContain("Loading");
        await gateway.resolveDeferred("sessions.list");
        await expectCount(more, 0);
        await sidebar
          .locator(".sidebar-shell__body")
          .evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
        await sidebar.locator('[data-session-key="agent:main:older"]').waitFor();
      },
    );
  });
});
