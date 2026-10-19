import type { Page } from "playwright";
import { expect, it } from "vitest";
import { waitForControlUiGatewayReconnecting } from "../test-helpers/control-ui-e2e-readiness.ts";
import {
  installMockGateway,
  pauseVirtualClock,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { expectAttribute, expectCount, showText } from "./activity-assertions.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Live Activity current sessions mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (path) => `Playwright Chromium is unavailable at ${path}`,
});
const at = 1_800_000_000_000;
const running = {
  key: "agent:main:main",
  agentId: "main",
  sessionId: "session-running",
  kind: "direct",
  updatedAt: at,
  label: "Review release notes",
  hasActiveRun: true,
  status: "running",
  activeRunIds: ["run-review"],
};
const queued = {
  ...running,
  key: "agent:main:links",
  sessionId: "session-queued",
  label: "Check documentation links",
  status: "queued",
  activeRunIds: ["run-links"],
};
const listing = (sessions: object[]) => ({
  ts: at,
  path: "",
  count: sessions.length,
  totalCount: sessions.length,
  hasMore: false,
  sessions,
  defaults: { model: null, modelProvider: null, contextTokens: null },
});
const finished = ({ key, agentId, sessionId }: typeof running) => ({
  key,
  agentId,
  sessionId,
  updatedAt: at + 1000,
  status: "done",
  hasActiveRun: false,
});
async function openCurrentWork(page: Page, options: Parameters<typeof installMockGateway>[1]) {
  const gateway = await installMockGateway(page, options);
  await page.goto(`${suite.server.baseUrl}activity?view=live`);
  await waitForControlUiRoute(page, { routeId: "activity", search: "?view=live" });
  await gateway.waitForRequest("sessions.list", { match: { activeOnly: true } });
  const current = page.getByRole("region", { name: "Active sessions", exact: true });
  return { gateway, current, rows: current.locator(".activity-current-work__row") };
}

