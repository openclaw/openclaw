// Cron CLI pagination exercises real Gateway handlers and canonical cron snapshots.
import { expectDefined } from "@openclaw/normalization-core";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tryResolveAmbientOwnerAgentId } from "../../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createMockCronStateForJobs } from "../../cron/service.test-harness.js";
import { listPage } from "../../cron/service/ops-read.js";
import type { CronJob } from "../../cron/types.js";
import { cronHandlers } from "../../gateway/server-methods/cron.js";
import { formatCliJsonFailure } from "../failure-output.js";
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
  return { runtime, callGatewayFromCli: vi.fn() };
});

vi.mock("../gateway-rpc.js", async () => {
  const actual = await vi.importActual<typeof import("../gateway-rpc.js")>("../gateway-rpc.js");
  return {
    ...actual,
    callGatewayFromCli: (...args: Parameters<typeof actual.callGatewayFromCli>) =>
      mocks.callGatewayFromCli(...args),
  };
});

vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime: mocks.runtime,
}));

const { registerCronCli } = await import("../cron-cli.js");
const { runtime, callGatewayFromCli } = mocks;
const listRequests = () =>
  callGatewayFromCli.mock.calls.filter(([method]) => method === "cron.list");
const listOffsets = () => listRequests().map((call) => (call[2] as { offset: number }).offset);
const output = (stream: "log" | "error") => runtime[stream].mock.calls.flat().join("\n");
function expectIncludes(text: string, ...parts: string[]) {
  for (const part of parts) {
    expect(text).toContain(part);
  }
}
async function expectListFailure(message: string) {
  await expect(runCron(["list", "--json"])).rejects.toThrow("exit 1");
  expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining(message));
  expect(runtime.writeJson).not.toHaveBeenCalled();
}
const createJobs = (count = 201) => Array.from({ length: count }, (_, index) => createJob(index));
function expectRpc(method: string, params: unknown) {
  expect(callGatewayFromCli).toHaveBeenCalledWith(method, expect.anything(), params);
}
function match(id: string, name: string, schedule = "every 1m", enabled = true) {
  return { id, name, schedule, enabled, status: enabled ? "idle" : "disabled" };
}

function createJob(index: number, overrides: Partial<CronJob> = {}): CronJob {
  return {
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
  };
}

function installRealCronGateway(
  jobs: CronJob[],
  options: {
    config?: OpenClawConfig;
    beforeList?: (params: Record<string, unknown>, listCall: number, jobs: CronJob[]) => void;
    transformListPage?: (page: unknown, listCall: number) => unknown;
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
      options.beforeList?.(
        params ?? {},
        listCalls,
        expectDefined(state.store, "expected loaded canonical cron test store").jobs,
      );
      return await listPage(state, params);
    },
    readJob: async (id: string) =>
      expectDefined(state.store, "expected loaded canonical cron test store").jobs.find(
        (job) => job.id === id,
      ),
    getDefaultAgentId: () => state.deps.defaultAgentId,
  };

  mocks.callGatewayFromCli.mockImplementation(
    async (method: string, _options: unknown, params: Record<string, unknown> = {}) => {
      const handler = expectDefined(cronHandlers[method], `missing real Gateway method ${method}`);
      let response:
        | { ok: boolean; payload?: unknown; error?: { code?: string; message?: string } }
        | undefined;
      await handler({
        req: {} as never,
        params,
        respond: (ok: boolean, payload?: unknown, error?: { code?: string; message?: string }) => {
          response = { ok, payload, error };
        },
        context: {
          cron,
          getRuntimeConfig: () => config,
        } as never,
      } as never);
      const result = expectDefined(response, `${method} returned no Gateway response`);
      if (!result.ok) {
        throw Object.assign(new Error(result.error?.message ?? `${method} failed`), {
          name: "GatewayClientRequestError",
          gatewayCode: result.error?.code,
        });
      }
      if (method === "cron.list" && options.transformListPage) {
        return options.transformListPage(result.payload, listCalls);
      }
      return result.payload;
    },
  );
  return state;
}

