import { expect, it } from "vitest";
import {
  controlUiSessionUrl,
  installMockGateway,
  pauseVirtualClock,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Session list row events" });

// These are separate foreground routes. The sidebar and its agent roster share
// each route's connection; manually mounting all pages would invent a UI state.
suite.define(() => {
  it.each(["chat", "sessions", "dashboards", "agents"])(
    "updates held rows on %s without any mounted caller refetching a list",
    async (route) => {
      await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
        const key = "agent:main:row-events";
        const mainKey = "agent:main:main";
        const row = createControlUiSessionRow(key, "Initial roster title", Date.now(), {
          agentId: "main",
          parentSessionKey: mainKey,
          childOwnerSessionKeys: [mainKey],
          boardFace: "dashboard",
          hasBoard: true,
          lastMessagePreview: "Initial roster preview",
          snapshotAt: Date.now(),
        });
        const main = createControlUiSessionRow(mainKey, "Main conversation", row.updatedAt - 2, {
          agentId: "main",
          isMain: true,
          childSessions: [key],
          childOwnerSessionKeys: [],
          hasBoard: false,
          lastMessagePreview: "Main roster preview",
          ancestorRevision: "main-row-revision",
          snapshotAt: row.updatedAt,
        });
        const tail = createControlUiSessionRow(
          "agent:main:gallery-tail",
          "Second gallery page",
          row.updatedAt - 1,
          { agentId: "main", boardFace: "dashboard", hasBoard: true },
        );
        const list = (sessions: (typeof row)[], hasMore = false) => ({
          ts: row.updatedAt,
          path: "",
          count: sessions.length,
          totalCount: hasMore ? 2 : sessions.length,
          defaults: { contextTokens: null, model: null, modelProvider: null },
          sessions,
          hasMore,
          nextOffset: hasMore ? 1 : null,
        });
        const gateway = await installMockGateway(page, {
          sessionKey: key,
          sessions: [row, main, tail],
          historyMessages: [{ role: "assistant", content: "Synthetic conversation" }],
          methodResponses: {
            "board.get": { sessionKey: key, revision: 1, tabs: [], widgets: [] },
            "sessions.list": {
              cases: [
                { match: { hasBoard: true, offset: 1 }, response: list([tail]) },
                { match: { hasBoard: true }, response: list([row], true) },
                { response: list([row, main, tail]) },
              ],
            },
          },
        });
        await page.goto(
          route === "chat"
            ? controlUiSessionUrl(suite.server.baseUrl, key)
            : `${suite.server.baseUrl}${route}`,
        );
        const foreground = page.locator(
          route === "chat"
            ? ".chat-thread"
            : route === "sessions"
              ? ".sessions-table"
              : route === "dashboards"
                ? "[data-dashboard-session]"
                : ".agents-home__preview",
        );
        await foreground.first().waitFor();
        if (route === "dashboards") {
          await expect.poll(() => foreground.count()).toBe(2);
        }
        const sidebarRow = page.locator(`openclaw-app-sidebar [data-session-key="${key}"]`).first();
        await expect.poll(() => sidebarRow.textContent()).toContain("Initial roster title");
        await gateway.waitForRequest("sessions.list", { match: { spawnedBy: mainKey } });
        if (route === "chat") {
          await gateway.waitForRequest("sessions.list", { match: { spawnedBy: key } });
        }
        await page.clock.install();
        await pauseVirtualClock(page);
        const before = await gateway.getRequests("sessions.list");
        expect(before.length).toBeGreaterThan(0);
        const now = await page.evaluate(() => Date.now());
        await gateway.emitGatewayEvent("sessions.changed", {
          agentId: "main",
          sessionKey: key,
          reason: "patch",
          ancestorSessions: [{ ...main, snapshotAt: now }],
          session: {
            ...row,
            label: "Updated by certified event",
            displayName: "Updated by certified event",
            lastMessagePreview: "Updated roster preview",
            updatedAt: now,
            snapshotAt: now,
          },
        });
        await expect.poll(() => sidebarRow.textContent()).toContain("Updated by certified event");
        if (route !== "chat") {
          await expect
            .poll(() => foreground.first().textContent())
            .toContain(route === "agents" ? "Main roster preview" : "Updated by certified event");
        }
        await page.clock.runFor(500);
        await gateway.emitGatewayEvent("sessions.changed", {
          agentId: "main",
          sessionKey: key,
          reason: "patch",
          ancestorSessions: [],
          ancestorSessionRefs: [
            {
              key: mainKey,
              sessionId: main.sessionId,
              revision: "main-row-revision",
              snapshotAt: now + 500,
            },
          ],
          session: {
            ...row,
            label: "Updated with held ancestor",
            displayName: "Updated with held ancestor",
            updatedAt: now + 500,
            snapshotAt: now + 500,
          },
        });
        await expect.poll(() => sidebarRow.textContent()).toContain("Updated with held ancestor");
        await page.clock.runFor(59_499);
        expect(await gateway.getRequests("sessions.list")).toEqual(before);
        for (const request of before) {
          expect(request.params).toMatchObject({ rowMode: "compact", source: expect.any(String) });
        }
      });
    },
  );
});
