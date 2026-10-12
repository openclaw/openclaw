// Cron shared tests cover shared cron CLI parsing, display, and error helpers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { visibleWidth } from "../../../packages/terminal-core/src/ansi.js";
import type { CronJob } from "../../cron/types.js";
import { GatewayClientRequestError } from "../../gateway/client.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import {
  ExpectedCliError,
  formatCliFailureLines,
  formatCliJsonFailure,
} from "../failure-output.js";
import { CronCliError } from "./cron-cli-error.js";
import { resolveCronCreateScheduleFromArgs } from "./schedule-options.js";
import {
  coerceCronDeliveryPreviews,
  enrichCronJsonWithStatus,
  getCronChannelOptions,
  handleCronCliError,
  parseAt,
  parseCronStringList,
  parsePositiveCronDurationMs,
  printCronList,
  printCronShow,
} from "./shared.js";

const hoisted = vi.hoisted(() => ({
  listChannelPluginsMock: vi.fn(),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  listChannelPlugins: hoisted.listChannelPluginsMock,
}));

function createRuntimeLogCapture(): { logs: string[]; runtime: RuntimeEnv } {
  const logs: string[] = [];
  const runtime = {
    log: (msg: string) => logs.push(...msg.split("\n")),
    error: () => {},
    exit: () => {},
  } as RuntimeEnv;
  return { logs, runtime };
}

function expectLogsToInclude(logs: readonly string[], text: string): void {
  expect(logs.join("\n")).toContain(text);
}

afterEach(() => {
  vi.useRealTimers();
});

function createBaseJob(overrides: Partial<CronJob>): CronJob {
  const now = Date.now();
  return {
    id: "job-id",
    agentId: "main",
    name: "Test Job",
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: { kind: "at", at: new Date(now + 3600000).toISOString() },
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "test" },
    state: { nextRunAtMs: now + 3600000 },
    ...overrides,
  } as CronJob;
}

