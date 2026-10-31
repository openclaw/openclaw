import type { Page } from "playwright";
import { expect, it } from "vitest";
import { SIDEBAR_SESSION_ROSTER_LIMIT } from "../../../src/shared/session-list-limits.ts";
import { getControlUiContextHandle } from "../test-helpers/control-ui-e2e-context.ts";
import {
  installMockGateway,
  pauseVirtualClock,
  waitForControlUiRoute,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI dashboard session-list demand",
});

const COMMON_REQUEST_PARAMS = {
  configuredAgentsOnly: true,
  excludeDock: true,
  includeGlobal: true,
  includeUnknown: true,
  limit: SIDEBAR_SESSION_ROSTER_LIMIT,
} as const;
const DASHBOARD_REQUEST_PARAMS = {
  ...COMMON_REQUEST_PARAMS,
  ifRowsRevision: "",
  archived: "all",
  hasBoard: true,
  rowMode: "dashboard",
  source: "dashboard",
} as const;

function sessionsResult(key: string, label: string, updatedAt: number) {
  return {
    count: 1,
    defaults: { contextTokens: null, model: null, modelProvider: null },
    path: "",
    sessions: [{ boardFace: "dashboard", key, kind: "direct", label, updatedAt }],
    ts: updatedAt,
  };
}

const dashboardResponse = (response: unknown, match: object = { hasBoard: true }) => ({
  cases: [{ match, response }],
});
const allBoardsResponse = (response: unknown) =>
  dashboardResponse(response, { archived: "all", hasBoard: true });
const listMethod = "sessions.list";
const installList = (
  page: Page,
  response: unknown,
  options: Parameters<typeof installMockGateway>[1] = {},
) => installMockGateway(page, { ...options, methodResponses: { [listMethod]: response } });
const setList = (gateway: MockGatewayControls, response: unknown) =>
  gateway.setMethodResponse(listMethod, dashboardResponse(response));
const getDashboardRequests = async (gateway: MockGatewayControls) =>
  (await gateway.getRequests(listMethod)).filter(isDashboardRequest);
async function resumeGateway(gateway: MockGatewayControls) {
  await gateway.emitGatewayEvent("gateway.suspension", { phase: "draining" });
  await gateway.emitGatewayEvent("gateway.suspension", { phase: "accepting" });
}
const listError = (message: string, suspending = false) => ({
  __mockError: {
    code: "UNAVAILABLE",
    message,
    retryable: true,
    ...(suspending ? { details: { reason: "gateway-suspending", phase: "draining" } } : {}),
  },
});
const changedSession = (key: string, updatedAt?: number) => ({
  agentId: "main",
  key,
  sessionKey: key,
  kind: "direct",
  reason: "update",
  updatedAt,
});

function isDashboardRequest(request: { params?: unknown }): boolean {
  return (
    typeof request.params === "object" &&
    request.params !== null &&
    "hasBoard" in request.params &&
    request.params.hasBoard === true
  );
}

const listRequests = (gateways: MockGatewayControls[]) =>
  Promise.all(gateways.map((gateway) => gateway.getRequests("sessions.list")));
function requestCounts(requests: Array<{ params?: unknown }>) {
  const dashboard = requests.filter(isDashboardRequest).length;
  return [requests.length - dashboard, dashboard, requests.length];
}

