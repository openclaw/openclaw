import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { CRON_JOB_SCRATCH_MAX_BYTES } from "../../cron/scratch-contract.js";
import { defaultRuntime } from "../../runtime.js";
import { ExpectedCliError } from "../expected-cli-error.js";
import { formatCliJsonFailure } from "../failure-output.js";

const callGatewayFromCli = vi.hoisted(() => vi.fn());
vi.mock("../gateway-rpc.js", async () => {
  const actual = await vi.importActual<typeof import("../gateway-rpc.js")>("../gateway-rpc.js");
  return { ...actual, callGatewayFromCli };
});
const { registerCronAddCommand } = await import("./register.cron-add.js");
const { registerCronEditCommand } = await import("./register.cron-edit.js");
const { registerCronScratchCommand } = await import("./register.cron-scratch.js");
const { readCronPayloadScript, readCronTriggerScript, readCronScratchContent } =
  await import("./trigger-options.js");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function run(args: readonly string[]) {
  const program = new Command().exitOverride();
  registerCronAddCommand(program);
  registerCronEditCommand(program);
  registerCronScratchCommand(program);
  await program.parseAsync([...args], { from: "user" });
}
async function edit(args: readonly string[], patch: Record<string, unknown>, extra = {}) {
  await run(["edit", "job-1", ...args]);
  expectPatch(patch, extra);
}
const flags = (options: Record<string, string | true>) =>
  Object.entries(options).flatMap(([key, value]) =>
    value === true ? [`--${key}`] : [`--${key}`, value],
  );
async function add(args: readonly string[], expected: Record<string, unknown>) {
  await run([...addMessage, ...args]);
  expect(callGatewayFromCli).toHaveBeenCalledWith(
    "cron.add",
    expect.anything(),
    expect.objectContaining(expected),
  );
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

it.each`
  options                                                                                     | patch
  ${{ enable: true, json: true }}                                                             | ${{ enabled: true }}
  ${{ "clear-display-name": true }}                                                           | ${{ displayName: null }}
  ${{ "clear-model": true }}                                                                  | ${{ payload: turn({ model: null }) }}
  ${{ "clear-thinking": true }}                                                               | ${{ payload: turn({ thinking: null }) }}
  ${{ name: "Renamed" }}                                                                      | ${{ name: "Renamed" }}
  ${{ session: "main", message: "resume" }}                                                   | ${{ sessionTarget: "main", payload: turn({ message: "resume" }) }}
  ${{ "best-effort-deliver": true }}                                                          | ${{ delivery: { mode: "announce", bestEffort: true } }}
  ${{ "clear-to": true }}                                                                     | ${{ delivery: { to: null } }}
  ${{ cron: "0 5 * * *", tz: "UTC", stagger: "10s" }}                                         | ${{ schedule: cron({ expr: "0 5 * * *", tz: "UTC", staggerMs: 10000 }) }}
  ${{ message: "new", "timeout-seconds": "12", tools: "read" }}                               | ${{ payload: turn({ message: "new", timeoutSeconds: 12, toolsAllow: ["read"] }) }}
  ${{ "failure-alert-cooldown": "0" }}                                                        | ${{ failureAlert: { cooldownMs: 0 } }}
  ${{ "failure-alert-cooldown": "1h30m" }}                                                    | ${{ failureAlert: { cooldownMs: 5_400_000 } }}
  ${{ "failure-alert-channel": "", "failure-alert-to": " ", "failure-alert-account-id": "" }} | ${{ failureAlert: { channel: null, to: null, accountId: null } }}
`(
  "patches $options without loading the old job",
  async ({ options, patch }: Pick<EditCase, "options" | "patch">) => {
    await edit(flags(options), patch);
    expect(methods()).toEqual(["cron.update", "cron.status"]);
  },
);

it.each(["display-name", "agent", "session-key", "model", "thinking", "thread-id"])(
  "rejects simultaneous --%s and its clear flag",
  async (flag) => {
    const value =
      flag === "thread-id" ? "42" : flag === "model" || flag === "thinking" ? "" : "value";
    await rejectEdit([`--${flag}`, value, `--clear-${flag}`], `Use --${flag} or --clear-${flag}`);
  },
);
it.each`
  options                                                               | message
  ${{ tools: "", "clear-tools": true, "pacing-min": "30m" }}            | ${"Use --tools or --clear-tools"}
  ${{ "trigger-script": "", "clear-trigger": true }}                    | ${"--trigger-script must not be blank"}
  ${{ script: " ", "pacing-min": "30m" }}                               | ${"--script must not be blank"}
  ${{ command: "", name: "Renamed" }}                                   | ${"--command must not be blank"}
  ${{ "system-event": "hello", "timeout-seconds": "12" }}               | ${"--timeout-seconds is not supported for systemEvent jobs"}
  ${{ "timeout-seconds": "12", "script-tool-budget": "3" }}             | ${"Use --script-timeout-seconds"}
  ${{ "pacing-min": "30m", "command-cwd": " " }}                        | ${"--command-cwd must not be blank"}
  ${{ webhook: "https://example.invalid/hook", "clear-channel": true }} | ${"--webhook cannot be combined with chat delivery options"}
  ${{ webhook: "not-a-url" }}                                           | ${"--webhook must be a valid http(s) URL"}
  ${{ session: "main", "system-event": "wakeup", channel: "telegram" }} | ${"require an agentTurn job or a non-main command or script job with delivery"}
  ${{ "on-exit-cwd": "/repo" }}                                         | ${"--on-exit-cwd requires --on-exit"}
  ${{ "on-exit": "./watch.sh", every: "5m" }}                           | ${"Choose at most one schedule change"}
  ${{ "stream-batch-ms": "100", tz: "UTC" }}                            | ${"not valid with stream schedule edits"}
`(
  "rejects $options before Gateway access",
  ({ options, message }: { options: EditCase["options"]; message: string }) =>
    rejectEdit(flags(options), message),
);

it.each`
  args                                                                             | message                                     | root
  ${["edit", "job-1", "--enable", "--disable", "--json"]}                          | ${"Choose --enable or --disable, not both"} | ${"cron"}
  ${["create", "--name", "fixture", ...onExitArgs, "--on-exit-cwd", "", "--json"]} | ${"--on-exit-cwd must not be blank"}        | ${"automations"}
`(
  "preserves $root JSON validation errors",
  ({ args, message, root }: { args: string[]; message: string; root: string }) =>
    expectJsonFailure(args, message, root),
);

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
  const offsets = callGatewayFromCli.mock.calls
    .filter(([method]) => method === "cron.list")
    .map((call) => call[2].offset);
  expect(offsets).toEqual([0, 200]);
});