describe("printCronList", () => {
  beforeEach(() => {
    hoisted.listChannelPluginsMock.mockReset();
    hoisted.listChannelPluginsMock.mockReturnValue([]);
  });

  it.each([
    { at: "+010000-01-15T12:34:56.789Z", expected: "+010000-01-15 12:34Z" },
    { at: "not-a-time", expected: "-" },
  ])("preserves one-shot ISO year in cron list for $at", ({ at, expected }) => {
    const { logs, runtime } = createRuntimeLogCapture();
    printCronList([createBaseJob({ schedule: { kind: "at", at }, state: {} })], runtime);
    expectLogsToInclude(logs, `at ${expected}`);
  });

  it("truncates and aligns names by sanitized terminal display width", () => {
    const { logs, runtime } = createRuntimeLogCapture();
    const prefix19 = "x".repeat(19);
    const prefix20 = "x".repeat(20);
    const prefix21 = "x".repeat(21);
    const injectedMarker = "cron-table-injection";
    const injectedControl = `\u001B]0;${injectedMarker}\u0007`;
    const cases = [
      { name: `${prefix20}🚀tail`, expected: `${prefix20}...` },
      { name: `${prefix21}Atail`, expected: `${prefix21}...` },
      { name: `${prefix19}表tail`, expected: `${prefix19}表...` },
      { name: `${prefix20}e\u0301tail`, expected: `${prefix20}e\u0301...` },
      { name: `${prefix19}👨‍👩‍👧‍👦tail`, expected: `${prefix19}👨‍👩‍👧‍👦...` },
      { name: `${prefix20}👨‍👩‍👧‍👦`, expected: `${prefix20}👨‍👩‍👧‍👦` },
      { name: `${prefix20}${injectedControl}🚀tail`, expected: `${prefix20}...` },
    ];

    printCronList(
      cases.map(({ name }, index) => createBaseJob({ id: `unicode-name-${index}`, name })),
      runtime,
    );

    const header = logs[0] ?? "";
    const rows = logs.slice(1);
    const scheduleColumn = visibleWidth(header.slice(0, header.indexOf("Schedule")));
    expect(rows).toHaveLength(cases.length);
    for (const [index, row] of rows.entries()) {
      const scheduleIndex = row.indexOf("at ");
      expect(scheduleIndex).toBeGreaterThan(-1);
      expect(visibleWidth(row.slice(0, scheduleIndex))).toBe(scheduleColumn);
      expect(row).toContain(cases[index]?.expected);
    }
    const output = logs.join("\n");
    expect(Buffer.from(output, "utf8").toString("utf8")).toBe(output);
    expect(output).not.toContain("\uFFFD");
    expect(output).not.toContain(injectedMarker);
  });

  it("sanitizes and bounds named-session targets", () => {
    const { logs, runtime } = createRuntimeLogCapture();
    const injectedMarker = "cron-target-injection";
    const sessionTarget = `session:${"x".repeat(20)}\u001B]0;${injectedMarker}\u0007`;
    const job = createBaseJob({
      id: "target-job",
      sessionTarget: sessionTarget as CronJob["sessionTarget"],
    });

    printCronList([job], runtime, {
      deliveryPreviews: new Map([[job.id, { label: "target-delivery", detail: "destination" }]]),
    });

    const header = logs[0] ?? "";
    const row = logs[1] ?? "";
    const deliveryColumn = visibleWidth(header.slice(0, header.indexOf("Delivery")));
    const deliveryIndex = row.indexOf("target-delivery");
    expect(deliveryIndex).toBeGreaterThan(-1);
    expect(visibleWidth(row.slice(0, deliveryIndex))).toBe(deliveryColumn);
    expect(row).toContain("sessio...");
    expect(row).not.toContain(injectedMarker);
  });

  it("shows declaration metadata and existing run status", () => {
    const job = createBaseJob({
      declarationKey: "daily-report",
      displayName: "Daily summary",
      owner: { agentId: "ops", sessionKey: "agent:ops:main" },
      sessionTarget: "isolated",
      state: {
        nextRunAtMs: Date.now() + 60_000,
        lastRunAtMs: Date.now() - 60_000,
        lastRunStatus: "error",
        lastError: "boom",
        lastDeliveryStatus: "not-delivered",
        lastDeliveryError: "offline",
      },
    });

    const list = createRuntimeLogCapture();
    printCronList([job], list.runtime);
    expect(list.logs[0]).toContain("Declaration");
    expect(list.logs[0]).toContain("Owner");
    expectLogsToInclude(list.logs, "daily-report");
    expectLogsToInclude(list.logs, "Daily summary");
    expectLogsToInclude(list.logs, "agent:ops:main");

    const show = createRuntimeLogCapture();
    printCronShow(job, show.runtime);
    expectLogsToInclude(show.logs, "declaration: daily-report");
    expectLogsToInclude(show.logs, "display name: Daily summary");
    expectLogsToInclude(show.logs, "owner agent: ops");
    expectLogsToInclude(show.logs, "last error: boom");
    expectLogsToInclude(show.logs, "last delivery: not-delivered");
    expectLogsToInclude(show.logs, "last delivery error: offline");
  });

  it.each(["failed", "unknown"] as const)(
    "does not report a one-shot as complete when required delivery is %s",
    (lastCompletionStatus) => {
      const job = createBaseJob({
        enabled: false,
        state: {
          lastRunStatus: "ok",
          lastCompletionStatus,
          lastDeliveryStatus: lastCompletionStatus === "failed" ? "not-delivered" : "unknown",
        },
      });
      expect(enrichCronJsonWithStatus(job)).toMatchObject({
        status: "disabled",
        state: { lastCompletionStatus },
      });
      const show = createRuntimeLogCapture();
      printCronShow(job, show.runtime);
      expect(show.logs.join("\n")).toContain(
        lastCompletionStatus === "failed"
          ? "disabled (delivery failed)"
          : "disabled (delivery unknown)",
      );
    },
  );

  it.each(["failed", "unknown"] as const)(
    "shows an active run before the previous %s delivery outcome",
    (lastCompletionStatus) => {
      const job = createBaseJob({
        state: {
          runningAtMs: Date.now(),
          lastRunStatus: "ok",
          lastCompletionStatus,
          lastDeliveryStatus: lastCompletionStatus === "failed" ? "not-delivered" : "unknown",
        },
      });
      expect(enrichCronJsonWithStatus(job)).toMatchObject({ status: "running" });
      const list = createRuntimeLogCapture();
      printCronList([job], list.runtime);
      expect(list.logs.join("\n")).toContain("running");
      expect(list.logs.join("\n")).not.toContain("delivery failed");
      expect(list.logs.join("\n")).not.toContain("delivery unknown");
      const show = createRuntimeLogCapture();
      printCronShow(job, show.runtime);
      expect(show.logs.join("\n")).toContain("status: running");
    },
  );

  it.each(["error", "skipped"] as const)(
    "preserves %s execution status when completion also failed",
    (lastRunStatus) => {
      const job = createBaseJob({
        state: { lastRunStatus, lastCompletionStatus: "failed" },
      });
      expect(enrichCronJsonWithStatus(job)).toMatchObject({ status: lastRunStatus });
      const list = createRuntimeLogCapture();
      printCronList([job], list.runtime);
      expect(list.logs.join("\n")).toContain(lastRunStatus);
    },
  );

  it("sanitizes every stored cron show value at the terminal boundary", () => {
    const control = "\u001B]0;cron-show-injection\u0007";
    const injected = (value: string) => `${control}${value}\r\nforged-row\tfield`;
    const job = createBaseJob({
      id: injected("job-id"),
      declarationKey: injected("declaration"),
      name: injected("name 🦞"),
      displayName: injected("display"),
      owner: { agentId: injected("owner"), sessionKey: injected("owner-session") },
      agentId: injected("agent"),
      sessionTarget: injected("session") as CronJob["sessionTarget"],
      payload: { kind: "agentTurn", message: "test", model: injected("model") },
      state: {
        lastError: injected("last-error"),
        lastDeliveryStatus: "not-delivered",
        lastDeliveryError: injected("delivery-error"),
        lastDiagnosticSummary: injected("diagnostic"),
      },
    });
    const { logs, runtime } = createRuntimeLogCapture();

    printCronShow(job, runtime, {
      deliveryPreview: { label: injected("delivery"), detail: injected("detail") },
    });

    const output = logs.join("\n");
    expect(output).not.toContain("\u001B");
    expect(output).not.toContain("\nforged-row");
    expect(output).toContain("\\r\\nforged-row\\tfield");
    expect(output).toContain("name 🦞");
  });

  it("tolerates malformed rows in human-readable output", () => {
    const { logs, runtime } = createRuntimeLogCapture();
    const malformedJob = {
      id: "malformed-job",
      name: undefined,
      enabled: true,
      sessionTarget: undefined,
      payload: undefined,
      schedule: undefined,
      state: undefined,
    } as unknown as CronJob;

    printCronList([malformedJob], runtime);
    expectLogsToInclude(logs, "malformed-job");
  });

  it.each([
    {
      schedule: { kind: "cron", expr: "* * * * *", staggerMs: 1_001 },
      expected: "cron * * * * * (stagger 1s 1ms)",
    },
  ] as const)(
    "preserves configured duration precision in list and show: $expected",
    ({ schedule, expected }) => {
      const job = createBaseJob({ schedule, state: {} });
      const list = createRuntimeLogCapture();
      printCronList([job], list.runtime);
      expectLogsToInclude(list.logs, expected);

      const show = createRuntimeLogCapture();
      printCronShow(job, show.runtime);
      expectLogsToInclude(show.logs, `schedule: ${expected}`);
    },
  );

  it("marks trigger schedules and shows evaluation details", () => {
    const job = createBaseJob({
      schedule: { kind: "every", everyMs: 30_000 },
      trigger: { script: "json({ fire: true })", once: true },
      state: {
        triggerEvalCount: 4,
        lastTriggerEvalAtMs: Date.now() - 30_000,
        lastTriggerFireAtMs: Date.now() - 60_000,
      },
    });

    const list = createRuntimeLogCapture();
    printCronList([job], list.runtime);
    expectLogsToInclude(list.logs, "every 30s+trigger");

    const show = createRuntimeLogCapture();
    printCronShow(job, show.runtime);
    expectLogsToInclude(show.logs, "trigger: once=yes; evals=4;");
  });

  it("includes condition triggers on stream schedules", () => {
    const job = createBaseJob({
      schedule: { kind: "stream", command: ["node", "events.mjs"] },
      trigger: { script: "json({ fire: true })" },
      state: {},
    });

    const list = createRuntimeLogCapture();
    printCronList([job], list.runtime);
    expectLogsToInclude(list.logs, "stream node events.mjs+trigger");

    const show = createRuntimeLogCapture();
    printCronShow(job, show.runtime);
    expectLogsToInclude(show.logs, "schedule: stream node events.mjs+trigger");
  });

  it.each([false, true])("shows disabled stream sources with running=%s", (running) => {
    const job = createBaseJob({
      schedule: { kind: "stream", command: ["node", "events.mjs"] },
      state: {
        streamStatus: "disabled",
        streamError: "stream sources require cron.triggers.enabled=true",
        lastRunStatus: "ok",
        lastDeliveryStatus: "not-delivered",
        deliverySuppressionReason: "silent",
        ...(running ? { runningAtMs: Date.now() } : {}),
      },
    });

    const list = createRuntimeLogCapture();
    printCronList([job], list.runtime);
    const row = list.logs.find((line) => line.includes(job.id)) ?? "";
    expect(row).toContain(running ? "running" : "disabled");
    expect(row).not.toContain("idle");
    expect(row).not.toContain("ok (suppressed)");

    const show = createRuntimeLogCapture();
    printCronShow(job, show.runtime);
    expect(show.logs).toContain(`status: ${running ? "running" : "disabled"}`);
    expectLogsToInclude(show.logs, "stream status: disabled");
    expectLogsToInclude(
      show.logs,
      "stream error: stream sources require cron.triggers.enabled=true",
    );
    expect(enrichCronJsonWithStatus(job)).toMatchObject({ status: running ? "running" : "ok" });
  });

  it("shows on-exit schedules in list and show output", () => {
    const job = createBaseJob({
      id: "on-exit-job",
      name: "Watch build",
      schedule: { kind: "on-exit", command: "pnpm build", cwd: "/repo" },
      sessionTarget: "main",
      state: {},
      payload: { kind: "systemEvent", text: "done" },
    });

    const list = createRuntimeLogCapture();
    printCronList([job], list.runtime);
    expectLogsToInclude(list.logs, "on-exit pnpm build @ /repo");

    const show = createRuntimeLogCapture();
    printCronShow(job, show.runtime);
    expectLogsToInclude(show.logs, "schedule: on-exit pnpm build @ /repo");
  });

  it("shows the consecutive failure count for chronically failing jobs", () => {
    const failing = createBaseJob({
      id: "failing-job",
      name: "Failing",
      state: { lastRunStatus: "error", consecutiveErrors: 12, lastError: "boom" },
    });
    const singleFailure = createBaseJob({
      id: "single-failure-job",
      name: "Failed Once",
      state: { lastRunStatus: "error", consecutiveErrors: 1, lastError: "boom" },
    });

    const { logs, runtime } = createRuntimeLogCapture();
    printCronList([failing, singleFailure], runtime);

    expectLogsToInclude(logs, "error (12x)");
    // A single failure keeps the bare status token; the count only marks repeats.
    const singleLine = logs.find((line) => line.includes("single-failure-job")) ?? "";
    expect(singleLine).toContain("error");
    expect(singleLine).not.toContain("(1x)");
  });

  it.each([
    ["required", false, "not-delivered", "HTTP 503", "ok (not delivered)"],
    ["required", false, "unknown", "request timed out", "delivery unknown"],
  ] as const)(
    "shows %s delivery outcomes (best effort %s, status %s) without changing JSON status",
    (_policy, bestEffort, deliveryStatus, deliveryError, expectedStatus) => {
      const job = createBaseJob({
        id: "delivery-job",
        delivery: {
          mode: "webhook",
          to: "https://example.invalid/hook",
          bestEffort,
        },
        state: {
          lastRunStatus: "ok",
          lastDeliveryStatus: deliveryStatus,
          lastDeliveryError: deliveryError,
        },
      });

      const list = createRuntimeLogCapture();
      printCronList([job], list.runtime);
      expectLogsToInclude(list.logs, expectedStatus);

      const show = createRuntimeLogCapture();
      printCronShow(job, show.runtime);
      expectLogsToInclude(show.logs, `status: ${expectedStatus}`);
      expectLogsToInclude(show.logs, `last delivery error: ${deliveryError}`);

      expect(enrichCronJsonWithStatus(job)).toMatchObject({
        status: "ok",
        state: { lastRunStatus: "ok", lastDeliveryStatus: deliveryStatus },
      });
      expect(enrichCronJsonWithStatus({ jobs: [job] })).toMatchObject({
        jobs: [{ status: "ok" }],
      });
    },
  );

  it.each(["silent"] as const)(
    "shows recorded %s suppression without changing JSON delivery status",
    (deliverySuppressionReason) => {
      const job = createBaseJob({
        state: {
          lastRunStatus: "ok",
          lastDeliveryStatus: "not-delivered",
          lastDelivered: false,
          deliverySuppressionReason,
        },
      });
      const list = createRuntimeLogCapture();
      printCronList([job], list.runtime);
      expectLogsToInclude(list.logs, "ok (suppressed)");
      expect(list.logs.join("\n")).not.toContain("ok (not delivered)");

      const show = createRuntimeLogCapture();
      printCronShow(job, show.runtime);
      expectLogsToInclude(show.logs, "status: ok (suppressed)");
      expectLogsToInclude(show.logs, "last delivery: not-delivered");
      expectLogsToInclude(show.logs, `last delivery suppression: ${deliverySuppressionReason}`);
      expect(enrichCronJsonWithStatus(job)).toMatchObject({
        status: "ok",
        state: {
          lastDeliveryStatus: "not-delivered",
          lastDelivered: false,
          deliverySuppressionReason,
        },
      });
    },
  );

  it("shows why the scheduler auto-disabled a job without changing JSON status", () => {
    const runFailures = createBaseJob({
      id: "auto-disabled-runs",
      name: "Auto-disabled runs",
      enabled: false,
      state: {
        consecutiveErrors: 10,
        autoDisabled: {
          reason: "consecutive-failures",
          atMs: Date.now(),
          consecutiveErrors: 10,
        },
      },
    });
    const scheduleErrors = createBaseJob({
      id: "auto-disabled-schedule",
      name: "Auto-disabled schedule",
      enabled: false,
      state: {
        scheduleErrorCount: 3,
        autoDisabled: {
          reason: "schedule-errors",
          atMs: Date.now(),
          consecutiveErrors: 3,
        },
      },
    });

    const list = createRuntimeLogCapture();
    printCronList([runFailures, scheduleErrors], list.runtime);
    expectLogsToInclude(list.logs, "disabled (10x)");
    expectLogsToInclude(list.logs, "disabled (schedule)");

    const show = createRuntimeLogCapture();
    printCronShow(runFailures, show.runtime);
    expectLogsToInclude(show.logs, "status: disabled (10x)");

    expect(enrichCronJsonWithStatus(runFailures)).toMatchObject({
      status: "disabled",
      state: {
        autoDisabled: { reason: "consecutive-failures", consecutiveErrors: 10 },
      },
    });
  });

  it("caps the failure count so the status column never overflows", () => {
    const { logs, runtime } = createRuntimeLogCapture();
    printCronList(
      [
        createBaseJob({
          id: "minute-cron-job",
          state: { lastRunStatus: "error", consecutiveErrors: 1440, lastError: "boom" },
        }),
      ],
      runtime,
    );
    expectLogsToInclude(logs, "error (99+x)");
    expect(logs.join("\n")).not.toContain("1440");
  });

  it("shows dash for unset agentId instead of default", () => {
    const { logs, runtime } = createRuntimeLogCapture();
    const job = createBaseJob({
      id: "no-agent-job",
      name: "No Agent",
      agentId: undefined,
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "hello", model: "sonnet" },
    });

    printCronList([job], runtime);
    // Header should say "Agent ID" not "Agent"
    expect(logs[0]).toContain("Agent ID");
    // Data row should show "-" for missing agentId, not "default"
    const dataLine = logs[1] ?? "";
    expect(dataLine).not.toContain("default");
  });

  it("shows exact label for cron schedules with stagger disabled", () => {
    const { logs, runtime } = createRuntimeLogCapture();
    const job = createBaseJob({
      id: "exact-job",
      name: "Exact",
      schedule: { kind: "cron", expr: "0 7 * * *", staggerMs: 0 },
      sessionTarget: "main",
      state: {},
      payload: { kind: "systemEvent", text: "tick" },
    });

    printCronList([job], runtime);
    expectLogsToInclude(logs, "(exact)");
  });
});

