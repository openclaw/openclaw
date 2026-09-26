import { describe, expect, it, vi } from "vitest";
import type { CronRunLogEntry } from "../../api/types.ts";
import { i18n, t } from "../../i18n/index.ts";
import { captureI18nStateForTesting } from "../../i18n/lib/translate.test-support.ts";
import {
  createCronViewJob,
  getElement,
  renderCronView as renderView,
} from "./view.test-support.ts";

function createRun(overrides: Partial<CronRunLogEntry>): CronRunLogEntry {
  return { ts: 1, jobId: "job-1", action: "finished", status: "ok", ...overrides };
}

describe("cron view run history", () => {
  it.each(["overview", "job"] as const)(
    "refreshes localized timestamps across %s history renders",
    async (scope) => {
      const restoreI18n = captureI18nStateForTesting();
      const timestamp = Date.UTC(2026, 0, 2, 15, 4, 55);
      try {
        for (const locale of ["en", "fr", "en"] as const) {
          await i18n.setLocale(locale);
          const container = renderView({
            listTab: "activity",
            editingJob: scope === "job" ? createCronViewJob("job-1", { state: {} }) : null,
            detailTab: "history",
            runs: [
              { ts: timestamp, runAtMs: 0, jobId: "job-1", action: "finished", status: "ok" },
              { ts: 1, runAtMs: Number.NaN, jobId: "job-2", action: "finished", status: "ok" },
            ],
          });
          const entries = container.querySelectorAll(".cron-run-entry__meta");
          const dateOptions: Intl.DateTimeFormatOptions = {
            year: "numeric",
            month: "numeric",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          };
          expect(entries[0]?.firstElementChild?.textContent).toBe(
            new Date(timestamp).toLocaleString(locale, dateOptions),
          );
          expect(entries[0]?.children[1]?.textContent).toContain(
            new Date(0).toLocaleString(locale, dateOptions),
          );
          expect(entries[1]?.children[1]?.textContent).toContain(t("common.na"));
        }
      } finally {
        await restoreI18n();
      }
    },
  );

  it("renders runs sorted newest first and wires run filters", () => {
    const onRunsFiltersChange = vi.fn();
    const container = renderView({
      listTab: "activity",
      onRunsFiltersChange,
      runs: [
        { ts: 1_000, jobId: "job-1", action: "finished", status: "ok", summary: "older run" },
        { ts: 2_000, jobId: "job-2", action: "finished", status: "ok", summary: "newer run" },
      ],
      status: { enabled: true, triggersEnabled: true, jobs: 2 },
    });

    const titles = Array.from(container.querySelectorAll(".cron-run-entry__title")).map((el) =>
      el.textContent?.trim(),
    );
    expect(titles[0]).toContain("job-2");
    expect(titles[1]).toContain("job-1");

    const search = getElement(container, ".cron-run-filter-search input", HTMLInputElement);
    search.value = "fail";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onRunsFiltersChange).toHaveBeenCalledWith({ cronRunsQuery: "fail" });

    const statusOption = container.querySelector<HTMLElement & { checked: boolean }>(
      '[data-filter="status"] wa-dropdown-item[value="option:error"]',
    );
    expect(statusOption).not.toBeNull();
    statusOption
      ?.closest("wa-dropdown")
      ?.dispatchEvent(
        new CustomEvent("wa-select", { detail: { item: statusOption }, bubbles: true }),
      );
    expect(onRunsFiltersChange).toHaveBeenCalledWith({ cronRunsStatuses: ["error"] });

    const clearCommand = container.querySelector<HTMLElement>(
      '[data-filter="status"] wa-dropdown-item[value="command:clear"]',
    );
    clearCommand
      ?.closest("wa-dropdown")
      ?.dispatchEvent(
        new CustomEvent("wa-select", { detail: { item: clearCommand }, bubbles: true }),
      );
    expect(onRunsFiltersChange).toHaveBeenCalledWith({ cronRunsStatuses: [] });
  });

  it.each(["overview", "job"] as const)(
    "shows whole-run completion beside execution status in %s history",
    (scope) => {
      const onRunsFiltersChange = vi.fn();
      const cases = [
        {
          status: "ok",
          completionStatus: "failed",
          deliveryStatus: "not-delivered",
          expected: "OK · Error",
        },
        {
          status: "ok",
          completionStatus: "unknown",
          deliveryStatus: "unknown",
          expected: "OK · Unknown",
        },
        {
          status: "ok",
          completionStatus: "succeeded",
          deliveryStatus: "delivered",
          expected: "OK",
        },
        { status: "ok", expected: "OK" },
        { status: "error", completionStatus: "failed", expected: "Error" },
        { status: "skipped", completionStatus: "failed", expected: "Skipped" },
        {
          status: "ok",
          completionStatus: "succeeded",
          deliveryStatus: "not-delivered",
          deliveryError: "Synthetic best-effort delivery failure.",
          expected: "OK",
        },
        {
          status: "ok",
          completionStatus: "succeeded",
          deliveryStatus: "not-delivered",
          deliverySuppressionReason: "silent",
          expected: "OK",
        },
      ] as const;
      const container = renderView({
        listTab: "activity",
        editingJob: scope === "job" ? createCronViewJob("job-1", { state: {} }) : null,
        detailTab: "history",
        onRunsFiltersChange,
        runs: cases.map(({ expected: _expected, ...entry }, index) => ({
          ts: index + 1,
          jobId: "job-1",
          action: "finished",
          ...entry,
        })),
      });

      const titles = Array.from(container.querySelectorAll(".cron-run-entry__title"), (title) =>
        title.textContent?.replace(/\s+/g, " ").trim(),
      );
      expect(titles).toEqual(cases.toReversed().map(({ expected }) => `job-1 · ${expected}`));

      const okOption = container.querySelector<HTMLElement>(
        '[data-filter="status"] wa-dropdown-item[value="option:ok"]',
      );
      expect(okOption).not.toBeNull();
      okOption
        ?.closest("wa-dropdown")
        ?.dispatchEvent(
          new CustomEvent("wa-select", { detail: { item: okOption }, bubbles: true }),
        );
      expect(onRunsFiltersChange).toHaveBeenCalledWith({ cronRunsStatuses: ["ok"] });
    },
  );

  it("formats run token counts and durations in the rendered entry", () => {
    const container = renderView({
      listTab: "activity",
      runs: [
        createRun({ ts: 6, jobId: "job-hour-seconds", durationMs: 3_630_000 }),
        createRun({ ts: 5, jobId: "job-day-minutes", durationMs: 86_460_000 }),
        createRun({
          ts: 4,
          jobId: "job-total",
          summary: "total usage",
          durationMs: 90_000,
          usage: { total_tokens: 1_234_567 },
        }),
        createRun({
          ts: 3,
          jobId: "job-split",
          summary: "split usage",
          durationMs: 500,
          usage: { input_tokens: 50_000, output_tokens: 999 },
        }),
        createRun({ ts: 2, jobId: "job-zero", summary: "zero duration", durationMs: 0 }),
        createRun({ ts: 1.5, jobId: "job-invalid", summary: "invalid duration", durationMs: -1 }),
        createRun({ ts: 1, jobId: "job-unknown", summary: "unknown duration" }),
      ],
    });
    const entries = Array.from(container.querySelectorAll(".cron-run-entry"));
    const entryFor = (jobId: string) => {
      const entry = entries.find((candidate) =>
        candidate.querySelector(".cron-run-entry__title")?.textContent?.includes(jobId),
      );
      expect(entry).toBeInstanceOf(HTMLDivElement);
      return entry;
    };

    expect(
      entryFor("job-hour-seconds")?.querySelector(".cron-run-entry__meta")?.textContent,
    ).toContain("1h 30s");
    expect(
      entryFor("job-day-minutes")?.querySelector(".cron-run-entry__meta")?.textContent,
    ).toContain("1d 1m");

    const total = entryFor("job-total");
    expect(total?.querySelector(".cron-run-entry__facts")?.textContent).toContain("1.2M Tokens");
    expect(total?.querySelector(".cron-run-entry__meta")?.textContent).toContain("1m 30s");
    expect(total?.textContent).not.toContain("1234567");
    expect(total?.textContent).not.toContain("90000ms");

    const split = entryFor("job-split");
    expect(split?.querySelector(".cron-run-entry__facts")?.textContent).toContain(
      "50k in / 999 out",
    );
    expect(split?.querySelector(".cron-run-entry__meta")?.textContent).toContain("500ms");
    expect(entryFor("job-zero")?.querySelector(".cron-run-entry__meta")?.textContent).toContain(
      "0ms",
    );
    expect(entryFor("job-invalid")?.querySelector(".cron-run-entry__meta")?.textContent).toContain(
      "n/a",
    );
    expect(entryFor("job-unknown")?.querySelector(".cron-run-entry__meta")?.textContent).toContain(
      "n/a",
    );
  });

  it("renders run summaries as sanitized markdown", () => {
    const container = renderView({
      listTab: "activity",
      runs: [
        {
          ts: 1,
          jobId: "job-1",
          action: "finished",
          status: "ok",
          summary: "**bold** <script>alert(1)</script>",
        },
      ],
    });
    const body = getElement(container, ".cron-run-entry__body", HTMLDivElement);
    expect(body.querySelector("strong")?.textContent).toBe("bold");
    expect(body.querySelector("script")).toBeNull();
  });

  it("shows run errors as the body when no summary exists", () => {
    const container = renderView({
      listTab: "activity",
      runs: [{ ts: 1, jobId: "job-1", action: "finished", status: "error", error: "boom" }],
    });
    const body = getElement(container, ".cron-run-entry__body", HTMLDivElement);
    expect(body.textContent).toContain("boom");
  });

  it("shows empty guidance only for settled history and offers recovery after failure", () => {
    for (const runsState of ["idle", "pending", "failed"] as const) {
      for (const runsQuery of ["", "fail"]) {
        const onRefresh = vi.fn();
        const container = renderView({ listTab: "activity", runsState, runsQuery, onRefresh });
        expect(container.textContent).not.toContain("No runs yet");
        expect(container.textContent).not.toContain("No matching runs.");
        expect(container.querySelector('[data-test-id="cron-runs-loading"]') !== null).toBe(
          runsState === "pending",
        );
        expect(container.querySelector(".cron-runs")?.getAttribute("aria-busy")).toBe(
          String(runsState === "pending"),
        );
        const retry = Array.from(container.querySelectorAll("button")).find(
          (button) => button.textContent?.trim() === "Retry",
        );
        expect(retry !== undefined).toBe(runsState === "failed");
        retry?.click();
        expect(onRefresh).toHaveBeenCalledTimes(runsState === "failed" ? 1 : 0);
      }
    }
    const retained = renderView({
      listTab: "activity",
      runsState: "failed",
      error: "History unavailable",
      runs: [{ ts: 1, jobId: "job-1", action: "finished", summary: "Previously accepted run" }],
    });
    expect(retained.querySelector(".cron-run-entry")?.textContent).toContain(
      "Previously accepted run",
    );
    expect(retained.textContent).toContain("History unavailable");
    const empty = renderView({ listTab: "activity" });
    expect(empty.querySelector(".cron-empty-state")?.textContent).toContain("No runs yet");

    const filtered = renderView({ listTab: "activity", runsQuery: "fail" });
    expect(filtered.querySelector(".cron-runs__empty")?.textContent).toContain("No matching runs.");
  });

  it.each(["overview", "job"] as const)(
    "shows recorded suppression without reclassifying delivery in %s history",
    (scope) => {
      const reasons = ["empty", "silent", "heartbeat", "channel_transform"];
      const runs = reasons.map((reason, index) =>
        createRun({
          ts: index + 1,
          completionStatus: "succeeded",
          deliveryStatus: "not-delivered",
          delivered: false,
          deliverySuppressionReason: reason,
          summary: `Recorded ${reason}`,
        }),
      );
      runs.push(
        createRun({
          ts: 5,
          completionStatus: "succeeded",
          deliveryStatus: "not-delivered",
          deliveryError: "Synthetic delivery target unavailable.",
          summary: "Best-effort failure",
        }),
        createRun({
          ts: 6,
          status: "error",
          error: "Synthetic execution failure.",
          deliveryStatus: "not-delivered",
          summary: "Execution failure",
        }),
        createRun({
          ts: 7,
          deliveryStatus: "delivered",
          summary: "Successful delivery",
        }),
        createRun({
          ts: 8,
          deliveryStatus: "not-requested",
          summary: "Internal run",
        }),
        createRun({
          ts: 9,
          deliveryStatus: "not-delivered",
          summary: "No recorded reason",
        }),
      );
      const container = renderView({
        listTab: "activity",
        editingJob: scope === "job" ? createCronViewJob("job-1", { state: {} }) : null,
        detailTab: "history",
        runs,
      });
      const history = getElement(
        container,
        scope === "overview" ? ".cron-activity" : ".cron-history",
        HTMLDivElement,
      );
      const entries = Array.from(history.querySelectorAll(".cron-run-entry"));
      expect(entries).toHaveLength(runs.length);
      for (const run of runs) {
        const entry = entries.find((candidate) =>
          candidate.querySelector(".cron-run-entry__body")?.textContent?.includes(run.summary!),
        );
        expect(entry).toBeDefined();
        const facts = entry?.querySelector(".cron-run-entry__facts")?.textContent ?? "";
        if (run.deliverySuppressionReason) {
          expect(facts).toContain(`Delivery suppression: ${run.deliverySuppressionReason}`);
          expect(facts).toContain("Not delivered");
          expect(entry?.querySelector(".cron-run-entry__title")?.textContent).toContain("OK");
        } else {
          expect(facts).not.toContain("Delivery suppression:");
        }
        if (run.deliveryError) {
          expect(entry?.textContent).toContain(run.deliveryError);
          expect(facts).toContain("Not delivered");
        }
        if (run.error) {
          expect(entry?.textContent).toContain(run.error);
          expect(entry?.querySelector(".cron-run-entry__title")?.textContent).toContain("Error");
        }
        if (run.deliveryStatus === "delivered") {
          expect(facts).toContain("Delivered");
        }
        if (run.deliveryStatus === "not-requested") {
          expect(facts).toContain("Not requested");
        }
      }
    },
  );

  it("redacts and escapes server-provided suppression text in run facts", () => {
    const container = renderView({
      listTab: "activity",
      runs: [
        {
          ts: 1,
          jobId: "job-1",
          action: "finished",
          status: "ok",
          deliveryStatus: "not-delivered",
          deliverySuppressionReason: "silent <img src=x onerror=alert(1)> Bearer abcdefghijkl",
        },
      ],
    });
    const facts = getElement(container, ".cron-run-entry__facts", HTMLDivElement);
    expect(facts.textContent).toContain("Delivery suppression: silent <img");
    expect(facts.textContent).toContain("Bearer [redacted]");
    expect(facts.textContent).not.toContain("abcdefghijkl");
    expect(facts.querySelector("img")).toBeNull();
  });
});