type RejectCase = {
  args: readonly string[];
  message: string;
  job?: Record<string, unknown>;
  reads?: string[];
};
it.each`
  args                                                                                                       | message                                                                                                                       | job                                                                                                         | reads
  ${["edit", "job-1", "--failure-alert-cooldown", "not-a-duration"]}                                         | ${"Invalid --failure-alert-cooldown."}                                                                                        | ${undefined}                                                                                                | ${undefined}
  ${[...addArgs, "--message", "hello", "--at", "2030-01-01T09:00:00", "--tz", "Invalid/Timezone"]}           | ${"Invalid --tz"}                                                                                                             | ${undefined}                                                                                                | ${undefined}
  ${[...addArgs, "--message", "hello", "--at", "2030-02-30T09:00:00", "--tz", "UTC"]}                        | ${"Invalid --at"}                                                                                                             | ${undefined}                                                                                                | ${undefined}
  ${["edit", "job-1", "--tz", "Invalid/Timezone"]}                                                           | ${"Invalid --tz"}                                                                                                             | ${undefined}                                                                                                | ${undefined}
  ${["edit", "job-1", "--delivery-target", "owner"]}                                                         | ${"require an agentTurn job or a non-main job"}                                                                               | ${{ sessionTarget: "main", payload: { kind: "systemEvent", text: "tick" }, delivery: { mode: "none" } }}    | ${["cron.get"]}
  ${["edit", "job-1", "--direct-policy", "block"]}                                                           | ${"require an agentTurn job or a non-main job"}                                                                               | ${{ sessionTarget: "main", payload: { kind: "script", script: "return {};" }, delivery: { mode: "none" } }} | ${["cron.get"]}
  ${["edit", "job-1", "--idle-only", "--clear-idle-only"]}                                                   | ${"Use --idle-only/--no-idle-only"}                                                                                           | ${undefined}                                                                                                | ${undefined}
  ${["edit", "job-1", "--active-hours-start", "09:00", "--clear-active-hours"]}                              | ${"Use --clear-active-hours"}                                                                                                 | ${undefined}                                                                                                | ${undefined}
  ${["edit", "job-1", "--delivery-target", "last"]}                                                          | ${"--delivery-target must be owner"}                                                                                          | ${undefined}                                                                                                | ${undefined}
  ${["edit", "job-1", "--delivery-target", "owner", "--to", "group-123"]}                                    | ${"cannot be combined with --to"}                                                                                             | ${undefined}                                                                                                | ${undefined}
  ${["edit", "job-1", "--delivery-target", "owner", "--clear-delivery-target"]}                              | ${"Use --delivery-target"}                                                                                                    | ${undefined}                                                                                                | ${undefined}
  ${["edit", "job-1", "--direct-policy", "ignore"]}                                                          | ${"--direct-policy must be allow or block"}                                                                                   | ${undefined}                                                                                                | ${undefined}
  ${["edit", "job-1", "--direct-policy", "block", "--clear-direct-policy"]}                                  | ${"Use --direct-policy"}                                                                                                      | ${undefined}                                                                                                | ${undefined}
  ${["edit", "job-1", "--direct-policy", "block", "--webhook", "https://example.invalid/hook"]}              | ${"requires chat delivery"}                                                                                                   | ${undefined}                                                                                                | ${undefined}
  ${["edit", "job-1", "--skip-if-scratch-empty"]}                                                            | ${"require an agentTurn job or --message"}                                                                                    | ${{ payload: { kind: "command", argv: ["true"] } }}                                                         | ${["cron.get"]}
  ${["edit", "job-1", "--include-reasoning"]}                                                                | ${"require an agentTurn job or --message"}                                                                                    | ${{ payload: { kind: "command", argv: ["true"] } }}                                                         | ${["cron.get"]}
  ${[...addArgs, "--at", "+3m", "--session", "session:agent:main:conversation", "--system-event", "resume"]} | ${'sessionTarget "session:agent:main:conversation" cannot run systemEvent: systemEvent only runs in the main session'}        | ${undefined}                                                                                                | ${undefined}
  ${[...addArgs, "--every", "1h", "--system-event", "tick", "--timeout-seconds", "bogus"]}                   | ${"--timeout-seconds is not supported for systemEvent jobs."}                                                                 | ${undefined}                                                                                                | ${undefined}
  ${[...addArgs, "9am standup with the team today", "--message", "run"]}                                     | ${'Invalid cron expression "9am standup with the team today". Use 5 fields like "0 9 * * *" or 6 fields like "0 0 9 * * *".'} | ${undefined}                                                                                                | ${undefined}
  ${[...addArgs, ...messageArgs, ...topicArgs, ""]}                                                          | ${"--thread-id must be a positive integer"}                                                                                   | ${undefined}                                                                                                | ${undefined}
  ${[...addArgs, "--stream-command", "node events.mjs", "--message", "run"]}                                 | ${"JSON array"}                                                                                                               | ${undefined}                                                                                                | ${undefined}
  ${[...addArgs, "--stream-command", '["node","events.mjs"]', "--stream-mode", "match", "--message", "run"]} | ${"--stream-match is required"}                                                                                               | ${undefined}                                                                                                | ${undefined}
  ${[...addArgs, "--every", "1m", "--stream-batch-ms", "250", "--message", "run"]}                           | ${"require --stream-command"}                                                                                                 | ${undefined}                                                                                                | ${undefined}
  ${["edit", "job-1", "--pacing-min", "30m", "--every", ""]}                                                 | ${"Schedule values must not be blank"}                                                                                        | ${{ configRevision: "revision", pacing: { min: "1m", max: "1h" } }}                                         | ${["cron.get"]}
  ${[...addArgs, "--system-event", "test", "--every", "8640000000000001ms"]}                                 | ${"Invalid --every"}                                                                                                          | ${undefined}                                                                                                | ${undefined}
  ${["edit", "job-1", "--cron", "0 * * * *", "--tz", "UTC", "--stagger", "8640000000000001ms"]}              | ${"Invalid --stagger"}                                                                                                        | ${undefined}                                                                                                | ${undefined}
`("rejects $args", async ({ args, message, job, reads }: RejectCase) => {
  if (job) {
    existing(job);
  }
  await reject(args, message, reads);
});