describe("parseAt", () => {
  it.each([
    ["2027-02-28t24:00:00.000", "America/New_York", "2027-03-01T05:00:00.000Z"],
    ["2027-02-28t24:00:00+05:45", "Europe/Oslo", "2027-02-28T18:15:00.000Z"],
    ["2027-09-04t24:00", "America/Santiago", null],
  ])("interprets offsetless one-shot %s in %s", (input, timezone, expected) => {
    expect(parseAt(input, timezone)).toBe(expected);
    if (expected !== null) {
      expect(resolveCronCreateScheduleFromArgs({ at: input, tz: timezone })).toEqual({
        kind: "at",
        at: expected,
      });
    }
  });

  it("accepts leading plus relative durations for cron add --at", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-25T00:00:00.000Z"));

    expect(parseAt("+30m")).toBe("2026-05-25T00:30:00.000Z");
    expect(parseAt("30m")).toBe("2026-05-25T00:30:00.000Z");
  });

  it("rejects out-of-range epoch milliseconds", () => {
    expect(parseAt(String(Number.MAX_SAFE_INTEGER))).toBeNull();
  });

  it("rejects relative durations outside the Date range", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-25T00:00:00.000Z"));

    expect(parseAt("+999999999999999999d")).toBeNull();
  });

  it("rejects relative durations when the current clock is at the Date boundary", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(8_640_000_000_000_000));

    expect(parseAt("+1m")).toBeNull();
  });
});

