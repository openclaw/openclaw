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
  parseCronCommandEnv,
  parseCronStringList,
  parsePositiveCronDurationMs,
  printCronList,
  printCronShow,
} from "./shared.js";

it("serializes prototype-named overrides with last-value precedence", () => {
  const env = parseCronCommandEnv([
    "__proto__=first",
    "NORMAL_KEY=control",
    "__proto__=kept=tail",
    "constructor=ordinary",
  ]);
  expect(JSON.stringify(env)).toBe(
    '{"__proto__":"kept=tail","NORMAL_KEY":"control","constructor":"ordinary"}',
  );
});

const hoisted = vi.hoisted(() => ({ listChannelPluginsMock: vi.fn() }));

vi.mock("../../channels/plugins/index.js", () => ({
  listChannelPlugins: hoisted.listChannelPluginsMock,
}));

function capture(write: (runtime: RuntimeEnv) => void) {
  const logs: string[] = [];
  write({
    log: (...args) => logs.push(...args.flatMap((value) => String(value).split("\n"))),
    error: () => {},
    exit: () => {},
  });
  return logs;
}

function expectText(logs: readonly string[], ...texts: string[]): void {
  for (const text of texts) {
    expect(logs.join("\n")).toContain(text);
  }
}

function renderJob(job: CronJob) {
  return { list: renderList(job), show: renderShow(job) };
}
function renderList(job: CronJob | CronJob[], options?: Parameters<typeof printCronList>[2]) {
  return capture((runtime) => printCronList(Array.isArray(job) ? job : [job], runtime, options));
}
function renderShow(job: CronJob, options?: Parameters<typeof printCronShow>[2]) {
  return capture((runtime) => printCronShow(job, runtime, options));
}

function captureError(error: unknown): unknown {
  try {
    handleCronCliError(error);
  } catch (caught) {
    return caught;
  }
  return undefined;
}

function renderJsonError(
  error: unknown,
  args: string[],
  debug = "",
  title = "The CLI command failed.",
) {
  const argv = process.argv;
  process.argv = [...argv.slice(0, 2), ...args, "--json"];
  vi.stubEnv("OPENCLAW_DEBUG", debug);
  try {
    const thrown = captureError(error);
    return {
      thrown,
      json: formatCliJsonFailure(thrown),
      stderr: formatCliFailureLines({ title, error: thrown, argv: process.argv }).join("\n"),
    };
  } finally {
    process.argv = argv;
    vi.unstubAllEnvs();
  }
}

afterEach(() => vi.useRealTimers());

function makeJob(overrides: Partial<CronJob>): CronJob {
  const now = Date.now();
  return {
    id: "job-id",
    agentId: "main",
    name: "Test Job",
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: { kind: "at", at: new Date(now + 3600000).toISOString() },
    payload: { kind: "systemEvent", text: "test" },
    state: { nextRunAtMs: now + 3600000 },
    ...overrides,
  } as CronJob;
}

beforeEach(() => hoisted.listChannelPluginsMock.mockReset().mockReturnValue([]));

it.each([
  { at: "+010000-01-15T12:34:56.789Z", expected: "+010000-01-15 12:34Z" },
  { at: "not-a-time", expected: "-" },
])("preserves one-shot ISO year in cron list for $at", ({ at, expected }) => {
  const logs = renderList(makeJob({ schedule: { kind: "at", at }, state: {} }));
  expectText(logs, `at ${expected}`);
});

