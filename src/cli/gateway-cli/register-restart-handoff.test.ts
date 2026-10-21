import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runRegisteredCli } from "../../test-utils/command-runner.js";
import { addGatewayRestartHandoffCommands } from "./register-restart-handoff.js";

const mocks = vi.hoisted(() => ({
  consumeGatewayRestartHandoffSync: vi.fn(),
  defaultRuntime: {
    error: vi.fn(),
    writeJson: vi.fn(),
    exit: vi.fn(),
  },
}));

vi.mock("../../infra/restart-handoff.js", () => ({
  consumeGatewayRestartHandoffSync: (opts: unknown) => mocks.consumeGatewayRestartHandoffSync(opts),
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: mocks.defaultRuntime,
}));

function registerGatewayRestartHandoffCli(program: Command): void {
  addGatewayRestartHandoffCommands(program.command("gateway"));
}

const run = (...args: string[]) =>
  runRegisteredCli({
    register: registerGatewayRestartHandoffCli,
    argv: ["gateway", "restart-handoff", ...args, "--json"],
  });
const protocol = { protocol: "openclaw.gateway.restart-handoff", protocolVersion: 1 };
function expectJson(fields: Record<string, unknown>) {
  expect(mocks.defaultRuntime.writeJson).toHaveBeenCalledWith({
    ...protocol,
    ...fields,
  });
}
function expectError(reason: string, exitCode: number) {
  expectJson({ ok: false, status: "error", reason });
  expect(mocks.defaultRuntime.exit).toHaveBeenCalledWith(exitCode);
}

describe("gateway restart-handoff commands", () => {
  beforeEach(() => {
    mocks.consumeGatewayRestartHandoffSync.mockReset();
    mocks.defaultRuntime.error.mockReset();
    mocks.defaultRuntime.writeJson.mockReset();
    mocks.defaultRuntime.exit.mockReset();
  });

  it("keeps the machine command group out of normal gateway help", () => {
    const program = new Command();
    const gateway = program.command("gateway");
    addGatewayRestartHandoffCommands(gateway);

    expect(gateway.helpInformation()).not.toContain("restart-handoff");
  });

  it("reports protocol version 1 capabilities", async () => {
    await run("capabilities");

    expectJson({ ok: true, operations: ["consume"] });
  });

  it("forwards a validated expected PID and wraps the consume result", async () => {
    mocks.consumeGatewayRestartHandoffSync.mockReturnValue({ status: "none", reason: "missing" });
    await run("consume", "--expected-pid", "4242");

    expect(mocks.consumeGatewayRestartHandoffSync).toHaveBeenCalledWith({ expectedPid: 4242 });
    expectJson({ ok: true, status: "none", reason: "missing" });
  });

  it.each([
    { name: "missing", args: [] },
    { name: "valueless", args: ["--expected-pid"] },
    { name: "unsafe", args: ["--expected-pid", "9007199254740992"] },
    { name: "dash-prefixed malformed", args: ["--expected-pid", "-invalid"] },
    { name: "valid with an unknown option", args: ["--expected-pid", "4242", "--unknown"] },
    { name: "repeated", args: ["--expected-pid", "111", "--expected-pid", "222"] },
  ])("rejects $name expected PID values before touching the handoff store", async ({ args }) => {
    await run("consume", ...args);

    expect(mocks.consumeGatewayRestartHandoffSync).not.toHaveBeenCalled();
    expectError("invalid-expected-pid", 2);
  });

  it("returns a stable machine error when the handoff store is unavailable", async () => {
    mocks.consumeGatewayRestartHandoffSync.mockImplementation(() => {
      throw new Error("database locked");
    });

    await run("consume", "--expected-pid", "4242");

    expect(mocks.defaultRuntime.error).toHaveBeenCalledWith(
      "Gateway restart handoff consume failed: Error: database locked",
    );
    expectError("store-unavailable", 1);
  });
});
