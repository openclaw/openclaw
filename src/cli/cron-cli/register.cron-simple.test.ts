import { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultRuntime } from "../../runtime.js";
import { ExpectedCliError, formatCliJsonFailure } from "../failure-output.js";
import { isCommandJsonOutputMode } from "../program/json-mode.js";

const callGatewayFromCli = vi.fn();
vi.mock("../gateway-rpc.js", async () => {
  const actual = await vi.importActual<typeof import("../gateway-rpc.js")>("../gateway-rpc.js");
  return {
    ...actual,
    callGatewayFromCli: (...args: Parameters<typeof actual.callGatewayFromCli>) =>
      callGatewayFromCli(...args),
  };
});
const { registerCronCli } = await import("./register.js");
const { registerCronSimpleCommands } = await import("./register.cron-simple.js");
const stderrIsTTY = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
async function run(args: string[]) {
  const program = new Command().exitOverride();
  registerCronSimpleCommands(program);
  await program.parseAsync(args, { from: "user" });
}
function mockPages(readPage: (params: { offset?: number }) => unknown, legacy = false) {
  callGatewayFromCli.mockImplementation(
    async (method: string, _opts: unknown, params?: { id?: string; offset?: number }) => {
      if (method === "cron.get") {
        const message = legacy
          ? "unknown method: cron.get"
          : `cron job not found: ${params?.id ?? ""}`;
        throw Object.assign(new Error(message), {
          name: "GatewayClientRequestError",
          gatewayCode: "INVALID_REQUEST",
        });
      }
      if (method === "cron.list") {
        return readPage(params ?? {});
      }
      throw new Error(`unexpected cron method: ${method}`);
    },
  );
}
const listCalls = () => callGatewayFromCli.mock.calls.filter(([method]) => method === "cron.list");
function expectRequest(method: string, params: unknown) {
  expect(callGatewayFromCli).toHaveBeenCalledExactlyOnceWith(method, expect.anything(), params);
}
const page = {
  snapshotRevision: "stable",
  offset: 0,
  limit: 200,
  hasMore: false,
  nextOffset: null,
};
beforeEach(() => {
  callGatewayFromCli
    .mockReset()
    .mockImplementation(async (method: string) =>
      method === "cron.status" ? { enabled: true } : { ok: true },
    );
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "exit").mockImplementation((code) => {
    throw new Error(`exit ${code}`);
  });
});
afterEach(() => {
  if (stderrIsTTY) {
    Object.defineProperty(process.stderr, "isTTY", stderrIsTTY);
  } else {
    Reflect.deleteProperty(process.stderr, "isTTY");
  }
  vi.restoreAllMocks();
});

it("inherits parent Gateway options without losing JSON mode", async () => {
  const program = new Command().name("openclaw");
  registerCronCli(program);
  const argv = ["node", "openclaw", "automations", "--port", "18789", "status"];
  program.hook("preAction", (_parent, command) => {
    expect(isCommandJsonOutputMode(command, argv)).toBe(true);
  });
  await program.parseAsync(argv);
  expect(callGatewayFromCli).toHaveBeenCalledWith(
    "cron.status",
    expect.objectContaining({ port: "18789" }),
    {},
  );
  expect(defaultRuntime.writeJson).toHaveBeenCalledWith({ enabled: true });
});

it.each([
  {
    label: "non-advancing cursor",
    read: () => ({ ...page, jobs: [], total: 1, hasMore: true, nextOffset: 0 }),
    error: "pagination did not advance",
    calls: 1,
  },
  {
    label: "page bound",
    read: ({ offset = 0 }: { offset?: number }) => ({
      ...page,
      jobs: [{ id: `page-${offset}`, name: `Page ${offset}` }],
      total: 51,
      offset,
      hasMore: true,
      nextOffset: offset + 1,
    }),
    error: "pagination exceeded maximum pages",
    calls: 50,
  },
  {
    label: "missing job",
    read: () => ({ ...page, jobs: [], total: 0 }),
    error: "Automation not found: missing. Run `openclaw cron list` to see recent automation ids.",
    calls: 1,
  },
])("cron show rejects $label (#83856)", async ({ read, error, calls }) => {
  mockPages(read);
  await expect(run(["show", "missing", "--json"])).rejects.toThrow("exit 1");
  expect(defaultRuntime.error).toHaveBeenCalledWith(expect.stringContaining(error));
  expect(listCalls()).toHaveLength(calls);
});

