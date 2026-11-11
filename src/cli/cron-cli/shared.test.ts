import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { visibleWidth } from "../../../packages/terminal-core/src/ansi.js";
import type { CronJob } from "../../cron/types.js";
import { GatewayClientRequestError } from "../../gateway/client.js";
import type { RuntimeEnv } from "../../runtime.js";
import { ExpectedCliError } from "../expected-cli-error.js";
import { formatCliFailureLines, formatCliJsonFailure } from "../failure-output.js";
import { CronCliError } from "./cron-cli-error.js";
import { resolveCronCreateScheduleFromArgs as createSchedule } from "./schedule-options.js";
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

const renderJob = (job: CronJob) => ({ list: renderList(job), show: renderShow(job) });
function renderList(job: CronJob | CronJob[], options?: Parameters<typeof printCronList>[2]) {
  return capture((runtime) => printCronList(Array.isArray(job) ? job : [job], runtime, options));
}
function renderShow(job: CronJob, options?: Parameters<typeof printCronShow>[2]) {
  return capture((runtime) => printCronShow(job, runtime, options));
}

function renderJsonError(error: unknown, args: string[], title = "The CLI command failed.") {
  const argv = process.argv;
  process.argv = [...argv.slice(0, 2), ...args, "--json"];
  vi.stubEnv("OPENCLAW_DEBUG", "");
  try {
    let thrown: unknown;
    try {
      handleCronCliError(error);
    } catch (caught) {
      thrown = caught;
    }
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

const unknownDelivery = {
  lastRunStatus: "ok",
  lastDeliveryStatus: "unknown",
  lastDeliveryError: "request timed out",
} as const;
const policyJob = (value: boolean) => ({
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
});
const policyText = (value: boolean) =>
  `policies: active hours=22:00-06:00 @ America/Los_Angeles; idle only=${value}; delivery target=owner; direct policy=block; skip if scratch empty=${value}; include reasoning=${value}`;
type RenderCase = {
  name: string;
  job: CronJob;
  list: string[];
  show: string[];
  privateText?: string;
  listNot?: string;
  json?: Record<string, unknown>;
};
it.each`
  name                              | job                                                                                                                                                                                                                                                                                       | list                                                                           | show                                                                                                                                                                    | privateText                     | json
  ${"declaration and run metadata"} | ${makeJob({ declarationKey: "daily-report", displayName: "Daily summary", owner: { agentId: "ops", sessionKey: "agent:ops:main" }, sessionTarget: "isolated", state: { lastRunStatus: "error", lastError: "boom", lastDeliveryStatus: "not-delivered", lastDeliveryError: "offline" } })} | ${["Declaration", "Owner", "daily-report", "Daily summary", "agent:ops:main"]} | ${["declaration: daily-report", "display name: Daily summary", "owner agent: ops", "last error: boom", "last delivery: not-delivered", "last delivery error: offline"]} | ${undefined}                    | ${undefined}
  ${"enabled policies"}             | ${policyJob(true)}                                                                                                                                                                                                                                                                        | ${[policyText(true)]}                                                          | ${[policyText(true)]}                                                                                                                                                   | ${"private checklist sentinel"} | ${undefined}
  ${"disabled policies"}            | ${policyJob(false)}                                                                                                                                                                                                                                                                       | ${[policyText(false)]}                                                         | ${[policyText(false)]}                                                                                                                                                  | ${"private checklist sentinel"} | ${undefined}
  ${"unknown delivery"}             | ${makeJob({ delivery: { mode: "webhook", to: "https://example.invalid/hook", bestEffort: false }, state: unknownDelivery })}                                                                                                                                                              | ${["delivery unknown"]}                                                        | ${["status: delivery unknown", "last delivery error: request timed out"]}                                                                                               | ${undefined}                    | ${{ status: "ok", state: unknownDelivery }}
`("renders $name in list and show", expectRendering);
function expectRendering({ job, list, show, privateText, listNot, json }: RenderCase) {
  const output = renderJob(job);
  expectText(output.list, ...list);
  expectText(output.show, ...show);
  if (privateText) {
    for (const lines of Object.values(output)) {
      expect(lines.join("\n")).not.toContain(privateText);
    }
  }
  if (listNot) {
    expect(output.list.join("\n")).not.toContain(listNot);
  }
  if (json) {
    expect(enrichCronJsonWithStatus(job)).toMatchObject(json);
    expect(enrichCronJsonWithStatus({ jobs: [job] })).toMatchObject({
      jobs: [{ status: json.status }],
    });
  }
}

const disabled = (reason: "consecutive-failures" | "schedule-errors", count: number) =>
  makeJob({
    enabled: false,
    state: { autoDisabled: { reason, atMs: Date.now(), consecutiveErrors: count } },
  });
it.each`
  name                                     | job                                                                                                                                                                                                                                       | list                                   | show                                                              | listNot      | json
  ${"extended ISO year"}                   | ${makeJob({ schedule: { kind: "at", at: "+010000-01-15T12:34:56.789Z" }, state: {} })}                                                                                                                                                    | ${["at +010000-01-15 12:34Z"]}         | ${[]}                                                             | ${undefined} | ${undefined}
  ${"invalid ISO time"}                    | ${makeJob({ schedule: { kind: "at", at: "not-a-time" }, state: {} })}                                                                                                                                                                     | ${["at -"]}                            | ${[]}                                                             | ${undefined} | ${undefined}
  ${"malformed row"}                       | ${{ id: "malformed-job", enabled: true } as unknown as CronJob}                                                                                                                                                                           | ${["malformed-job"]}                   | ${[]}                                                             | ${undefined} | ${undefined}
  ${"staggered cron"}                      | ${makeJob({ schedule: { kind: "cron", expr: "* * * * *", staggerMs: 1_001 }, state: {} })}                                                                                                                                                | ${["cron * * * * * (stagger 1s 1ms)"]} | ${["schedule: cron * * * * * (stagger 1s 1ms)"]}                  | ${undefined} | ${undefined}
  ${"exact cron"}                          | ${makeJob({ schedule: { kind: "cron", expr: "0 7 * * *", staggerMs: 0 }, state: {} })}                                                                                                                                                    | ${["cron 0 7 * * * (exact)"]}          | ${["schedule: cron 0 7 * * * (exact)"]}                           | ${undefined} | ${undefined}
  ${"interval with trigger"}               | ${makeJob({ schedule: { kind: "every", everyMs: 30_000 }, trigger: { script: "json({ fire: true })", once: true }, state: { triggerEvalCount: 4, lastTriggerEvalAtMs: Date.now() - 30_000, lastTriggerFireAtMs: Date.now() - 60_000 } })} | ${["every 30s+trigger"]}               | ${["schedule: every 30s+trigger", "trigger: once=yes; evals=4;"]} | ${undefined} | ${undefined}
  ${"stream with trigger"}                 | ${makeJob({ schedule: { kind: "stream", command: ["node", "events.mjs"] }, trigger: { script: "json({ fire: true })" }, state: {} })}                                                                                                     | ${["stream node events.mjs+trigger"]}  | ${["schedule: stream node events.mjs+trigger"]}                   | ${undefined} | ${undefined}
  ${"on-exit with cwd"}                    | ${makeJob({ schedule: { kind: "on-exit", command: "pnpm build", cwd: "/repo" }, state: {} })}                                                                                                                                             | ${["on-exit pnpm build @ /repo"]}      | ${["schedule: on-exit pnpm build @ /repo"]}                       | ${undefined} | ${undefined}
  ${"repeated errors"}                     | ${makeJob({ state: { lastRunStatus: "error", consecutiveErrors: 12, lastError: "boom" } })}                                                                                                                                               | ${["error (12x)"]}                     | ${[]}                                                             | ${undefined} | ${undefined}
  ${"single error"}                        | ${makeJob({ state: { lastRunStatus: "error", consecutiveErrors: 1, lastError: "boom" } })}                                                                                                                                                | ${["error"]}                           | ${[]}                                                             | ${"(1x)"}    | ${undefined}
  ${"bounded error count"}                 | ${makeJob({ state: { lastRunStatus: "error", consecutiveErrors: 1440, lastError: "boom" } })}                                                                                                                                             | ${["error (99+x)"]}                    | ${[]}                                                             | ${"1440"}    | ${undefined}
  ${"auto-disabled after run failures"}    | ${disabled("consecutive-failures", 10)}                                                                                                                                                                                                   | ${["disabled (10x)"]}                  | ${["status: disabled (10x)"]}                                     | ${undefined} | ${{ status: "disabled", state: { autoDisabled: { reason: "consecutive-failures", consecutiveErrors: 10 } } }}
  ${"auto-disabled after schedule errors"} | ${disabled("schedule-errors", 3)}                                                                                                                                                                                                         | ${["disabled (schedule)"]}             | ${[]}                                                             | ${undefined} | ${undefined}
`("renders $name", expectRendering);

it("sanitizes, truncates and aligns names and session targets by terminal width", () => {
  const prefix20 = "x".repeat(20);
  const injectedMarker = "cron-table-injection";
  const injectedControl = `\u001B]0;${injectedMarker}\u0007`;
  const cases = [
    { name: `${prefix20}🚀tail`, expected: `${prefix20}...` },
    { name: `${prefix20}👨‍👩‍👧‍👦`, expected: `${prefix20}👨‍👩‍👧‍👦` },
    { name: `${prefix20}${injectedControl}🚀tail`, expected: `${prefix20}...` },
  ];

  const jobs = cases.map(({ name }, index) =>
    makeJob({
      id: `unicode-name-${index}`,
      name,
      sessionTarget: `session:${prefix20}${injectedControl}`,
    }),
  );
  const logs = renderList(jobs, {
    deliveryPreviews: new Map(
      jobs.map(({ id }) => [id, { label: "target-delivery", detail: "destination" }]),
    ),
  });

  const header = logs[0] ?? "";
  const rows = logs.slice(1);
  const scheduleColumn = visibleWidth(header.slice(0, header.indexOf("Schedule")));
  const deliveryColumn = visibleWidth(header.slice(0, header.indexOf("Delivery")));
  expect(rows).toHaveLength(cases.length);
  for (const [index, row] of rows.entries()) {
    const scheduleIndex = row.indexOf("at ");
    expect(scheduleIndex).toBeGreaterThan(-1);
    expect(visibleWidth(row.slice(0, scheduleIndex))).toBe(scheduleColumn);
    expect(row).toContain(cases[index]?.expected);
    const deliveryIndex = row.indexOf("target-delivery");
    expect(deliveryIndex).toBeGreaterThan(-1);
    expect(visibleWidth(row.slice(0, deliveryIndex))).toBe(deliveryColumn);
    expect(row).toContain("sessio...");
  }
  const output = logs.join("\n");
  expect(Buffer.from(output, "utf8").toString("utf8")).toBe(output);
  expect(output).not.toContain("\uFFFD");
  expect(output).not.toContain(injectedMarker);
});

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

it.each([
  ["2027-02-28t24:00:00.000", "America/New_York", "2027-03-01T05:00:00.000Z"],
  ["2027-02-28t24:00:00+05:45", "Europe/Oslo", "2027-02-28T18:15:00.000Z"],
  ["2027-09-04t24:00", "America/Santiago", null],
])("interprets offsetless one-shot %s in %s", (input, timezone, expected) => {
  expect(parseAt(input, timezone)).toBe(expected);
  if (expected !== null) {
    expect(createSchedule({ at: input, tz: timezone })).toEqual({
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
  ["1h30m", 5_400_000],
  ["0s", null],
  ["0.5ms", 1],
  ["0.001ms", null],
  ["abc", null],
  // A finite mantissa can overflow when multiplied by a unit factor (#83906).
  [`1${"0".repeat(302)}d`, null],
  ["8640000000000000ms", 8_640_000_000_000_000],
  ["8640000000000001ms", null],
] as const)("parses bounded positive duration %j as %j", (input, expected) => {
  expect(parsePositiveCronDurationMs(input)).toBe(expected);
});

describe("handleCronCliError", () => {
  const recovery =
    "Automation not found: missing-job. Run `openclaw cron list` to see recent automation ids.";
  const missingJob = () =>
    new GatewayClientRequestError({
      code: "INVALID_REQUEST",
      message: "transport-neutral lookup miss",
      details: { code: "CRON_JOB_NOT_FOUND", jobId: "missing-job" },
    });
  it("renders typed lookup misses as expected machine failures", () => {
    const { thrown, json, stderr } = renderJsonError(
      missingJob(),
      ["cron", "show", "missing-job"],
      "Could not start the CLI.",
    );
    expect(thrown).toBeInstanceOf(ExpectedCliError);
    expect(json).toEqual({ ok: false, error: { type: "cli_error", message: recovery } });
    expect(stderr).toContain(recovery);
    for (const forbidden of ["Could not start the CLI.", "openclaw doctor", "OPENCLAW_DEBUG"]) {
      expect(stderr).not.toContain(forbidden);
    }
  });
  it.each([false, true])("keeps wrapped cron diagnostics behind --debug=%s", (debug) => {
    const message = "unknown automation id: missing-job";
    const cause = "unknown method: cron.get";
    const error = new CronCliError(message, { cause: new Error(cause) });
    const { thrown, json, stderr } = renderJsonError(error, [
      "cron",
      "edit",
      "missing-job",
      "--exact",
      ...(debug ? ["--debug"] : []),
    ]);
    expect(thrown).toBeInstanceOf(ExpectedCliError);
    for (const text of [json.error.message, stderr]) {
      expect(text).toContain(message);
      expect(text.includes(cause)).toBe(debug);
    }
  });
  it("leaves unexpected machine errors to the root renderer", () => {
    const error = new Error("Automation runtime failed", {
      cause: new Error("Runtime load failed"),
    });
    expect(renderJsonError(error, ["automations", "status"]).thrown).toBe(error);
  });
});
