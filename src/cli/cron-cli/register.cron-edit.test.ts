import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
async function edit(args: readonly string[], patch: Record<string, unknown>, extra = {}) {
  await run(["edit", "job-1", ...args]);
  expectPatch(patch, extra);
}
const addArgs = ["add", "--name", "fixture", "--agent", "main"];
const messageArgs = ["--every", "1m", "--message", "hello"];
const addMessage = [...addArgs, ...messageArgs];
const topicArgs = ["--channel", "telegram", "--to", "group-123", "--thread-id"];
const onExitArgs = ["--on-exit", "pwd", "--message", "run"];
const cron = (fields: Record<string, unknown>) => ({ kind: "cron", ...fields });
const turn = (fields: Record<string, unknown>) => ({ kind: "agentTurn", ...fields });
const methods = () => callGatewayFromCli.mock.calls.map(([method]) => method);
const rejectEdit = (args: readonly string[], message: string, reads?: string[]) =>
  reject(["edit", "job-1", ...args], message, reads);
async function expectJsonFailure(args: readonly string[], message: string, root = "cron") {
  const argv = process.argv;
  process.argv = [...argv.slice(0, 2), root, ...args];
  try {
    const failure = await run(args).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ExpectedCliError);
    const formatted = formatCliJsonFailure(failure);
    expect(formatted).toEqual({ ok: false, error: { type: "cli_error", message } });
    expect(callGatewayFromCli).not.toHaveBeenCalled();
  } finally {
    process.argv = argv;
  }
}
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
  expect(methods()).toEqual(reads);
}

