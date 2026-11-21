import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { CronRunLogEntry } from "../../api/types.ts";
import { waitForCronPage } from "./cron-page.test-support.tsx";
import { cronRpc, emitEvent, mountCronPage } from "./cron-rpc.test-support.ts";
import { createCronViewJob } from "./view.test-support.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

function runPage(entries: CronRunLogEntry[]) {
  return { entries, total: entries.length, offset: 0, hasMore: false };
}

it.each([true, false])(
  "retains the edit only for a fresh same-ID run link (same job: %s)",
  async (sameJob) => {
    const original = createCronViewJob("linked-job", { configRevision: "original-revision" });
    const refreshed = createCronViewJob(sameJob ? original.id : "other-job", {
      name: "Refreshed job",
      configRevision: "refreshed-revision",
    });
    let nextJob = original;
    const { page } = mountCronPage(
      cronRpc({
        "cron.get": () => ({ ...nextJob }),
        "cron.runs": (params) => {
          const request = asOptionalRecord(params);
          if (typeof request?.runId !== "string" || typeof request.id !== "string") {
            return runPage([]);
          }
          return runPage([
            {
              jobId: request.id,
              runId: request.runId,
              ts: 10,
              action: "finished",
              summary: request.runId,
            },
          ]);
        },
      }),
    );
    try {
      page.routeSearch = "?job=linked-job&run=first-run";
      await waitForCronPage(() =>
        expect(page.cron.cronEditingJob?.configRevision).toBe("original-revision"),
      );
      const editingSnapshot = page.cron.cronEditingJob;
      page.patchForm({ name: "Unsaved draft" });
      nextJob = refreshed;
      page.routeSearch = `?job=${refreshed.id}&run=second-run`;
      await waitForCronPage(() =>
        expect(page.querySelector(".cron-run-entry--highlighted")?.textContent).toContain(
          "second-run",
        ),
      );
      page.querySelector<HTMLButtonElement>('[data-test-id="cron-detail-tab-settings"]')!.click();
      await waitForCronPage(() =>
        expect(page.querySelector<HTMLInputElement>("#cron-name")?.value).toBe(
          sameJob ? "Unsaved draft" : "Refreshed job",
        ),
      );
      expect(page.cron.cronEditingJob?.configRevision).toBe(
        sameJob ? "original-revision" : "refreshed-revision",
      );
      if (sameJob) {
        expect(page.cron.cronEditingJob).toBe(editingSnapshot);
      } else {
        expect(page.cron.cronEditingJob).not.toBe(editingSnapshot);
      }
    } finally {
      page.remove();
    }
  },
);

it("scrolls to a linked run again after its history rows unmount", async () => {
  const job = createCronViewJob("linked-job");
  const entry: CronRunLogEntry = {
    jobId: job.id,
    runId: "linked-run",
    ts: 10,
    action: "finished",
    summary: "Linked run",
  };
  const held = createDeferred<ReturnType<typeof runPage>>();
  let hold = false;
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
  const { page, gateway } = mountCronPage(
    cronRpc({
      "cron.get": () => job,
      "cron.runs": (params) =>
        asOptionalRecord(params)?.runId ? (hold ? held.promise : runPage([entry])) : runPage([]),
    }),
  );
  try {
    const link = "?job=linked-job&run=linked-run";
    page.routeSearch = link;
    await waitForCronPage(() => expect(scroll).toHaveBeenCalledOnce());
    const first = page.querySelector(".cron-run-entry--highlighted");
    expect(first).not.toBeNull();
    expect(scroll.mock.instances[0]).toBe(first);
    expect(scroll).toHaveBeenLastCalledWith({ block: "nearest" });

    page.closePanel();
    page.routeSearch = "";
    await waitForCronPage(() => expect(page.querySelector(".cron-run-entry")).toBeNull());
    expect(first?.isConnected).toBe(false);
    hold = true;
    page.routeSearch = link;
    await waitForCronPage(() =>
      expect(page.querySelector('[data-test-id="cron-runs-loading"]')).not.toBeNull(),
    );
    expect(scroll).toHaveBeenCalledOnce();

    held.resolve(runPage([entry]));
    await waitForCronPage(() => expect(scroll).toHaveBeenCalledTimes(2));
    const current = page.querySelector(".cron-run-entry--highlighted");
    expect(current).not.toBe(first);
    expect(scroll.mock.instances[1]).toBe(current);

    page.remove();
    emitEvent(gateway);
    await page.settle();
    expect(scroll).toHaveBeenCalledTimes(2);
  } finally {
    held.resolve(runPage([]));
    page.remove();
  }
});

it.each([
  { link: "cron:linked-job:10", metadata: { runAtMs: 10 } },
  { link: "recorded-session", metadata: { sessionId: "recorded-session" } },
])("uses refreshed row metadata when scrolling to $link", async ({ link, metadata }) => {
  const job = createCronViewJob("linked-job");
  let entry: CronRunLogEntry = {
    jobId: job.id,
    runId: "public-run",
    ts: 11,
    action: "finished",
    summary: "Awaiting run metadata",
  };
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
  const { page, gateway } = mountCronPage(
    cronRpc({
      "cron.get": () => job,
      "cron.runs": (params) => runPage(asOptionalRecord(params)?.runId ? [entry] : []),
    }),
  );
  try {
    page.routeSearch = `?job=linked-job&run=${encodeURIComponent(link)}`;
    await waitForCronPage(() =>
      expect(page.querySelector(".cron-run-entry")?.textContent).toContain(entry.summary),
    );
    const row = page.querySelector(".cron-run-entry");
    expect(page.querySelector(".cron-run-entry--highlighted")).toBeNull();
    expect(scroll).not.toHaveBeenCalled();

    entry = { ...entry, ...metadata, summary: "Run metadata loaded" };
    emitEvent(gateway);
    await waitForCronPage(() => expect(scroll).toHaveBeenCalledOnce());
    expect(page.querySelector(".cron-run-entry--highlighted")).toBe(row);
    expect(row?.textContent).toContain("Run metadata loaded");
    expect(scroll.mock.instances[0]).toBe(row);
    page.refreshView();
    await page.settle();
    expect(scroll).toHaveBeenCalledOnce();
  } finally {
    page.remove();
  }
});
