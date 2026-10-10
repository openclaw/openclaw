import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CronDeliveryPreview, CronJob, CronJobCreate, CronJobPatch } from "../cron/types.js";
import { ExitError } from "../runtime.js";
import { registerCronCli } from "./cron-cli.js";

const mocks = vi.hoisted(() => {
  const defaultRuntime = {
    log: vi.fn(),
    error: vi.fn(),
    writeStdout: vi.fn<(value: string) => void>(),
    writeJson: vi.fn((value: unknown, space = 2) => {
      defaultRuntime.writeStdout(JSON.stringify(value, null, space > 0 ? space : undefined));
    }),
    exit: vi.fn((code: number) => {
      throw new Error(`__exit__:${code}`);
    }),
  };
  return {
    defaultRuntime,
    callGatewayFromCli: vi.fn(),
  };
});

const { defaultRuntime, callGatewayFromCli } = mocks;

const defaultGatewayMock = async (method: string, _opts: unknown, params?: unknown) => {
  if (method === "cron.status") {
    return { enabled: true };
  }
  if (method === "cron.list") {
    return cronPage([]);
  }
  return { ok: true, params };
};
callGatewayFromCli.mockImplementation(defaultGatewayMock);

afterEach(() => {
  vi.useRealTimers();
});

vi.mock("./gateway-rpc.js", async () => {
  const actual = await vi.importActual<typeof import("./gateway-rpc.js")>("./gateway-rpc.js");
  return {
    ...actual,
    callGatewayFromCli: (method: string, opts: unknown, params?: unknown, extra?: unknown) =>
      mocks.callGatewayFromCli(method, opts, params, extra as number | undefined),
  };
});

vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime.js")>()),
  defaultRuntime: mocks.defaultRuntime,
}));

function buildProgram() {
  const program = new Command().enablePositionalOptions().exitOverride();
  registerCronCli(program);
  return program;
}

function resetGatewayMock() {
  callGatewayFromCli.mockClear();
  callGatewayFromCli.mockImplementation(defaultGatewayMock);
  defaultRuntime.log.mockClear();
  defaultRuntime.error.mockClear();
  defaultRuntime.writeStdout.mockClear();
  defaultRuntime.writeJson.mockClear();
  defaultRuntime.exit.mockClear();
}

function stdoutText(): string {
  return defaultRuntime.writeStdout.mock.calls.map(([value]) => value).join("\n");
}

function expectRuntimeErrorContaining(text: string): void {
  expect(defaultRuntime.error.mock.calls.flat().join("\n")).toContain(text);
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Test helper lets each assertion ascribe expected RPC params.
function rpcParams<T>(method: string): T {
  return callGatewayFromCli.mock.calls.find(([name]) => name === method)?.[2] as T;
}

async function runCronCommand(args: string[]): Promise<void> {
  resetGatewayMock();
  await buildProgram().parseAsync(args, { from: "user" });
}

const CREATE = ["cron", "add", "--name", "job"];
const ADD = [...CREATE, "--cron", "* * * * *"];
const EDIT = ["cron", "edit", "job-1"];
const RUN_WAIT = ["cron", "run", "job-1", "--wait"];
const AGENT_ADD = [...ADD, "--message", "hello"];
const EVENT_ADD = [...ADD, "--system-event", "tick"];

async function add(...args: string[]): Promise<CronJobCreate> {
  await runCronCommand(["cron", "add", ...args]);
  return rpcParams("cron.add");
}

async function namedAdd(...args: string[]): Promise<CronJobCreate> {
  return add(...ADD.slice(2), ...args);
}

async function edit(...args: string[]): Promise<CronJobPatch> {
  await runCronCommand([...EDIT, ...args]);
  return rpcParams<{ patch: CronJobPatch }>("cron.update").patch;
}

async function expectCronCommandExit(args: string[]): Promise<void> {
  await expect(runCronCommand(args)).rejects.toMatchObject({ name: "ExitError", code: 1 });
}

function createCronJob(id: string, name: string): CronJob {
  const now = Date.now();
  return {
    id,
    name,
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: { kind: "at", at: new Date(now + 3_600_000).toISOString() },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "hello" },
    state: {},
  };
}