beforeEach(() => {
  callGatewayFromCli.mockReset().mockResolvedValue({ ok: true });
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

it.each([
  [["--enable", "--json"], { enabled: true }],
  [["--clear-display-name"], { displayName: null }],
  [["--clear-model"], { payload: turn({ model: null }) }],
  [["--clear-thinking"], { payload: turn({ thinking: null }) }],
  [["--name", "Renamed"], { name: "Renamed" }],
  [["--best-effort-deliver"], { delivery: { mode: "announce", bestEffort: true } }],
  [["--clear-to"], { delivery: { to: null } }],
  [
    ["--cron", "0 5 * * *", "--tz", "UTC", "--stagger", "10s"],
    { schedule: cron({ expr: "0 5 * * *", tz: "UTC", staggerMs: 10000 }) },
  ],
  [
    ["--message", "new", "--timeout-seconds", "12", "--tools", "read"],
    { payload: turn({ message: "new", timeoutSeconds: 12, toolsAllow: ["read"] }) },
  ],
  [["--failure-alert-cooldown", "0"], { failureAlert: { cooldownMs: 0 } }],
  [["--failure-alert-cooldown", "1h30m"], { failureAlert: { cooldownMs: 5_400_000 } }],
  [
    ["--failure-alert-channel", "", "--failure-alert-to", " ", "--failure-alert-account-id", ""],
    { failureAlert: { channel: null, to: null, accountId: null } },
  ],
] as const)("patches %j without loading the old job", async (args, patch) => {
  await edit(args, patch);
  expect(methods()).toEqual(["cron.update", "cron.status"]);
});

it.each([
  ...(
    [
      ["display-name", "Daily summary"],
      ["agent", "main"],
      ["session-key", "agent:main:main"],
      ["model", ""],
      ["thinking", ""],
      ["thread-id", "42"],
    ] as const
  ).map(
    ([flag, value]) =>
      [[`--${flag}`, value, `--clear-${flag}`], `Use --${flag} or --clear-${flag}`] as const,
  ),
  [["--tools", "", "--clear-tools", "--pacing-min", "30m"], "Use --tools or --clear-tools"],
  [["--trigger-script", "", "--clear-trigger"], "--trigger-script must not be blank"],
  [["--script", " ", "--pacing-min", "30m"], "--script must not be blank"],
  [["--command", "", "--name", "Renamed"], "--command must not be blank"],
  [
    ["--system-event", "hello", "--timeout-seconds", "12"],
    "--timeout-seconds is not supported for systemEvent jobs",
  ],
  [["--timeout-seconds", "12", "--script-tool-budget", "3"], "Use --script-timeout-seconds"],
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
] as const)("rejects %j before Gateway access", rejectEdit);

it.each([
  [
    ["edit", "job-1", "--enable", "--disable", "--json"],
    "Choose --enable or --disable, not both",
    "cron",
  ],
  [
    ["create", "--name", "fixture", ...onExitArgs, "--on-exit-cwd", "", "--json"],
    "--on-exit-cwd must not be blank",
    "automations",
  ],
] as const)("preserves JSON validation errors for %j", expectJsonFailure);

it("preserves trigger.once and the exact script path when replacing the body (#119916)", async () => {
  const dir = tempDirs.make("cron-edit-");
  const scriptPath = path.join(dir, "next.js ");
  await fs.writeFile(path.join(dir, "next.js"), "return { fire: false };");
  await fs.writeFile(scriptPath, "return { fire: true };");
  existing({ configRevision: "revision", trigger: { script: "old", once: true } });
  await edit(
    ["--trigger-script", scriptPath],
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
    await rejectEdit(["--pacing-min", "30m", "--trigger-script", path.join(dir, file)], message);
  }
});

it("reuses one versioned snapshot for pacing and tool edits", async () => {
  existing({
    configRevision: "revision",
    pacing: { min: "15m", max: "4h" },
    payload: turn({ message: "hello" }),
  });
  await edit(
    ["--pacing-min", "30m", "--tools", "read"],
    { pacing: { min: "30m", max: "4h" }, payload: turn({ toolsAllow: ["read"] }) },
    { expectedConfigRevision: "revision" },
  );
  expect(methods().filter((method) => method === "cron.get")).toHaveLength(1);
});

it("preserves timezone without copying stale stagger on expression replacement (#92291)", async () => {
  existing({
    schedule: cron({ expr: "0 * * * *", tz: "America/Phoenix", staggerMs: 120_000 }),
  });
  await edit(["--cron", "0 5 * * *"], {
    schedule: cron({ expr: "0 5 * * *", tz: "America/Phoenix", staggerMs: undefined }),
  });
});

it.each([
  [
    { kind: "command", argv: ["echo", "hello"] },
    ["--timeout-seconds", "0", "--clear-tools"],
    { kind: "command", timeoutSeconds: 0, toolsAllow: ["*"] },
  ],
  [
    { kind: "systemEvent", text: "hello" },
    ["--tools", "read"],
    { kind: "systemEvent", toolsAllow: ["read"] },
  ],
] as const)("preserves execution kind on policy-only edits: %j", async (payload, args, patch) => {
  existing({ payload });
  await edit(args, { payload: patch });
  expect(methods()).toEqual(["cron.get", "cron.update", "cron.status"]);
  expect(callGatewayFromCli).toHaveBeenCalledWith("cron.get", expect.anything(), { id: "job-1" });
});

it("falls back to paginated cron.list for a Gateway without cron.get", async () => {
  const expr = "0 */2 * * *";
  const job = { id: "job-1", schedule: cron({ expr, staggerMs: 300_000 }) };
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
          ? { jobs: [job], hasMore: false, nextOffset: null }
          : { jobs: [{ id: "other" }], hasMore: true, nextOffset: 200 };
      }
      return { ok: true };
    },
  );
  await edit(["--exact"], { schedule: cron({ expr, tz: undefined, staggerMs: 0 }) });
  expect(callGatewayFromCli.mock.calls.filter(([method]) => method === "cron.list")).toEqual(
    [0, 200].map((offset) => [
      "cron.list",
      expect.anything(),
      { includeDisabled: true, limit: 200, offset },
    ]),
  );
});

it.each(["-1s", "not-a-duration", "999999999999999999d"])(
  "rejects failure cooldown %s",
  (duration) =>
    rejectEdit(["--failure-alert-cooldown", duration], "Invalid --failure-alert-cooldown."),
);
it.each([
  ["add", ["--at", "2030-01-01T09:00:00", "--tz", "Invalid/Timezone"], "Invalid --tz"],
  ["add", ["--at", "2030-02-30T09:00:00", "--tz", "UTC"], "Invalid --at"],
  ["edit", ["--tz", "Invalid/Timezone"], "Invalid --tz"],
] as const)("reports invalid schedule input on %s: %j", (operation, args, message) =>
  reject(
    [...(operation === "add" ? [...addArgs, "--message", "hello"] : ["edit", "job-1"]), ...args],
    message,
  ),
);

