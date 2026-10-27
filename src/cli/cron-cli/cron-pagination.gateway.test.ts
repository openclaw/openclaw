// Cron CLI pagination exercises real Gateway handlers and canonical cron snapshots.
import { expectDefined } from "@openclaw/normalization-core";
import { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { tryResolveAmbientOwnerAgentId } from "../../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createMockCronStateForJobs } from "../../cron/service.test-harness.js";
import { listPage } from "../../cron/service/ops-read.js";
import type { CronJob } from "../../cron/types.js";
import { callCron } from "../../gateway/server-methods/cron-read.test-support.js";
import { ExpectedCliError, formatCliJsonFailure } from "../failure-output.js";
import { withConsoleLogsRoutedToStderrForJson } from "../json-output-mode.js";

const mocks = vi.hoisted(() => {
  const runtime = {
    log: vi.fn(),
    error: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`exit ${code}`);
    }),
  };
  return { runtime, rpc: vi.fn() };
});

vi.mock("../gateway-rpc.js", async () => {
  const actual = await vi.importActual<typeof import("../gateway-rpc.js")>("../gateway-rpc.js");
  return { ...actual, callGatewayFromCli: mocks.rpc };
});

vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime: mocks.runtime,
}));

const { registerCronCli } = await import("../cron-cli.js");
const { runtime, rpc } = mocks;
const listRequests = () => rpc.mock.calls.filter(([method]) => method === "cron.list");
const listOffsets = () => listRequests().map((call) => (call[2] as { offset: number }).offset);
const output = (stream: "log" | "error") => runtime[stream].mock.calls.flat().join("\n");
const readJson = (): unknown => runtime.writeJson.mock.calls.at(-1)?.[0];
type Inventory = {
  jobs: Array<CronJob & { effectiveAgentId?: string | null }>;
  deliveryPreviews: Record<string, { label: string; detail: string }>;
};
const inventory = () => readJson() as Inventory;
const stderrIsTTY = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
function expectIncludes(text: string, ...parts: string[]) {
  for (const part of parts) {
    expect(text).toContain(part);
  }
}
function expectExcludes(text: string, ...parts: string[]) {
  for (const part of parts) {
    expect(text).not.toContain(part);
  }
}
async function expectListFailure(message: string) {
  await expectFailure(["list", "--json"], message);
  expect(runtime.writeJson).not.toHaveBeenCalled();
}
async function expectFailure(args: string[], message: string) {
  await expect(runCron(args)).rejects.toThrow("exit 1");
  expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining(message));
}
const createJobs = (count = 201, overrides: (index: number) => Partial<CronJob> = () => ({})) =>
  Array.from({ length: count }, (_, index) => createJob(index, overrides(index)));
const expectRpc = (method: string, params: unknown) =>
  expect(rpc).toHaveBeenCalledWith(method, expect.anything(), params);
const expectSingleRpc = (method: string, params: unknown) =>
  expect(rpc).toHaveBeenCalledExactlyOnceWith(method, expect.anything(), params);
function match(id: string, name: string, schedule = "every 1m", enabled = true) {
  return { id, name, schedule, enabled, status: enabled ? "idle" : "disabled" };
}
const jobIds = (jobs: CronJob[]) => jobs.map(({ id }) => id).toSorted();
const patchPage = (patch: Record<string, unknown>) => (page: unknown) => ({
  ...(page as Record<string, unknown>),
  ...patch,
});

const createJob = (index: number, overrides: Partial<CronJob> = {}): CronJob => ({
  id: `job-${String(index).padStart(3, "0")}`,
  name: `Job ${String(index).padStart(3, "0")}`,
  enabled: true,
  createdAtMs: index,
  updatedAtMs: index,
  schedule: { kind: "every", everyMs: 60_000 },
  sessionTarget: "main",
  wakeMode: "next-heartbeat",
  payload: { kind: "systemEvent", text: "scheduled check" },
  state: { nextRunAtMs: index + 1 },
  ...overrides,
});