suite.define(() => {
  it("loads running and queued sessions before events and refreshes current work on reconnect", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const { gateway, current, rows } = await openCurrentWork(page, {
        sessionKey: "main",
        sessions: [running, queued],
        methodResponses: { "sessions.list": listing([running, queued]) },
      });
      const entries = page.locator(".activity-entry");
      await showText(current, "Review release notes");
      await showText(current, "Queued");
      expect(await rows.count()).toBe(2);
      expect(await entries.count()).toBe(0);

      await gateway.emitGatewayEvent("session.tool", {
        stream: "tool",
        runId: "run-review",
        sessionKey: running.key,
        data: {
          phase: "result",
          name: "read",
          toolCallId: "read-release-notes",
          result: { text: "Release notes checked." },
        },
      });
      await expectCount(entries).toBe(1);
      await page.getByRole("button", { name: "Clear", exact: true }).click();
      await expectCount(entries).toBe(0);
      expect(await rows.count()).toBe(2);

      await gateway.setMethodResponse("sessions.list", listing([queued]));
      await gateway.emitGatewayEvent("sessions.changed", {
        ...finished(running),
        activeRunIds: [],
      });
      await expectCount(rows).toBe(1);
      await gateway.setOnline(false);
      await waitForControlUiGatewayReconnecting(page);
      expect(await current.getByText("Check documentation links", { exact: true }).count()).toBe(1);
      expect(await rows.count()).toBe(1);
      expect(
        await current
          .getByText("Connect to the Gateway to load active sessions.", { exact: true })
          .count(),
      ).toBe(0);
      await gateway.setMethodResponse("sessions.list", listing([]));
      const previousReads = await gateway.deferNext("sessions.list", { activeOnly: true });
      await gateway.setOnline(true);
      await gateway.waitForRequest("sessions.list", {
        after: previousReads,
        match: { activeOnly: true },
      });
      expect(await current.getByText("Check documentation links", { exact: true }).count()).toBe(1);
      await gateway.resolveDeferred("sessions.list", listing([]), { match: { activeOnly: true } });
      await showText(current, "No active sessions.");
      expect(await rows.count()).toBe(0);
      await page.clock.install();
      await pauseVirtualClock(page);
      await gateway.setMethodResponse("sessions.list", {
        __mockError: { code: "UNAVAILABLE", message: "Snapshot unavailable" },
      });
      await gateway.emitGatewayEvent("sessions.changed", { reason: "update" });
      // Cross the full refresh window and deliver its nested mock response timer.
      await page.clock.runFor(5_001);
      await showText(current, "Could not load active sessions.");
      await page.clock.resume();
      await gateway.setMethodResponse("sessions.list", listing([]));
      await current.getByRole("button", { name: "Retry", exact: true }).click();
      await showText(current, "No active sessions.");
    });
  });

  it("reconciles completion during the first snapshot and keeps global navigation owner-specific", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const sessionRow = (agentId: string, kind = "global", literal = false) => ({
        ...running,
        key: literal ? `agent:${agentId}:${kind}` : kind,
        agentId,
        kind: literal ? running.kind : kind,
        label: literal ? `Literal ${kind} session` : `${agentId} ${kind} work`,
        sessionId: literal ? `literal-${kind}` : `${kind}-${agentId}`,
        activeRunIds: !literal && kind === "global" ? [`run-${agentId}`] : running.activeRunIds,
      });
      const mainGlobal = sessionRow("main");
      const workGlobal = sessionRow("work");
      const literal = sessionRow("work", "global", true);
      const unknown = ["main", "work"].map((agentId) => sessionRow(agentId, "unknown"));
      const literalUnknown = sessionRow("work", "unknown", true);
      const activeRows = [mainGlobal, workGlobal, literal, ...unknown, literalUnknown];
      const remainingRows = activeRows.filter((row) => row !== mainGlobal);
      const { gateway, current, rows } = await openCurrentWork(page, {
        sessionScope: "global",
        heldMethods: ["sessions.list"],
        sessions: activeRows,
        methodResponses: {
          "agents.list": {
            defaultId: "main",
            mainKey: "main",
            scope: "global",
            agents: [{ id: "main" }, { id: "work" }],
          },
          "sessions.list": {
            cases: [
              // Only the held first snapshot predates the completion event.
              { match: { activeOnly: true }, response: listing(remainingRows) },
              { match: { agentId: "work" }, response: listing([workGlobal, literal]) },
              { match: {}, response: listing([mainGlobal, literal]) },
            ],
          },
        },
      });
      const row = (key: string, agentId?: string) =>
        current.locator(
          `[data-session-key="${key}"]${agentId ? `[data-agent-id="${agentId}"]` : ""}`,
        );
      await showText(current, "Loading active sessions…");
      const currentRequests = (await gateway.getRequests("sessions.list", { activeOnly: true }))
        .length;
      await gateway.emitGatewayEvent("sessions.changed", finished(mainGlobal));
      await gateway.resolveDeferred("sessions.list", listing(activeRows));
      await expectCount(rows).toBe(5);
      // The completion fully reconciles this bounded snapshot; no catch-up RPC is needed.
      await expectAttribute(current, "aria-busy").toBe("false");
      expect(await gateway.getRequests("sessions.list", { activeOnly: true })).toHaveLength(
        currentRequests,
      );
      const work = row("global", "work");
      await showText(work, "work global work");
      expect(await work.getAttribute("href")).toBe("/chat/work");
      expect(await row("agent:work:global").getAttribute("href")).toBe("/chat/work/~key/global");
      expect(await row("global", "main").count()).toBe(0);
      expect(await rows.count()).toBe(5);
      expect(await row("unknown").count()).toBe(2);
      expect(await current.locator('a[data-session-key="unknown"]').count()).toBe(0);
      expect(
        await current.locator('a[data-session-key="agent:work:unknown"]').getAttribute("href"),
      ).toBe("/chat/work/unknown");
      expect(await page.locator(".activity-entry").count()).toBe(0);
      await work.click();
      await waitForControlUiRoute(page, { routeId: "chat", pathname: "/chat/work" });
      await gateway.waitForRequest("chat.startup", {
        match: { sessionKey: "agent:work:main", agentId: "work" },
      });
    });
  });
});