describe("getCronChannelOptions", () => {
  it("falls back to a channel plugin id placeholder when no plugins are loaded", () => {
    hoisted.listChannelPluginsMock.mockReturnValue([]);
    expect(getCronChannelOptions()).toBe("last|<channel-plugin-id>");
  });

  it("lists discovered channel plugin ids when plugins are available", () => {
    hoisted.listChannelPluginsMock.mockReturnValue([{ id: "quietchat" }, { id: "forum" }]);
    expect(getCronChannelOptions()).toBe("last|quietchat|forum");
  });
});

describe("parseCronStringList", () => {
  it.each([
    { input: "exec,read,write", expected: ["exec", "read", "write"] },
    { input: ["exec", "read", "write"], expected: ["exec", "read", "write"] },
    { input: undefined, expected: undefined },
  ])("parses $input", ({ input, expected }) => {
    expect(parseCronStringList(input)).toEqual(expected);
  });
});

describe("coerceCronDeliveryPreviews", () => {
  it("keeps gateway-provided preview entries", () => {
    expect(
      coerceCronDeliveryPreviews({
        deliveryPreviews: {
          job1: { label: "announce -> telegram:123", detail: "explicit" },
        },
      }).get("job1"),
    ).toEqual({ label: "announce -> telegram:123", detail: "explicit" });
  });

  it("drops malformed preview entries", () => {
    expect(
      coerceCronDeliveryPreviews({
        deliveryPreviews: {
          job1: { label: "announce -> telegram:123" },
        },
      }).size,
    ).toBe(0);
  });
});

