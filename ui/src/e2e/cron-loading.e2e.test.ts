import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { CronJob } from "../api/types.ts";
import {
  installMockGateway,
  startControlUiE2eServer,
  type MockGatewayRequest,
} from "../test-helpers/control-ui-e2e.ts";
import { cronListResponseFixture } from "../test-helpers/cron.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Cron loading mocked Gateway E2E",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}.`,
});

const emptyList = {
  jobs: [],
  snapshotRevision: "cron-loading-empty",
  total: 0,
  offset: 0,
  limit: 50,
  hasMore: false,
  nextOffset: null,
};

const contextOptions = createControlUiE2eContextOptions();
const emptyRuns = { entries: [], total: 0, offset: 0, limit: 50, hasMore: false };

function installCronGateway(
  page: Page,
  responses: Record<string, unknown> = {},
  heldMethods?: string[],
) {
  return installMockGateway(page, {
    ...(heldMethods ? { heldMethods } : {}),
    methodResponses: {
      "cron.list": emptyList,
      "cron.runs": emptyRuns,
      "cron.status": { enabled: true, jobs: 0, nextWakeAtMs: null },
      ...responses,
    },
  });
}

function runsPage(
  entries: unknown[],
  total = entries.length,
  offset = 0,
  nextOffset: number | null = null,
) {
  return { entries, total, offset, hasMore: nextOffset !== null, nextOffset };
}

function run(ts: number, jobId: string, summary: string) {
  return { ts, jobId, action: "finished", status: "ok", summary };
}

function setVisibility(page: Page, state: "hidden" | "visible") {
  return page.evaluate((visibility) => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
    document.dispatchEvent(new Event("visibilitychange"));
    if (visibility === "visible") {
      globalThis.dispatchEvent(new Event("focus"));
    }
  }, state);
}

async function emitBurst(gateway: Awaited<ReturnType<typeof installCronGateway>>) {
  for (let event = 0; event < 20; event += 1) {
    await gateway.emitGatewayEvent("cron", { jobId: "synthetic-job", action: "finished" });
  }
}

function tableListRequests(requests: MockGatewayRequest[]) {
  return requests.filter(
    ({ params }) => isRecord(params) && params.scheduleKind === "all" && params.trigger === "all",
  );
}

suite.define(() => {
  it.each(
    (["saved", "conflict", "error"] as const).flatMap((outcome) => [
      { navigation: "same editor", goBack: false, outcome },
      { navigation: "browser Back to another automation", goBack: true, outcome },
    ]),
  )("settles a held automation save after $navigation ($outcome)", async ({ goBack, outcome }) => {
    await suite.withPage(contextOptions, async ({ page }) => {
      const job = (id: string, name: string): CronJob => ({
        id,
        name,
        enabled: true,
        createdAtMs: 0,
        updatedAtMs: 0,
        configRevision: `revision-${id}`,
        schedule: { kind: "cron", expr: "0 9 * * *" },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "Synthetic garden inventory reminder" },
        state: {},
      });
      const a = job("garden-a", "Garden A");
      const b = job("garden-b", "Garden B");
      const saved = { ...a, name: "Garden A saved", configRevision: "revision-a-saved" };
      const exactJobs = (first: CronJob) => ({
        cases: [
          { match: { id: a.id }, response: first },
          { match: { id: b.id }, response: b },
        ],
      });
      const list = (jobs: CronJob[]) =>
        cronListResponseFixture({
          ...emptyList,
          jobs,
          total: jobs.length,
          snapshotRevision: "garden-inventory",
        });
      const gateway = await installCronGateway(page, {
        "cron.list": list([a, b]),
        "cron.get": exactJobs(a),
        "cron.status": { enabled: true, jobs: 2, nextWakeAtMs: null },
        "cron.runs": { entries: [], total: 0, offset: 0, hasMore: false },
      });
      const bUrl = `${suite.server.baseUrl}cron?job=${b.id}`;
      const aUrl = `${suite.server.baseUrl}cron?job=${a.id}`;
      await page.goto(bUrl);
      const name = page.locator("#cron-name");
      const editor = page.locator("fieldset.cron-editor");
      await expect.poll(() => name.inputValue()).toBe(b.name);
      const instance = await page.locator("openclaw-cron-page").elementHandle();
      if (!instance) {
        throw new Error("The automation page did not mount");
      }
      const observe = async () => ({
        url: page.url(),
        name: await name.inputValue(),
        title: (await page.locator(".cron-detail-title").textContent())?.trim(),
        busy: await editor.getAttribute("aria-busy"),
        samePage: await instance.evaluate(
          (element) =>
            element.isConnected && element === document.querySelector("openclaw-cron-page"),
        ),
      });
      try {
        // Seed the second browser-history entry through the public history/router boundary.
        await page.evaluate((url) => {
          history.pushState(null, "", url);
          window.dispatchEvent(new PopStateEvent("popstate"));
        }, aUrl);
        await expect.poll(() => name.inputValue()).toBe(a.name);
        expect((await observe()).samePage).toBe(true);
        await name.fill(saved.name);
        await gateway.deferNext("cron.update");
        await page.locator('[data-test-id="cron-submit"]').click();
        const request = await gateway.waitForRequest("cron.update");
        expect(request.params).toMatchObject({
          id: a.id,
          expectedConfigRevision: a.configRevision,
          patch: { name: saved.name },
        });
        await expect.poll(() => editor.getAttribute("aria-busy")).toBe("true");
        if (goBack) {
          await page.goBack();
          await page.waitForURL(bUrl);
          await expect.poll(() => name.inputValue()).toBe(b.name);
        }
        expect(await observe()).toMatchObject({ samePage: true, busy: "true" });
        await gateway.setMethodResponse("cron.list", list([saved, b]));
        await gateway.setMethodResponse("cron.get", exactJobs(saved));
        if (outcome === "saved") {
          await gateway.resolveDeferred("cron.update", saved);
        } else {
          await gateway.rejectDeferred("cron.update", {
            code: "UNAVAILABLE",
            message: "Garden A save failed.",
            ...(outcome === "conflict" ? { details: { code: "CRON_JOB_CHANGED" } } : {}),
          });
        }
        await expect.poll(() => editor.getAttribute("aria-busy")).toBe("false");
        const settled = await observe();
        expect(settled).toMatchObject({
          url: goBack ? bUrl : aUrl,
          name: goBack ? b.name : saved.name,
          title: goBack ? b.name : outcome === "error" ? a.name : saved.name,
          samePage: true,
        });
        const errors = await page.locator(".cron-error-banner").allTextContents();
        if (goBack || outcome === "saved") {
          expect(errors).toEqual([]);
        } else {
          expect(errors.join(" ")).toContain(
            outcome === "conflict"
              ? "This automation changed on the Gateway"
              : "Garden A save failed.",
          );
        }
        expect(await gateway.getRequests("cron.update")).toHaveLength(1);
      } finally {
        await instance.dispose();
      }
    });
  });

  it("keeps filtered history on page zero while replacement results are pending", async () => {
    await suite.withPage(contextOptions, async ({ page }) => {
      const museumRun = (ts: number, summary: string) => ({
        ...run(ts, "museum-inventory", summary),
        jobName: "Museum inventory",
      });
      const oldRun = museumRun(1, "Previous unfiltered inventory");
      const firstRun = museumRun(2, "Lunar inventory first page");
      const secondRun = museumRun(3, "Lunar inventory second page");
      const firstPage = runsPage([firstRun], 2, 0, 1);
      const gateway = await installCronGateway(page, {
        "cron.runs": runsPage([oldRun], 51, 0, 50),
      });
      await page.goto(`${suite.server.baseUrl}cron`);
      await page.getByRole("tab", { name: "Run history", exact: true }).click();
      await page.getByText(oldRun.summary, { exact: true }).waitFor();
      await gateway.deferNext("cron.runs");
      await gateway.setMethodResponse("cron.runs", runsPage([secondRun], 2, 50, null));
      await page.getByRole("searchbox", { name: "Search runs" }).fill("Lunar");
      await expect
        .poll(
          async () =>
            (await gateway.getRequests("cron.runs", { query: "Lunar", offset: 0 })).length,
        )
        .toBe(1);
      const loadMore = page.getByRole("button", { name: "Load more runs", exact: true });
      if ((await loadMore.isVisible()) && (await loadMore.isEnabled())) {
        await loadMore.click();
      }
      await gateway.resolveDeferred("cron.runs", firstPage);
      const filteredRequests = await gateway.getRequests("cron.runs", { query: "Lunar" });
      expect(filteredRequests.map(({ params }) => isRecord(params) && params.offset)).toEqual([0]);
      await page.getByText(firstRun.summary, { exact: true }).waitFor();
      expect(await page.getByText(oldRun.summary, { exact: true }).count()).toBe(0);
      await gateway.setMethodResponse("cron.runs", runsPage([secondRun], 2, 1, null));
      await loadMore.click();
      await page.getByText(secondRun.summary, { exact: true }).waitFor();
      expect(await page.getByText(firstRun.summary, { exact: true }).count()).toBe(1);
      expect(
        (await gateway.getRequests("cron.runs", { query: "Lunar" })).map(
          ({ params }) => isRecord(params) && params.offset,
        ),
      ).toEqual([0, 1]);
    });
  });

  it("bounds a held cron event burst and displays the completed run", async () => {
    await suite.withPage(contextOptions, async ({ page }) => {
      const summary = "Synthetic automation completed successfully";
      const runs = {
        ...runsPage([run(Date.parse("2026-08-01T12:00:00Z"), "synthetic-job", summary)]),
        limit: 50,
      };
      const gateway = await installCronGateway(page, { "cron.runs": runs }, [
        "cron.status",
        "cron.runs",
      ]);
      await page.goto(`${suite.server.baseUrl}cron`);
      await page.getByText("No automations yet").waitFor({ state: "visible" });
      await gateway.waitForRequest("cron.runs");
      await page.getByRole("tab", { name: "Run history", exact: true }).click();
      const countRequests = async () => ({
        status: (await gateway.getRequests("cron.status")).length,
        runs: (await gateway.getRequests("cron.runs")).length,
      });
      const before = await countRequests();
      await emitBurst(gateway);
      const held = await countRequests();
      expect(held).toEqual(before);
      await gateway.resolveDeferred("cron.status");
      await gateway.resolveDeferred("cron.runs");
      await page.getByText(summary).waitFor({ state: "visible" });
      await expect
        .poll(async () => (await gateway.getRequests("cron.runs")).length)
        .toBe(before.runs + 1);
    });
  });

  it("pauses queued automation reads while hidden and catches up once on show", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const gateway = await installCronGateway(page, {}, ["cron.list", "cron.runs"]);
      await page.goto(`${suite.server.baseUrl}cron`);
      await page.locator('[data-test-id="cron-jobs-loading"]').waitFor({ state: "visible" });
      await gateway.waitForRequest("cron.runs");
      const counts = async () => ({
        table: tableListRequests(await gateway.getRequests("cron.list")).length,
        runs: (await gateway.getRequests("cron.runs")).length,
      });
      const before = await counts();
      await emitBurst(gateway);
      await setVisibility(page, "hidden");
      await gateway.resolveDeferred("cron.list");
      await gateway.resolveDeferred("cron.runs");
      await page.getByText("No automations yet").waitFor({ state: "visible" });
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, 0);
          }),
      );
      expect(await counts()).toEqual(before);
      await setVisibility(page, "visible");
      await expect.poll(counts).toEqual({ table: before.table + 1, runs: before.runs + 1 });
      await page.getByText("No automations yet").waitFor({ state: "visible" });
    });
  });

  it("shows pending before empty and keeps empty visible after a run-history failure", async () => {
    await suite.withPage(contextOptions, async ({ page }) => {
      const gateway = await installCronGateway(page, {}, ["cron.list"]);

      const response = await page.goto(`${suite.server.baseUrl}cron`);
      expect(response?.status()).toBe(200);
      await gateway.waitForRequest("cron.list");

      const loading = page.locator('[data-test-id="cron-jobs-loading"]');
      await loading.waitFor({ state: "visible" });
      expect(await loading.getAttribute("role")).toBe("status");
      expect(await loading.getAttribute("aria-live")).toBe("polite");
      await expect.poll(() => loading.textContent()).toContain("Loading...");
      expect(await page.getByText("No automations yet").count()).toBe(0);
      expect(await page.locator(".cron-table").getAttribute("aria-busy")).toBe("true");
      expect(tableListRequests(await gateway.getRequests("cron.list"))).toHaveLength(1);

      await gateway.resolveDeferred("cron.list", emptyList);
      await page.getByText("No automations yet").waitFor({ state: "visible" });
      expect(await loading.count()).toBe(0);
      expect(await page.locator(".cron-table").getAttribute("aria-busy")).toBeNull();

      await gateway.setMethodResponse("cron.runs", {
        __mockError: { code: "UNAVAILABLE", message: "Run history unavailable." },
      });
      const previousTableRequests = tableListRequests(
        await gateway.getRequests("cron.list"),
      ).length;
      await page.getByRole("button", { name: "Refresh" }).click();

      await page.getByText("Run history unavailable.").waitFor({ state: "visible" });
      await page.getByText("No automations yet").waitFor({ state: "visible" });
      await expect
        .poll(async () => tableListRequests(await gateway.getRequests("cron.list")))
        .toHaveLength(previousTableRequests + 1);
    });
  });
});