function installGateway(
  jobs: CronJob[],
  options: {
    config?: OpenClawConfig;
    beforeList?: (params: Record<string, unknown>, listCall: number, jobs: CronJob[]) => void;
    transformListPage?: (page: unknown, listCall: number) => unknown;
    getError?: Error;
  } = {},
) {
  const state = createMockCronStateForJobs({ jobs });
  // Pagination observes the loaded snapshot of a running Gateway.
  state.schedulerStarted = true;
  const config = options.config ?? {};
  state.deps.defaultAgentId = tryResolveAmbientOwnerAgentId(config);
  let listCalls = 0;
  const cron = {
    listPage: async (params: Parameters<typeof listPage>[1]) => {
      listCalls += 1;
      options.beforeList?.(params ?? {}, listCalls, jobs);
      return await listPage(state, params);
    },
    readJob: async (id: string) => jobs.find((job) => job.id === id),
    getDefaultAgentId: () => state.deps.defaultAgentId,
  };

  mocks.rpc.mockImplementation(
    async (method: string, _options: unknown, params: Record<string, unknown> = {}) => {
      if (method === "cron.get" && options.getError) {
        throw options.getError;
      }
      const respond = await callCron(
        { cron, getRuntimeConfig: () => config } as never,
        method,
        params,
      );
      const [ok, payload, error] = expectDefined(respond.mock.calls.at(-1), "Gateway response");
      if (!ok) {
        throw Object.assign(new Error(error?.message ?? `${method} failed`), {
          name: "GatewayClientRequestError",
          gatewayCode: error?.code,
        });
      }
      if (method === "cron.list" && options.transformListPage) {
        return options.transformListPage(payload, listCalls);
      }
      return payload;
    },
  );
}

function unversionedPage(page: unknown) {
  const { jobs, hasMore, nextOffset, deliveryPreviews } = page as Record<string, unknown>;
  return { jobs, hasMore, nextOffset, deliveryPreviews };
}

const legacyGetError = Object.assign(new Error("unknown method: cron.get"), {
  name: "GatewayClientRequestError",
  gatewayCode: "INVALID_REQUEST",
});

async function runCron(args: string[], root = "cron"): Promise<void> {
  const program = new Command().exitOverride();
  registerCronCli(program);
  await program.parseAsync([root, ...args], { from: "user" });
}

async function runJson(args: string[], root = "cron"): Promise<void> {
  const originalArgv = process.argv;
  process.argv = ["node", "openclaw", root, ...args];
  try {
    await withConsoleLogsRoutedToStderrForJson(process.argv, () => runCron(args, root));
  } finally {
    process.argv = originalArgv;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  rpc
    .mockReset()
    .mockImplementation(async (method: string) =>
      method === "cron.status" ? { enabled: true } : { ok: true },
    );
});
afterEach(() => {
  if (stderrIsTTY) {
    Object.defineProperty(process.stderr, "isTTY", stderrIsTTY);
  } else {
    Reflect.deleteProperty(process.stderr, "isTTY");
  }
  vi.restoreAllMocks();
});

it.each([true, false])("shows disabled streams, running=%s", async (running) => {
  const job = createJob(400, {
    agentId: "main",
    schedule: { kind: "stream", command: ["node", "events.mjs"] },
    state: {
      ...(running ? { runningAtMs: Date.now() } : {}),
      lastRunStatus: "ok",
      lastDeliveryStatus: "not-delivered",
      deliverySuppressionReason: "silent",
      streamStatus: "disabled",
      streamError: "cron is disabled",
    },
  });
  installGateway([job]);
  await runCron(["list"]);
  const row =
    output("log")
      .split("\n")
      .find((line) => line.includes(job.id)) ?? "";
  expectIncludes(row, running ? "running" : "disabled");
  expectExcludes(row, running ? "disabled" : "running", "idle", "ok (suppressed)");
  await runCron(["show", job.id]);
  expectIncludes(
    output("log"),
    `status: ${running ? "running" : "disabled"}`,
    "stream status: disabled",
    "stream error: cron is disabled",
  );
  const expected = { id: job.id, status: running ? "running" : "ok", state: job.state };
  await runCron(["list", "--json"]);
  expect(inventory().jobs[0]).toMatchObject(expected);
  await runCron(["show", job.id, "--json"]);
  expect(readJson()).toMatchObject(expected);
});