it("truncates and aligns names by sanitized terminal display width", () => {
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

  const logs = renderList(
    cases.map(({ name }, index) => makeJob({ id: `unicode-name-${index}`, name })),
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
  const injectedMarker = "cron-target-injection";
  const sessionTarget = `session:${"x".repeat(20)}\u001B]0;${injectedMarker}\u0007`;
  const job = makeJob({
    id: "target-job",
    sessionTarget: sessionTarget as CronJob["sessionTarget"],
  });

  const logs = renderList(job, {
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
  const job = makeJob({
    declarationKey: "daily-report",
    displayName: "Daily summary",
    owner: { agentId: "ops", sessionKey: "agent:ops:main" },
    sessionTarget: "isolated",
    state: {
      lastRunStatus: "error",
      lastError: "boom",
      lastDeliveryStatus: "not-delivered",
      lastDeliveryError: "offline",
    },
  });

  const { list, show } = renderJob(job);
  expectText([list[0] ?? ""], "Declaration", "Owner");
  expectText(list, "daily-report", "Daily summary", "agent:ops:main");
  expectText(
    show,
    "declaration: daily-report",
    "display name: Daily summary",
    "owner agent: ops",
    "last error: boom",
    "last delivery: not-delivered",
    "last delivery error: offline",
  );
});

it.each([true, false])(
  "shows configured job policies, including explicit %s, without scratch content",
  (value) => {
    const job = {
      ...makeJob({
        activeHours: { start: "22:00", end: "06:00", timezone: "America/Los_Angeles" },
        idleOnly: value,
        delivery: { mode: "announce", target: "owner", directPolicy: "block" },
        payload: {
          kind: "agentTurn",
          message: "Check",
          skipIfScratchEmpty: value,
          includeReasoning: value,
        },
      }),
      scratch: { content: "private checklist sentinel" },
    };
    const policies = `policies: active hours=22:00-06:00 @ America/Los_Angeles; idle only=${value}; delivery target=owner; direct policy=block; skip if scratch empty=${value}; include reasoning=${value}`;
    for (const logs of Object.values(renderJob(job))) {
      expectText(logs, policies);
      expect(logs.join("\n")).not.toContain("private checklist sentinel");
    }
  },
);

it("sanitizes every stored cron show value at the terminal boundary", () => {
  const control = "\u001B]0;cron-show-injection\u0007";
  const injected = (value: string) => `${control}${value}\r\nforged-row\tfield`;
  const job = makeJob({
    id: injected("job-id"),
    declarationKey: injected("declaration"),
    name: injected("name 🦞"),
    displayName: injected("display"),
    owner: { agentId: injected("owner"), sessionKey: injected("owner-session") },
    agentId: injected("agent"),
    sessionTarget: injected("session") as CronJob["sessionTarget"],
    payload: { kind: "agentTurn", message: "test", model: injected("model") },
    activeHours: { start: "09:00", end: "17:00", timezone: injected("local") },
    state: {
      lastError: injected("last-error"),
      lastDeliveryStatus: "not-delivered",
      lastDeliveryError: injected("delivery-error"),
      lastDiagnosticSummary: injected("diagnostic"),
    },
  });
  const logs = renderShow(job, {
    deliveryPreview: { label: injected("delivery"), detail: injected("detail") },
  });

  const output = logs.join("\n");
  expect(output).not.toContain("\u001B");
  expect(output).not.toContain("\nforged-row");
  expect(output).toContain("\\r\\nforged-row\\tfield");
  expect(output).toContain("name 🦞");
});

it("tolerates malformed rows in human-readable output", () => {
  const malformed = { id: "malformed-job", enabled: true } as unknown as CronJob;
  expectText(renderList(malformed), "malformed-job");
});

it.each<[CronJob["schedule"], string, Partial<CronJob>?, string?]>([
  [{ kind: "cron", expr: "* * * * *", staggerMs: 1_001 }, "cron * * * * * (stagger 1s 1ms)"],
  [{ kind: "cron", expr: "0 7 * * *", staggerMs: 0 }, "cron 0 7 * * * (exact)"],
  [
    { kind: "every", everyMs: 30_000 },
    "every 30s+trigger",
    {
      trigger: { script: "json({ fire: true })", once: true },
      state: {
        triggerEvalCount: 4,
        lastTriggerEvalAtMs: Date.now() - 30_000,
        lastTriggerFireAtMs: Date.now() - 60_000,
      },
    },
    "trigger: once=yes; evals=4;",
  ],
  [
    { kind: "stream", command: ["node", "events.mjs"] },
    "stream node events.mjs+trigger",
    { trigger: { script: "json({ fire: true })" } },
  ],
  [{ kind: "on-exit", command: "pnpm build", cwd: "/repo" }, "on-exit pnpm build @ /repo"],
])("formats %j in list and show", (schedule, expected, details, triggerDetail) => {
  const { list, show } = renderJob(makeJob({ schedule, state: {}, ...details }));
  expectText(list, expected);
  expectText(show, `schedule: ${expected}`);
  if (triggerDetail) {
    expectText(show, triggerDetail);
  }
});

it.each([false, true])("shows disabled stream sources with running=%s", (running) => {
  const job = makeJob({
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

  const { list, show } = renderJob(job);
  const row = list.find((line) => line.includes(job.id)) ?? "";
  expect(row).toContain(running ? "running" : "disabled");
  expect(row).not.toContain("idle");
  expect(row).not.toContain("ok (suppressed)");

  expect(show).toContain(`status: ${running ? "running" : "disabled"}`);
  expectText(
    show,
    "stream status: disabled",
    "stream error: stream sources require cron.triggers.enabled=true",
  );
  expect(enrichCronJsonWithStatus(job)).toMatchObject({ status: running ? "running" : "ok" });
});

it.each([
  [12, "error (12x)", undefined],
  [1, "error", "(1x)"],
  [1440, "error (99+x)", "1440"],
] as const)("bounds the failure-count decoration for %i failures", (count, status, forbidden) => {
  const logs = renderList(
    makeJob({
      state: { lastRunStatus: "error", consecutiveErrors: count, lastError: "boom" },
    }),
  );
  expectText(logs, status);
  if (forbidden) {
    expect(logs.join("\n")).not.toContain(forbidden);
  }
});

it.each([
  ["not-delivered", "HTTP 503", "ok (not delivered)"],
  ["unknown", "request timed out", "delivery unknown"],
  ["not-delivered", undefined, "ok (suppressed)"],
] as const)("shows %s (%s) without decorating JSON status", (deliveryStatus, error, status) => {
  const suppression: CronJob["state"] =
    error === undefined ? { lastDelivered: false, deliverySuppressionReason: "silent" } : {};
  const job = makeJob({
    ...(error === undefined
      ? {}
      : {
          delivery: { mode: "webhook", to: "https://example.invalid/hook", bestEffort: false },
        }),
    state: {
      lastRunStatus: "ok",
      lastDeliveryStatus: deliveryStatus,
      lastDeliveryError: error,
      ...suppression,
    },
  });
  const { list, show } = renderJob(job);
  expectText(list, status);
  expectText(show, `status: ${status}`);
  if (error === undefined) {
    expect(list.join("\n")).not.toContain("ok (not delivered)");
    expectText(show, "last delivery: not-delivered", "last delivery suppression: silent");
  } else {
    expectText(show, `last delivery error: ${error}`);
  }
  expect(enrichCronJsonWithStatus(job)).toMatchObject({
    status: "ok",
    state: { lastRunStatus: "ok", lastDeliveryStatus: deliveryStatus, ...suppression },
  });
  expect(enrichCronJsonWithStatus({ jobs: [job] })).toMatchObject({ jobs: [{ status: "ok" }] });
});

it("shows why the scheduler auto-disabled a job without changing JSON status", () => {
  const disabledJob = (reason: "consecutive-failures" | "schedule-errors", count: number) =>
    makeJob({
      enabled: false,
      state: {
        autoDisabled: { reason, atMs: Date.now(), consecutiveErrors: count },
      },
    });
  const runFailures = disabledJob("consecutive-failures", 10);
  const scheduleErrors = disabledJob("schedule-errors", 3);

  expectText(renderList([runFailures, scheduleErrors]), "disabled (10x)", "disabled (schedule)");
  expectText(renderShow(runFailures), "status: disabled (10x)");

  expect(enrichCronJsonWithStatus(runFailures)).toMatchObject({
    status: "disabled",
    state: {
      autoDisabled: { reason: "consecutive-failures", consecutiveErrors: 10 },
    },
  });
});

it("shows dash for unset agentId instead of default", () => {
  const logs = renderList(makeJob({ agentId: undefined, sessionTarget: "isolated" }));
  expect(logs[0]).toContain("Agent ID");
  const dataLine = logs[1] ?? "";
  expect(dataLine).not.toContain("default");
});

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

it.each<[string, string | null, number?]>([
  ["+30m", "2026-05-25T00:30:00.000Z"],
  ["30m", "2026-05-25T00:30:00.000Z"],
  [String(Number.MAX_SAFE_INTEGER), null],
  ["+999999999999999999d", null],
  ["+1m", null, 8_640_000_000_000_000],
])("parses relative/epoch time %s", (input, expected, now) => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(now ?? "2026-05-25T00:00:00.000Z"));
  expect(parseAt(input)).toBe(expected);
});

it.each([
  { plugins: [], expected: "last|<channel-plugin-id>" },
  { plugins: [{ id: "quietchat" }, { id: "forum" }], expected: "last|quietchat|forum" },
])("lists channel options as $expected", ({ plugins, expected }) => {
  hoisted.listChannelPluginsMock.mockReturnValue(plugins);
  expect(getCronChannelOptions()).toBe(expected);
});

it.each([
  { input: "exec,read,write", expected: ["exec", "read", "write"] },
  { input: ["exec", "read", "write"], expected: ["exec", "read", "write"] },
  { input: undefined, expected: undefined },
])("parses cron tool list $input", ({ input, expected }) => {
  expect(parseCronStringList(input)).toEqual(expected);
});

it("keeps valid previews and drops malformed entries", () => {
  expect([
    ...coerceCronDeliveryPreviews({
      deliveryPreviews: {
        job1: { label: "announce -> telegram:123", detail: "explicit" },
        job2: { label: "announce -> telegram:456" },
      },
    }),
  ]).toEqual([["job1", { label: "announce -> telegram:123", detail: "explicit" }]]);
});

it.each([
  ["500ms", 500],
  ["30s", 30_000],
  ["1.5h", 5_400_000],
  ["1h30m", 5_400_000],
  ["1d", 86_400_000],
  ["0s", null],
  ["0.5ms", 1],
  ["0.001ms", null],
  ["-5s", null],
  ["abc", null],
  ["", null],
  // A finite mantissa can overflow when multiplied by a unit factor (#83906).
  [`1${"0".repeat(302)}d`, null],
  ["8640000000000000ms", 8_640_000_000_000_000],
  ["8640000000000001ms", null],
] as const)("parses bounded positive duration %j as %j", (input, expected) => {
  expect(parsePositiveCronDurationMs(input)).toBe(expected);
});

describe("handleCronCliError", () => {
  const missingJob = () =>
    new GatewayClientRequestError({
      code: "INVALID_REQUEST",
      message: "transport-neutral lookup miss",
      details: { code: "CRON_JOB_NOT_FOUND", jobId: "missing-job" },
    });
  const recovery =
    "Automation not found: missing-job. Run `openclaw cron list` to see recent automation ids.";
  it("renders typed automation lookup misses with the cron list recovery command", () => {
    const errorOutput = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(((code: number) => {
      throw new Error(`exit ${code}`);
    }) as never);

    expect(() => handleCronCliError(missingJob())).toThrow("exit 1");
    expect(errorOutput).toHaveBeenCalledWith(expect.stringContaining(recovery));
    errorOutput.mockRestore();
    exit.mockRestore();
  });

  it("hands a typed lookup miss to the root renderer as an expected machine-output failure", () => {
    const { thrown, json, stderr } = renderJsonError(
      missingJob(),
      ["cron", "show", "missing-job"],
      "",
      "Could not start the CLI.",
    );
    expect(thrown).toBeInstanceOf(ExpectedCliError);
    expect(json).toEqual({
      ok: false,
      error: { type: "cli_error", message: recovery },
    });
    expect(stderr).toContain(recovery);
    expect(stderr).not.toContain("Could not start the CLI.");
    expect(stderr).not.toContain("openclaw doctor");
    expect(stderr).not.toContain("OPENCLAW_DEBUG");
  });

  // A legacy gateway without cron.get makes `cron edit <id> --exact` wrap the
  // lookup miss; the renderer only reveals such causes on explicit debug intent.
  it.each([false, true])("wrapped cron failure with --debug=%s", (debug) => {
    const wrapped = new CronCliError("unknown automation id: missing-job", {
      cause: new Error("unknown method: cron.get"),
    });
    const { thrown, json, stderr } = renderJsonError(wrapped, [
      "cron",
      "edit",
      "missing-job",
      "--exact",
      ...(debug ? ["--debug"] : []),
    ]);
    expect(thrown).toBeInstanceOf(ExpectedCliError);
    const machineMessage = json.error.message;
    expect(machineMessage).toContain("unknown automation id: missing-job");
    expect(machineMessage.includes("unknown method: cron.get")).toBe(debug);
    expect(stderr).toContain("unknown automation id: missing-job");
    expect(stderr.includes("unknown method: cron.get")).toBe(debug);
  });

  it.each([false, true])("preserves unexpected machine-mode errors with debug=%s", (debug) => {
    const error = new Error("Automation runtime failed", {
      cause: new Error("Runtime load failed"),
    });
    const { thrown, json, stderr } = renderJsonError(
      error,
      ["automations", "status"],
      debug ? "1" : "",
    );
    expect(thrown).toBe(error);
    expect(stderr).toContain("The CLI command failed.");
    expect(stderr).toContain("openclaw doctor");
    expect(stderr.includes("Stack:")).toBe(debug);
    expect(json.error.message.includes("Runtime load failed")).toBe(debug);
  });
});
