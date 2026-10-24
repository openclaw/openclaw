import { writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Page } from "playwright";
import { expect, it, onTestFinished } from "vitest";
import { SIDEBAR_SESSION_ROSTER_LIMIT } from "../../../src/shared/session-list-limits.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway, pauseVirtualClock } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { expectCount } from "./session-page.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI session-list event scope" });
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

async function openSessionFilters(page: Page) {
  await page.getByRole("button", { name: "Filters" }).click();
  await page.locator(".sessions-filter-popover:popover-open").waitFor();
}

async function newPage(recordVideo = false) {
  const context = await suite.browser.newContext({
    viewport: { height: 800, width: 1200 },
    ...(recordVideo ? { recordVideo: { dir: suite.artifactDir } } : {}),
  });
  onTestFinished(() => context.close().catch(() => {}));
  return context.newPage();
}
function sessionList(sessions: ReturnType<typeof row>[], ts = 1) {
  return {
    count: sessions.length,
    defaults: { contextTokens: null, model: null, modelProvider: null },
    path: "",
    sessions,
    ts,
  };
}
function row(key: string, label: string, updatedAt = 1) {
  return { key, label, updatedAt, kind: "direct" };
}
type Gateway = Awaited<ReturnType<typeof installMockGateway>>;
function scopedParams(
  requests: Awaited<ReturnType<Gateway["getRequests"]>>,
  includeUnknown: boolean,
) {
  return requests.find(
    ({ params }) =>
      (params as { includeUnknown?: unknown } | undefined)?.includeUnknown === includeUnknown,
  )?.params;
}
async function lastParams(gateway: Gateway) {
  return (await gateway.getRequests("sessions.list")).at(-1)?.params as
    | Record<string, unknown>
    | undefined;
}
async function waitForList(gateway: Gateway, previousCount: number) {
  await expect
    .poll(async () => (await gateway.getRequests("sessions.list")).length)
    .toBeGreaterThan(previousCount);
}
const allAgentsQuery = {
  configuredAgentsOnly: true,
  excludeDock: true,
  ifRowsRevision: "",
  includeGlobal: true,
  includeUnknown: false,
  limit: 50,
  rowMode: "compact",
  source: "sessions-page",
};
suite.define(() => {
  it("refetches instead of showing a row excluded by configured-agent filtering", async () => {
    const visibleLabel = "Visible configured session";
    const hiddenLabel = "Hidden unconfigured session";
    const page = await newPage();
    const gateway = await installMockGateway(page, {
      sessionKey: "unknown",
      methodResponses: {
        "agents.list": {
          defaultId: "main",
          mainKey: "main",
          scope: "per-sender",
          agents: [{ id: "main" }, { id: "writer" }],
        },
        "sessions.list": sessionList([row("agent:main:visible", visibleLabel)]),
      },
    });

    await page.goto(`${suite.server?.baseUrl ?? ""}sessions`);
    const visibleRow = page.getByText(visibleLabel, { exact: true }).first();
    await visibleRow.waitFor({ timeout: 10_000 });
    // An agent-scoped list can ignore another agent; this query must exercise
    // the Gateway's configured-agent membership filter across all agents.
    const pageScope = page.locator(".agent-scope-control openclaw-agent-select");
    await pageScope.locator(".agent-select__trigger").click();
    await pageScope
      .locator(".agent-select__option[data-agent-option]")
      .filter({ hasText: "All agents" })
      .evaluate((item) => (item as HTMLElement).click());
    await expect
      .poll(async () =>
        (await gateway.getRequests("sessions.list")).map((request) => request.params),
      )
      .toContainEqual({ ...allAgentsQuery, ifRowsRevision: "" });
    await gateway.deferNext("sessions.list", { ...allAgentsQuery, ifRowsRevision: "" });
    const requestsBeforeEvent = await gateway.getRequests("sessions.list");

    await page.clock.install();
    await pauseVirtualClock(page);
    await gateway.emitGatewayEvent("sessions.changed", {
      sessionKey: "agent:local:hidden",
      reason: "create",
      key: "agent:local:hidden",
      kind: "direct",
      label: hiddenLabel,
      updatedAt: 2,
      archived: false,
    });

    // Cross the full event window while keeping the response explicitly deferred.
    await page.clock.runFor(5_000);
    await waitForList(gateway, requestsBeforeEvent.length);
    expect((await gateway.getRequests("sessions.list")).at(-1)?.params).toEqual({
      ...allAgentsQuery,
      ifRowsRevision: "",
    });
    expect(await page.getByText(hiddenLabel, { exact: true }).count()).toBe(0);
    await page.clock.resume();
    await gateway.resolveDeferred(
      "sessions.list",
      sessionList([row("agent:main:visible", visibleLabel, 3)], 3),
    );
    await visibleRow.waitFor();
    expect(await page.getByText(hiddenLabel, { exact: true }).count()).toBe(0);
  });

  it("keeps the Sessions page query stable when the startup roster completes", async () => {
    const visibleLabel = "Visible page-owned session";
    const pageQueryParams = { ...allAgentsQuery, agentId: "main", ifRowsRevision: "" };
    const visibleResponse = sessionList([row("agent:main:page-owned", visibleLabel)]);
    const page = await newPage(captureUiProof);
    const gateway = await installMockGateway(page, {
      deferredMethods: ["sessions.list"],
      sessionKey: "agent:main:main",
      methodResponses: {
        "sessions.list": {
          cases: [
            { match: pageQueryParams, response: visibleResponse },
            { response: sessionList([]) },
          ],
        },
      },
    });
    const exactPageQueries = async () =>
      (await gateway.getRequests("sessions.list")).filter(({ params }) =>
        isDeepStrictEqual(params, pageQueryParams),
      );
    const capture = async (stage: string) => {
      if (!captureUiProof) {
        return;
      }
      await writeFile(
        path.join(suite.artifactDir, `${stage}.png`),
        await takeControlUiViewportScreenshot(page, page.locator(".shell"), [visibleRow]),
      );
      await writeFile(
        path.join(suite.artifactDir, `${stage}.json`),
        JSON.stringify(await gateway.getRequests("sessions.list"), null, 2),
      );
    };

    await page.goto(`${suite.server.baseUrl}sessions`);
    const visibleRow = page.getByText(visibleLabel, { exact: true }).first();
    await visibleRow.waitFor({ timeout: 10_000 });
    await capture("before-startup-roster");

    const startupAndPageRequests = await gateway.getRequests("sessions.list");
    expect(startupAndPageRequests[0]?.params).toEqual({
      agentId: "main",
      configuredAgentsOnly: true,
      excludeDock: true,
      includeGlobal: true,
      includeDerivedTitles: true,
      includeLastMessage: true,
      includeUnknown: true,
      limit: SIDEBAR_SESSION_ROSTER_LIMIT,
      rowMode: "sidebar",
      source: "sidebar",
    });
    expect
      .soft((await exactPageQueries()).map((request) => request.params))
      .toEqual([pageQueryParams]);

    await gateway.resolveDeferred("sessions.list", visibleResponse);
    await visibleRow.waitFor();
    await capture("after-startup-roster");

    const stabilityDeadline = Date.now() + 500;
    do {
      expect(await exactPageQueries()).toHaveLength(1);
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
    } while (Date.now() < stabilityDeadline);
  });

  it("keeps older Gateway sessions consistent between the sidebar and Sessions page", async () => {
    const sessionKey = "agent:main:older-stored";
    const sessionLabel = "Older stored session";
    const populatedResponse = sessionList([row(sessionKey, sessionLabel)]);
    const page = await newPage();
    const gateway = await installMockGateway(page, {
      sessionKey: "agent:main:main",
      methodResponses: {
        "sessions.list": {
          cases: [
            { match: { activeMinutes: 60 }, response: sessionList([], 2) },
            { response: populatedResponse },
          ],
        },
      },
    });

    await page.goto(`${suite.server?.baseUrl ?? ""}chat`);
    const sidebarRow = page.locator(`.sidebar-recent-session[data-session-key="${sessionKey}"]`);
    await sidebarRow.getByText(sessionLabel, { exact: true }).waitFor({ timeout: 10_000 });
    const sidebarRequests = await gateway.getRequests("sessions.list");
    const sidebarParams = scopedParams(sidebarRequests, true);
    expect(sidebarParams).toMatchObject({ limit: SIDEBAR_SESSION_ROSTER_LIMIT });
    expect(sidebarParams).not.toHaveProperty("activeMinutes");

    await page.goto(`${suite.server?.baseUrl ?? ""}sessions`);
    const sessionsPage = page.locator("openclaw-sessions-page");
    await sessionsPage.getByText(sessionLabel, { exact: true }).waitFor({ timeout: 10_000 });
    const initialPageRequests = await gateway.getRequests("sessions.list");
    const initialPageParams = scopedParams(initialPageRequests, false);
    expect(initialPageParams).toMatchObject({ limit: 50 });
    expect(initialPageParams).not.toHaveProperty("activeMinutes");

    await openSessionFilters(page);
    const activeMinutes = sessionsPage.getByLabel("Updated within");
    const limit = sessionsPage.getByLabel("Limit");
    await expect.poll(() => activeMinutes.inputValue()).toBe("");
    await expect.poll(() => limit.inputValue()).toBe("50");

    let requestCount = initialPageRequests.length;
    await activeMinutes.fill("60");
    await waitForList(gateway, requestCount);
    const filteredParams = await lastParams(gateway);
    expect(filteredParams).toMatchObject({ activeMinutes: 60, limit: 50 });
    await expectCount(sessionsPage.getByText(sessionLabel, { exact: true }), 0);

    requestCount = (await gateway.getRequests("sessions.list")).length;
    await sessionsPage.getByRole("button", { name: "Show all" }).click();
    await waitForList(gateway, requestCount);
    await sessionsPage.getByText(sessionLabel, { exact: true }).waitFor();
    const resetParams = await lastParams(gateway);
    expect(resetParams).toMatchObject({ includeUnknown: false, limit: 50 });
    expect(resetParams).not.toHaveProperty("activeMinutes");
    await expect.poll(() => activeMinutes.inputValue()).toBe("");
    await expect.poll(() => limit.inputValue()).toBe("50");
  });

  it("omits noncanonical numeric filters from sessions.list requests", async () => {
    const page = await newPage();
    const gateway = await installMockGateway(page, {
      sessionKey: "unknown",
      methodResponses: {
        "sessions.list": sessionList([]),
      },
    });

    await page.goto(`${suite.server?.baseUrl ?? ""}sessions`);
    await gateway.waitForRequest("sessions.list");
    await openSessionFilters(page);
    const activeMinutes = page.getByLabel("Updated within");
    const limit = page.getByLabel("Limit");
    const cases = [
      ["60minutes", "70junk", undefined, 50],
      ["12.5", "1e2", undefined, 50],
      ["9007199254740993", "9007199254740993", undefined, 50],
      ["+30", "060", 30, 60],
      [" 80 ", " 090 ", 80, 90],
    ] as const;
    for (const [minutes, cap, expectedMinutes, expectedLimit] of cases) {
      const requestCount = (await gateway.getRequests("sessions.list")).length;
      await activeMinutes.fill(minutes);
      await limit.fill(cap);
      await waitForList(gateway, requestCount);
      await expect
        .poll(async () => {
          const params = await lastParams(gateway);
          return { activeMinutes: params?.activeMinutes, limit: params?.limit };
        })
        .toEqual({ activeMinutes: expectedMinutes, limit: expectedLimit });
    }
  });
});