it("lists ownerless jobs and filters by resolved owner", async () => {
  const ownerless = {
    sessionTarget: "isolated",
    payload: { kind: "agentTurn", message: "legacy job" },
    delivery: { mode: "announce" },
  } satisfies Partial<CronJob>;
  installGateway(
    [createJob(0, ownerless), createJob(2, { ...ownerless, sessionKey: "agent:ops:main" })],
    { config: { agents: { entries: { main: {}, ops: {} } } } },
  );
  await runCron(["list", "--all"]);
  expectIncludes(output("log"), "Agent ID", "job-000", "job-002");
  expect(output("log")).not.toContain("default");
  expect(
    output("log")
      .split("\n")
      .find((line) => line.includes("job-002")),
  ).toContain("ops");
  await runCron(["list", "--all", "--json"]);
  const owned = { id: "job-002", effectiveAgentId: "ops", sessionKey: "agent:ops:main" };
  expect(inventory().jobs).toMatchObject([{ id: "job-000", effectiveAgentId: null }, owned]);
  expect(inventory().jobs[0]?.agentId).toBeUndefined();
  expect(inventory().deliveryPreviews["job-000"]?.detail).toContain("no resolvable owner");
  await runCron(["list", "--all", "--json", "--agent", "ops"]);
  expect(inventory().jobs).toMatchObject([owned]);
});

it.each([false, true])("paginates filtered inventories, JSON=%s", async (json) => {
  const matching = createJobs(201, (index) => ({
    displayName: `Backup ${index}`,
    agentId: "ops",
    enabled: !json || index % 2 === 0,
  }));
  installGateway([
    ...matching,
    createJob(900, { name: json ? "backup other" : "unrelated", agentId: "other" }),
    createJob(901, { name: "unrelated", agentId: "ops" }),
    createJob(902, { displayName: "Backup paused", enabled: false, agentId: "other" }),
  ]);
  await runCron(
    ["list", "--query", " BACKUP ", ...(json ? ["--all", "--agent", " Ops ", "--json"] : [])],
    "automations",
  );
  if (json) {
    expect(jobIds(inventory().jobs)).toEqual(jobIds(matching));
    expect(inventory().jobs[0]?.effectiveAgentId).toBe("ops");
    expect(inventory().deliveryPreviews["job-200"]).toMatchObject({ label: "not requested" });
    await runCron(["list", "--query", "no-matching-automation", "--json"]);
    expect(inventory().jobs).toEqual([]);
  } else {
    const text = output("log");
    expectIncludes(text, "Backup 0", "Backup 200");
    expectExcludes(text, "unrelated", "Backup paused");
    expect(text.split("\n")).toHaveLength(202);
  }
});

it.each([
  { change: "replacement", count: 201, offsets: [0, 200, 0, 200] },
  { change: "shrink", count: 199, offsets: [0, 200, 0] },
])("restarts inventory pagination after snapshot $change", async ({ change, count, offsets }) => {
  installGateway(createJobs(), {
    beforeList(_params, call, jobs) {
      if (call === 2) {
        if (change === "replacement") {
          jobs[0] = createJob(900, { name: "Replacement after snapshot change" });
        } else {
          jobs.splice(0, 2);
        }
      }
    },
  });
  await runCron(["list", "--json"]);
  const result = inventory();
  expect(result.jobs).toHaveLength(count);
  expect(result.jobs.some((job) => job.id === "job-000")).toBe(false);
  expect(
    result.jobs.some((job) => job.id === (change === "replacement" ? "job-900" : "job-001")),
  ).toBe(change === "replacement");
  expect(listOffsets()).toEqual(offsets);
});

