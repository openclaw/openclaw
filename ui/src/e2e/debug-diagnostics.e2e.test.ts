import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { deviceSystemInfo } from "../test-helpers/devices-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { catalogModel } from "./model-catalog-fixtures.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Debug diagnostics mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

function systemInfo(
  total: number,
  utilization: number,
  delays: [number, number],
  memory: [number, number, number],
  cpu: [number | undefined, number | undefined, number | undefined, number | undefined],
) {
  const [mainThreadCoreRatio, workerCoreRatio, otherThreadsCoreRatio, hostUtilization] = cpu;
  const [rss, used, heap] = memory;
  return {
    ...deviceSystemInfo,
    eventLoop: {
      degraded: false,
      reasons: [],
      intervalMs: 1_000,
      utilization,
      cpuCoreRatio: total,
      delayP99Ms: delays[0],
      delayMaxMs: delays[1],
      cpuBreakdown: {
        mainThreadCoreRatio,
        workerCoreRatio,
        otherThreadsCoreRatio,
        hostUtilization,
        hostCpuCount: 8,
      },
    },
    processMemory: {
      rssBytes: rss * 1_048_576,
      heapUsedBytes: used * 1_048_576,
      heapTotalBytes: heap * 1_048_576,
    },
  };
}
const contains = (target: Locator, text: string) =>
  expect.poll(() => target.textContent()).toContain(text);
async function expectBounds(target: Locator, width: number, height: number, inset?: number) {
  const bounds = await target.boundingBox();
  expect(bounds).not.toBeNull();
  const { x, y, width: w, height: h } = bounds!;
  expect(Math.min(x, y, width - x - w, height - y - h)).toBeGreaterThanOrEqual(0);
  if (inset !== undefined) {
    expect(Math.max(width - x - w, height - y - h)).toBeLessThanOrEqual(inset);
  }
  return bounds!;
}
const finishAnimations = (target: Locator) =>
  target.evaluate(async (element) => {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
  });

