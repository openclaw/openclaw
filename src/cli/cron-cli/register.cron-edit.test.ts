import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { defaultRuntime } from "../../runtime.js";
import { ExpectedCliError, formatCliJsonFailure } from "../failure-output.js";

const callGatewayFromCli = vi.fn();
vi.mock("../gateway-rpc.js", async () => {
  const actual = await vi.importActual<typeof import("../gateway-rpc.js")>("../gateway-rpc.js");
  return {
    ...actual,
    callGatewayFromCli: (...args: Parameters<typeof actual.callGatewayFromCli>) =>
      callGatewayFromCli(...args),
  };
});
const { registerCronAddCommand } = await import("./register.cron-add.js");
const { registerCronEditCommand } = await import("./register.cron-edit.js");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function run(args: readonly string[]) {
  const program = new Command().exitOverride();
  registerCronAddCommand(program);
  registerCronEditCommand(program);
  await program.parseAsync([...args], { from: "user" });
}
const edit = (args: readonly string[]) => run(["edit", "job-1", ...args]);
const addArgs = ["add", "--name", "fixture", "--agent", "main"];
function existing(job: Record<string, unknown>) {
  callGatewayFromCli.mockImplementation(async (method: string) =>
    method === "cron.get" ? { id: "job-1", ...job } : { ok: true },
  );
}
function expectPatch(patch: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  expect(callGatewayFromCli).toHaveBeenCalledWith("cron.update", expect.anything(), {
    id: "job-1",
    patch,
    ...extra,
  });
}
async function reject(args: readonly string[], message: string, reads: string[] = []) {
  await expect(run(args)).rejects.toMatchObject({ name: "ExitError", code: 1 });
  expect(defaultRuntime.error).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(message));
  expect(callGatewayFromCli.mock.calls.map(([method]) => method)).toEqual(reads);
}

