import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultRuntime } from "../../runtime.js";
import { registerCronAddCommand } from "./register.cron-add.js";

const callGatewayMock = vi.hoisted(() => vi.fn());
vi.mock("../gateway-rpc.js", () => ({
  addGatewayClientOptions: (cmd: Command) => cmd,
  callGatewayFromCli: callGatewayMock,
}));

const warnMock = vi.hoisted(() => vi.fn());
vi.mock("./shared.js", () => ({
  getCronChannelOptions: () => "telegram,whatsapp",
  handleCronCliError: (err: unknown) => {
    throw err;
  },
  parseCronToolsAllow: vi.fn().mockReturnValue(undefined),
  printCronJson: vi.fn(),
  printCronList: vi.fn(),
  warnIfCronSchedulerDisabled: warnMock,
}));

// Mock schedule-options so we don't drag in shared.js parse functions
vi.mock("./schedule-options.js", () => ({
  addScheduleOptions: (cmd: Command) => cmd,
  resolveCronCreateSchedule: vi.fn().mockReturnValue({
    kind: "agentTurn",
    every: 3600000,
    requestedStaggerMs: undefined,
  }),
  resolveCronEditScheduleRequest: vi.fn().mockReturnValue({}),
}));

describe("cron add --dry-run", () => {
  let program: Command;
  let writeStdoutSpy: ReturnType<typeof vi.spyOn>;
  let writeJsonSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    program = new Command().exitOverride();
    program.configureOutput({ writeErr: () => {} });
    callGatewayMock.mockReset();
    warnMock.mockReset();
    writeStdoutSpy = vi.spyOn(defaultRuntime, "writeStdout").mockImplementation(() => {});
    writeJsonSpy = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints params preview and skips RPC when --dry-run is passed", async () => {
    const cron = program.command("cron");
    registerCronAddCommand(cron);

    await program.parseAsync(
      [
        "node",
        "openclaw",
        "cron",
        "add",
        "--name",
        "my-job",
        "--message",
        "hello",
        "--every",
        "1h",
        "--dry-run",
      ],
      { from: "node" },
    );

    expect(callGatewayMock).not.toHaveBeenCalled();
    expect(warnMock).not.toHaveBeenCalled();
    expect(writeJsonSpy).not.toHaveBeenCalled();
    expect(writeStdoutSpy).toHaveBeenCalledOnce();
    const output = writeStdoutSpy.mock.calls[0][0] as string;
    expect(output).toMatch(/Dry run/);
    expect(output).toMatch(/"name":\s*"my-job"/);
    expect(output).toMatch(/"kind":\s*"agentTurn"/);
  });

  it("emits raw JSON via writeJson when --dry-run --json are both passed", async () => {
    const cron = program.command("cron");
    registerCronAddCommand(cron);

    await program.parseAsync(
      [
        "node",
        "openclaw",
        "cron",
        "add",
        "--name",
        "my-job",
        "--message",
        "hello",
        "--every",
        "1h",
        "--dry-run",
        "--json",
      ],
      { from: "node" },
    );

    expect(callGatewayMock).not.toHaveBeenCalled();
    expect(writeStdoutSpy).not.toHaveBeenCalled();
    expect(writeJsonSpy).toHaveBeenCalledOnce();
    const params = writeJsonSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(params).toMatchObject({ name: "my-job" });
  });

  it("--dry-run --json output is a plain object with no human-readable wrapper text", async () => {
    const cron = program.command("cron");
    registerCronAddCommand(cron);

    await program.parseAsync(
      [
        "node",
        "openclaw",
        "cron",
        "add",
        "--name",
        "json-purity-test",
        "--message",
        "ping",
        "--every",
        "30m",
        "--dry-run",
        "--json",
      ],
      { from: "node" },
    );

    expect(writeStdoutSpy).not.toHaveBeenCalled();
    expect(writeJsonSpy).toHaveBeenCalledOnce();

    const params = writeJsonSpy.mock.calls[0][0];
    // Must be a plain object, not a string (no "Dry run — …" prefix wrapping)
    expect(typeof params).toBe("object");
    expect(params).not.toBeNull();
    expect(typeof params).not.toBe("string");
    // Spot-check expected fields are present at top level (not buried in a string)
    expect(params).toMatchObject({ name: "json-purity-test" });
    expect(params).toHaveProperty("payload");
    expect(params).toHaveProperty("schedule");
  });
});