const command = "printf %s hello\\ ";
it.each([
  ["--command", command, { payload: { kind: "command", argv: ["sh", "-lc", command] } }],
  ["--on-exit", ` ${command}`, { schedule: { kind: "on-exit", command: ` ${command}` } }],
] as const)("preserves escaped trailing %s whitespace on edit", (flag, text, patch) =>
  edit([flag, text], patch),
);

it.each([
  [
    ["--at", "+3m", "--session", "session:agent:main:conversation", "--system-event", "resume"],
    'sessionTarget "session:agent:main:conversation" cannot run systemEvent: systemEvent only runs in the main session',
  ],
  [
    ["--every", "1h", "--system-event", "tick", "--timeout-seconds", "bogus"],
    "--timeout-seconds is not supported for systemEvent jobs.",
  ],
  [
    ["9am standup with the team today", "--message", "run"],
    'Invalid cron expression "9am standup with the team today". Use 5 fields like "0 9 * * *" or 6 fields like "0 0 9 * * *".',
  ],
  [[...messageArgs, ...topicArgs, ""], "--thread-id must be a positive integer"],
] as const)("rejects invalid creation %j before RPC", (args, message) =>
  reject([...addArgs, ...args], message),
);

const streamArgs = ["--stream-command", '["node","events.mjs"]', "--message", "run"];
it.each([
  ["--command-cwd", ["--every", "1m", "--command", "pwd"], "payload", " /repo "],
  ["--on-exit-cwd", onExitArgs, "schedule", " /repo "],
  ["--stream-cwd", streamArgs, "schedule", " /repo "],
  ["--stream-cwd", streamArgs, "schedule", undefined],
] as const)("creates %s with cwd %s", async (flag, args, target, value) => {
  await run([...addArgs, ...args, ...(value === undefined ? [] : [flag, value])]);
  const creation = callGatewayFromCli.mock.calls.find(([method]) => method === "cron.add");
  expect(creation?.[2]).toHaveProperty(target);
  expect(creation?.[2]?.[target]?.cwd).toBe(value);
  expect(defaultRuntime.error).not.toHaveBeenCalled();
});

it("preserves leading and trailing cwd whitespace on command-cwd edit", async () => {
  await edit(["--command-cwd", " /repo "], { payload: { kind: "command", cwd: " /repo " } });
});

it.each([undefined, ""])("preserves stream cwd edit semantics for %j", async (value) => {
  existing({
    schedule: { kind: "stream", command: ["node", "events.mjs"], cwd: "/repo" },
    payload: turn({ message: "run" }),
  });
  await edit(["--stream-mode", "line", ...(value === undefined ? [] : ["--stream-cwd", value])], {
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
it("rejects a blank schedule after reading pacing without mutating", async () => {
  existing({ configRevision: "revision", pacing: { min: "1m", max: "1h" } });
  await rejectEdit(["--pacing-min", "30m", "--every", ""], "Schedule values must not be blank", [
    "cron.get",
  ]);
});

it.each([
  ["add", "--every"],
  ["edit", "--stagger"],
])("rejects out-of-range %s %s durations before RPC", (operation, flag) =>
  reject(
    [
      ...(operation === "add" ? [...addArgs, "--system-event", "test"] : ["edit", "job-1"]),
      ...(flag === "--stagger" ? ["--cron", "0 * * * *", "--tz", "UTC"] : []),
      flag,
      "8640000000000001ms",
    ],
    `Invalid ${flag}`,
  ),
);
it.each(["add", "edit"])("preserves the maximum-safe topic id on %s", async (operation) => {
  const delivery = { channel: "telegram", to: "group-123", threadId: Number.MAX_SAFE_INTEGER };
  await run([
    ...(operation === "add" ? addMessage : ["edit", "job-1"]),
    ...topicArgs,
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
