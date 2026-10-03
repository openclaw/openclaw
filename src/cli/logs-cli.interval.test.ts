import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { Command } from "commander";
import { beforeEach, expect, it, vi } from "vitest";
import { registerLogsCli } from "./logs-cli.js";

const mocks = vi.hoisted(() => ({
  delay: vi.fn(async (_milliseconds: number) => {
    throw new Error("stop polling fixture");
  }),
  callGateway: vi.fn(async () => ({ cursor: 1, lines: [] })),
}));

vi.mock("node:timers/promises", () => ({ setTimeout: mocks.delay }));

vi.mock("../gateway/call.js", () => ({
  buildGatewayConnectionDetails: () => ({
    url: "ws://127.0.0.1:18789",
    urlSource: "local loopback",
    message: "",
  }),
  isGatewayTransportError: () => false,
}));

vi.mock("./gateway-rpc.js", () => ({
  addGatewayClientOptions: (command: Command) => command,
  callGatewayFromCli: mocks.callGateway,
}));

beforeEach(() => vi.clearAllMocks());

function runLogs(args: string[]) {
  const program = new Command();
  registerLogsCli(program);
  return program.parseAsync(["logs", ...args], { from: "user" });
}

it.each([
  { value: undefined, expected: 1000 },
  { value: "1", expected: 1 },
  { value: "2000", expected: 2000 },
  { value: String(MAX_TIMER_TIMEOUT_MS), expected: MAX_TIMER_TIMEOUT_MS },
  { value: "2147483648", expected: MAX_TIMER_TIMEOUT_MS },
  { value: String(Number.MAX_SAFE_INTEGER), expected: MAX_TIMER_TIMEOUT_MS },
])("keeps follow interval $value within the safe timer range", async ({ value, expected }) => {
  await expect(
    runLogs(["--follow", ...(value === undefined ? [] : ["--interval", value])]),
  ).rejects.toThrow("stop polling fixture");

  expect(mocks.callGateway).toHaveBeenCalledTimes(1);
  expect(mocks.delay).toHaveBeenCalledTimes(1);
  expect(mocks.delay).toHaveBeenCalledWith(expected);
});

it("does not schedule polling for a one-shot log read", async () => {
  await runLogs(["--interval", "2147483648"]);
  expect(mocks.callGateway).toHaveBeenCalledTimes(1);
  expect(mocks.delay).not.toHaveBeenCalled();
});

it.each(["0", "1s"])("still rejects invalid interval %s before fetching logs", async (value) => {
  await expect(runLogs(["--follow", "--interval", value])).rejects.toThrow(
    "--interval must be a positive integer.",
  );
  expect(mocks.callGateway).not.toHaveBeenCalled();
  expect(mocks.delay).not.toHaveBeenCalled();
});