const command = "printf %s hello\\ ";

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

type AddCase = { name: string; options: EditCase["options"]; expected: Record<string, unknown> };
it.each`
  name                                         | options                                                                                                                                                                                                                                                       | expected
  ${"enabled ordinary policies"}               | ${{ "active-hours-start": "22:00", "active-hours-end": "06:00", "active-hours-timezone": "America/Los_Angeles", "idle-only": true, "skip-if-scratch-empty": true, "include-reasoning": true, "delivery-target": "owner", "direct-policy": "block" }}          | ${{ activeHours: { start: "22:00", end: "06:00", timezone: "America/Los_Angeles" }, idleOnly: true, payload: expect.objectContaining({ kind: "agentTurn", skipIfScratchEmpty: true, includeReasoning: true }), delivery: expect.objectContaining({ mode: "announce", target: "owner", directPolicy: "block", channel: undefined }) }}
  ${"disabled ordinary policies"}              | ${{ "active-hours-start": "22:00", "active-hours-end": "06:00", "active-hours-timezone": "America/Los_Angeles", "no-idle-only": true, "no-skip-if-scratch-empty": true, "no-include-reasoning": true, "delivery-target": "owner", "direct-policy": "block" }} | ${{ activeHours: { start: "22:00", end: "06:00", timezone: "America/Los_Angeles" }, idleOnly: false, payload: expect.objectContaining({ kind: "agentTurn", skipIfScratchEmpty: false, includeReasoning: false }), delivery: expect.objectContaining({ mode: "announce", target: "owner", directPolicy: "block", channel: undefined }) }}
  ${"main-session owner delivery"}             | ${{ session: "main", announce: true, "delivery-target": "owner", "direct-policy": "block" }}                                                                                                                                                                  | ${{ sessionTarget: "main", payload: expect.objectContaining({ kind: "agentTurn", message: "hello" }), delivery: expect.objectContaining({ mode: "announce", target: "owner", directPolicy: "block" }) }}
  ${"unflagged main-session delivery default"} | ${{ session: "main" }}                                                                                                                                                                                                                                        | ${{ sessionTarget: "main", delivery: undefined }}
`("creates $name", async ({ options, expected }: AddCase) => add(flags(options), expected));