beforeEach(() => {
  callGatewayFromCli.mockReset().mockResolvedValue({ ok: true });
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("cron edit", () => {
  it.each([
    [["--enable", "--json"], { enabled: true }],
    [["--display-name", "Daily summary"], { displayName: "Daily summary" }],
    [["--clear-display-name"], { displayName: null }],
    [["--clear-model"], { payload: { kind: "agentTurn", model: null } }],
    [["--clear-thinking"], { payload: { kind: "agentTurn", thinking: null } }],
    [["--command-input", ""], { payload: { kind: "command", input: "" } }],
    [["--script-timeout-seconds", "20"], { payload: { kind: "script", timeoutSeconds: 20 } }],
    [["--name", "Renamed"], { name: "Renamed" }],
  ] as const)("sends only the requested patch for %j", async (args, patch) => {
    await edit(args);
    expectPatch(patch);
  });

  it.each([
    [
      ["--display-name", "Daily summary", "--clear-display-name"],
      "Use --display-name or --clear-display-name",
    ],
    [["--trigger-script", "", "--clear-trigger"], "--trigger-script must not be blank"],
    [["--script", " ", "--pacing-min", "30m"], "--script must not be blank"],
    [["--session", "main", "--message", "resume"], 'sessionTarget "main" requires'],
    [
      ["--session", "current", "--system-event", "resume"],
      'sessionTarget "current" cannot run systemEvent: systemEvent only runs in the main session',
    ],
    [
      ["--session", "session:agent:main:conversation", "--script", "missing.js"],
      'sessionTarget "session:agent:main:conversation" cannot run script payloads',
    ],
    [["--tools", "", "--clear-tools", "--pacing-min", "30m"], "Use --tools or --clear-tools"],
    [["--agent", "main", "--clear-agent"], "Use --agent or --clear-agent"],
    [
      ["--session-key", "agent:main:main", "--clear-session-key"],
      "Use --session-key or --clear-session-key",
    ],
    [["--model", "", "--clear-model"], "Use --model or --clear-model"],
    [["--thinking", "", "--clear-thinking"], "Use --thinking or --clear-thinking"],
    [
      ["--system-event", "hello", "--timeout-seconds", "12"],
      "--timeout-seconds is not supported for systemEvent jobs",
    ],
    [["--timeout-seconds", "12", "--script", "missing.js"], "Use --script-timeout-seconds"],
    [["--timeout-seconds", "12", "--script-tool-budget", "3"], "Use --script-timeout-seconds"],
    [["--channel", "telegram", "--clear-channel"], "Use --channel or --clear-channel"],
    [["--to", "12345", "--clear-to"], "Use --to or --clear-to"],
    [["--thread-id", "42", "--clear-thread-id"], "Use --thread-id or --clear-thread-id"],
    [["--account", "writer", "--clear-account"], "Use --account or --clear-account"],
    [["--pacing-min", "30m", "--command-cwd", " "], "--command-cwd must not be blank"],
    [
      ["--webhook", "https://example.invalid/hook", "--clear-channel"],
      "--webhook cannot be combined with chat delivery options",
    ],
    [["--webhook", "not-a-url"], "--webhook must be a valid http(s) URL"],
    [
      ["--session", "main", "--system-event", "wakeup", "--channel", "telegram"],
      "require a non-main agentTurn or command job with delivery",
    ],
    [["--on-exit-cwd", "/repo"], "--on-exit-cwd requires --on-exit"],
    [["--on-exit", "./watch.sh", "--every", "5m"], "Choose at most one schedule change"],
    [["--pacing-min", "30m", "--thread-id", "topic-42"], "--thread-id must be a positive integer"],
    [["--cron", "9am standup with the team today"], "Invalid cron expression"],
  ] as const)("rejects %j before Gateway access", async (args, message) => {
    await reject(["edit", "job-1", ...args], message);
  });

  it.each([
    [["--enable", "--disable"], "Choose --enable or --disable, not both"],
    [
      ["--session", "main", "--message", "resume"],
      'cron sessionTarget "main" requires payload.kind="systemEvent" or "script"; agent turns use "isolated", "current", or "session:<key>"',
    ],
  ])("keeps edit guidance for %j in JSON mode before RPC", async (args, message) => {
    const argv = process.argv;
    const commandArgs = ["edit", "job-1", ...args, "--json"];
    process.argv = [...argv.slice(0, 2), "cron", ...commandArgs];
    try {
      const failure = await run(commandArgs).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ExpectedCliError);
      expect(formatCliJsonFailure(failure)).toEqual({
        ok: false,
        error: { type: "cli_error", message },
      });
      expect(callGatewayFromCli).not.toHaveBeenCalled();
    } finally {
      process.argv = argv;
    }
  });

  it("preserves trigger.once and the exact script path when replacing the body (#119916)", async () => {
    const dir = tempDirs.make("cron-edit-");
    const scriptPath = path.join(dir, "next.js ");
    await fs.writeFile(path.join(dir, "next.js"), "return { fire: false };");
    await fs.writeFile(scriptPath, "return { fire: true };");
    existing({ configRevision: "revision", trigger: { script: "old", once: true } });
    await edit(["--trigger-script", scriptPath]);
    expectPatch(
      { trigger: { script: "return { fire: true };", once: true } },
      { expectedConfigRevision: "revision" },
    );
  });

  it("validates trigger files before reading an existing job", async () => {
    const dir = tempDirs.make("cron-edit-invalid-");
    await fs.writeFile(path.join(dir, "empty.js"), " \n");
    await fs.writeFile(path.join(dir, "oversized.js"), "x".repeat(65_537));
    for (const [file, message] of [
      ["empty.js", "Trigger script must not be empty"],
      ["oversized.js", "Trigger script exceeds 65536 bytes"],
      ["missing.js", "ENOENT"],
    ] as const) {
      vi.mocked(defaultRuntime.error).mockClear();
      await reject(
        ["edit", "job-1", "--pacing-min", "30m", "--trigger-script", path.join(dir, file)],
        message,
      );
    }
  });

  it("reuses one versioned snapshot for pacing and tool edits", async () => {
    existing({
      configRevision: "revision",
      pacing: { min: "15m", max: "4h" },
      payload: { kind: "agentTurn", message: "hello" },
    });
    await edit(["--pacing-min", "30m", "--tools", "read"]);
    expect(callGatewayFromCli.mock.calls.filter(([method]) => method === "cron.get")).toHaveLength(
      1,
    );
    expectPatch(
      { pacing: { min: "30m", max: "4h" }, payload: { kind: "agentTurn", toolsAllow: ["read"] } },
      { expectedConfigRevision: "revision" },
    );
  });

  it.each([
    ["--best-effort-deliver", { mode: "announce", bestEffort: true }],
    ["--no-best-effort-deliver", { bestEffort: false }],
  ] as const)("keeps %s-only edits delivery-only (#83908)", async (flag, delivery) => {
    await edit([flag]);
    expectPatch({ delivery });
  });

  it("preserves timezone without copying stale stagger on expression replacement (#92291)", async () => {
    existing({
      schedule: { kind: "cron", expr: "0 * * * *", tz: "America/Phoenix", staggerMs: 120_000 },
    });
    await edit(["--cron", "0 5 * * *"]);
    expectPatch({
      schedule: { kind: "cron", expr: "0 5 * * *", tz: "America/Phoenix", staggerMs: undefined },
    });
  });

  it("uses explicit timezone and stagger without reading the existing job", async () => {
    await edit(["--cron", "0 5 * * *", "--tz", "UTC", "--stagger", "10s"]);
    expectPatch({ schedule: { kind: "cron", expr: "0 5 * * *", tz: "UTC", staggerMs: 10000 } });
    expect(callGatewayFromCli.mock.calls.map(([method]) => method)).toEqual([
      "cron.update",
      "cron.status",
    ]);
  });

  it.each([
    {
      payload: { kind: "agentTurn", message: "hello" },
      timeout: "0",
      tools: [],
      patch: { kind: "agentTurn", timeoutSeconds: 0 },
    },
    {
      payload: { kind: "command", argv: ["echo", "hello"] },
      timeout: "12",
      tools: ["--clear-tools"],
      patch: { kind: "command", timeoutSeconds: 12, toolsAllow: ["*"] },
    },
  ])("preserves $payload.kind on timeout edits", async ({ payload, timeout, tools, patch }) => {
    existing({ payload });
    await edit(["--timeout-seconds", timeout, ...tools]);
    expect(callGatewayFromCli.mock.calls.map(([method]) => method)).toEqual([
      "cron.get",
      "cron.update",
      "cron.status",
    ]);
    expectPatch({ payload: patch });
  });

  it.each([
    [{ kind: "script", script: "return {}" }, "Use --script-timeout-seconds"],
    [{ kind: "heartbeat" }, "--timeout-seconds is not supported for heartbeat jobs"],
  ] as const)("rejects generic timeouts on stored %j", async (payload, message) => {
    existing({ payload });
    await reject(["edit", "job-1", "--timeout-seconds", "0"], message, ["cron.get"]);
  });

  it("falls back to paginated cron.list for a Gateway without cron.get", async () => {
    callGatewayFromCli.mockImplementation(
      async (method: string, _opts: unknown, params?: { offset?: number }) => {
        if (method === "cron.get") {
          throw Object.assign(new Error("unknown method: cron.get"), {
            name: "GatewayClientRequestError",
            gatewayCode: "INVALID_REQUEST",
          });
        }
        if (method === "cron.list") {
          return params?.offset
            ? {
                jobs: [
                  {
                    id: "job-1",
                    schedule: { kind: "cron", expr: "0 */2 * * *", staggerMs: 300_000 },
                  },
                ],
                hasMore: false,
                nextOffset: null,
              }
            : { jobs: [{ id: "other" }], hasMore: true, nextOffset: 200 };
        }
        return { ok: true };
      },
    );
    await edit(["--exact"]);
    expect(callGatewayFromCli).toHaveBeenCalledWith("cron.list", expect.anything(), {
      includeDisabled: true,
      limit: 200,
      offset: 0,
    });
    expect(callGatewayFromCli).toHaveBeenCalledWith("cron.list", expect.anything(), {
      includeDisabled: true,
      limit: 200,
      offset: 200,
    });
    expectPatch({ schedule: { kind: "cron", expr: "0 */2 * * *", tz: undefined, staggerMs: 0 } });
  });

  it.each([
    [{ kind: "agentTurn", message: "hello" }, ["--clear-tools"], ["*"]],
    [{ kind: "command", argv: ["echo", "hello"] }, ["--tools", ""], []],
    [{ kind: "script", script: "return {}" }, ["--tools", "read,write"], ["read", "write"]],
    [{ kind: "systemEvent", text: "hello" }, ["--tools", "read"], ["read"]],
  ] as const)("preserves %j when changing its tool policy", async (payload, args, toolsAllow) => {
    existing({ payload });
    await edit(args);
    expect(callGatewayFromCli).toHaveBeenCalledWith("cron.get", expect.anything(), { id: "job-1" });
    expectPatch({ payload: { kind: payload.kind, toolsAllow } });
  });

  it("changes an explicit conversational payload without loading the old job", async () => {
    await edit(["--message", "new message", "--timeout-seconds", "12", "--tools", "read"]);
    expect(callGatewayFromCli.mock.calls.map(([method]) => method)).toEqual([
      "cron.update",
      "cron.status",
    ]);
    expectPatch({
      payload: {
        kind: "agentTurn",
        message: "new message",
        timeoutSeconds: 12,
        toolsAllow: ["read"],
      },
    });
  });

  it.each([
    ["0", 0],
    ["1h30m", 5_400_000],
  ] as const)("accepts failure cooldown %s", async (duration, cooldownMs) => {
    await edit(["--failure-alert-cooldown", duration]);
    expectPatch({ failureAlert: { cooldownMs } });
  });
  it.each(["-1s", "not-a-duration", "999999999999999999d"])(
    "rejects failure cooldown %s",
    async (duration) => {
      await reject(
        ["edit", "job-1", "--failure-alert-cooldown", duration],
        "Invalid --failure-alert-cooldown.",
      );
    },
  );
  it.each([
    ["--clear-channel", "channel"],
    ["--clear-to", "to"],
    ["--clear-thread-id", "threadId"],
    ["--clear-account", "accountId"],
  ])("clears delivery with %s", async (flag, field) => {
    await edit([flag]);
    expectPatch({ delivery: { [field]: null } });
  });
});

describe("automation mutation options", () => {
  it("uses target-specific guidance when adding a system event to a conversation", async () => {
    await reject(
      [
        ...addArgs,
        "--at",
        "+3m",
        "--session",
        "session:agent:main:conversation",
        "--system-event",
        "resume",
      ],
      'sessionTarget "session:agent:main:conversation" cannot run systemEvent: systemEvent only runs in the main session',
    );
  });

  it.each([
    ["add", ["--at", "2030-01-01T09:00:00", "--tz", "Invalid/Timezone"], "Invalid --tz"],
    ["add", ["--at", "2030-01-01T09:00:00Z", "--tz", "Invalid/Timezone"], "Invalid --tz"],
    ["add", ["--at", "2030-02-30T09:00:00", "--tz", "UTC"], "Invalid --at"],
    ["edit", ["--tz", "Invalid/Timezone"], "Invalid --tz"],
  ] as const)("reports invalid schedule input on %s: %j", async (operation, args, message) => {
    await reject(
      [...(operation === "add" ? [...addArgs, "--message", "hello"] : ["edit", "job-1"]), ...args],
      message,
    );
  });

  it.each(["add", "edit"])(
    "preserves escaped trailing command whitespace on %s",
    async (operation) => {
      const command = "printf %s hello\\ ";
      const payload = { kind: "command", argv: ["sh", "-lc", command] };
      await run([
        ...(operation === "add" ? [...addArgs, "--every", "1h"] : ["edit", "job-1"]),
        "--command",
        command,
      ]);
      if (operation === "edit") {
        expectPatch({ payload });
      } else {
        expect(callGatewayFromCli).toHaveBeenCalledWith(
          "cron.add",
          expect.anything(),
          expect.objectContaining({ payload: expect.objectContaining(payload) }),
        );
      }
    },
  );

  it.each(["add", "edit"])(
    "preserves escaped trailing on-exit whitespace on %s",
    async (operation) => {
      const schedule = { kind: "on-exit", command: " printf %s hello\\ " };
      await run([
        ...(operation === "add" ? [...addArgs, "--message", "done"] : ["edit", "job-1"]),
        "--on-exit",
        schedule.command,
      ]);
      if (operation === "edit") {
        expectPatch({ schedule });
      } else {
        expect(callGatewayFromCli).toHaveBeenCalledWith(
          "cron.add",
          expect.anything(),
          expect.objectContaining({ schedule }),
        );
      }
    },
  );

  it("rejects system-event timeouts on creation before RPC", async () => {
    await reject(
      [...addArgs, "--every", "1h", "--system-event", "tick", "--timeout-seconds", "bogus"],
      "--timeout-seconds is not supported for systemEvent jobs.",
    );
  });

  it.each([
    [
      ["9am standup with the team today"],
      'Invalid cron expression "9am standup with the team today"',
    ],
    [["--cron", "9am standup"], 'Invalid cron expression "9am standup"'],
  ] as const)("rejects an unparseable cron schedule %j on creation before RPC", async (args) => {
    await reject([...addArgs, ...args, "--message", "run"], "Invalid cron expression");
  });

  const cwdCases = [
    { flag: "--command-cwd", args: ["--every", "1m", "--command", "pwd"], target: "payload" },
    { flag: "--on-exit-cwd", args: ["--on-exit", "pwd", "--message", "run"], target: "schedule" },
    {
      flag: "--stream-cwd",
      args: ["--stream-command", '["node","events.mjs"]', "--message", "run"],
      target: "schedule",
    },
  ];
  it.each(
    cwdCases.flatMap(({ flag, args, target }) =>
      [undefined, " /repo "].map((value) => ({ flag, args, target, value })),
    ),
  )("creates $flag=$value", async ({ flag, args, target, value }) => {
    await run([...addArgs, ...args, ...(value === undefined ? [] : [flag, value])]);
    const creation = callGatewayFromCli.mock.calls.find(([method]) => method === "cron.add");
    expect(creation?.[2]).toHaveProperty(target);
    expect(creation?.[2]?.[target]?.cwd).toBe(value === undefined ? undefined : "/repo");
    expect(defaultRuntime.error).not.toHaveBeenCalled();
  });

  it("rejects blank creation cwd before resolving a positional schedule", async () => {
    await reject(
      [...addArgs, "every 1m", "--command", "pwd", "--command-cwd", " "],
      "--command-cwd must not be blank",
    );
  });
  it("preserves the blank cwd error through JSON output and the create alias", async () => {
    const argv = process.argv;
    const args = [
      "create",
      "--name",
      "fixture",
      "--on-exit",
      "pwd",
      "--message",
      "run",
      "--on-exit-cwd",
      "",
      "--json",
    ];
    process.argv = [...argv.slice(0, 2), "automations", ...args];
    try {
      let failure: unknown;
      try {
        await run(args);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ExpectedCliError);
      expect(formatCliJsonFailure(failure)).toEqual({
        ok: false,
        error: { type: "cli_error", message: "--on-exit-cwd must not be blank" },
      });
      expect(callGatewayFromCli).not.toHaveBeenCalled();
    } finally {
      process.argv = argv;
    }
  });

  it.each([undefined, ""])("preserves stream cwd edit semantics for %j", async (value) => {
    existing({
      schedule: { kind: "stream", command: ["node", "events.mjs"], cwd: "/repo" },
      payload: { kind: "agentTurn", message: "run" },
    });
    await edit(["--stream-mode", "line", ...(value === undefined ? [] : ["--stream-cwd", value])]);
    expectPatch({
      schedule: {
        kind: "stream",
        command: ["node", "events.mjs"],
        cwd: value === undefined ? "/repo" : undefined,
        mode: "line",
        match: undefined,
        batchMs: undefined,
        maxBatchBytes: undefined,
      },
    });
  });
  it("rejects a blank schedule mixed with an interval on creation", async () => {
    await reject(
      [...addArgs, "--message", "hello", "--every", "1h", "--cron", ""],
      "Schedule values must not be blank",
    );
  });
  it("rejects a blank schedule after reading pacing without mutating", async () => {
    existing({ configRevision: "revision", pacing: { min: "1m", max: "1h" } });
    await reject(
      ["edit", "job-1", "--pacing-min", "30m", "--every", ""],
      "Schedule values must not be blank",
      ["cron.get"],
    );
  });

  it.each([
    ["add", "--every"],
    ["edit", "--stagger"],
  ])("rejects out-of-range %s %s durations before RPC", async (operation, flag) => {
    await reject(
      [
        ...(operation === "add" ? [...addArgs, "--system-event", "test"] : ["edit", "job-1"]),
        ...(flag === "--stagger" ? ["--cron", "0 * * * *", "--tz", "UTC"] : []),
        flag,
        "8640000000000001ms",
      ],
      `Invalid ${flag}`,
    );
  });
  it.each(["--every", "--stagger"])("accepts the inclusive duration limit for %s", async (flag) => {
    await run([
      ...addArgs,
      "--system-event",
      "test",
      "--disabled",
      ...(flag === "--stagger" ? ["--cron", "0 * * * *"] : []),
      flag,
      "8640000000000000ms",
    ]);
    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "cron.add",
      expect.anything(),
      expect.objectContaining({
        enabled: false,
        schedule:
          flag === "--every"
            ? { kind: "every", everyMs: 8_640_000_000_000_000 }
            : { kind: "cron", expr: "0 * * * *", tz: undefined, staggerMs: 8_640_000_000_000_000 },
      }),
    );
  });
  it("replaces an existing schedule with an exit-triggered schedule", async () => {
    await edit(["--on-exit", "./watch.sh", "--on-exit-cwd", "/repo"]);
    expectPatch({ schedule: { kind: "on-exit", command: "./watch.sh", cwd: "/repo" } });
  });

  it("rejects a blank topic id on creation before RPC", async () => {
    await reject(
      [
        ...addArgs,
        "--every",
        "1m",
        "--message",
        "hello",
        "--channel",
        "telegram",
        "--to",
        "group-123",
        "--thread-id",
        "",
      ],
      "--thread-id must be a positive integer",
    );
  });
  it.each(["add", "edit"])("preserves the maximum-safe topic id on %s", async (operation) => {
    const delivery = { channel: "telegram", to: "group-123", threadId: Number.MAX_SAFE_INTEGER };
    await run([
      ...(operation === "add"
        ? [...addArgs, "--every", "1m", "--message", "hello"]
        : ["edit", "job-1"]),
      "--channel",
      "telegram",
      "--to",
      "group-123",
      "--thread-id",
      String(Number.MAX_SAFE_INTEGER),
    ]);
    if (operation === "edit") {
      expectPatch({ delivery });
    } else {
      expect(callGatewayFromCli).toHaveBeenCalledWith(
        "cron.add",
        expect.anything(),
        expect.objectContaining({ delivery: expect.objectContaining(delivery) }),
      );
    }
  });
});
