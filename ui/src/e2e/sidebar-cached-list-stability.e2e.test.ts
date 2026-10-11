import { expect, it } from "vitest";
import type { AppSidebarSessionNavigationElement } from "../components/app-sidebar-session-navigation.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it.each(["fresh", "stale"] as const)(
    "publishes fresh child activity over the initial %s root list",
    async (initialPrimary) => {
      const baseTime = Date.parse("2026-09-16T00:00:00Z");
      const parentKey = "agent:main:jitter-parent";
      const selectedKey = "agent:main:jitter-selected";
      const children = Array.from({ length: 12 }, (_, index) =>
        sessionRow(
          `agent:main:dashboard:jitter-${index}`,
          `Research session ${index + 1}`,
          baseTime,
          {
            spawnedBy: parentKey,
            snapshotAt: baseTime + 200,
            createdAt: baseTime - index,
            hasActiveRun: index >= 4 && index <= 8,
            activeRunIds: index >= 4 && index <= 8 ? [`run-${index}`] : [],
            status: index >= 4 && index <= 8 ? "running" : "done",
          },
        ),
      );
      const parent = sessionRow(parentKey, "Research home", baseTime + 10, {
        childSessions: children.map((child) => child.key),
        category: "Development",
        snapshotAt: baseTime + 200,
      });
      const selected = sessionRow(selectedKey, "Section below children", baseTime, {
        category: "PR: Open",
        snapshotAt: baseTime + 200,
      });
      const initialChildren = children.map((child, index) =>
        initialPrimary === "stale" && index === 8
          ? { ...child, hasActiveRun: false, activeRunIds: [], status: "done" }
          : child,
      );
      const initialRoot = {
        ...sessionsListResponse(
          [parent, selected, ...initialChildren].map((row) => ({
            ...row,
            snapshotAt: baseTime + 100,
          })),
        ),
        ts: baseTime + 100,
      };
      const freshChildren = { ...sessionsListResponse(children), ts: baseTime + 200 };
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 1000 } },
        async ({ page }) => {
          await installMockGateway(page, {
            sessions: [parent, selected, ...children],
            sessionKey: selectedKey,
            sessionGroups: ["Development", "PR: Open"],
            methodResponses: {
              "sessions.list": {
                cases: [
                  { match: { spawnedBy: parentKey }, response: freshChildren },
                  {
                    match: { spawnedBy: selectedKey },
                    response: { ...sessionsListResponse([]), ts: baseTime + 200 },
                  },
                  { response: initialRoot },
                ],
              },
            },
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, selectedKey));
          const toggle = page.locator(`[data-child-session-toggle="${parentKey}"]`);
          await expect.poll(() => toggle.count()).toBe(1);
          if ((await toggle.getAttribute("aria-expanded")) !== "true") {
            await toggle.click();
          }
          const childList = page.locator(
            `[data-session-tree="${parentKey}"] > .sidebar-session-tree__children > .sidebar-session-tree__list`,
          );
          await expect
            .poll(() =>
              page.evaluate((key) => {
                const sidebar =
                  document.querySelector<AppSidebarSessionNavigationElement>(
                    "openclaw-app-sidebar",
                  );
                return sidebar?.sessionData.context?.sessions.listSnapshot({
                  spawnedBy: key,
                  limit: 100,
                  includeGlobal: false,
                  includeUnknown: false,
                  configuredAgentsOnly: true,
                }).result?.ts;
              }, parentKey),
            )
            .toBe(freshChildren.ts);
          await expect
            .poll(() => childList.locator(":scope > [data-session-tree]").count())
            .toBe(9);
          expect(
            await page.locator(`[data-show-more-children="${parentKey}"]`).textContent(),
          ).toContain("3");
          expect(await page.locator(`[data-session-key="${selectedKey}"]`).isVisible()).toBe(true);
        },
      );
    },
  );
});