const stream = () => ({
  kind: "stream",
  command: ["node", "events.mjs"],
  cwd: "/repo",
  mode: "match",
  match: "^ready:",
  batchMs: 100,
});
type EditCase = {
  name: string;
  job: Record<string, unknown>;
  options: Record<string, string | true>;
  patch: Record<string, unknown>;
};
it.each`
  name                                                        | job                                                                                                                        | options                                                                                                                | patch
  ${"cron timezone without stale stagger (#92291)"}           | ${{ schedule: cron({ expr: "0 * * * *", tz: "America/Phoenix", staggerMs: 120_000 }) }}                                    | ${{ cron: "0 5 * * *" }}                                                                                               | ${{ schedule: cron({ expr: "0 5 * * *", tz: "America/Phoenix", staggerMs: undefined }) }}
  ${"command policy-only edit"}                               | ${{ payload: { kind: "command", argv: ["echo", "hello"] } }}                                                               | ${{ "timeout-seconds": "0", "clear-tools": true }}                                                                     | ${{ payload: { kind: "command", timeoutSeconds: 0, toolsAllow: ["*"] } }}
  ${"system event policy-only edit"}                          | ${{ payload: { kind: "systemEvent", text: "hello" } }}                                                                     | ${{ tools: "read" }}                                                                                                   | ${{ payload: { kind: "systemEvent", toolsAllow: ["read"] } }}
  ${"main-session owner target"}                              | ${{ sessionTarget: "main", payload: turn({ message: "hello" }), delivery: { mode: "announce" } }}                          | ${{ "delivery-target": "owner" }}                                                                                      | ${{ delivery: { target: "owner", to: null, threadId: null } }}
  ${"main-session direct policy"}                             | ${{ sessionTarget: "main", payload: turn({ message: "hello" }), delivery: { mode: "announce" } }}                          | ${{ "direct-policy": "block" }}                                                                                        | ${{ delivery: { directPolicy: "block" } }}
  ${"partial active window"}                                  | ${{ activeHours: { start: "22:00", end: "06:00", timezone: "UTC" } }}                                                      | ${{ "active-hours-end": "08:00", "no-idle-only": true }}                                                               | ${{ activeHours: { start: "22:00", end: "08:00", timezone: "UTC" }, idleOnly: false }}
  ${"cleared ordinary policies"}                              | ${{ sessionTarget: "isolated" }}                                                                                           | ${{ "clear-active-hours": true, "clear-idle-only": true, "clear-delivery-target": true, "clear-direct-policy": true }} | ${{ activeHours: null, idleOnly: null, delivery: { target: null, directPolicy: null } }}
  ${"enabled scratch/reasoning policies"}                     | ${{ payload: turn({ message: "Check" }) }}                                                                                 | ${{ "skip-if-scratch-empty": true, "include-reasoning": true }}                                                        | ${{ payload: turn({ skipIfScratchEmpty: true, includeReasoning: true }) }}
  ${"disabled scratch/reasoning policies"}                    | ${{ payload: turn({ message: "Check" }) }}                                                                                 | ${{ "no-skip-if-scratch-empty": true, "no-include-reasoning": true }}                                                  | ${{ payload: turn({ skipIfScratchEmpty: false, includeReasoning: false }) }}
  ${"announce destination replaced by owner"}                 | ${{ sessionTarget: "isolated", delivery: { mode: "announce", to: "previous-target", threadId: 42, channel: "telegram" } }} | ${{ "delivery-target": "owner" }}                                                                                      | ${{ delivery: { target: "owner", to: null, threadId: null } }}
  ${"disabled delivery destination replaced by owner"}        | ${{ sessionTarget: "isolated", delivery: { mode: "none", to: "previous-target", threadId: 42, channel: "telegram" } }}     | ${{ "delivery-target": "owner" }}                                                                                      | ${{ delivery: { target: "owner", to: null, threadId: null } }}
  ${"webhook destination replaced by owner"}                  | ${{ sessionTarget: "isolated", delivery: { mode: "webhook", to: "previous-target", threadId: 42, channel: "telegram" } }}  | ${{ "delivery-target": "owner" }}                                                                                      | ${{ delivery: { target: "owner", to: null, threadId: null, mode: "announce" } }}
  ${"explicit recipient replaces owner"}                      | ${{ delivery: { mode: "announce", target: "owner" }, sessionTarget: "isolated" }}                                          | ${{ to: "group-123" }}                                                                                                 | ${{ delivery: { target: null, to: "group-123" } }}
  ${"escaped command whitespace"}                             | ${{}}                                                                                                                      | ${{ command }}                                                                                                         | ${{ payload: { kind: "command", argv: ["sh", "-lc", command] } }}
  ${"escaped on-exit whitespace"}                             | ${{}}                                                                                                                      | ${{ "on-exit": ` ${command}` }}                                                                                        | ${{ schedule: { kind: "on-exit", command: ` ${command}` } }}
  ${"command cwd whitespace"}                                 | ${{}}                                                                                                                      | ${{ "command-cwd": " /repo " }}                                                                                        | ${{ payload: { kind: "command", cwd: " /repo " } }}
  ${"stream line mode clears match, preserves cwd and batch"} | ${{ schedule: stream(), payload: turn({ message: "run" }) }}                                                               | ${{ "stream-mode": "line" }}                                                                                           | ${{ schedule: { ...stream(), mode: "line", match: undefined, maxBatchBytes: undefined } }}
  ${"stream cwd cleared"}                                     | ${{ schedule: stream(), payload: turn({ message: "run" }) }}                                                               | ${{ "stream-mode": "line", "stream-cwd": "" }}                                                                         | ${{ schedule: { ...stream(), cwd: undefined, mode: "line", match: undefined, maxBatchBytes: undefined } }}
  ${"stream match replaced"}                                  | ${{ schedule: stream(), payload: turn({ message: "run" }) }}                                                               | ${{ "stream-match": "^updated:" }}                                                                                     | ${{ schedule: { ...stream(), match: "^updated:", maxBatchBytes: undefined } }}
`("edits $name", async ({ job, options, patch }: EditCase) => {
  existing(job);
  await edit(flags(options), patch);
});