describe("parsePositiveCronDurationMs", () => {
  it("parses valid positive durations", () => {
    expect(parsePositiveCronDurationMs("500ms")).toBe(500);
    expect(parsePositiveCronDurationMs("30s")).toBe(30_000);
    expect(parsePositiveCronDurationMs("1.5h")).toBe(5_400_000);
    expect(parsePositiveCronDurationMs("1h30m")).toBe(5_400_000);
    expect(parsePositiveCronDurationMs("1d")).toBe(86_400_000);
  });

  it("rejects non-positive and malformed durations", () => {
    expect(parsePositiveCronDurationMs("0s")).toBeNull();
    expect(parsePositiveCronDurationMs("0.5ms")).toBe(1);
    expect(parsePositiveCronDurationMs("0.001ms")).toBeNull();
    expect(parsePositiveCronDurationMs("-5s")).toBeNull();
    expect(parsePositiveCronDurationMs("abc")).toBeNull();
    expect(parsePositiveCronDurationMs("")).toBeNull();
  });

  it("rejects durations that overflow to a non-finite millisecond value (#83906)", () => {
    // A finite mantissa can still overflow once multiplied by a large unit factor.
    expect(parsePositiveCronDurationMs(`1${"0".repeat(302)}d`)).toBeNull();
    expect(parsePositiveCronDurationMs("8640000000000000ms")).toBe(8_640_000_000_000_000);
    expect(parsePositiveCronDurationMs("8640000000000001ms")).toBeNull();
  });
});

