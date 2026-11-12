import type { Locator } from "playwright";
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

  it("collapses without fetching and shares unread styling while preserving manual pagination", async () => {
    await suite.withPage(
      { viewport: { width: 1100, height: 500 }, reducedMotion: "reduce" },
      async ({ page }) => {
        const now = Date.now();
        const current = "agent:main:current";
        const pinned = "agent:main:notes";
        const sessions = [
          sessionRow(current, "Sidebar review", now),
          sessionRow(pinned, "Release notes", now - 1, { unread: true }),
          sessionRow("agent:main:attention", "Review needed", now - 2, {
            status: "failed",
            endedAt: now - 2,
          }),
          ...Array.from({ length: 13 }, (_, i) =>
            sessionRow("agent:main:task-" + i, "Project discussion " + (i + 1), now - 10 - i),
          ),
        ];
        const first = { ...sidebarSessionList(sessions, {}, []), hasMore: true, nextOffset: 16 };
        const last = sessionRow("agent:main:older", "Earlier planning", now - 100);
        await seedSidebarSettings(page, suite.server.baseUrl, {
          sidebarAgentsMode: "chip",
        });
        await page.addInitScript(() => {
          localStorage.setItem("openclaw:sidebar:sessions:grouping", "none");
          localStorage.setItem("openclaw:sidebar:sessions:sort-mode", "updated");
        });
        const gateway = await installMockGateway(page, {
          sessionKey: current,
          sessions,
          historyMessages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "Ready to review the sidebar." }],
              timestamp: now,
            },
          ],
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
                { response: first },
              ],
            },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, current));
        await evaluateControlUiContext(page, ({ navigation }) =>
          navigation.update({
            sidebarEntries: ["session:agent:main:notes"],
          }),
        );
        const sidebar = page.locator("openclaw-app-sidebar");
        const other = sidebar.locator('[data-session-section="ungrouped"]');
        const toggle = other.locator(".sidebar-session-group-toggle").first();
        const more = sidebar.locator(".sidebar-session-pagination--roster button");
        const unread = sidebar.locator('[data-session-section="pinned"] .session-unread-dot');
        await expectAttribute(toggle, "aria-expanded", "true");
        await unread.waitFor();
        await expect
          .poll(() => more.evaluate((element) => element.getBoundingClientRect().top > innerHeight))
          .toBe(true);
        const sidebarPage = { offset: 16, source: "sidebar" };
        await gateway.deferNext("sessions.list", sidebarPage);
        const before = (await gateway.getRequests("sessions.list", sidebarPage)).length;
        expect(before).toBe(0);
        await toggle.click();
        await expectAttribute(toggle, "aria-expanded", "false");
        const attention = other.locator(".sidebar-session-group-attention");
        await attention.waitFor();
        await more.waitFor();
        await expect
          .poll(() =>
            more.evaluate((element) => element.getBoundingClientRect().bottom < innerHeight),
          )
          .toBe(true);
        // Allow actual observer delivery after layout; no mocked IntersectionObserver.
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }),
        );
        for (const colorScheme of ["dark", "light"] as const) {
          await page.emulateMedia({ colorScheme });
          await page.mouse.move(900, 400);
          if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
            await captureFrame(
              suite.artifactDir,
              colorScheme + ".png",
              sidebar.locator(".sidebar"),
              [attention, unread, more],
            );
          }
          expect.soft(await dotStyle(attention)).toEqual(await dotStyle(unread));
        }
        expect((await gateway.getRequests("sessions.list", sidebarPage)).length).toBe(before);
        expect(await more.getAttribute("aria-busy")).toBe("false");
        await more.click();
        await gateway.waitForRequest("sessions.list", { match: sidebarPage });
        await expectAttribute(more, "aria-busy", "true");
        expect(await more.isDisabled()).toBe(true);
        expect(await more.textContent()).toContain("Loading");
        await gateway.resolveDeferred("sessions.list");
        await expectCount(more, 0);
        await expectAttribute(toggle, "aria-expanded", "false");
        await toggle.click();
        await sidebar
          .locator(".sidebar-shell__body")
          .evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
        await sidebar.locator('[data-session-key="agent:main:older"]').waitFor();
        await expectCount(attention, 0);
      },
    );
  });
});
