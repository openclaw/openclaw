import { describe, expect, it, vi } from "vitest";
import type { CronRunLogEntry } from "../../api/types.ts";
import { i18n, t } from "../../i18n/index.ts";
import { captureI18nStateForTesting } from "../../i18n/lib/translate.test-support.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  createCronViewJob,
  createCronViewRun as createRun,
  getElement,
  openCronMenu,
  renderCronView,
} from "./view.test-support.ts";

function renderView(props: Parameters<typeof renderCronView>[0] = {}, scope = "overview") {
  return renderCronView({
    listTab: "activity",
    detailTab: "history",
    editingJob: scope === "job" ? createCronViewJob("job-1", { state: {} }) : null,
    ...props,
  });
}

function entryText(entry: Element | undefined, part: string) {
  return entry?.querySelector(`.cron-run-entry__${part}`)?.textContent;
}

const statusFilter = '[data-filter="status"]';
function clickStatus(container: Element, value: string) {
  getElement(container, `${statusFilter} [data-value="${value}"]`, HTMLButtonElement).click();
}

describe("cron view run history", () => {
  it.each(["overview", "job"] as const)(
    "refreshes localized timestamps across %s history renders",
    async (scope) => {
      const restoreI18n = captureI18nStateForTesting();
      const timestamp = Date.UTC(2026, 0, 2, 15, 4, 55);
      const runs = [
        createRun({ ts: timestamp, runAtMs: 0 }),
        createRun({ runAtMs: Number.NaN, jobId: "job-2" }),
      ];
      try {
        for (const locale of ["en", "fr", "en"] as const) {
          await i18n.setLocale(locale);
          const container = renderView({ runs }, scope);
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

  it("renders runs sorted newest first and wires run filters", async () => {
    const onChange = vi.fn();
    const container = renderView({
      onRunsFiltersChange: onChange,
      runs: [
        createRun({ ts: 1_000, summary: "older run" }),
        createRun({ ts: 2_000, jobId: "job-2", summary: "newer run" }),
      ],
      status: { enabled: true, triggersEnabled: true, jobs: 2 },
    });

    const titles = Array.from(container.querySelectorAll(".cron-run-entry__title"), (el) =>
      el.textContent?.trim(),
    );
    expect(titles[0]).toContain("job-2");
    expect(titles[1]).toContain("job-1");

    const search = getElement(container, ".cron-run-filter-search input", HTMLInputElement);
    search.value = "fail";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onChange).toHaveBeenCalledWith({ cronRunsQuery: "fail" });

    const statusTrigger = await openCronMenu(container, statusFilter);
    clickStatus(container, "option:error");
    await waitForSolid(() =>
      expect(onChange).toHaveBeenCalledWith({ cronRunsStatuses: ["error"] }),
    );
    expect(statusTrigger.getAttribute("aria-expanded")).toBe("true");

    clickStatus(container, "command:clear");
    await waitForSolid(() => expect(onChange).toHaveBeenCalledWith({ cronRunsStatuses: [] }));
    await waitForSolid(() => expect(statusTrigger.getAttribute("aria-expanded")).toBe("false"));
  });

  it("shows whole-run completion beside execution status", () => {
    const succeeded = { completionStatus: "succeeded", deliveryStatus: "not-delivered" } as const;
    const cases: Array<[Partial<CronRunLogEntry>, string]> = [
      [{ completionStatus: "failed", deliveryStatus: "not-delivered" }, "OK · Error"],
      [{ completionStatus: "unknown", deliveryStatus: "unknown" }, "OK · Unknown"],
      [{ completionStatus: "succeeded", deliveryStatus: "delivered" }, "OK"],
      [{}, "OK"],
      [{ status: "error", completionStatus: "failed" }, "Error"],
      [{ status: "skipped", completionStatus: "failed" }, "Skipped"],
      [{ ...succeeded, deliveryError: "Synthetic best-effort delivery failure." }, "OK"],
      [{ ...succeeded, deliverySuppressionReason: "silent" }, "OK"],
    ];
    const runs = cases.map(([entry], index) => createRun({ ts: index + 1, ...entry }));
    const container = renderView({ runs });

    const titles = Array.from(container.querySelectorAll(".cron-run-entry__title"), (title) =>
      title.textContent?.replace(/\s+/g, " ").trim(),
    );
    expect(titles).toEqual(cases.toReversed().map(([, expected]) => `job-1 · ${expected}`));
  });

  it("formats run token counts and durations in the rendered entry", () => {
    const container = renderView({
      runs: [
        { jobId: "hour-seconds", durationMs: 3_630_000 },
        { jobId: "day-minutes", durationMs: 86_460_000 },
        { jobId: "total", durationMs: 90_000, usage: { total_tokens: 1_234_567 } },
        { jobId: "split", durationMs: 500, usage: { input_tokens: 50_000, output_tokens: 999 } },
        { jobId: "zero", durationMs: 0 },
        { jobId: "invalid", durationMs: -1 },
        { jobId: "unknown" },
      ].map((entry, index) => createRun({ ts: 7 - index, ...entry })),
    });
    const entries = Array.from(container.querySelectorAll(".cron-run-entry"));
    const entryFor = (jobId: string) => {
      const entry = entries.find((candidate) => entryText(candidate, "title")?.includes(jobId));
      expect(entry).toBeInstanceOf(HTMLDivElement);
      return entry;
    };

    expect(entryText(entryFor("hour-seconds"), "meta")).toContain("1h 30s");
    expect(entryText(entryFor("day-minutes"), "meta")).toContain("1d 1m");

    const total = entryFor("total");
    expect(entryText(total, "facts")).toContain("1.2M Tokens");
    expect(entryText(total, "meta")).toContain("1m 30s");
    expect(total?.textContent).not.toContain("1234567");
    expect(total?.textContent).not.toContain("90000ms");

    const split = entryFor("split");
    expect(entryText(split, "facts")).toContain("50k in / 999 out");
    expect(entryText(split, "meta")).toContain("500ms");
    expect(entryText(entryFor("zero"), "meta")).toContain("0ms");
    expect(entryText(entryFor("invalid"), "meta")).toContain("n/a");
    expect(entryText(entryFor("unknown"), "meta")).toContain("n/a");
  });

  it("renders run summaries as sanitized markdown", () => {
    const container = renderView({
      runs: [createRun({ summary: "**bold** <script>alert(1)</script>" })],
    });
    const body = getElement(container, ".cron-run-entry__body", HTMLDivElement);
    expect(body.querySelector("strong")?.textContent).toBe("bold");
    expect(body.querySelector("script")).toBeNull();
  });

  it("shows empty guidance only for settled history and offers recovery after failure", () => {
    for (const runsState of ["idle", "pending", "failed"] as const) {
      for (const runsQuery of ["", "fail"]) {
        const onRefresh = vi.fn();
        const container = renderView({ runsState, runsQuery, onRefresh });
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
      runsState: "failed",
      error: "History unavailable",
      runs: [createRun({ status: undefined, summary: "Previously accepted run" })],
    });
    expect(retained.querySelector(".cron-run-entry")?.textContent).toContain(
      "Previously accepted run",
    );
    expect(retained.textContent).toContain("History unavailable");
    const empty = renderView();
    expect(empty.querySelector(".cron-empty-state")?.textContent).toContain("No runs yet");

    const filtered = renderView({ runsQuery: "fail" });
    expect(filtered.querySelector(".cron-runs__empty")?.textContent).toContain("No matching runs.");
  });

  it("shows recorded suppression without reclassifying delivery", () => {
    const inputs: Partial<CronRunLogEntry>[] = [
      ...["empty", "silent", "heartbeat", "channel_transform"].map((deliverySuppressionReason) => ({
        completionStatus: "succeeded" as const,
        delivered: false,
        deliverySuppressionReason,
      })),
      { completionStatus: "succeeded", deliveryError: "Synthetic delivery target unavailable." },
      { status: "error", error: "Synthetic execution failure." },
      { deliveryStatus: "delivered" },
      { deliveryStatus: "not-requested" },
      {},
    ];
    const runs = inputs.map((entry, ts) =>
      createRun({
        ts,
        deliveryStatus: "not-delivered",
        summary: `Run ${ts}`,
        ...entry,
      }),
    );
    const history = getElement(renderView({ runs }, "job"), ".cron-history", HTMLDivElement);
    const entries = Array.from(history.querySelectorAll(".cron-run-entry"));
    expect(entries).toHaveLength(runs.length);
    for (const run of runs) {
      const entry = entries.find((candidate) =>
        entryText(candidate, "body")?.includes(run.summary!),
      );
      expect(entry).toBeDefined();
      const facts = entryText(entry, "facts") ?? "";
      if (run.deliverySuppressionReason) {
        expect(facts).toContain(`Delivery suppression: ${run.deliverySuppressionReason}`);
        expect(facts).toContain("Not delivered");
        expect(entryText(entry, "title")).toContain("OK");
      } else {
        expect(facts).not.toContain("Delivery suppression:");
      }
      if (run.deliveryError) {
        expect(entry?.textContent).toContain(run.deliveryError);
        expect(facts).toContain("Not delivered");
      }
      if (run.error) {
        expect(entry?.textContent).toContain(run.error);
        expect(entryText(entry, "title")).toContain("Error");
      }
      expect(facts).toContain(
        run.deliveryStatus === "delivered"
          ? "Delivered"
          : run.deliveryStatus === "not-requested"
            ? "Not requested"
            : "Not delivered",
      );
    }
  });

  it("redacts and escapes server-provided suppression text in run facts", () => {
    const container = renderView({
      runs: [
        createRun({
          deliveryStatus: "not-delivered",
          deliverySuppressionReason: "silent <img src=x onerror=alert(1)> Bearer abcdefghijkl",
        }),
      ],
    });
    const facts = getElement(container, ".cron-run-entry__facts", HTMLDivElement);
    expect(facts.textContent).toContain("Delivery suppression: silent <img");
    expect(facts.textContent).toContain("Bearer [redacted]");
    expect(facts.textContent).not.toContain("abcdefghijkl");
    expect(facts.querySelector("img")).toBeNull();
  });
});