async function fixture(name: string, content: string | Buffer) {
  const dir = tempDirs.make("cron-input-");
  if (name !== name.trim()) {
    await fs.writeFile(path.join(dir, name.trim()), "wrong file");
  }
  const file = path.join(dir, name);
  await fs.writeFile(file, content);
  return file;
}
function expectRequest(method: string, payload: unknown) {
  expect(callGatewayFromCli).toHaveBeenCalledWith(method, expect.anything(), payload);
}
function runOptions(operation: "add" | "edit", options: Record<string, string | true>) {
  return run(
    operation === "add"
      ? [...addArgs, ...flags({ every: "30s", ...options })]
      : ["edit", "job-1", ...flags(options)],
  );
}
async function rejectAdd(options: Record<string, string | true>, message: string) {
  await reject([...addArgs, ...flags({ every: "30s", ...options })], message);
}

describe("cron trigger CLI options", () => {
  it.each([
    ["Trigger script", readCronTriggerScript],
    ["Script payload", readCronPayloadScript],
    ["Cron scratch", readCronScratchContent],
  ] as const)("rejects malformed UTF-8 for %s from files and stdin", async (label, read) => {
    const bytes = Buffer.from([0x78, 0xff, 0x79]);
    const file = await fixture("invalid.txt", bytes);
    await expect(read(file)).rejects.toThrow(`${label} must be valid UTF-8`);
    vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(() =>
      Readable.from([bytes])[Symbol.asyncIterator](),
    );
    await expect(read("-")).rejects.toThrow(`${label} must be valid UTF-8`);
  });

  it("preserves exact scratch BOM, Unicode and CRLF while scripts retain trimming", async () => {
    const text = "\uFEFF 中文 😀 \uFFFD\r\n";
    const file = await fixture("valid.txt", text);
    await expect(readCronScratchContent(file)).resolves.toBe(text);
    await expect(readCronTriggerScript(file)).resolves.toBe("中文 😀 \uFFFD");
    await expect(readCronPayloadScript(file)).resolves.toBe("中文 😀 \uFFFD");
  });

  it("reads the exact trigger path on add", async () => {
    const scriptPath = await fixture("watch.js ", "  json({ fire: true })  \n");
    await runOptions("add", {
      "trigger-script": scriptPath,
      "trigger-once": true,
      "system-event": "changed",
      session: "main",
    });

    expectRequest(
      "cron.add",
      expect.objectContaining({ trigger: { script: "json({ fire: true })", once: true } }),
    );
  });

  it("rejects an explicitly blank trigger script before adding a job", async () => {
    await rejectAdd(
      { "trigger-script": "   ", "system-event": "changed", session: "main" },
      "--trigger-script must not be blank",
    );
  });

  it.each(["add", "edit"] as const)(
    "reads the exact payload path and budgets on %s",
    async (operation) => {
      const scriptPath = await fixture("job.js ", "  return { notify: 'done' }  \n");
      await runOptions(operation, {
        script: scriptPath,
        "script-timeout-seconds": "450",
        "script-tool-budget": "75",
        ...(operation === "add" ? { session: "isolated" } : {}),
      });

      const payload = {
        kind: "script",
        script: "return { notify: 'done' }",
        timeoutSeconds: 450,
        toolBudget: 75,
      };
      expectRequest(
        operation === "add" ? "cron.add" : "cron.update",
        operation === "add"
          ? expect.objectContaining({ sessionTarget: "isolated", payload })
          : { id: "job-1", patch: { payload } },
      );
    },
  );

  it("rejects script creation with a generic timeout", async () => {
    const scriptPath = await fixture("job.js", "return { notify: 'done' }");
    await rejectAdd(
      { name: "script job", script: scriptPath, "timeout-seconds": "30" },
      "Use --script-timeout-seconds for script jobs, not --timeout-seconds.",
    );
  });

  it("sends pacing bounds on add", async () => {
    await runOptions("add", {
      name: "paced",
      every: "30m",
      "pacing-min": "15m",
      "pacing-max": "4h",
      "system-event": "check",
      session: "main",
    });

    expectRequest("cron.add", expect.objectContaining({ pacing: { min: "15m", max: "4h" } }));
  });

  it.each(["trigger", "pacing"])("maps --clear-%s to a nullable edit patch", async (field) => {
    await runOptions("edit", { [`clear-${field}`]: true });
    expectRequest("cron.update", { id: "job-1", patch: { [field]: null } });
  });
});

