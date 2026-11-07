import { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
const { registerCronCli } = await import("./register.js");

function program() {
  const command = new Command().name("openclaw").exitOverride();
  registerCronCli(command);
  return command;
}
const run = (args: string[]) =>
  program().parseAsync(["cron", "history", ...args], { from: "user" });

beforeEach(() => {
  callGatewayFromCli.mockReset().mockResolvedValue({ ok: true });
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "exit").mockImplementation((code) => {
    throw new Error(`exit ${code}`);
  });
});
afterEach(() => vi.restoreAllMocks());

it("maps the selected job and run to the existing history RPC", async () => {
  await run(["job-1", "--run-id", "run-1"]);
  expect(callGatewayFromCli).toHaveBeenCalledExactlyOnceWith("cron.history", expect.anything(), {
    id: "job-1",
    runId: "run-1",
  });
});

it("forwards an opaque cursor unchanged and leaves page limits to the Gateway", async () => {
  const cursor = " opaque-bound-cursor+/=:%20 ";
  await run(["job-1", "--run-id", "run-1", "--cursor", cursor, "--limit", "201"]);
  expect(callGatewayFromCli).toHaveBeenCalledExactlyOnceWith("cron.history", expect.anything(), {
    id: "job-1",
    runId: "run-1",
    cursor,
    limit: 201,
  });
});

it("inherits the automations alias, parent connection options, and JSON mode", async () => {
  const command = program();
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
  command.hook("preAction", (_parent, action) => {
    expect(isCommandJsonOutputMode(action, argv)).toBe(true);
  });
  await command.parseAsync(argv);
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
  await expect(run(args)).rejects.toThrow(error);
  expect(callGatewayFromCli).not.toHaveBeenCalled();
});

it("uses the existing structured JSON failure for an unavailable transcript", async () => {
  callGatewayFromCli.mockRejectedValueOnce(
    new GatewayClientRequestError({ code: "UNAVAILABLE", message: "Cron history is unavailable" }),
  );
  const argv = process.argv;
  process.argv = [...argv.slice(0, 2), "cron", "history", "job-1", "--run-id", "run-1", "--json"];
  try {
    const error = await run(process.argv.slice(4)).catch((caughtError: unknown) => caughtError);
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