function mockExistingJob(job: Partial<CronJob>): void {
  resetGatewayMock();
  callGatewayFromCli.mockImplementation(async (method: string, opts: unknown, params?: unknown) =>
    method === "cron.get"
      ? { ...createCronJob("job-1", "Existing"), ...job }
      : await defaultGatewayMock(method, opts, params),
  );
}

async function editSchedule(
  schedule: CronJob["schedule"],
  ...args: string[]
): Promise<CronJobPatch> {
  mockExistingJob({ schedule });
  await buildProgram().parseAsync([...EDIT, ...args], { from: "user" });
  return rpcParams<{ patch: CronJobPatch }>("cron.update").patch;
}

async function runCronRunAndCaptureExit(params: {
  ran?: boolean;
  enqueued?: boolean;
  runId?: string;
  runStatus?: "ok" | "error" | "skipped";
  runStatuses?: Array<"ok" | "error" | "skipped" | undefined>;
  completionStatus?: "succeeded" | "failed" | "unknown";
  expectedError?: string;
  args?: string[];
}) {
  resetGatewayMock();
  let runPollCount = 0;
  callGatewayFromCli.mockImplementation(
    async (method: string, _opts: unknown, callParams?: unknown) => {
      if (method === "cron.run") {
        return {
          ok: true,
          params: callParams,
          ran: params.ran,
          enqueued: params.enqueued,
          runId: params.runId,
        };
      }
      if (method === "cron.runs") {
        const runStatus = params.runStatuses?.[runPollCount] ?? params.runStatus;
        runPollCount += 1;
        return {
          entries: runStatus
            ? [
                {
                  status: runStatus,
                  completionStatus: params.completionStatus,
                  ...(params.completionStatus === undefined && runStatus === "ok"
                    ? { deliveryStatus: "not-requested" }
                    : {}),
                },
              ]
            : [],
        };
      }
      return { ok: true, params: callParams };
    },
  );

  let exitCode: number | undefined;
  try {
    await buildProgram().parseAsync(params.args ?? ["cron", "run", "job-1"], { from: "user" });
  } catch (error) {
    if (!(error instanceof ExitError)) {
      throw error;
    }
    exitCode = error.code;
  }
  if (params.expectedError) {
    expectRuntimeErrorContaining(params.expectedError);
  } else {
    expect(defaultRuntime.error).not.toHaveBeenCalled();
  }
  const runCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.run");
  return {
    exitCode,
    runOpts: (runCall?.[1] ?? {}) as { timeout?: string },
    calls: callGatewayFromCli.mock.calls,
  };
}

function flags(options: Record<string, string | true>): string[] {
  return Object.entries(options).flatMap(([flag, value]) =>
    value === true ? [flag] : [flag, value],
  );
}

function cronPage(
  jobs: CronJob[],
  offset = 0,
  total = jobs.length,
  deliveryPreviews?: Record<string, CronDeliveryPreview>,
) {
  const next = offset + jobs.length;
  return {
    jobs,
    snapshotRevision: "test-stable-cron-inventory",
    total,
    offset,
    limit: 200,
    hasMore: next < total,
    nextOffset: next < total ? next : null,
    deliveryPreviews,
  };
}