async function exerciseDiagnostics({ page }: { page: Page }) {
  const noOverflow = async () =>
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  await page.clock.install();
  const activeRows = Array.from({ length: 101 }, (_, index) => ({
    key: index === 0 ? "global" : index === 1 ? "unknown" : `agent:main:older-${index}`,
    agentId: "main",
    sessionId: `active-session-${index}`,
    kind: index === 0 ? "global" : index === 1 ? "unknown" : "direct",
    updatedAt: 1000 - index,
    hasActiveRun: true,
    status: index === 1 ? "queued" : "running",
    activeRunIds: [`active-run-${index}`],
    archived: index === 2,
  }));
  const recentIdleRows = Array.from({ length: 100 }, (_, index) => ({
    key: `agent:main:recent-${index}`,
    sessionId: `idle-session-${index}`,
    kind: "direct",
    updatedAt: 2000 + index,
    hasActiveRun: false,
  }));
  const listing = (sessions: object[], totalCount = sessions.length) => ({
    ts: 3000,
    path: "",
    count: sessions.length,
    totalCount,
    limitApplied: 100,
    nextOffset: sessions.length < totalCount ? sessions.length : null,
    hasMore: sessions.length < totalCount,
    sessions,
    defaults: { model: null, modelProvider: null, contextTokens: null },
  });
  const currentWorkQuery = {
    activeOnly: true,
    archived: "all",
    includeGlobal: true,
    includeUnknown: true,
  };
  const gateway = await installMockGateway(page, {
    sessionScope: "global",
    sessions: [...activeRows, ...recentIdleRows],
    methodResponses: {
      "sessions.list": {
        cases: [
          { match: currentWorkQuery, response: listing(activeRows.slice(0, 100), 101) },
          { match: {}, response: listing(recentIdleRows, 198) },
        ],
      },
      status: {
        runtime: "diagnostics-e2e",
        securityAudit: { summary: { critical: 0, warn: 1, info: 2 } },
      },
      "system.info": systemInfo(0.25, 0.2, [4, 8], [432, 210, 256], [0.18, 0.04, 0.03, 0.23]),
      health: { ok: true, gateway: "healthy" },
      "models.list": {
        models: [catalogModel("openai", "gpt-5.6-luna", "GPT-5.6 Luna")],
      },
      "last-heartbeat": { ageMs: 1250, source: "gateway-heartbeat" },
      "diagnostics.lanes": {
        lanes: [
          {
            lane: "main",
            queuedCount: 0,
            activeCount: 0,
            maxConcurrent: 16,
            draining: false,
            generation: 1,
          },
        ],
        dynamic: null,
      },
    },
  });

  const response = await page.goto(`${suite.server.baseUrl}debug`);
  expect(response?.status()).toBe(200);
  await page.locator(".page-title", { hasText: "Debug" }).waitFor();
  const snapshots = page.locator(".settings-section", {
    has: page.getByRole("heading", { name: "Snapshots" }),
  });
  await snapshots.waitFor();
  for (const text of ["1 warning", "diagnostics-e2e", "healthy", "gateway-heartbeat"]) {
    await contains(snapshots, text);
  }
  const models = page.locator(".settings-section", {
    has: page.getByRole("heading", { name: "Models" }),
  });
  await contains(models, "gpt-5.6-luna");

  for (const method of ["status", "health", "models.list", "last-heartbeat", "diagnostics.lanes"]) {
    const requests = await gateway.getRequests(method);
    expect(requests.length).toBeGreaterThanOrEqual(1);
    expect(requests[0]?.params).toEqual(
      method === "models.list" ? { agentId: "main", view: "default" } : {},
    );
  }

  const snapshotMethods = ["status", "health", "models.list"];
  const snapshotCounts = await Promise.all(
    snapshotMethods.map(async (method) => (await gateway.getRequests(method)).length),
  );
  const systemInfoCount = (await gateway.getRequests("system.info")).length;
  await page.getByRole("button", { name: /^Open overlay/u }).click();
  const overlay = page.getByRole("complementary", { name: "System busyness" });
  await contains(overlay.locator(".gateway-vital--memory"), "432 MB");
  await contains(overlay.locator(".gateway-vital--cpu"), "0.25 cores");
  await page.clock.runFor(10_000);
  await expect.poll(() => overlay.locator(".gateway-vital--cpu polyline").count()).toBe(1);
  await overlay.getByRole("button", { name: "Minimize system busyness" }).click();
  const widget = page.locator("aside.debug-overlay--minimized");
  await widget.waitFor();
  await finishAnimations(widget);
  expect(await widget.getByRole("heading", { name: "Lanes", exact: true }).count()).toBe(0);
  const metrics = ["cpu", "ping", "memory"];
  const graphPoints = async (metric: string) =>
    (await widget.locator(`.gateway-vital--${metric} polyline`).getAttribute("points"))
      ?.trim()
      .split(/\s+/u);
  for (const metric of metrics) {
    const graph = widget.locator(`.gateway-vital--${metric} polyline`);
    await expect.poll(() => graph.count()).toBe(1);
    expect((await graphPoints(metric))?.length).toBeGreaterThan(1);
  }
  await expect
    .poll(() => widget.locator(".gateway-vital--ping").textContent())
    .toMatch(/\d+\s*ms/u);
  await contains(widget.locator(".gateway-vital--memory"), "432 MB");
  const desktopWidget = await expectBounds(widget, 1280, 1000, 32);
  expect(desktopWidget!.width).toBeLessThanOrEqual(240);
  expect(desktopWidget!.height).toBeLessThanOrEqual(100);
  const pingMs = async () =>
    Number.parseInt(
      (await widget.locator(".gateway-vital--ping .sparkline-tile__value").textContent()) ?? "",
      10,
    );
  const initialPingMs = await pingMs();
  expect(Number.isFinite(initialPingMs)).toBe(true);
  const ping = widget.locator(".gateway-vital--ping");
  expect(await ping.getAttribute("data-degraded")).toBeNull();
  const nextSystemInfoCount = (await gateway.getRequests("system.info")).length;
  const minimizedCurrentWorkCount = (await gateway.getRequests("sessions.list", currentWorkQuery))
    .length;
  await gateway.deferNext("system.info");
  await gateway.setMethodResponse(
    "system.info",
    systemInfo(0.75, 0.3, [6, 12], [654, 300, 384], [0.42, 0.28, 0.05, 0.34]),
  );
  await page.clock.runFor(10_000);
  await gateway.waitForRequest("system.info", { after: nextSystemInfoCount });
  // This delay is the simulated network latency the ping graph must measure.
  await page.clock.runFor(initialPingMs + 250);
  await gateway.resolveDeferred("system.info");
  await contains(widget.locator(".gateway-vital--memory"), "654 MB");
  await contains(widget.locator(".gateway-vital--cpu"), "0.75 cores");
  await expect.poll(pingMs).toBeGreaterThanOrEqual(initialPingMs + 200);
  expect(await ping.getAttribute("data-degraded")).toBe("");
  await page.clock.runFor(10_000);
  await expect.poll(() => ping.getAttribute("data-degraded")).toBeNull();
  await gateway.waitForRequest("system.info", { after: systemInfoCount + 2 });
  expect(await gateway.getRequests("sessions.list", currentWorkQuery)).toHaveLength(
    minimizedCurrentWorkCount,
  );
  for (const metric of metrics) {
    const plottedValues = (await graphPoints(metric))?.map((point) => point.split(",")[1]);
    expect(new Set(plottedValues).size).toBeGreaterThan(1);
  }
  const cpuTrigger = widget.getByRole("button", { name: "Show Gateway CPU breakdown" });
  const cpuTooltip = widget.locator(".gateway-cpu-tooltip");
  const cpuDetail = cpuTooltip.locator(".gateway-cpu-detail");
  const transitionCpuDetail = async (
    eventName: "overlay-after-show" | "overlay-after-hide",
    action: () => Promise<void>,
  ) => {
    // Visibility includes closing animations; finish each input mode before starting another.
    await cpuTooltip.evaluate((element, transitionEvent) => {
      element.removeAttribute("data-test-transition");
      element.addEventListener(
        transitionEvent,
        () => element.setAttribute("data-test-transition", transitionEvent),
        { once: true },
      );
    }, eventName);
    await action();
    await expect.poll(() => cpuTooltip.getAttribute("data-test-transition")).toBe(eventName);
  };
  await contains(widget.locator(".sparkline-tile__secondary"), "Host 34%");
  await expect.poll(() => widget.locator(".sparkline-tile__stack").count()).toBe(3);
  await cpuTrigger.hover();
  await expect.poll(() => cpuDetail.isVisible()).toBe(true);
  const cpuText = await cpuDetail.textContent();
  for (const reading of [
    "Main thread",
    "42%",
    "Worker threads",
    "28%",
    "Other threads",
    "≈5%",
    "Host · 8 logical CPUs",
    "34%",
  ]) {
    expect(cpuText).toContain(reading);
  }
  await cpuTrigger.click();
  await page.mouse.move(0, 0);
  expect(await cpuDetail.isVisible()).toBe(true);
  expect(await widget.boundingBox()).toMatchObject({
    width: desktopWidget.width,
    height: desktopWidget.height,
  });
  await transitionCpuDetail("overlay-after-hide", () => page.keyboard.press("Escape"));
  await expect.poll(() => cpuDetail.isVisible()).toBe(false);
  expect(await widget.isVisible()).toBe(true);
  await cpuTrigger.blur();
  await page.keyboard.press("Tab");
  await cpuTrigger.focus();
  await expect.poll(() => cpuDetail.isVisible()).toBe(true);
  await transitionCpuDetail("overlay-after-hide", () => page.keyboard.press("Escape"));
  await page.setViewportSize({ height: 844, width: 390 });
  const mobileWidget = await expectBounds(widget, 390, 844);
  expect(mobileWidget!.width).toBeLessThanOrEqual(240);
  expect(mobileWidget!.height).toBeLessThanOrEqual(100);
  expect(
    await widget
      .locator(".sparkline-tile__label, .sparkline-tile__value")
      .evaluateAll((elements) =>
        elements.every((element) => element.scrollWidth <= element.clientWidth),
      ),
  ).toBe(true);
  await transitionCpuDetail("overlay-after-show", () => cpuTrigger.tap());
  await expect.poll(() => cpuDetail.isVisible()).toBe(true);
  await expectBounds(cpuDetail, 390, 844);
  await transitionCpuDetail("overlay-after-hide", () => cpuTrigger.tap());
  await expect.poll(() => cpuDetail.isVisible()).toBe(false);
  await page.setViewportSize({ height: 1000, width: 1280 });
  const scenarios: [string, number, Parameters<typeof systemInfo>[4]][] = [
    ["main-hot", 1.15, [0.98, 0.12, 0.05, 0.23]],
    ["workers-hot", 2.58, [0.18, 2.2, 0.2, 0.44]],
    ["host-busy", 0.18, [0.1, 0.05, 0.03, 0.94]],
    ["unavailable", 0.5, [undefined, undefined, undefined, undefined]],
  ];
  for (const [, total, cpu] of scenarios) {
    await gateway.setMethodResponse(
      "system.info",
      systemInfo(total, 0.3, [22, 24], [654, 300, 384], cpu),
    );
    await page.clock.runFor(10_000);
    await expect
      .poll(() => widget.locator(".gateway-vital--cpu .sparkline-tile__value").textContent())
      .toContain(`${total.toFixed(2)} cores`);
    await expect
      .poll(() => widget.locator(".sparkline-tile__secondary").textContent())
      .toContain(cpu[3] === undefined ? "Host —" : `Host ${Math.round(cpu[3] * 100)}%`);
    await cpuTrigger.click();
    await expect.poll(() => cpuDetail.isVisible()).toBe(true);
    await transitionCpuDetail("overlay-after-hide", () => page.keyboard.press("Escape"));
  }
  await widget.getByRole("button", { name: "Expand system busyness" }).click();
  await widget.waitFor({ state: "detached" });
  await contains(overlay.locator(".gateway-vital--memory"), "654 MB");
  expect(await overlay.locator(".gateway-vital--cpu polyline").count()).toBe(1);
  expect(
    await Promise.all(
      snapshotMethods.map(async (method) => (await gateway.getRequests(method)).length),
    ),
  ).toEqual(snapshotCounts);
  const activeRuns = overlay.locator("section", {
    has: page.getByRole("heading", { name: "Active runs", exact: true }),
  });
  const activeCount = activeRuns.locator(".debug-overlay__count").first();
  await activeCount.waitFor();
  await activeCount.scrollIntoViewIfNeeded();
  expect((await activeCount.textContent())?.trim()).toBe("101 active");
  expect(await activeRuns.getByText("Showing 100 of 101", { exact: true }).count()).toBe(1);
  expect(await activeRuns.locator("li").count()).toBe(100);
  expect(await activeRuns.getByText("active-session-100", { exact: true }).count()).toBe(0);
  for (const sessionId of ["active-session-0", "active-session-1", "active-session-2"]) {
    expect(await activeRuns.getByText(sessionId, { exact: true }).count()).toBe(1);
  }
  expect(
    await gateway.getRequests("sessions.list", { ...currentWorkQuery, offset: 100 }),
  ).toHaveLength(0);
  await gateway.setMethodResponse("sessions.list", listing([]));
  await page.clock.runFor(10_000);
  await activeRuns.getByText("No active runs.", { exact: true }).waitFor();
  expect((await activeCount.textContent())?.trim()).toBe("0 active");
  expect(await activeRuns.locator("li").count()).toBe(0);
  expect(await activeRuns.getByText("Showing 100 of 101", { exact: true }).count()).toBe(0);
  await overlay.getByRole("button", { name: "Minimize system busyness" }).click();
  await widget.waitFor();
  await page.keyboard.press("ControlOrMeta+Shift+d");
  await widget.waitFor({ state: "detached" });
  await overlay.getByRole("heading", { name: "Lanes", exact: true }).waitFor();
  await overlay.getByRole("button", { name: "Minimize system busyness" }).click();
  await widget.waitFor();
  await finishAnimations(widget);
  await overlay.getByRole("button", { name: "Close", exact: true }).click();
  await overlay.waitFor({ state: "detached" });

  const refresh = snapshots.getByRole("button", { name: "Refresh" });
  const statusRequestCount = (await gateway.getRequests("status")).length;
  await gateway.deferNext("status");
  await refresh.click();
  await gateway.waitForRequest("status", { after: statusRequestCount });
  await expect.poll(() => refresh.textContent()).toMatch(/^\s*Refreshing…\s*$/u);
  expect(await refresh.isDisabled()).toBe(true);
  await contains(snapshots, "diagnostics-e2e");
  await noOverflow();

  await gateway.resolveDeferred("status");
  await expect.poll(() => refresh.textContent()).toMatch(/^\s*Refresh\s*$/u);
  await page.getByRole("button", { name: /^Open overlay/u }).click();
  await contains(overlay.locator(".gateway-vital--cpu"), "0.50 cores");
  await overlay.getByRole("button", { name: "Minimize system busyness" }).click();
  await widget.waitFor();
  await gateway.setOnline(false);
  await contains(widget, "Unavailable");
  expect(await widget.textContent()).not.toContain("0.50 cores");
  expect(await widget.textContent()).not.toContain("654 MB");
  await contains(snapshots, "Offline");
  await contains(snapshots, "Connect to the Gateway to refresh diagnostics.");
  expect(await refresh.isDisabled()).toBe(true);
  await contains(snapshots, "diagnostics-e2e");
  await page.setViewportSize({ height: 844, width: 390 });
  await noOverflow();
  await page.setViewportSize({ height: 1000, width: 1280 });
  await page.getByRole("searchbox", { name: "Search settings" }).focus();
  await page.keyboard.press("Escape");
  await expect.poll(() => new URL(page.url()).pathname).toBe("/chat/main");
  expect(await widget.isVisible()).toBe(true);
  await widget.getByRole("button", { name: "Close", exact: true }).press("Escape");
  await overlay.waitFor({ state: "detached" });
}

suite.define(() => {
  it("renders Gateway diagnostics and current work independently of session history", async () => {
    const viewport = { height: 1000, width: 1280 };
    await suite.withPage(
      {
        locale: "en-US",
        colorScheme: "dark",
        serviceWorkers: "block",
        hasTouch: true,
        viewport,
      },
      exerciseDiagnostics,
    );
  });
});
