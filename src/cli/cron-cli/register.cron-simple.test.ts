import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../../../packages/gateway-client/src/request-error.js";
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
const { isCronMachineOutput } = await import("./output-mode.js");
const { registerCronCli } = await import("./register.js");
const { registerCronSimpleCommands } = await import("./register.cron-simple.js");
const stderrIsTTY = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
async function run(args: string[]) {
  const program = new Command().exitOverride();
  registerCronSimpleCommands(program);
  await program.parseAsync(args, { from: "user" });
}
function mockPages(readPage: (params: { offset?: number }) => unknown) {
  callGatewayFromCli.mockImplementation(
    async (method: string, _opts: unknown, params?: { id?: string; offset?: number }) => {
      if (method === "cron.get") {
        throw Object.assign(new Error(`cron job not found: ${params?.id ?? ""}`), {
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

describe("cron output routing", () => {
  it("aligns early stdout routing with the registered command output modes", () => {
    const program = new Command().name("openclaw");
    registerCronCli(program);
    const cron = program.commands.find((command) => command.name() === "cron");
    expect(cron).toBeDefined();
    const gatewayOptions = [
      [],
      ["--url", "ws://127.0.0.1:18789"],
      ["--port", "18789"],
      ["--token", "test-token"],
      ["--password", "test-password"],
      ["--timeout", "250"],
      ["--expect-final"],
      ["--port=18789"],
      ["--timeout", "250", "--expect-final"],
      ["--log-level", "debug", "--port", "18789"],
    ];
    for (const command of cron!.commands) {
      const alwaysJson =
        command.options.find((option) => option.long === "--json")?.description ===
        "Explicit machine-output spelling (command results are JSON by default)";
      for (const name of [command.name(), ...command.aliases()]) {
        for (const root of ["cron", "automations"]) {
          for (const options of gatewayOptions) {
            const argv = ["node", "openclaw", root, ...options, name];
            expect(isCronMachineOutput(argv), argv.join(" ")).toBe(
              command.name() === "scratch" || alwaysJson,
            );
          }
        }
      }
    }
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
});

describe("cron show pagination (#83856)", () => {
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
      error:
        "Automation not found: missing. Run `openclaw cron list` to see recent automation ids.",
      calls: 1,
    },
  ])("rejects $label", async ({ read, error, calls }) => {
    mockPages(read);
    await expect(run(["show", "missing", "--json"])).rejects.toThrow("exit 1");
    expect(defaultRuntime.error).toHaveBeenCalledWith(expect.stringContaining(error));
    expect(callGatewayFromCli.mock.calls.filter(([method]) => method === "cron.list")).toHaveLength(
      calls,
    );
  });
  it("finds an exact name beyond the first page", async () => {
    mockPages(({ offset = 0 }) => ({
      ...page,
      total: 201,
      offset,
      hasMore: offset === 0,
      nextOffset: offset === 0 ? 200 : null,
      jobs: offset
        ? [{ id: "abc", name: "wanted" }]
        : Array.from({ length: 200 }, (_, index) => ({
            id: `page-${index}`,
            name: `Page ${index}`,
          })),
    }));
    await run(["show", "wanted", "--json"]);
    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(expect.objectContaining({ id: "abc" }));
    expect(callGatewayFromCli.mock.calls.filter(([method]) => method === "cron.list")).toHaveLength(
      2,
    );
  });
});

it.each([
  ["disable", false, false],
  ["disable", true, true],
  ["enable", true, false],
] as const)("%s with stderr TTY=%s emits hint=%s", async (command, tty, hint) => {
  Object.defineProperty(process.stderr, "isTTY", { value: tty, configurable: true });
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  await run([command, "job-1"]);
  expect(callGatewayFromCli).toHaveBeenCalledWith("cron.update", expect.anything(), {
    id: "job-1",
    patch: { enabled: command === "enable" },
  });
  if (hint) {
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("openclaw cron list --all"));
  } else {
    expect(stderr).not.toHaveBeenCalled();
  }
});

it.each([undefined, { enabled: false }])(
  "warns only for a known disabled scheduler: %j",
  async (status) => {
    callGatewayFromCli.mockImplementation(async (method: string) =>
      method === "cron.status" ? status : { ok: true },
    );
    await run(["enable", "job-1"]);
    expect(defaultRuntime.writeJson).toHaveBeenCalledExactlyOnceWith({ ok: true });
    if (status) {
      for (const text of ["scheduler is disabled", "cron.enabled", "OPENCLAW_SKIP_CRON=1"]) {
        expect(defaultRuntime.error).toHaveBeenCalledWith(expect.stringContaining(text));
      }
    } else {
      expect(defaultRuntime.error).not.toHaveBeenCalled();
    }
  },
);

describe("cron history", () => {
  it("returns the selected transcript page as JSON without changing its messages", async () => {
    const historyPage = {
      messages: [{ role: "assistant", content: [{ type: "text", text: "report".repeat(1_000) }] }],
      activity: [{ kind: "compaction", id: "activity-1" }],
      nextCursor: "opaque-bound-cursor+/=:%20",
    };
    callGatewayFromCli.mockResolvedValueOnce(historyPage);
    await run(["history", "job-1", "--run-id", "run-1"]);
    expect(callGatewayFromCli).toHaveBeenCalledExactlyOnceWith("cron.history", expect.anything(), {
      id: "job-1",
      runId: "run-1",
    });
    expect(defaultRuntime.writeJson).toHaveBeenCalledExactlyOnceWith(historyPage);
  });

  it("forwards an opaque cursor unchanged and leaves page limits to the Gateway", async () => {
    const cursor = " opaque-bound-cursor+/=:%20 ";
    await run(["history", "job-1", "--run-id", "run-1", "--cursor", cursor, "--limit", "201"]);
    expect(callGatewayFromCli).toHaveBeenCalledExactlyOnceWith("cron.history", expect.anything(), {
      id: "job-1",
      runId: "run-1",
      cursor,
      limit: 201,
    });
  });

  it("inherits the automations alias, parent connection options, and JSON mode", async () => {
    const program = new Command().name("openclaw").exitOverride();
    registerCronCli(program);
    const argv = [
      "node",
      "openclaw",
      "automations",
      "--port",
      "18789",
      "--token",
      "test-token",
      "history",
      "job-1",
      "--run-id",
      "run-1",
    ];
    program.hook("preAction", (_parent, command) => {
      expect(isCommandJsonOutputMode(command, argv)).toBe(true);
    });
    await program.parseAsync(argv);
    expect(callGatewayFromCli).toHaveBeenCalledExactlyOnceWith(
      "cron.history",
      expect.objectContaining({ port: "18789", token: "test-token" }),
      { id: "job-1", runId: "run-1" },
    );
  });

  it.each([
    { args: ["--run-id", "run-1"], error: /missing required argument/ },
    { args: ["job-1"], error: /required option/ },
    { args: ["  ", "--run-id", "run-1"], error: /exit 1/ },
    { args: ["job-1", "--run-id", "  "], error: /exit 1/ },
    { args: ["job-1", "--run-id", "run-1", "--cursor", "  "], error: /exit 1/ },
    { args: ["job-1", "--run-id", "run-1", "--limit", "0"], error: /exit 1/ },
    { args: ["job-1", "--run-id", "run-1", "--limit", "2x"], error: /exit 1/ },
  ])("rejects invalid selection or paging before RPC: $args", async ({ args, error }) => {
    await expect(run(["history", ...args])).rejects.toThrow(error);
    expect(callGatewayFromCli).not.toHaveBeenCalled();
  });

  it("uses the existing structured JSON failure for an unavailable transcript", async () => {
    callGatewayFromCli.mockRejectedValueOnce(
      new GatewayClientRequestError({
        code: "UNAVAILABLE",
        message: "Cron history is unavailable",
      }),
    );
    const argv = process.argv;
    process.argv = [...argv.slice(0, 2), "cron", "history", "job-1", "--run-id", "run-1", "--json"];
    try {
      const error = await run(process.argv.slice(3)).catch((caughtError: unknown) => caughtError);
      expect(error).toBeInstanceOf(ExpectedCliError);
      expect(formatCliJsonFailure(error)).toEqual({
        ok: false,
        error: { type: "cli_error", message: "Cron history is unavailable" },
      });
      expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
    } finally {
      process.argv = argv;
    }
  });
});

describe("cron runs", () => {
  it("queries all visible automations without a job selector", async () => {
    callGatewayFromCli.mockResolvedValueOnce({ entries: [], total: 0 });
    await run(["runs", "--all"]);
    expect(callGatewayFromCli).toHaveBeenCalledExactlyOnceWith("cron.runs", expect.anything(), {
      scope: "all",
      limit: 50,
    });
    expect(defaultRuntime.writeJson).toHaveBeenCalledWith({ entries: [], total: 0 });
  });

  it("retains filters and pagination in the all-jobs request", async () => {
    await run([
      "runs",
      "--all",
      "--status",
      "error",
      "--delivery-status",
      "not-delivered",
      "--query",
      "timeout",
      "--sort",
      "asc",
      "--offset",
      "1",
      "--limit",
      "2",
      "--run-id",
      "run-1",
    ]);
    expect(callGatewayFromCli).toHaveBeenCalledExactlyOnceWith("cron.runs", expect.anything(), {
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

  it.each([["job-1"], ["--id", "job-1"], [""], ["--id", "  "]].map((selector) => ({ selector })))(
    "rejects --all combined with a supplied selector %j before RPC",
    async ({ selector }) => {
      await expect(run(["runs", "--all", ...selector])).rejects.toThrow("exit 1");
      expect(defaultRuntime.error).toHaveBeenCalledWith("--all cannot be combined with a job id");
      expect(callGatewayFromCli).not.toHaveBeenCalled();
    },
  );

  it.each(["cron", "automations"])("registers --all through the %s root", async (root) => {
    const program = new Command().name("openclaw").exitOverride();
    registerCronCli(program);
    await program.parseAsync([root, "runs", "--all"], { from: "user" });
    expect(callGatewayFromCli).toHaveBeenCalledExactlyOnceWith("cron.runs", expect.anything(), {
      scope: "all",
      limit: 50,
    });
  });

  it("forwards filters, first-page offset, and sort", async () => {
    await run([
      "runs",
      "job-1",
      "--status",
      "error",
      "--delivery-status",
      "not-delivered",
      "--query",
      "timeout",
      "--offset",
      "0",
      "--sort",
      "asc",
      "--limit",
      "25",
    ]);
    expect(callGatewayFromCli).toHaveBeenCalledWith("cron.runs", expect.anything(), {
      id: "job-1",
      status: "error",
      deliveryStatus: "not-delivered",
      query: "timeout",
      offset: 0,
      sortDir: "asc",
      limit: 25,
    });
  });
  it("preserves default paging and the --id alias", async () => {
    await run(["runs", "--id", "job-1"]);
    expect(callGatewayFromCli).toHaveBeenCalledWith("cron.runs", expect.anything(), {
      id: "job-1",
      limit: 50,
    });
  });
  it("rejects invalid offsets before RPC", async () => {
    await expect(run(["runs", "job-1", "--offset", "-1"])).rejects.toThrow("exit 1");
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      "Invalid --offset (must be a non-negative integer).",
    );
    expect(callGatewayFromCli).not.toHaveBeenCalled();
  });
  it("reports an invalid offset as an expected JSON failure before RPC", async () => {
    const program = new Command().name("openclaw").exitOverride();
    registerCronCli(program);
    const argv = process.argv;
    process.argv = [...argv.slice(0, 2), "cron", "runs", "job-1", "--offset", "-1", "--json"];
    try {
      let thrown: unknown;
      try {
        await program.parseAsync(process.argv);
      } catch (error) {
        thrown = error;
      }
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
});
