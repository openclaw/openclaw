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

it("caps an overflowing follow interval at the safe timer maximum", async () => {
  await expect(runLogs(["--follow", "--interval", "2147483648"])).rejects.toThrow(
    "stop polling fixture",
  );
  expect(mocks.callGateway).toHaveBeenCalledTimes(1);
  expect(mocks.delay).toHaveBeenCalledTimes(1);
  expect(mocks.delay).toHaveBeenCalledWith(MAX_TIMER_TIMEOUT_MS);
});