it("renders a legacy job without state instead of crashing (#173631)", async () => {
  // Protocol-v4 rows can omit state, formerly crashing printCronShow.
  mockPages(() => ({ jobs: [{ id: "legacy-job", name: "Legacy job", enabled: true }] }), true);
  const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
  await run(["show", "legacy-job"]);
  expect(callGatewayFromCli).toHaveBeenCalledWith("cron.get", expect.anything(), {
    id: "legacy-job",
  });
  const output = log.mock.calls.flat().map(String).join("\n");
  expect(output).toContain("id: legacy-job");
  expect(output).toContain("name: Legacy job");
});

it("emits the hidden-job hint when disabling from a terminal", async () => {
  Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  await run(["disable", "job-1"]);
  expect(callGatewayFromCli).toHaveBeenCalledWith("cron.update", expect.anything(), {
    id: "job-1",
    patch: { enabled: false },
  });
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining("openclaw cron list --all"));
});

it("warns for a known disabled scheduler", async () => {
  callGatewayFromCli.mockImplementation(async (method: string) =>
    method === "cron.status" ? { enabled: false } : { ok: true },
  );
  await run(["enable", "job-1"]);
  expect(defaultRuntime.writeJson).toHaveBeenCalledExactlyOnceWith({ ok: true });
  for (const text of ["scheduler is disabled", "cron.enabled", "OPENCLAW_SKIP_CRON=1"]) {
    expect(defaultRuntime.error).toHaveBeenCalledWith(expect.stringContaining(text));
  }
});

it.each([
  { args: ["--all"], selector: { scope: "all" } },
  { args: ["--id", "job-1"], selector: { id: "job-1" } },
])("cron runs preserves default paging for $args", async ({ args, selector }) => {
  const response = { entries: [], total: 0 };
  callGatewayFromCli.mockResolvedValueOnce(response);
  await run(["runs", ...args]);
  expectRequest("cron.runs", { ...selector, limit: 50 });
  expect(defaultRuntime.writeJson).toHaveBeenCalledWith(response);
});

it("retains filters and pagination in the all-jobs request", async () => {
  await run(
    (
      "runs --all --status error --delivery-status not-delivered --query timeout " +
      "--sort asc --offset 1 --limit 2 --run-id run-1"
    ).split(" "),
  );
  expectRequest("cron.runs", {
    scope: "all",
    status: "error",
    deliveryStatus: "not-delivered",
    query: "timeout",
    sortDir: "asc",
    offset: 1,
    limit: 2,
    runId: "run-1",
  });
});

it("rejects --all combined with a supplied selector before RPC", async () => {
  await expect(run(["runs", "--all", "job-1"])).rejects.toThrow("exit 1");
  expect(defaultRuntime.error).toHaveBeenCalledWith("--all cannot be combined with a job id");
  expect(callGatewayFromCli).not.toHaveBeenCalled();
});

it("reports an invalid offset as an expected JSON failure before RPC", async () => {
  const program = new Command().name("openclaw").exitOverride();
  registerCronCli(program);
  const argv = process.argv;
  process.argv = [...argv.slice(0, 2), "cron", "runs", "job-1", "--offset", "-1", "--json"];
  try {
    const thrown = await program.parseAsync(process.argv).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(ExpectedCliError);
    expect(formatCliJsonFailure(thrown)).toEqual({
      ok: false,
      error: { type: "cli_error", message: "Invalid --offset (must be a non-negative integer)." },
    });
    expect(callGatewayFromCli).not.toHaveBeenCalled();
  } finally {
    process.argv = argv;
  }
});
