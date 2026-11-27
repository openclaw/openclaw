import { describe, expect, it, vi } from "vitest";
import type { CronRunLogEntry } from "../../api/types.ts";
import {
  createCronViewJob,
  createCronViewRun as createRun,
  getElement,
  renderCronView,
} from "./view.test-support.ts";

function renderView(props: Parameters<typeof renderCronView>[0] = {}, scope = "overview") {
  return renderCronView({
    activityOpen: true,
    detailTab: "history",
    editingJob: scope === "job" ? createCronViewJob("job-1", { state: {} }) : null,
    ...props,
  });
}

function entryText(entry: Element | undefined, part: string) {
  return entry?.querySelector(`.cron-run-entry__${part}`)?.textContent;
}

describe("cron view run history", () => {
  it("shows each recorded task outcome without borrowing the job's retained blocker", async () => {
    const cases: Array<[NonNullable<CronRunLogEntry["result"]>, string, string]> = [
      [{ outcome: "blocked", summary: "Source access required" }, "Blocked", "muted"],
      [{ outcome: "needs_attention", summary: "Choose the source" }, "Needs attention", "muted"],
      [{ outcome: "no_change" }, "No change", "muted"],
      [{ outcome: "progress", summary: "Processed one source" }, "Progress", "ok"],
      [{ outcome: "done", summary: "All sources processed" }, "Completed", "ok"],
    ];
    const container = await renderView(
      {
        editingJob: createCronViewJob("job-1", {
          state: {
            lastMeaningfulResult: { outcome: "blocked", summary: "Old blocker", atMs: 1 },
          },
        }),
        runs: cases.map(([result], ts) => createRun({ ts, result })),
      },
      "job",
    );
    const entries = [...container.querySelectorAll(".cron-run-entry")].toReversed();
    cases.forEach(([result, label, tone], index) => {
      const entry = entries[index]!;
      expect(entryText(entry, "status")).toBe(label);
      expect(entry.getAttribute("data-tone")).toBe(tone);
      expect(entry.textContent).not.toContain("Old blocker");
      if (result.summary) {
        expect(entryText(entry, "summary")).toContain(result.summary);
      }
    });
  });

  it("keeps execution errors ahead of a recorded result and delivery failures distinct", async () => {
    const container = await renderView(
      {
        runs: [
          createRun({
            ts: 2,
            status: "error",
            error: "Execution interrupted",
            result: { outcome: "done", summary: "Premature completion" },
          }),
          createRun({
            ts: 1,
            completionStatus: "failed",
            deliveryStatus: "not-delivered",
            deliveryError: "Destination unavailable",
            result: { outcome: "blocked", summary: "Source access required" },
          }),
        ],
      },
      "job",
    );
    const [failed, blocked] = [...container.querySelectorAll(".cron-run-entry")];
    expect(entryText(failed, "status")).toBe("Error");
    expect(failed?.getAttribute("data-tone")).toBe("danger");
    expect(failed?.textContent).toContain("Execution interrupted");
    expect(failed?.textContent).not.toContain("Premature completion");
    expect(entryText(blocked, "status")).toBe("Blocked · Error");
    expect(entryText(blocked, "delivery-error")).toContain("Destination unavailable");
  });

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
      expect(entryText(entry, "title")?.replace(/\s+/g, " ").trim()).toBe(title);
      expect(entryText(entry, "facts")).toBe(facts);
      if (error) {
        expect(entry.textContent).toContain(error);
      }
    });
  });

  it("renders a condition-script failure once, without unknown delivery or a transcript", async () => {
    const error = `cron trigger evaluation failed (internal_error): Error: ${Array(80).fill("HTTP 403").join(", ")}`;
    const container = await renderView(
      {
        runs: [
          createRun({
            status: "error",
            completionStatus: "failed",
            triggerFired: false,
            deliveryStatus: "unknown",
            runId: "receipt-1",
            sessionKey: "agent:main:cron:job-1",
            error,
          }),
        ],
      },
      "job",
    );
    const entry = container.querySelector(".cron-run-entry");
    expect(entryText(entry ?? undefined, "title")).toContain("Condition check failed");
    expect(entryText(entry ?? undefined, "facts")).toBe("");
    expect(entryText(entry ?? undefined, "meta") ?? "").not.toContain("403");
    expect(entry?.textContent?.split(error)).toHaveLength(2);
    expect(entry?.querySelector(".cron-error--clamped")).not.toBeNull();
    expect(
      [...(entry?.querySelectorAll("button:not(.cron-run-entry__header)") ?? [])].map((button) =>
        button.textContent?.trim(),
      ),
    ).toEqual(["Show details"]);
  });

  it("keeps distinct delivery explanations and drops copies of the run error", async () => {
    const container = await renderView({
      runs: [
        createRun({
          ts: 3,
          summary: "Report ready",
          deliveryStatus: "not-delivered",
          deliveryError: "Telegram chat not found",
        }),
        createRun({
          ts: 2,
          summary: "Report ready",
          deliveryStatus: "unknown",
          deliveryError: "Send returned no message id",
        }),
        createRun({
          ts: 1,
          status: "error",
          error: "boom",
          deliveryStatus: "unknown",
          deliveryError: "boom",
        }),
      ],
    });
    const [failed, uncertain, copied] = container.querySelectorAll(".cron-run-entry");
    expect(entryText(failed, "delivery-error")).toBe("Delivery failed: Telegram chat not found");
    expect(entryText(uncertain, "delivery-error")).toBe("Delivery: Send returned no message id");
    expect(entryText(uncertain, "facts")).toContain("Unknown");
    expect(copied?.querySelector(".cron-run-entry__delivery-error")).toBeNull();
  });

  it("formats run token counts and durations in the rendered entry", async () => {
    const container = await renderView({
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
    expect(entryText(total, "facts")).toContain("1m 30s");
    expect(total?.textContent).not.toContain("1234567");
    expect(total?.textContent).not.toContain("90000ms");

    expect(entryText(split, "facts")).toContain("50k in / 999 out");
    expect(entryText(split, "facts")).toContain("500ms");
    expect(entryText(zero, "facts")).toContain("0ms");
    expect(entryText(invalid, "facts")).toContain("n/a");
    // A run without a recorded duration omits it rather than printing a placeholder.
    expect(entryText(unknown, "facts")).not.toContain("n/a");
  });

  it("only exposes links and sanitized Markdown after expanding a run summary", async () => {
    const container = await renderView({
      runs: [
        createRun({
          summary: "**bold** [Report](https://example.com/report) <script>alert(1)</script>",
        }),
      ],
    });
    const body = () => getElement(container, ".cron-run-entry__summary", HTMLDivElement);
    expect(body().textContent).toContain("bold Report");
    expect(body().querySelector("a")).toBeNull();

    getElement(container, ".cron-run-entry__header", HTMLButtonElement).click();
    await vi.waitFor(() => expect(body().querySelector("strong")?.textContent).toBe("bold"));
    expect(body().querySelector("a")?.getAttribute("href")).toBe("https://example.com/report");
    expect(body().querySelector("script")).toBeNull();
  });

  it("shows empty guidance only for settled history and offers recovery after failure", async () => {
    for (const runsState of ["idle", "pending", "failed"] as const) {
      for (const runsQuery of ["", "fail"]) {
        const onRetryRuns = vi.fn();
        const container = await renderView({
          runsState,
          runsError:
            runsState === "failed" ? { reason: "load", detail: "History unavailable" } : null,
          runsQuery,
          onRetryRuns,
        });
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
        expect(onRetryRuns).toHaveBeenCalledTimes(runsState === "failed" ? 1 : 0);
      }
    }
    const retained = await renderView({
      runsState: "failed",
      runsError: { reason: "load", detail: "History unavailable" },
      runs: [createRun({ status: undefined, summary: "Previously accepted run" })],
    });
    expect(retained.querySelector(".cron-run-entry")?.textContent).toContain(
      "Previously accepted run",
    );
    expect(retained.querySelector(".cron-runs [role=alert] strong")?.textContent).toBe(
      "Couldn’t load run history.",
    );
    expect(retained.querySelector(".cron-runs details:not([open]) code")?.textContent).toBe(
      "History unavailable",
    );
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
    const facts = getElement(container, ".cron-run-entry__facts", HTMLElement);
    expect(facts.textContent).toContain("Delivery suppression: silent <img");
    expect(facts.textContent).toContain("Bearer [redacted]");
    expect(facts.textContent).not.toContain("abcdefghijkl");
    expect(facts.querySelector("img")).toBeNull();
  });
});