suite.define(() => {
  it("shows failed dashboard refreshes beside retained rows and retries the same query", async () => {
    await suite.withPage({ viewport: { height: 900, width: 1440 } }, async ({ page }) => {
      const key = "agent:main:dashboard-12345678";
      const gateway = await installList(
        page,
        dashboardResponse(sessionsResult(key, "Deploy monitor", 1)),
      );
      await page.goto(`${suite.server.baseUrl}dashboards`);
      const dashboards = page.locator("openclaw-dashboards-page");
      await dashboards.getByText("Deploy monitor", { exact: true }).waitFor();
      await page.clock.install();
      await pauseVirtualClock(page);
      const before = await getDashboardRequests(gateway);
      await gateway.deferNext(listMethod, { hasBoard: true });
      await gateway.emitGatewayEvent("sessions.changed", changedSession(key, 2));
      await page.clock.runFor(5_001);
      await expect
        .poll(async () => (await getDashboardRequests(gateway)).length)
        .toBe(before.length + 1);
      await gateway.rejectDeferred(listMethod, {
        code: "UNAVAILABLE",
        message: "Dashboard refresh unavailable",
        retryable: true,
      });
      expect(await dashboards.getByText("Deploy monitor", { exact: true }).isVisible()).toBe(true);
      expect(await page.locator("openclaw-router-outlet").getAttribute("inert")).toBeNull();
      await expect.poll(() => dashboards.getByRole("alert").allTextContents()).toHaveLength(1);
      const alert = dashboards.getByRole("alert");
      const alertText = await alert.textContent();
      expect(alertText).toContain("Dashboard refresh unavailable");
      expect(alertText).toContain("Showing stale data");
      expect(await alert.getByRole("button").count()).toBe(0);

      await setList(gateway, sessionsResult(key, "Updated deploy monitor", 2));
      await resumeGateway(gateway);
      await page.clock.runFor(5_001);
      await page.clock.resume();
      await dashboards.getByText("Updated deploy monitor", { exact: true }).waitFor();
      expect(await dashboards.getByRole("alert").count()).toBe(0);
      const after = await getDashboardRequests(gateway);
      expect(after).toHaveLength(before.length + 2);
      expect(after.at(-1)?.params).toEqual(before.at(-1)?.params);
    });
  });

  it.each([false, true])(
    "recovers an initial dashboard failure without claiming the list is empty (suspending: %s)",
    async (suspending) => {
      await suite.withPage({ viewport: { height: 900, width: 1440 } }, async ({ page }) => {
        const gateway = await installList(
          page,
          dashboardResponse(listError("Dashboard list unavailable", suspending)),
          {
            awaitInitialRoster: !suspending,
            gatewaySuspensionPhase: suspending ? "draining" : "accepting",
          },
        );
        await page.goto(`${suite.server.baseUrl}dashboards`);
        const dashboards = page.locator("openclaw-dashboards-page");
        if (!suspending) {
          await dashboards.getByRole("alert").waitFor();
          expect(await dashboards.getByRole("alert").textContent()).toContain(
            "Dashboard list unavailable",
          );
          await page.clock.install();
          await pauseVirtualClock(page);
          await setList(gateway, listError("Gateway is suspending", true));
          await gateway.emitGatewayEvent("gateway.suspension", { phase: "draining" });
          await gateway.emitGatewayEvent("sessions.changed", {
            agentId: "main",
            key: "agent:main:dashboard",
            sessionKey: "agent:main:dashboard",
            reason: "update",
          });
          await page.clock.runFor(5_001);
        }
        await dashboards.locator('[aria-busy="true"]').waitFor();
        expect(await dashboards.getByRole("alert").count()).toBe(0);
        expect(await dashboards.getByRole("button", { name: "Retry", exact: true }).count()).toBe(
          0,
        );
        expect(await dashboards.textContent()).not.toContain("Showing stale data");
        expect(await dashboards.locator("[data-dashboards-empty]").count()).toBe(0);
        const emptyResult = { ...sessionsResult("", "", 1), count: 0, sessions: [] };
        await setList(gateway, emptyResult);
        await resumeGateway(gateway);
        if (!suspending) {
          await page.clock.runFor(5_001);
          await page.clock.resume();
        }
        await dashboards.locator("[data-dashboards-empty]").waitFor();
        expect(await dashboards.getByRole("alert").count()).toBe(0);
      });
    },
  );

  it("keeps dashboard query demand at one request per real browser tab", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 800, width: 1200 } });
    try {
      const makeTab = async (index: number) => {
        const page = await context.newPage();
        const dashboardLabel = `Dashboard tab ${index}`;
        const gateway = await installList(
          page,
          allBoardsResponse(sessionsResult(`agent:main:dashboard-${index}`, dashboardLabel, index)),
          { deferredMethods: [listMethod] },
        );
        return {
          gateway,
          page,
          dashboardLabel,
          canonicalLabel: `Older canonical tab ${index}`,
          updatedDashboardLabel: `Updated dashboard tab ${index}`,
        };
      };
      const tabs = [await makeTab(1), await makeTab(2)] as const;
      const gateways = tabs.map(({ gateway }) => gateway);
      const eachTab = (run: (tab: (typeof tabs)[number], index: number) => Promise<unknown>) =>
        Promise.all(tabs.map(run));

      await eachTab(async ({ gateway, page }) => {
        // Chat hydrates its own Swarm child roster; start without that unrelated demand.
        await page.goto(`${suite.server.baseUrl}new`);
        const canonical = await gateway.waitForRequest(listMethod);
        expect(canonical.params).toEqual({
          ...COMMON_REQUEST_PARAMS,
          agentId: "main",
          includeDerivedTitles: true,
          includeLastMessage: true,
          rowMode: "sidebar",
          source: "sidebar",
        });
        await waitForControlUiRoute(page, { pathname: "/new", routeId: "new-session" });
        const appContext = await getControlUiContextHandle(page);
        try {
          await page.waitForFunction(
            (current) => current.agents.state.agentsList != null,
            appContext,
          );
          await appContext.evaluate((current) => {
            current.agentSelection.setScope(null);
            if (current.agentSelection.state.scopeId !== null) {
              throw new Error("Control UI did not enter all-agent scope");
            }
            current.navigate("dashboards");
          });
        } finally {
          await appContext.dispose();
        }
        await waitForControlUiRoute(page, { pathname: "/dashboards", routeId: "dashboards" });
      });
      await eachTab(({ page, dashboardLabel }) =>
        page.getByText(dashboardLabel, { exact: true }).waitFor(),
      );
      expect(requestCounts((await listRequests(gateways)).flat())).toEqual([2, 2, 4]);
      expect(
        (await listRequests(gateways)).map((requests) => requests.find(isDashboardRequest)?.params),
      ).toStrictEqual([DASHBOARD_REQUEST_PARAMS, DASHBOARD_REQUEST_PARAMS]);
      await eachTab(async ({ canonicalLabel, gateway, page }, index) => {
        await gateway.resolveDeferred(
          listMethod,
          sessionsResult(`agent:main:canonical-${index + 1}`, canonicalLabel, 10 + index),
        );
        const sidebar = page.locator("openclaw-app-sidebar");
        // The profileless roster has no ownership identities, so its title stays plain.
        await expect
          .poll(() =>
            sidebar
              .locator(".sidebar-session-toolbar .sidebar-recent-sessions__label-text")
              .textContent(),
          )
          .toBe("Sessions");
        await sidebar.getByText(canonicalLabel, { exact: true }).waitFor();
      });
      // Both tabs share the context clock; advance it once for each event wave.
      await context.clock.install();
      await pauseVirtualClock(tabs[0].page);

      expect(requestCounts((await listRequests(gateways)).flat())).toEqual([2, 2, 4]);

      const beforeWave = await listRequests(gateways);
      await eachTab(async ({ gateway, updatedDashboardLabel }, index) => {
        await gateway.setMethodResponse(
          listMethod,
          allBoardsResponse(
            sessionsResult(
              `agent:main:updated-dashboard-${index + 1}`,
              updatedDashboardLabel,
              20 + index,
            ),
          ),
        );
        await gateway.emitGatewayEvent(
          "sessions.changed",
          changedSession(`agent:main:changed-${index + 1}`, 20 + index),
        );
      });
      await context.clock.runFor(5_001);
      await context.clock.resume();
      await eachTab(({ gateway }, index) =>
        expect
          .poll(async () => {
            const added = (await gateway.getRequests(listMethod)).slice(
              beforeWave[index]?.length ?? 0,
            );
            return requestCounts(added);
          })
          .toEqual([1, 1, 2]),
      );

      const afterWave = await listRequests(gateways);
      expect(afterWave.map(requestCounts)).toEqual([
        [2, 2, 4],
        [2, 2, 4],
      ]);
      const dashboardRequests = afterWave.flat().filter(isDashboardRequest);
      expect(dashboardRequests).toHaveLength(4);
      expect(dashboardRequests.map(({ params }) => params)).toStrictEqual(
        Array.from({ length: 4 }, () => ({ ...DASHBOARD_REQUEST_PARAMS })),
      );
      await eachTab(({ page, updatedDashboardLabel }) =>
        page.getByText(updatedDashboardLabel, { exact: true }).waitFor(),
      );
    } finally {
      await context.close();
    }
  });
});
