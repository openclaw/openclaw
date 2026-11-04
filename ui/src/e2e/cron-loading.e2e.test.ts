import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { CronJob } from "../api/types.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { cronListResponseFixture } from "../test-helpers/cron.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import { cronJob, cronList } from "./cron-fixtures.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Cron loading mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}.`,
});

const emptyList = cronList([], "cron-loading-empty");

const contextOptions = createControlUiE2eContextOptions();
const emptyRuns = { entries: [], total: 0, offset: 0, limit: 50, hasMore: false };

function installCronGateway(page: Page, responses: Record<string, unknown> = {}) {
  return installMockGateway(page, {
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

suite.define(() => {
  it.each(
    (["saved", "conflict", "error"] as const).flatMap((outcome) => [
      { navigation: "same editor", goBack: false, outcome },
      { navigation: "browser Back to another automation", goBack: true, outcome },
    ]),
  )("settles a held automation save after $navigation ($outcome)", async ({ goBack, outcome }) => {
    await suite.withPage(contextOptions, async ({ page }) => {
      const job = (id: string, name: string) =>
        cronJob(id, name, {
          configRevision: `revision-${id}`,
          schedule: { kind: "cron", expr: "0 9 * * *" },
          payload: { kind: "systemEvent", text: "Synthetic garden inventory reminder" },
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
});