describe("handleCronCliError", () => {
  it("renders typed automation lookup misses with the cron list recovery command", () => {
    const error = new GatewayClientRequestError({
      code: "INVALID_REQUEST",
      message: "transport-neutral lookup miss",
      details: { code: "CRON_JOB_NOT_FOUND", jobId: "missing-job" },
    });
    const errorOutput = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(((code: number) => {
      throw new Error(`exit ${code}`);
    }) as never);

    expect(() => handleCronCliError(error)).toThrow("exit 1");
    expect(errorOutput).toHaveBeenCalledWith(
      expect.stringContaining(
        "Automation not found: missing-job. Run `openclaw cron list` to see recent automation ids.",
      ),
    );
    errorOutput.mockRestore();
    exit.mockRestore();
  });

  it.each([
    {
      label: "typed lookup miss",
      error: new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: "transport-neutral lookup miss",
        details: { code: "CRON_JOB_NOT_FOUND", jobId: "missing-job" },
      }),
      message:
        "Automation not found: missing-job. Run `openclaw cron list` to see recent automation ids.",
    },
  ])(
    "hands a $label to the root renderer as an expected machine-output failure",
    ({ error, message }) => {
      const argv = process.argv;
      process.argv = [...argv.slice(0, 2), "cron", "show", "missing-job", "--json"];
      try {
        let thrown: unknown;
        try {
          handleCronCliError(error);
        } catch (caught) {
          thrown = caught;
        }
        expect(thrown).toBeInstanceOf(ExpectedCliError);
        expect(formatCliJsonFailure(thrown)).toEqual({
          ok: false,
          error: { type: "cli_error", message },
        });
        const stderr = formatCliFailureLines({
          title: "Could not start the CLI.",
          error: thrown,
          argv: process.argv,
        }).join("\n");
        expect(stderr).toContain(message);
        expect(stderr).not.toContain("Could not start the CLI.");
        expect(stderr).not.toContain("openclaw doctor");
        expect(stderr).not.toContain("OPENCLAW_DEBUG");
      } finally {
        process.argv = argv;
      }
    },
  );

  // A legacy gateway without cron.get makes `cron edit <id> --exact` wrap the
  // lookup miss; the renderer only reveals such causes on explicit debug intent.
  it.each([
    {
      label: "stays terse without debug intent",
      flags: [] as string[],
      debug: "",
      causeShown: false,
    },
    { label: "keeps causes for --debug", flags: ["--debug"], debug: "", causeShown: true },
  ])("machine output for a wrapped cron failure $label", ({ flags, debug, causeShown }) => {
    const wrapped = new CronCliError("unknown automation id: missing-job", {
      cause: new Error("unknown method: cron.get"),
    });
    const argv = process.argv;
    process.argv = [
      ...argv.slice(0, 2),
      "cron",
      "edit",
      "missing-job",
      "--exact",
      "--json",
      ...flags,
    ];
    vi.stubEnv("OPENCLAW_DEBUG", debug);
    try {
      let thrown: unknown;
      try {
        handleCronCliError(wrapped);
      } catch (caught) {
        thrown = caught;
      }
      expect(thrown).toBeInstanceOf(ExpectedCliError);
      const machineMessage = formatCliJsonFailure(thrown).error.message;
      expect(machineMessage).toContain("unknown automation id: missing-job");
      expect(machineMessage.includes("unknown method: cron.get")).toBe(causeShown);
      const stderr = formatCliFailureLines({
        title: "The CLI command failed.",
        error: thrown,
      }).join("\n");
      expect(stderr).toContain("unknown automation id: missing-job");
      expect(stderr.includes("unknown method: cron.get")).toBe(causeShown);
    } finally {
      vi.unstubAllEnvs();
      process.argv = argv;
    }
  });

  it.each([false, true])("preserves unexpected machine-mode errors with debug=%s", (debug) => {
    const error = new Error("Automation runtime failed", {
      cause: new Error("Runtime load failed"),
    });
    const argv = process.argv;
    process.argv = [...argv.slice(0, 2), "automations", "status", "--json"];
    vi.stubEnv("OPENCLAW_DEBUG", debug ? "1" : "");
    try {
      let thrown: unknown;
      try {
        handleCronCliError(error);
      } catch (caught) {
        thrown = caught;
      }
      expect(thrown).toBe(error);
      const stderr = formatCliFailureLines({
        title: "The CLI command failed.",
        error: thrown,
      }).join("\n");
      expect(stderr).toContain("The CLI command failed.");
      expect(stderr).toContain("openclaw doctor");
      expect(stderr.includes("Stack:")).toBe(debug);
      expect(formatCliJsonFailure(thrown).error.message.includes("Runtime load failed")).toBe(
        debug,
      );
    } finally {
      vi.unstubAllEnvs();
      process.argv = argv;
    }
  });
});