it.each([0, 201])("detects and lists a protocol-v4 inventory of %i jobs", async (count) => {
  installGateway(createJobs(count), {
    transformListPage: unversionedPage,
    getError: legacyGetError,
  });
  await runCron(["list", "--json"]);
  expect(jobIds(inventory().jobs)).toEqual(jobIds(createJobs(count)));
});

it.each(["protocol", "revision"])("rejects repeated %s churn", async (change) => {
  const legacy = change === "protocol";
  installGateway(createJobs(), {
    getError: legacy ? legacyGetError : undefined,
    transformListPage: legacy
      ? (page, call) => (call % 2 === 0 ? page : unversionedPage(page))
      : undefined,
    beforeList(params, _call, jobs) {
      if (!legacy && params.offset === 200) {
        jobs[0] = createJob(0, { updatedAtMs: _call });
      }
    },
  });
  if (legacy) {
    await expect(runJson(["list", "--json"])).rejects.toThrow("inventory changed repeatedly");
    expect(mocks.runtime.error).not.toHaveBeenCalled();
  } else {
    await expectListFailure("inventory changed repeatedly");
  }
  expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
});

it.each([
  ["missing rows", patchPage({ jobs: undefined })],
  ["missing revision", patchPage({ snapshotRevision: undefined })],
  ["missing cursor", patchPage({ nextOffset: undefined })],
  ["oversized terminal page", patchPage({ jobs: createJobs(201), total: 201 })],
  ["truncated page", patchPage({ total: 2 }), "inconsistent terminal inventory page"],
  [
    "stalled cursor",
    patchPage({ total: 2, hasMore: true, nextOffset: 0 }),
    "pagination did not advance",
  ],
  ["empty modern unversioned page", unversionedPage, undefined, 0],
  ["modern unversioned page", unversionedPage, undefined, 201],
  [
    "oversized inventory",
    (_page: unknown, call: number) => ({
      jobs: createJobs(200),
      snapshotRevision: "stable",
      total: 10_001,
      offset: (call - 1) * 200,
      limit: 200,
      hasMore: true,
      nextOffset: call * 200,
    }),
    "pagination exceeded maximum pages",
  ],
] satisfies Array<[string, (page: unknown, call: number) => unknown, string?, number?]>)(
  "rejects %s",
  async (_label, transformListPage, error = "invalid inventory page", count = 1) => {
    installGateway(createJobs(count), { transformListPage });
    await expectListFailure(error);
  },
);

it.each(["job-200", "JOB-200"])("prefers ID %s with raw JSON", async (id) => {
  const name = "job\u001B]0;cron-json\u0007🦞\r\nname";
  const model = "model\u001B[31m\tvariant";
  const lastError = "failed\u001B]0;cron-error\u0007\nreason";
  installGateway([
    createJob(0, { id: "name-owner", name: "job-200" }),
    createJob(1, { name: "JOB-200" }),
    createJob(200, {
      name,
      payload: { kind: "agentTurn", message: "test", model },
      state: { lastError },
    }),
  ]);
  await runCron(["show", id, "--json"]);
  expect(readJson()).toMatchObject({
    id: "job-200",
    name,
    payload: { model },
    state: { lastError },
  });
});

