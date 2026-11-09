import { describe, expect, it, vi } from "vitest";
import type { CronRunLogEntry } from "../../api/types.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  createCronViewJob,
  createCronViewRun as createRun,
  getElement,
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

describe("cron view run history", () => {
  it("renders execution errors and delivery labels without overriding execution status", async () => {
    const cases: Array<[Partial<CronRunLogEntry>, string, string, string?]> = [
      [{ completionStatus: "succeeded", deliveryStatus: "delivered" }, "Completed", "Delivered"],
      [{ deliveryStatus: "not-requested" }, "Completed", "Not requested"],
      [{}, "Completed", "Not requested"],
      [
        { status: "error", completionStatus: "failed", error: "Execution failed" },
        "Error",
        "Not requested",
        "Execution failed",
      ],
      [{ status: "skipped", completionStatus: "failed" }, "Skipped", "Not requested"],
    ];
    const runs = cases.map(([entry], ts) => createRun({ ts, summary: `Run ${ts}`, ...entry }));
    const container = await renderView({ runs }, "job");
    const entries = [...container.querySelectorAll(".cron-run-entry")].toReversed();
    expect(entries).toHaveLength(cases.length);
    cases.forEach(([, title, facts, error], index) => {
      const entry = entries[index]!;
      expect(entryText(entry, "title")?.replace(/\s+/g, " ").trim()).toBe(`job-1 · ${title}`);
      expect(entryText(entry, "facts")).toBe(facts);
      if (error) {
        expect(entry.textContent).toContain(error);
      }
    });
  });

  it("preserves phone run token counts and durations in the rendered entry", async () => {
    const container = await renderView({
      phoneLayout: true,
      runs: [
        { jobId: "total", durationMs: 90_000, usage: { total_tokens: 1_234_567 } },
        { jobId: "split", durationMs: 500, usage: { input_tokens: 50_000, output_tokens: 999 } },
        { jobId: "zero", durationMs: 0 },
        { jobId: "invalid", durationMs: -1 },
        { jobId: "unknown" },
      ].map((entry, index) => createRun({ ts: 7 - index, ...entry })),
    });
    const entries = Array.from(container.querySelectorAll(".cron-run-entry"));
    const [total, split, zero, invalid, unknown] = entries;
    expect(entryText(total, "facts")).toContain("1.2M Tokens");
    expect(entryText(total, "meta")).toContain("1m 30s");
    expect(total?.textContent).not.toContain("1234567");
    expect(total?.textContent).not.toContain("90000ms");

    expect(entryText(split, "facts")).toContain("50k in / 999 out");
    expect(entryText(split, "meta")).toContain("500ms");
    expect(entryText(zero, "meta")).toContain("0ms");
    expect(entryText(invalid, "meta")).toContain("n/a");
    expect(entryText(unknown, "meta")).toContain("n/a");
  });

  it("renders run summaries as sanitized markdown", async () => {
    const container = await renderView({
      runs: [
        createRun({ ts: 3, summary: "**bold** <script>alert(1)</script>" }),
        createRun({
          ts: 2,
          status: "error",
          error: "Execution failed",
          summary: "Hidden failure summary",
        }),
        createRun({ ts: 1, summary: "No summary." }),
      ],
    });
    expect(container.querySelector(".cron-run-entry__summary")?.textContent).toContain("bold");
    expect(container.querySelector(".cron-run-entry__summary strong")).toBeNull();
    expect(container.querySelectorAll(".cron-run-entry__summary")).toHaveLength(1);
    expect(container.querySelector(".cron-run-entry__error")?.textContent).toBe("Execution failed");
    expect(container.textContent).not.toContain("Hidden failure summary");
    expect(container.textContent).not.toContain("No summary.");
    getElement(container, ".cron-run-entry__title", HTMLButtonElement).click();
    await waitForSolid(() =>
      expect(container.querySelector(".cron-run-entry__body")).not.toBeNull(),
    );
    const body = getElement(container, ".cron-run-entry__body", HTMLDivElement);
    expect(body.querySelector("strong")?.textContent).toBe("bold");
    expect(body.querySelector("script")).toBeNull();
  });

  it("shows empty guidance only for settled history and offers recovery after failure", async () => {
    for (const runsState of ["idle", "pending", "failed"] as const) {
      for (const runsQuery of ["", "fail"]) {
        const onRefresh = vi.fn();
        const container = await renderView({ runsState, runsQuery, onRefresh });
        expect(container.textContent).not.toContain("No activity yet.");
        expect(container.textContent).not.toContain("No activity matches the current filters.");
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
    const retained = await renderView({
      runsState: "failed",
      error: "History unavailable",
      runs: [
        createRun({
          status: undefined,
          summary: "Previously accepted run",
          jobName: "Retained automation",
        }),
      ],
    });
    expect(retained.querySelector(".cron-run-entry")?.textContent).toContain("Retained automation");
    expect(retained.textContent).toContain("History unavailable");
    const empty = await renderView();
    expect(empty.querySelector(".cron-empty-state")?.textContent).toContain("No activity yet.");

    const filtered = await renderView({ runsQuery: "fail" });
    expect(filtered.querySelector(".cron-runs__empty")?.textContent).toContain(
      "No activity matches the current filters.",
    );
  });

  it("redacts and escapes server-provided suppression text in run facts", async () => {
    const container = await renderView({
      runs: [
        createRun({
          deliveryStatus: "not-delivered",
          deliverySuppressionReason: "silent <img src=x onerror=alert(1)> Bearer abcdefghijkl",
        }),
      ],
    });
    getElement(container, ".cron-run-entry__title", HTMLButtonElement).click();
    await waitForSolid(() =>
      expect(container.querySelector(".cron-run-entry__facts")).not.toBeNull(),
    );
    const facts = getElement(container, ".cron-run-entry__facts", HTMLDivElement);
    expect(facts.textContent).toContain("Delivery suppression: silent <img");
    expect(facts.textContent).toContain("Bearer [redacted]");
    expect(facts.textContent).not.toContain("abcdefghijkl");
    expect(facts.querySelector("img")).toBeNull();
  });
});
