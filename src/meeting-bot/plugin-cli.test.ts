import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { callGatewayFromCli } from "../cli/gateway-rpc.js";
import { registerMeetingPluginCli } from "./plugin-cli.js";
import type { MeetingPluginConfig } from "./plugin-config.js";

function createCli(callGateway: typeof callGatewayFromCli) {
  const program = new Command();
  registerMeetingPluginCli({
    callGateway,
    commandName: "testmeetings",
    config: {} as MeetingPluginConfig,
    descriptions: {
      root: "test meetings",
      join: "join",
      leave: "leave",
      status: "status",
      setup: "setup",
      testSpeech: "test speech",
      testListen: "test listen",
    },
    methodPrefix: "testmeetings",
    program,
    resolveGatewayTimeoutMs: () => 1_000,
  });
  return (...args: string[]) => program.parseAsync(["testmeetings", ...args], { from: "user" });
}

describe("meeting plugin CLI options", () => {
  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it.each([
    ["setup", "--mode", "agnt", "mode must be agent, bidi, or transcribe; received agnt"],
    [
      "setup",
      "--transport",
      "invalid",
      "transport must be chrome or chrome-node; received invalid",
    ],
    ["join", "--mode", "", "mode must be agent, bidi, or transcribe; received "],
    ["join", "--transport", "", "transport must be chrome or chrome-node; received "],
    ["test-listen", "--timeout-ms", "", "timeout-ms must be a positive integer"],
  ])("rejects %s %s '%s' before dispatch", async (command, option, value, error) => {
    const callGateway = vi.fn();
    const args = command === "setup" ? [] : ["https://meet.example.test/room"];
    await expect(createCli(callGateway)(command, ...args, option, value)).rejects.toThrow(error);
    expect(callGateway).not.toHaveBeenCalled();
  });

  it.each([
    { options: [], enums: {} },
    {
      options: ["--mode", "transcribe", "--transport", "chrome-node"],
      enums: { mode: "transcribe", transport: "chrome-node" },
    },
  ])("preserves omitted or valid enums ($options)", async ({ options, enums }) => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const callGateway = vi.fn(async () => ({ ok: true }));
    await createCli(callGateway)("join", "https://meet.example.test/room", ...options);
    expect(callGateway).toHaveBeenCalledExactlyOnceWith(
      "testmeetings.join",
      { json: true, timeout: "1000" },
      { url: "https://meet.example.test/room", ...enums },
      { progress: false, scopes: ["operator.admin"] },
    );
  });

  it("sets a failing process exit code for unhealthy setup status", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const callGateway = vi.fn(async () => ({ ok: false, checks: [] }));

    await createCli(callGateway)("setup");

    expect(callGateway).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
  });
});