it.each([true, false])("protects ambiguous choices in JSON=%s or legacy text", async (json) => {
  const legacy = !json;
  const control = "\u001B]0;name\u0007\r\njob";
  const first = `backup${control}`;
  const last = `BACKUP${control}`;
  const query = `bAcKuP${control}`;
  const longId = `backup-${"0123456789".repeat(5)}`;
  const jobs = createJobs(202);
  jobs[0] = createJob(0, {
    id: longId,
    name: first,
    sessionTarget: "isolated",
    delivery: { mode: "none" },
    payload: {
      kind: "command",
      argv: ["node", "private-command"],
      env: { PRIVATE_VALUE: "private-env" },
      input: "private-input",
    },
  });
  jobs[200] = createJob(200, {
    name: last,
    enabled: false,
    schedule: { kind: "on-exit", command: "private-exit" },
  });
  jobs[201] = createJob(201, {
    name: first,
    sessionTarget: "isolated",
    schedule: { kind: "stream", command: ["node", "private-stream"] },
    payload: { kind: "agentTurn", message: "private-prompt" },
    delivery: { mode: "none" },
  });
  installGateway(
    jobs,
    legacy ? { transformListPage: unversionedPage, getError: legacyGetError } : {},
  );
  const message =
    "Multiple automations match this name. Retry this command with a matching job ID instead of the name.";
  if (json) {
    const error = await runJson(["show", query, "--json"], "automations").catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ExpectedCliError);
    const failure = formatCliJsonFailure(error);
    expect(failure.error.matches).toEqual([
      match(longId, first),
      match("job-200", last, "on-exit", false),
      match("job-201", first, "stream"),
    ]);
    expect(JSON.stringify(failure)).not.toContain("private-");
    expect(runtime.writeJson).not.toHaveBeenCalled();
    const selected = expectDefined(failure.error.matches?.[0], "matching choice");
    await runCron(["show", selected.id, "--json"], "automations");
    expect(readJson()).toMatchObject({ id: longId, name: first });
  } else {
    await expectFailure(["show", query], message);
    const text = output("error");
    expectIncludes(
      text,
      "Matching automations:",
      `${longId}  backup\\r\\njob`,
      "job-200",
      "job-201",
      "every 1m; enabled: yes; status: idle",
      "on-exit; enabled: no; status: disabled",
      "stream; enabled: yes; status: idle",
    );
    expectExcludes(text, "job-001", "private-", "\u001B]", "\u0007", "\r");
    expect(runtime.writeJson).not.toHaveBeenCalled();
  }
  expect(runtime.log).not.toHaveBeenCalled();
});

it("does not scan after transport errors", async () => {
  installGateway([createJob(0)], { getError: new Error("Gateway transport is unavailable") });

  await expectFailure(["show", "job-000", "--json"], "Gateway transport is unavailable");
  expect(listRequests()).toHaveLength(0);
});
it("reports visibility and scheduler hints when toggling jobs", async () => {
  Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  rpc.mockImplementation(async (method: string) =>
    method === "cron.status" ? { enabled: false } : { ok: true },
  );
  await runCron(["disable", "job-1"]);
  expectRpc("cron.update", { id: "job-1", patch: { enabled: false } });
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining("openclaw cron list --all"));
  await runCron(["enable", "job-1"]);
  expectRpc("cron.update", { id: "job-1", patch: { enabled: true } });
  expect(runtime.writeJson).toHaveBeenCalledWith({ ok: true });
  expectIncludes(output("error"), "scheduler is disabled", "cron.enabled", "OPENCLAW_SKIP_CRON=1");
});

it.each([
  { args: ["--id", "job-1"], selector: { id: "job-1" } },
  {
    args: "--all --status error --delivery-status not-delivered --query timeout --sort asc --offset 1 --limit 2 --run-id run-1".split(
      " ",
    ),
    selector: {
      scope: "all",
      status: "error",
      deliveryStatus: "not-delivered",
      query: "timeout",
      sortDir: "asc",
      offset: 1,
      limit: 2,
      runId: "run-1",
    },
  },
])("retains history selection $args", async ({ args, selector }) => {
  await runCron(["runs", ...args]);
  expectSingleRpc("cron.runs", { limit: 50, ...selector });
});

it.each([
  ["--all job-1", "--all cannot be combined with a job id"],
  ["job-1 --offset -1", "Invalid --offset (must be a non-negative integer)."],
])("rejects history options %s before RPC", async (args, message) => {
  const thrown = await runJson(["runs", ...args.split(" "), "--json"]).catch(
    (error: unknown) => error,
  );
  expect(thrown).toBeInstanceOf(ExpectedCliError);
  expect(formatCliJsonFailure(thrown)).toEqual({
    ok: false,
    error: { type: "cli_error", message },
  });
  expect(rpc).not.toHaveBeenCalled();
});