function unversionedPage(page: unknown) {
  const { jobs, hasMore, nextOffset, deliveryPreviews } = page as Record<string, unknown>;
  return { jobs, hasMore, nextOffset, deliveryPreviews };
}

function disableCronGetForProtocolV4Gateway(): void {
  const invokeGateway = expectDefined(
    mocks.callGatewayFromCli.getMockImplementation(),
    "expected installed real cron Gateway",
  );
  mocks.callGatewayFromCli.mockImplementation(async (...args: unknown[]) => {
    if (args[0] === "cron.get") {
      throw Object.assign(new Error("unknown method: cron.get"), {
        name: "GatewayClientRequestError",
        gatewayCode: "INVALID_REQUEST",
      });
    }
    return await invokeGateway(...args);
  });
}

async function runCron(args: string[], root = "cron"): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerCronCli(program);
  await program.parseAsync([root, ...args], { from: "user" });
}

async function runCronWithJsonOwner(args: string[], root = "cron"): Promise<void> {
  const originalArgv = process.argv;
  process.argv = ["node", "openclaw", root, ...args];
  try {
    await withConsoleLogsRoutedToStderrForJson(process.argv, () => runCron(args, root));
  } finally {
    process.argv = originalArgv;
  }
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("cron CLI with the real Gateway pagination contract", () => {
  it.each(["list", "show"])(
    "preserves active run status in %s with a disabled stream source",
    async (surface) => {
      const job = createJob(400, {
        agentId: "main",
        schedule: { kind: "stream", command: ["node", "events.mjs"] },
        state: {
          runningAtMs: Date.now(),
          streamStatus: "disabled",
          streamError: "cron is disabled",
        },
      });
      installRealCronGateway([job]);
      const args = surface === "list" ? ["list"] : ["show", job.id];

      await runCron(args);

      const lines = mocks.runtime.log.mock.calls.flatMap(([line]) => String(line).split("\n"));
      if (surface === "list") {
        const row = lines.find((line) => line.includes(job.id));
        expect(row).toContain("running");
        expect(row).not.toContain("disabled");
      } else {
        expect(lines).toContain("status: running");
        expect(lines).toContain("stream status: disabled");
        expect(lines).toContain("stream error: cron is disabled");
      }

      await runCron([...args, "--json"]);
      const result = mocks.runtime.writeJson.mock.calls.at(-1)?.[0];
      const expected = {
        id: job.id,
        status: "running",
        state: { runningAtMs: job.state.runningAtMs, streamStatus: "disabled" },
      };
      expect(result).toMatchObject(surface === "list" ? { jobs: [expected] } : expected);
    },
  );

  it.each([
    { name: "all jobs as JSON", args: ["--json"], ids: ["job-000", "job-001", "job-002"] },
    { name: "the agent filter", args: ["--json", "--agent", "ops"], ids: ["job-002"] },
    { name: "all jobs as text", args: [], ids: ["job-000", "job-001", "job-002"] },
  ])("lists $name without requiring a fleet owner", async ({ args, ids }) => {
    installRealCronGateway(
      [
        createJob(0, {
          sessionTarget: "isolated",
          payload: { kind: "agentTurn", message: "legacy job" },
          delivery: { mode: "announce" },
        }),
        createJob(1, { agentId: "main" }),
        createJob(2, {
          sessionKey: "agent:ops:main",
          sessionTarget: "isolated",
          payload: { kind: "agentTurn", message: "session-owned job" },
          delivery: { mode: "announce" },
        }),
      ],
      { config: { agents: { entries: { main: {}, ops: {} } } } },
    );

    await runCron(["list", "--all", ...args]);

    if (args.includes("--json")) {
      const result = mocks.runtime.writeJson.mock.calls.at(-1)?.[0] as {
        jobs: Array<CronJob & { effectiveAgentId: string | null }>;
        deliveryPreviews: Record<string, { detail: string }>;
      };
      expect(result.jobs.map((job) => job.id)).toEqual(ids);
      expect(result.jobs.find((job) => job.id === "job-002")).toMatchObject({
        effectiveAgentId: "ops",
        sessionKey: "agent:ops:main",
      });
      if (!args.includes("--agent")) {
        expect(result.jobs[0]).toMatchObject({ effectiveAgentId: null });
        expect(result.jobs[0]?.agentId).toBeUndefined();
        expect(result.jobs[1]).toMatchObject({ agentId: "main", effectiveAgentId: "main" });
        expect(result.deliveryPreviews["job-000"]).toMatchObject({
          detail: expect.stringContaining("Agent-less cron job has no resolvable owner"),
        });
      }
    } else {
      const rendered = mocks.runtime.log.mock.calls.map(([line]) => line).join("\n");
      for (const id of ids) {
        expect(rendered).toContain(id);
      }
      expect(rendered.split("\n").find((line) => line.includes("job-002"))).toContain("ops");
    }
  });

  it.each([
    { root: "cron", json: true, query: "   ", filtered: false },
    { root: "cron", json: false, query: undefined, filtered: false },
    { root: "cron", json: true, query: " Backup ", filtered: true },
    { root: "automations", json: true, query: " Backup ", filtered: true },
  ])(
    "lists every page with $root (json=$json, filtered=$filtered)",
    async ({ root, json, query, filtered }) => {
      const matching = Array.from({ length: 201 }, (_, index) =>
        createJob(
          index,
          filtered ? { name: `backup ${index}`, agentId: "ops", enabled: index % 2 === 0 } : {},
        ),
      );
      installRealCronGateway(
        filtered
          ? [
              ...matching,
              createJob(900, { name: "backup other", agentId: "other" }),
              createJob(901, { name: "unrelated", agentId: "ops" }),
            ]
          : matching,
      );

      await runCron(
        [
          "list",
          ...(filtered ? ["--all", "--agent", "Ops"] : []),
          ...(query === undefined ? [] : ["--query", query]),
          ...(json ? ["--json"] : []),
        ],
        root,
      );

      if (json) {
        const result = runtime.writeJson.mock.calls.at(-1)?.[0] as {
          jobs: CronJob[];
          deliveryPreviews?: Record<string, unknown>;
        };
        expect(result.jobs.map((job) => job.id).toSorted()).toEqual(
          matching.map((job) => job.id).toSorted(),
        );
        if (!filtered) {
          expect(result.deliveryPreviews?.["job-200"]).toEqual(
            expect.objectContaining({ label: "not requested" }),
          );
        }
      } else {
        expect(output("log")).toContain("Job 200");
        expect(output("log").split("\n")).toHaveLength(202);
      }
      const requests = listRequests();
      const filters = {
        includeDisabled: filtered,
        ...(filtered ? { agentId: "ops", query: "Backup" } : {}),
        limit: 200,
      };
      expect(requests.map((call) => call[2])).toEqual([
        { ...filters, offset: 0 },
        { ...filters, offset: 200 },
      ]);
    },
  );

  it("uses the inventory query for visible names in text output and empty JSON results", async () => {
    installRealCronGateway([
      createJob(0, { displayName: "Visible backup" }),
      createJob(1),
      createJob(2, { displayName: "Visible paused", enabled: false }),
    ]);

    await runCron(["list", "--query", "VISIBLE"]);
    expect(output("log")).toContain("Visible backup");
    expect(output("log")).not.toContain("Job 001");
    expect(output("log")).not.toContain("Visible paused");

    await runCron(["list", "--query", "no-matching-automation", "--json"]);
    expect(mocks.runtime.writeJson).toHaveBeenCalledWith(expect.objectContaining({ jobs: [] }));
  });

  it.each([
    { change: "replacement", count: 201, offsets: [0, 200, 0, 200] },
    { change: "shrink", count: 199, offsets: [0, 200, 0] },
  ])("restarts inventory pagination after snapshot $change", async ({ change, count, offsets }) => {
    installRealCronGateway(createJobs(), {
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
    const result = runtime.writeJson.mock.calls.at(-1)?.[0] as { jobs: CronJob[] };
    expect(result.jobs).toHaveLength(count);
    expect(result.jobs.some((job) => job.id === "job-000")).toBe(false);
    if (change === "replacement") {
      expect(result.jobs.some((job) => job.id === "job-900")).toBe(true);
    } else {
      expect(result.jobs.some((job) => job.id === "job-001")).toBe(false);
    }
    expect(listOffsets()).toEqual(offsets);
  });

  it.each([0, 201])("detects and lists a protocol-v4 inventory of %i jobs", async (count) => {
    installRealCronGateway(createJobs(count), { transformListPage: unversionedPage });
    disableCronGetForProtocolV4Gateway();
    await runCron(["list", "--json"]);
    const result = runtime.writeJson.mock.calls.at(-1)?.[0] as { jobs: CronJob[] };
    expect(result.jobs).toHaveLength(count);
    expectRpc("cron.get", {
      id: count ? "job-000" : expect.any(String),
    });
    if (count) {
      expect(result.jobs.some((job) => job.id === "job-200")).toBe(true);
      expect(listRequests()).toHaveLength(2);
    }
  });

  it.each(["mixed protocol", "snapshot revision"])(
    "fails closed for repeated %s churn",
    async (change) => {
      const legacy = change === "mixed protocol";
      installRealCronGateway(createJobs(), {
        transformListPage: legacy
          ? (page, call) => (call % 2 === 0 ? page : unversionedPage(page))
          : undefined,
        beforeList(params, _call, jobs) {
          if (!legacy && params.offset === 200) {
            const first = expectDefined(jobs[0], "expected first cron snapshot job");
            jobs[0] = { ...first, updatedAtMs: first.updatedAtMs + 1 };
          }
        },
      });
      if (legacy) {
        disableCronGetForProtocolV4Gateway();
        await expect(runCronWithJsonOwner(["list", "--json"])).rejects.toThrow(
          "inventory changed repeatedly",
        );
        expect(mocks.runtime.error).not.toHaveBeenCalled();
      } else {
        await expectListFailure("inventory changed repeatedly");
      }
      expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
      expect(listRequests()).toHaveLength(8);
    },
  );

  it.each([
    ["missing job rows", { jobs: undefined }],
    ["missing snapshot revision", { snapshotRevision: undefined }],
    ["a missing terminal cursor", { nextOffset: undefined }],
    [
      "a terminal page exceeding its declared job limit",
      {
        jobs: createJobs(10_001),
        total: 10_001,
        limit: 200,
        hasMore: false,
        nextOffset: null,
      },
    ],
    ["a truncated terminal page", { total: 2 }, "inconsistent terminal inventory page"],
  ] satisfies Array<[string, Record<string, unknown>, string?]>)(
    "fails closed for %s",
    async (_label, patch, error = "invalid inventory page") => {
      installRealCronGateway([createJob(0)], {
        transformListPage(page) {
          return { ...(page as Record<string, unknown>), ...patch };
        },
      });

      await expectListFailure(error);
    },
  );

  it.each([0, 201])(
    "rejects an unversioned current-Gateway inventory of %i jobs",
    async (count) => {
      installRealCronGateway(createJobs(count), { transformListPage: unversionedPage });
      await expectListFailure("invalid inventory page");
      expect(listRequests()).toHaveLength(1);
      expectRpc("cron.get", {
        id: count ? "job-000" : expect.any(String),
      });
      expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
    },
  );

  it("stops a stable oversized cron inventory after the canonical page bound", async () => {
    const jobs = createJobs(200);
    mocks.callGatewayFromCli.mockImplementation(
      async (method: string, _options: unknown, params: { offset?: number } = {}) => {
        if (method !== "cron.list") {
          throw new Error(`unexpected cron method: ${method}`);
        }
        const offset = params.offset ?? 0;
        return {
          jobs,
          snapshotRevision: "stable-oversized-cron-inventory",
          total: 10_001,
          offset,
          limit: 200,
          hasMore: true,
          nextOffset: offset + 200,
        };
      },
    );

    await expectListFailure("pagination exceeded maximum pages");
    expect(mocks.callGatewayFromCli).toHaveBeenCalledTimes(50);
    expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
  });

  it.each(["job-200", "JOB-200"])("prefers ID %s over multiple matching names", async (id) => {
    const nameCollision = createJob(0, { id: "name-owner", name: "job-200" });
    const secondNameCollision = createJob(1, { name: "JOB-200" });
    const actualId = createJob(200, { id: "job-200", name: "Actual ID owner" });
    installRealCronGateway([nameCollision, secondNameCollision, actualId]);

    await runCron(["show", id, "--json"]);

    expect(runtime.writeJson.mock.calls.at(-1)?.[0]).toMatchObject({
      id: "job-200",
      name: "Actual ID owner",
    });
    expectRpc("cron.get", { id });
    expect(listRequests().length > 0).toBe(id !== actualId.id);
  });

  it.each([
    { label: "mixed case", first: "Backup", last: "BACKUP", query: "bAcKuP", json: true },
    { label: "protocol v4", first: "Backup", last: "BACKUP", query: "Backup", legacy: true },
    ...[false, true].map((json) => ({
      label: `terminal controls with json=${json}`,
      first: "backup\u001B]0;name\u0007\r\njob",
      last: "backup\u001B]0;name\u0007\r\njob",
      query: "backup\u001B]0;name\u0007\r\njob",
      json,
    })),
  ])(
    "rejects ambiguous $label across Gateway pages",
    async ({ first, last, query, json = false, legacy = false }) => {
      const jobs = createJobs();
      jobs[0] = createJob(0, { name: first });
      jobs[200] = createJob(200, { name: last, enabled: false });
      installRealCronGateway(
        jobs,
        legacy
          ? {
              transformListPage: unversionedPage,
            }
          : {},
      );
      if (legacy) {
        disableCronGetForProtocolV4Gateway();
      }

      const message =
        "Multiple automations match this name. Retry this command with a matching job ID instead of the name.";
      if (json) {
        const error = await runCronWithJsonOwner(["show", query, "--json"]).catch(
          (caught: unknown) => caught,
        );
        expect(error).toMatchObject({
          name: "ExpectedCliError",
          message,
          machineOutput: message,
        });
        expect(formatCliJsonFailure(error)).toEqual({
          ok: false,
          error: {
            type: "cli_error",
            message,
            matches: [match("job-000", first), match("job-200", last, "every 1m", false)],
          },
        });
      } else {
        await expect(runCron(["show", query])).rejects.toThrow("exit 1");
        expect(mocks.runtime.error).toHaveBeenCalledWith(expect.stringContaining(message));
        const text = output("error");
        expectIncludes(
          text,
          "Matching automations:",
          "job-000",
          "job-200",
          "every 1m; enabled: yes; status: idle",
          "every 1m; enabled: no; status: disabled",
        );
        expect(text).not.toContain("job-001");
        if (query.includes("\u001B")) {
          expect(text).toContain("backup\\r\\njob");
          expect(text).not.toContain("\u001B]");
          expect(text).not.toContain("\u0007");
          expect(text).not.toContain("\r");
        } else {
          expectIncludes(text, first, last);
        }
      }
      expect(mocks.runtime.log).not.toHaveBeenCalled();
      expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
      expect(listOffsets()).toEqual([0, 200]);
    },
  );

  it("lets the caller retry a complete matching ID without exposing job payloads", async () => {
    const longId = `backup-${"0123456789".repeat(5)}`;
    installRealCronGateway([
      createJob(0, {
        id: longId,
        name: "Backup",
        sessionTarget: "isolated",
        payload: {
          kind: "command",
          argv: ["node", "private-payload-command"],
          env: { PRIVATE_VALUE: "private-env-value" },
          input: "private-command-input",
        },
        delivery: { mode: "none" },
      }),
      createJob(1, {
        name: "BACKUP",
        enabled: false,
        schedule: { kind: "on-exit", command: "private-exit-command" },
      }),
      createJob(2, {
        name: "backup",
        schedule: { kind: "stream", command: ["node", "private-stream-command"] },
        sessionTarget: "isolated",
        payload: { kind: "agentTurn", message: "private-agent-prompt" },
        delivery: { mode: "none" },
      }),
      createJob(3, { name: "Unrelated job" }),
    ]);

    await expect(runCron(["show", "Backup"], "automations")).rejects.toThrow("exit 1");
    const text = output("error");
    expectIncludes(
      text,
      `${longId}  Backup`,
      "on-exit; enabled: no; status: disabled",
      "stream; enabled: yes; status: idle",
    );
    expect(text).not.toContain("private-");
    expect(text).not.toContain("Unrelated job");

    const error = await runCronWithJsonOwner(["show", "Backup", "--json"], "automations").catch(
      (caught: unknown) => caught,
    );
    const failure = formatCliJsonFailure(error);
    expect(failure.error.matches).toEqual([
      match(longId, "Backup"),
      match("job-001", "BACKUP", "on-exit", false),
      match("job-002", "backup", "stream"),
    ]);
    expect(JSON.stringify(failure)).not.toContain("private-");
    const selected = expectDefined(failure.error.matches?.[0], "expected a matching job choice");
    const listCalls = listRequests().length;

    await runCron(["show", selected.id, "--json"], "automations");

    expect(mocks.runtime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({ id: longId, name: "Backup" }),
    );
    expect(listRequests()).toHaveLength(listCalls);
  });

  it("preserves hostile stored values in cron show JSON", async () => {
    const name = "job\u001B]0;cron-json\u0007🦞\r\nname";
    const model = "model\u001B[31m\tvariant";
    const lastError = "failed\u001B]0;cron-error\u0007\nreason";
    const job = createJob(123, {
      name,
      payload: { kind: "agentTurn", message: "test", model },
      state: { lastError },
    });
    installRealCronGateway([job]);

    await runCron(["show", job.id, "--json"]);

    const result = runtime.writeJson.mock.calls.at(-1)?.[0] as CronJob;
    expect(result).toMatchObject({ id: job.id, name, payload: { model }, state: { lastError } });
  });

  it("finds an exact cron job name beyond the first real Gateway page", async () => {
    const jobs = createJobs();
    jobs[200] = createJob(200, { name: "Last page exact job" });
    installRealCronGateway(jobs);

    await runCron(["show", "Last page exact job", "--json"]);

    expect(mocks.runtime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({ id: "job-200", name: "Last page exact job" }),
    );
    expect(listOffsets()).toEqual([0, 200]);
  });

  it("never hides Gateway transport errors behind a name-based cron scan", async () => {
    installRealCronGateway([createJob(0)]);
    const invokeGateway = expectDefined(
      mocks.callGatewayFromCli.getMockImplementation(),
      "expected installed real cron Gateway",
    );
    mocks.callGatewayFromCli.mockImplementation(async (...args: unknown[]) => {
      if (args[0] === "cron.get") {
        throw new Error("Gateway transport is unavailable");
      }
      return await invokeGateway(...args);
    });

    await expect(runCron(["show", "job-000", "--json"])).rejects.toThrow("exit 1");

    expect(mocks.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Gateway transport is unavailable"),
    );
    expect(listRequests()).toHaveLength(0);
  });
});