describe("cron scratch", () => {
  const runScratch = (args: string[]) => run(["scratch", "job-1", ...args]);
  const result = { ok: true, scratch: null, currentRevision: 3, maxBytes: 1024 };
  const current = { ...result, currentRevision: 2 };
  beforeEach(() => {
    callGatewayFromCli
      .mockReset()
      .mockImplementation(async (method: string) =>
        method === "cron.scratch.get" ? current : result,
      );
  });

  function expectRpc(...calls: ["get" | "set", Record<string, unknown>][]) {
    expect(callGatewayFromCli.mock.calls).toEqual(
      calls.map(([method, params]) => [
        `cron.scratch.${method}`,
        expect.anything(),
        { id: "job-1", ...params },
      ]),
    );
  }

  type ScratchFailure = {
    name: string;
    args: string[];
    message: string;
    calls: ["get" | "set", Record<string, unknown>][];
    reply?: { ok: false; currentRevision: number };
    offline?: boolean;
  };
  it.each`
    name                                         | args                                                                                  | message                                                      | calls                                                 | reply                                 | offline
    ${"non-decimal revision"}                    | ${["--set", "x", "--expected-revision", "0x2"]}                                       | ${"--expected-revision must be a non-negative integer"}      | ${[["get", {}]]}                                      | ${undefined}                          | ${false}
    ${"revision conflict without retry"}         | ${["--unset", "--expected-revision", "42"]}                                           | ${"cron scratch changed concurrently (current revision 43)"} | ${[["set", { content: null, expectedRevision: 42 }]]} | ${{ ok: false, currentRevision: 43 }} | ${false}
    ${"Gateway failure before invalid revision"} | ${["--set", "x", "--expected-revision", "invalid"]}                                   | ${"Gateway unavailable"}                                     | ${[["get", {}]]}                                      | ${undefined}                          | ${true}
    ${"Gateway failure before reading file"}     | ${["--file", "missing-scratch-file", "--expected-revision", "42"]}                    | ${"Gateway unavailable"}                                     | ${[["get", {}]]}                                      | ${undefined}                          | ${true}
    ${"Gateway failure before oversized input"}  | ${["--set", "x".repeat(CRON_JOB_SCRATCH_MAX_BYTES + 1), "--expected-revision", "42"]} | ${"Gateway unavailable"}                                     | ${[["get", {}]]}                                      | ${undefined}                          | ${true}
  `("rejects $name", async ({ args, message, calls, reply, offline }: ScratchFailure) => {
    if (offline) {
      callGatewayFromCli.mockRejectedValue(new Error("Gateway unavailable"));
    }
    if (reply) {
      callGatewayFromCli.mockResolvedValue(reply);
    }
    await reject(
      ["scratch", "job-1", ...args],
      message,
      calls.map(([method]) => `cron.scratch.${method}`),
    );
    expectRpc(...calls);
  });

  it("uses the read revision for an implicit CAS write and prints JSON", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const json = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    await runScratch(["--set", "new note"]);
    expect(json).toHaveBeenCalledExactlyOnceWith(result);
    expect(stdout).not.toHaveBeenCalled();
    expectRpc(["get", {}], ["set", { content: "new note", expectedRevision: 2 }]);
  });

  it.each([
    ["0", ["--set", "x"], "x"],
    ["42", ["--unset", "--json"], null],
  ] as const)("writes at explicit revision %s without a read", async (revision, args, content) => {
    await runScratch([...args, "--expected-revision", revision]);
    expectRpc(["set", { content, expectedRevision: Number(revision) }]);
  });
});