describe("cron cli", () => {
  it.each([
    { leaf: ["--port", "65268", "--token", "leaf-token"], port: "65268", token: "leaf-token" },
  ])("resolves Gateway options with leaf overrides $leaf", async ({ leaf, port, token }) => {
    await runCronCommand([
      "automations",
      "--port",
      "65267",
      "--token",
      "parent-token",
      "create",
      "--name",
      "job",
      "--cron",
      "* * * * *",
      "--message",
      "hello",
      ...leaf,
    ]);
    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "cron.add",
      expect.objectContaining({ port, token }),
      expect.anything(),
      undefined,
    );
  });

  it.each([
    {
      name: "exits 0 for cron run when job is queued successfully",
      enqueued: true,
      expectedExitCode: 0,
    },
    {
      name: "exits 1 for cron run when job does not execute",
      ran: false,
      expectedExitCode: 1,
    },
  ])("$name", async ({ ran, enqueued, expectedExitCode }) => {
    const { exitCode } = await runCronRunAndCaptureExit({ ran, enqueued });
    expect(exitCode).toBe(expectedExitCode);
  });

  it("waits for stored failed completion", async () => {
    const { calls, exitCode } = await runCronRunAndCaptureExit({
      enqueued: true,
      runId: "manual:job-1:123:0",
      runStatus: "ok",
      completionStatus: "failed",
      args: [...RUN_WAIT, "--wait-timeout", "1s", "--poll-interval", "1ms"],
    });
    expect(exitCode).toBe(1);
    expect(rpcParams("cron.runs")).toEqual({
      id: "job-1",
      runId: "manual:job-1:123:0",
      limit: 1,
    });
    expect(JSON.parse(stdoutText())).toMatchObject({
      completed: true,
      status: "ok",
      completionStatus: "failed",
    });
    expect(calls.some(([method]) => method === "cron.get")).toBe(false);
  });

  it("reduces each history RPC timeout after the system clock jumps backward", async () => {
    vi.useFakeTimers();
    const monotonicNow = performance.now.bind(performance);
    let monotonicSample = 0;
    vi.spyOn(performance, "now").mockImplementation(
      () => monotonicNow() + ++monotonicSample / 1_000,
    );
    const startedAt = new Date("2026-07-27T12:00:00.000Z");
    vi.setSystemTime(startedAt);

    const pendingRun = runCronRunAndCaptureExit({
      enqueued: true,
      runId: "manual:job-1:123:0",
      runStatuses: [undefined, "ok"],
      args: [...RUN_WAIT, "--wait-timeout", "100ms", "--poll-interval", "25ms"],
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(callGatewayFromCli.mock.calls.filter(([method]) => method === "cron.runs")).toHaveLength(
      1,
    );
    vi.setSystemTime(new Date(startedAt.getTime() - 3_600_000));
    await vi.advanceTimersByTimeAsync(25);

    const { calls, exitCode, runOpts } = await pendingRun;
    const pollTimeouts = calls
      .filter(([method]) => method === "cron.runs")
      .map(([, options]) => Number((options as { timeout?: string }).timeout));

    expect(exitCode).toBe(0);
    expect(runOpts.timeout).toBe("600000");
    expect(pollTimeouts).toHaveLength(2);
    expect(pollTimeouts.every(Number.isSafeInteger)).toBe(true);
    expect(pollTimeouts[0]).toBeLessThanOrEqual(100);
    expect(pollTimeouts[1]).toBeLessThanOrEqual(75);
    expect(pollTimeouts[1]).toBeLessThan(pollTimeouts[0] ?? 0);
  });

  it("bounds oversized poll intervals by the wait timeout", async () => {
    vi.useFakeTimers();
    const run = runCronRunAndCaptureExit({
      enqueued: true,
      runId: "manual:job-1:123:0",
      args: [...RUN_WAIT, "--wait-timeout", "10ms", "--poll-interval", "999999999999999ms"],
      expectedError: "timed out waiting for cron run",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(callGatewayFromCli.mock.calls.some(([method]) => method === "cron.runs")).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    expect((await run).exitCode).toBe(1);
  });

  it.each([
    ["rm", "cron.remove"],
    ["scratch", "cron.scratch.get"],
    ["runs", "cron.runs"],
  ])("preserves canonical lookup errors for %s", async (command, method) => {
    resetGatewayMock();
    callGatewayFromCli.mockRejectedValueOnce(
      Object.assign(new Error("gateway cron lookup failed"), {
        details: { code: "CRON_JOB_NOT_FOUND", jobId: "missing" },
      }),
    );
    await expect(
      buildProgram().parseAsync(["cron", command, "missing"], { from: "user" }),
    ).rejects.toMatchObject({ name: "ExitError", code: 1 });
    expect(callGatewayFromCli.mock.calls[0]?.[0]).toBe(method);
    expectRuntimeErrorContaining(
      "Automation not found: missing. Run `openclaw cron list` to see recent automation ids.",
    );
  });

  it("composes run-history IDs, Gateway options, filters, and JSON output", async () => {
    await runCronCommand([
      "automations",
      "--port",
      "65267",
      "runs",
      "job-1",
      "--id",
      "job-1",
      "--limit",
      "5",
      "--run-id",
      "run-1",
      "--json",
    ]);
    const call = callGatewayFromCli.mock.calls.find(([method]) => method === "cron.runs");
    expect(call?.[1]).toMatchObject({ port: "65267" });
    expect(call?.[2]).toEqual({ id: "job-1", runId: "run-1", limit: 5 });
    expect(defaultRuntime.writeJson).toHaveBeenCalledOnce();
  });

  it.each([["disable", false]] as const)("sets enabled with %s", async (command, enabled) => {
    await runCronCommand(["cron", command, "job-1"]);
    expect(rpcParams("cron.update")).toEqual({ id: "job-1", patch: { enabled } });
  });

  it.each([
    {
      args: ["--agent", " Ops "],
      expected: { includeDisabled: false, agentId: "ops", limit: 200, offset: 0 },
    },
  ])("lists jobs with agent filter $args", async ({ args, expected }) => {
    await runCronCommand(["cron", "list", ...args]);
    expect(rpcParams("cron.list")).toEqual(expected);
  });

  it("paginates cron show lookups", async () => {
    resetGatewayMock();
    callGatewayFromCli.mockImplementation(
      async (method: string, _opts: unknown, params?: unknown) => {
        if (method === "cron.list") {
          const offset = (params as { offset?: number }).offset ?? 0;
          if (offset === 0) {
            return cronPage(
              Array.from({ length: 200 }, (_, index) =>
                createCronJob(`first-page-${index}`, `First Page ${index}`),
              ),
              0,
              201,
            );
          }
          const targetJob = createCronJob("target-job", "Target Job");
          targetJob.state.lastDiagnosticSummary = "exec stderr tail";
          return cronPage([targetJob], 200, 201, {
            "target-job": {
              label: "announce -> telegram:-100",
              detail: "resolved from last, main session",
            },
          });
        }
        return { ok: true, params };
      },
    );

    await buildProgram().parseAsync(["cron", "show", "Target Job"], { from: "user" });

    const listParams = callGatewayFromCli.mock.calls
      .filter((call) => call[0] === "cron.list")
      .map((call) => call[2]);
    expect(listParams).toEqual([
      { includeDisabled: true, limit: 200, offset: 0 },
      { includeDisabled: true, limit: 200, offset: 200 },
    ]);
    expect(defaultRuntime.log).toHaveBeenCalledWith("id: target-job");
    expect(defaultRuntime.log).toHaveBeenCalledWith(
      "delivery: announce -> telegram:-100 (resolved from last, main session)",
    );
    expect(defaultRuntime.log).toHaveBeenCalledWith("diagnostic: exec stderr tail");
  });

  it("creates a configured agent job from a positional cron schedule and prompt", async () => {
    const params = await add(
      "0 2 * * *",
      "hello",
      ...flags({
        "--name": "job",
        "--agent": " Ops ",
        "--session": "SESSION:agent:ops:telegram:group:-100123:topic:42",
        "--model": "  opus  ",
        "--thinking": "  low  ",
        "--light-context": true,
        "--fallbacks": "openrouter/gpt-4.1-mini openai/gpt-5",
        "--tools": "read write",
        "--timeout-seconds": "0",
        "--stagger": "45s",
        "--deliver": true,
        "--channel": "telegram",
        "--to": "-100123",
        "--thread-id": " 42 ",
        "--account": "  coordinator  ",
      }),
    );
    expect(params).toMatchObject({
      name: "job",
      agentId: "ops",
      sessionTarget: "session:agent:ops:telegram:group:-100123:topic:42",
      schedule: { kind: "cron", expr: "0 2 * * *", staggerMs: 45_000 },
      payload: {
        kind: "agentTurn",
        message: "hello",
        model: "opus",
        thinking: "low",
        lightContext: true,
        fallbacks: ["openrouter/gpt-4.1-mini", "openai/gpt-5"],
        timeoutSeconds: 0,
        toolsAllow: ["read", "write"],
      },
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "-100123",
        threadId: 42,
        accountId: "coordinator",
      },
    });
    expect(defaultRuntime.error).not.toHaveBeenCalled();
  });

  it("keeps the default-agent warning off JSON stdout and preserves an empty tool grant", async () => {
    const params = await namedAdd("--message", "hello", "--tools", "", "--json");
    expect(params).toMatchObject({
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "hello", toolsAllow: [] },
    });
    expect(params.payload).toHaveProperty("timeoutSeconds", undefined);
    expectRuntimeErrorContaining("No --agent specified");
    expectRuntimeErrorContaining("configured default agent");
    expect(stdoutText()).not.toContain("No --agent specified");
    expect(JSON.parse(stdoutText())).toMatchObject({
      ok: true,
      params: { name: "job", payload: { message: "hello" } },
    });
  });

  it("creates a one-shot webhook system event with an explicit keep policy", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-25T00:00:00.000Z"));
    const params = await add(
      "Reminder",
      "--at",
      "+30m",
      "--system-event",
      "hi",
      "--webhook",
      " https://example.invalid/openclaw ",
      "--keep-after-run",
    );
    expect(params).toMatchObject({
      name: "Reminder",
      sessionTarget: "main",
      deleteAfterRun: false,
      schedule: { kind: "at", at: "2026-05-25T00:30:00.000Z" },
      payload: { kind: "systemEvent", text: "hi" },
    });
    expect(params.delivery).toEqual({
      mode: "webhook",
      to: "https://example.invalid/openclaw",
      channel: undefined,
      threadId: undefined,
      accountId: undefined,
      bestEffort: undefined,
    });
    expect(defaultRuntime.error).not.toHaveBeenCalled();
  });

  it("creates exact system events with a tool allowlist", async () => {
    expect(
      await namedAdd("--system-event", "tick", "--exact", "--tools", "read,write"),
    ).toMatchObject({
      sessionTarget: "main",
      schedule: { kind: "cron", staggerMs: 0 },
      payload: { kind: "systemEvent", text: "tick", toolsAllow: ["read", "write"] },
    });
  });

  it("accepts a positional every interval without delivery", async () => {
    expect(await add("every 1h", "summary", "--name", "job", "--no-deliver")).toMatchObject({
      schedule: { kind: "every", everyMs: 3_600_000 },
      payload: { kind: "agentTurn", message: "summary" },
      delivery: { mode: "none" },
    });
  });

  it("creates a shell command with limits and environment overrides", async () => {
    const params = await add(
      ...flags({
        "--name": "job",
        "--every": "10m",
        "--command": "echo ok",
        "--command-cwd": "/srv/app",
        "--command-env": "FOO=bar",
        "--timeout-seconds": "0",
        "--no-output-timeout-seconds": "5",
        "--output-max-bytes": "4096",
        "--tools": "read write",
        "--no-deliver": true,
      }),
    );
    expect(params).toMatchObject({
      sessionTarget: "isolated",
      delivery: { mode: "none" },
      payload: {
        kind: "command",
        argv: ["sh", "-lc", "echo ok"],
        cwd: "/srv/app",
        env: { FOO: "bar" },
        timeoutSeconds: 0,
        noOutputTimeoutSeconds: 5,
        outputMaxBytes: 4096,
        toolsAllow: ["read", "write"],
      },
    });
    expect(defaultRuntime.error).not.toHaveBeenCalled();
  });

  it("creates stream schedules from exact argv flags", async () => {
    expect(
      await add(
        ...flags({
          "--name": "events",
          "--stream-command": '["node","events.mjs"]',
          "--stream-cwd": "/srv/app",
          "--stream-mode": "match",
          "--stream-match": "^ready:",
          "--stream-batch-ms": "100",
          "--stream-max-batch-bytes": "2048",
          "--message": "handle events",
          "--session": "isolated",
        }),
      ),
    ).toHaveProperty("schedule", {
      kind: "stream",
      command: ["node", "events.mjs"],
      cwd: "/srv/app",
      mode: "match",
      match: "^ready:",
      batchMs: 100,
      maxBatchBytes: 2_048,
    });
  });

  it("updates configured agent payload fields", async () => {
    const patch = await edit(
      ...flags({
        "--message": "hello",
        "--model": "  opus  ",
        "--thinking": "  high  ",
        "--fallbacks": "openrouter/gpt-4.1-mini,openai/gpt-5",
        "--tools": "exec read write",
        "--light-context": true,
        "--timeout-seconds": "0",
      }),
    );
    expect(patch.payload).toEqual({
      kind: "agentTurn",
      message: "hello",
      model: "opus",
      thinking: "high",
      fallbacks: ["openrouter/gpt-4.1-mini", "openai/gpt-5"],
      toolsAllow: ["exec", "read", "write"],
      lightContext: true,
      timeoutSeconds: 0,
    });
    expect(patch).not.toHaveProperty("delivery");
  });

  it("sets and clears agent routing", async () => {
    expect(await edit("--agent", " Ops ", "--session", "SESSION:Project-Alpha")).toEqual({
      agentId: "ops",
      sessionTarget: "session:Project-Alpha",
    });
    expect(await edit("--clear-agent")).toEqual({ agentId: null });
  });

  it("preserves the stored command kind on timeout-only edits", async () => {
    mockExistingJob({ payload: { kind: "command", argv: ["sh", "-lc", "echo ok"] } });
    await buildProgram().parseAsync([...EDIT, "--timeout-seconds", "120"], { from: "user" });
    expect(rpcParams("cron.update")).toEqual({
      id: "job-1",
      patch: { payload: { kind: "command", timeoutSeconds: 120 } },
    });
    expect(rpcParams("cron.get")).toEqual({ id: "job-1" });
    expect(callGatewayFromCli.mock.calls.some(([method]) => method === "cron.list")).toBe(false);
  });

  it("retargets Telegram delivery without replacing the payload", async () => {
    expect(
      await edit(
        "--deliver",
        "--channel",
        "telegram",
        "--to",
        "-100123",
        "--thread-id",
        "42",
        "--account",
        "  coordinator  ",
      ),
    ).toEqual({
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "-100123",
        threadId: 42,
        accountId: "coordinator",
      },
    });
  });

  it.each([
    { args: ["--no-deliver"], delivery: { mode: "none" } },
    {
      args: ["--webhook", " https://example.invalid/cron ", "--best-effort-deliver"],
      delivery: { mode: "webhook", to: "https://example.invalid/cron", bestEffort: true },
    },
  ])("edits only requested delivery fields for $args", async ({ args, delivery }) => {
    expect(await edit(...args)).toEqual({ delivery });
  });

  it("implies announcement when enabling best-effort on a message edit", async () => {
    expect(await edit("--message", "hello", "--best-effort-deliver")).toEqual({
      payload: { kind: "agentTurn", message: "hello" },
      delivery: { mode: "announce", bestEffort: true },
    });
  });

  it("patches failure-alert settings", async () => {
    expect(
      await edit(
        ...flags({
          "--failure-alert-after": "3",
          "--failure-alert-cooldown": "1h",
          "--failure-alert-channel": "telegram",
          "--failure-alert-to": "19098680",
          "--failure-alert-mode": "webhook",
          "--failure-alert-account-id": "bot-a",
          "--failure-alert-include-skipped": true,
        }),
      ),
    ).toEqual({
      failureAlert: {
        after: 3,
        cooldownMs: 3_600_000,
        channel: "telegram",
        to: "19098680",
        mode: "webhook",
        accountId: "bot-a",
        includeSkipped: true,
      },
    });
  });

  it("disables failure alerts", async () => {
    expect(await edit("--no-failure-alert")).toEqual({ failureAlert: false });
  });

  it.each([
    ["+002027-01-15T12:00:00+02:00", "America/New_York", "2027-01-15T10:00:00.000Z"],
  ] as const)("normalizes one-shot creation %s in %s", async (at, tz, expected) => {
    const params = await add("--name", "job", "--at", at, "--message", "hello", "--tz", tz);
    expect(params.schedule).toEqual({ kind: "at", at: expected });
  });

  it("converts to a zoned one-shot with keep-after-run", async () => {
    const patch = await edit(
      "--at",
      "+002027-01-15T12:00:00",
      "--tz",
      "America/New_York",
      "--keep-after-run",
    );
    expect(patch).toEqual({
      schedule: { kind: "at", at: "2027-01-15T17:00:00.000Z" },
      deleteAfterRun: false,
    });
  });

  it("replaces a cron expression and stagger while retaining its timezone", async () => {
    expect(
      await editSchedule(
        { kind: "cron", expr: "0 */2 * * *", tz: "UTC", staggerMs: 300_000 },
        "--cron",
        "0 * * * *",
        "--stagger",
        "30s",
      ),
    ).toEqual({ schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC", staggerMs: 30_000 } });
  });

  it.each([
    { args: ["--stream-match", "^updated:"], match: "^updated:" },
    { args: ["--stream-mode", "match"], match: "^ready:" },
  ])("merges stream replacement metadata $args", async ({ args, match }) => {
    expect(
      await editSchedule(
        { kind: "stream", command: ["node", "events.mjs"], mode: "match", match: "^ready:" },
        "--stream-command",
        '["node","replacement.mjs"]',
        ...args,
      ),
    ).toMatchObject({
      schedule: { kind: "stream", command: ["node", "replacement.mjs"], mode: "match", match },
    });
  });

  it("applies exact mode without replacing the cron expression", async () => {
    expect(
      await editSchedule(
        { kind: "cron", expr: "0 */2 * * *", tz: "UTC", staggerMs: 300_000 },
        "--exact",
      ),
    ).toEqual({ schedule: { kind: "cron", expr: "0 */2 * * *", tz: "UTC", staggerMs: 0 } });
    expect(rpcParams("cron.get")).toEqual({ id: "job-1" });
    expect(callGatewayFromCli.mock.calls.some(([method]) => method === "cron.list")).toBe(false);
  });

  it("rejects exact mode for stored non-cron schedules", async () => {
    mockExistingJob({ schedule: { kind: "every", everyMs: 60_000 } });
    await expect(
      buildProgram().parseAsync([...EDIT, "--exact"], { from: "user" }),
    ).rejects.toMatchObject({ name: "ExitError", code: 1 });
    expectRuntimeErrorContaining("Current job is not a cron schedule");
  });

  it.each([
    { args: [...AGENT_ADD, "--script", "   "], error: "--script must not be blank" },
    {
      args: [...AGENT_ADD, "--webhook", "not-a-url"],
      error: "--webhook must be a valid http(s) URL",
    },
    {
      args: ["cron", "create", "0 2 * * *", "Positional", "--name", "job", "--message", "Option"],
      error: "Pass the automation message either positionally or with --message",
    },
    {
      args: [...ADD, "Positional", "--system-event", "tick"],
      error: "Pass the automation name either positionally or with --name",
    },
    {
      args: [...AGENT_ADD, "--webhook", "https://example.invalid/cron", "--to", "channel:C123"],
      error: "--webhook cannot be combined with chat delivery options",
    },
    { args: [...AGENT_ADD, "--command", "echo ok"], error: "Choose exactly one payload" },
    {
      args: [...ADD, "--session", "main", "--system-event", "tick", "--thread-id", "42"],
      error: "require a non-main agentTurn, command, or script job with delivery",
    },
    {
      args: [...AGENT_ADD, "--thread-id", "topic-42"],
      error: "--thread-id must be a positive integer",
    },
    { args: ["cron", "list", "--agent", "   "], error: "--agent must not be blank" },
    {
      args: ["cron", "runs", "--id", "job-1", "--run-id", "   "],
      error: "--run-id must not be blank",
    },
    {
      args: ["cron", "runs", "job-1", "--id", "job-2"],
      error: 'Conflicting job ids: positional "job-1" and --id "job-2".',
    },
    { args: ["cron", "show", "   "], error: "Missing job id" },
    {
      args: ["cron", "run", "job-1", "--wait", "--poll-interval", "0ms"],
      error: "invalid --poll-interval",
    },
    {
      args: [...EVENT_ADD, "--stagger", "1m", "--exact"],
      error: "Choose either --stagger or --exact",
    },
    {
      args: [...CREATE, "--every", "10m", "--stagger", "30s", "--system-event", "tick"],
      error: "--stagger/--exact are only valid for cron schedules",
    },
    {
      args: [...CREATE, "--every", "10m", "--tz", "UTC", "--system-event", "tick"],
      error: "--tz is only valid with --cron or offset-less --at",
    },
    {
      args: [
        ...CREATE,
        "--at",
        "2027-09-04T24:00:00",
        "--tz",
        "America/Santiago",
        "--message",
        "hello",
      ],
      error: "Invalid --at",
    },
    {
      args: [...EDIT, "--webhook", "https://example.invalid/cron", "--announce"],
      error: "Choose at most one of --announce, --no-deliver, or --webhook",
    },
    { args: [...EDIT, "--failure-alert-after", "3x"], error: "Invalid --failure-alert-after" },
    {
      args: [...EDIT, "--failure-alert-include-skipped", "--failure-alert-exclude-skipped"],
      error: "Use either --failure-alert-include-skipped",
    },
  ])("rejects $args before Gateway access", async ({ args, error }) => {
    await expectCronCommandExit(args);
    expectRuntimeErrorContaining(error);
    expect(callGatewayFromCli).not.toHaveBeenCalled();
  });
});
