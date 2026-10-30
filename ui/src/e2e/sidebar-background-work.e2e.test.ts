import { expect, it } from "vitest";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import * as ui from "./session-management.compact.test-support.ts";
import {
  createSessionManagementE2eSuite,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it("clears its quiet leading ring from row events without polling", () =>
    suite.withPage(
      {
        ...createControlUiE2eContextOptions(),
        colorScheme: "light",
        viewport: { width: 1440, height: 900 },
      },
      async ({ page }) => {
        const now = Date.now();
        const key = "agent:main:background-build";
        const background = sessionRow(key, "Background build", now - 1, {
          icon: "🔨",
          backgroundProcessCount: 1,
          snapshotAt: now,
        });
        await page.addInitScript(() => {
          localStorage.setItem("openclaw:sidebar:sessions:grouping", "none");
          localStorage.setItem("openclaw:sidebar:sessions:show-preview", "false");
        });
        const gateway = await ui.installSessionRows(
          page,
          [sessionRow("agent:main:main", "Planning desk", now), background],
          {
            sessionKey: "agent:main:main",
            historyMessages: [
              { role: "assistant", content: "The build continues in the background." },
            ],
          },
        );
        await page.goto(`${suite.server.baseUrl}chat`);
        const row = page.locator(`.sidebar-recent-session[data-session-key="${key}"]`);
        await ui.visible(row);
        const ring = row.getByRole("img", { name: "Background work running", exact: true });
        await ui.visible(ring);
        expect(await ring.getAttribute("class")).toContain("session-glyph__ring--background");
        expect(await row.locator(".sidebar-session-indicator .session-glyph__ring").count()).toBe(
          1,
        );
        // The chat pane admits its initial child roster after the sidebar is ready.
        await gateway.waitForRequest("sessions.list", {
          match: { source: "chat-pane", spawnedBy: "agent:main:main" },
        });
        const listReads = (await gateway.getRequests("sessions.list")).length;
        await gateway.emitGatewayEvent("sessions.changed", {
          reason: "background-processes",
          agentId: "main",
          backgroundProcessCount: null,
          session: { ...background, snapshotAt: now + 1, backgroundProcessCount: null },
          ancestorSessions: [],
          ts: now + 1,
        });
        await expect.poll(() => ring.count()).toBe(0);
        expect((await gateway.getRequests("sessions.list")).length).toBe(listReads);
        expect(await gateway.getRequests("sessions.processes.list")).toEqual([]);
      },
    ));

  it("keeps a background child beyond the quiet cap and preserves the hidden subagent ring", () =>
    suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const now = Date.now();
      const parentKey = "agent:main:build-plan";
      const children = Array.from({ length: 6 }, (_, index) =>
        sessionRow(`agent:main:build-child-${index}`, `Build check ${index}`, now - index - 1, {
          parentSessionKey: parentKey,
          spawnedBy: parentKey,
          createdAt: now - index - 1,
          ...(index === 5 ? { backgroundProcessCount: 1 } : {}),
        }),
      );
      const hiddenRun = sessionRow("agent:main:subagent:build-worker", "Build worker", now - 7, {
        spawnedBy: parentKey,
        backgroundProcessCount: 1,
      });
      const descendants = [...children, hiddenRun];
      const parent = sessionRow(parentKey, "Build plan", now, {
        backgroundProcessCount: 1,
        childSessions: descendants.map((child) => child.key),
        worktree: { branch: "build/checks", repoRoot: "/workspace/demo" },
      });
      await page.addInitScript(() => {
        localStorage.setItem("openclaw:sidebar:sessions:collapsed-sections", '["work"]');
      });
      await ui.installSessionRows(page, [parent], {
        sessionKey: "agent:main:main",
        sessions: [parent, ...descendants],
        methodResponses: {
          "sessions.list": {
            cases: [
              { match: { spawnedBy: parentKey }, response: sessionsListResponse(descendants) },
              { response: sessionsListResponse([parent, ...descendants]) },
            ],
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      const section = page.locator('[data-session-section="work"]');
      const sectionToggle = section.locator(".sidebar-session-group-toggle");
      await ui.visible(sectionToggle);
      await ui.visible(section.locator(".sidebar-session-group-running"));
      await sectionToggle.click();
      const parentRow = page.locator(`.sidebar-recent-session[data-session-key="${parentKey}"]`);
      const toggle = parentRow.locator("[data-child-session-toggle]");
      await ui.visible(toggle);
      expect(await toggle.getAttribute("aria-expanded")).toBe("false");
      expect(
        await parentRow
          .locator(".sidebar-session-indicator .session-glyph__ring--background")
          .count(),
      ).toBe(0);
      await ui.visible(toggle.locator(".session-run-spinner"));
      expect(await toggle.getAttribute("aria-description")).toBe("Active run");
      await toggle.click();
      const background = page.locator(
        `.sidebar-recent-session[data-session-key="${children[5]!.key}"]`,
      );
      await ui.visible(
        background.getByRole("img", { name: "Background work running", exact: true }),
      );
      expect(
        await page
          .locator(`.sidebar-recent-session[data-session-key="${children[4]!.key}"]`)
          .count(),
      ).toBe(0);
      expect(
        await parentRow
          .locator(".sidebar-session-indicator .session-glyph__ring--background")
          .count(),
      ).toBe(0);
      await ui.visible(
        parentRow.locator(".sidebar-session-indicator").getByRole("img", {
          name: "Subagents working",
          exact: true,
        }),
      );
      expect(
        await parentRow.locator('.session-row-aside [aria-label="Subagents working"]').count(),
      ).toBe(0);
      expect(await page.locator(`[data-session-key="${hiddenRun.key}"]`).count()).toBe(0);
    }));
});
