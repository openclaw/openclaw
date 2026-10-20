import "../test-utils/prepare-compiled-subprocesses.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  programGatewayCallMock,
  configureCommand,
  ensureConfigReadyMock,
  runtime,
  setupCommandMock,
  setupWizardCommandMock,
  systemAgentRunMock,
  tuiRunMock,
} from "./program.test-mocks.js";
import { buildProgram } from "./program/build-program.js";

vi.mock("./config-cli.js", () => ({
  registerConfigCli: (program: {
    command: (name: string) => { action: (fn: () => unknown) => void };
  }) => {
    program.command("config").action(() => configureCommand({}, runtime));
  },
  runConfigGet: vi.fn(),
  runConfigUnset: vi.fn(),
}));

describe("cli program (smoke)", () => {
  let program = buildProgram();

  async function runProgram(argv: string[]) {
    await program.parseAsync(argv, { from: "user" });
  }

  function expectTui(options: object) {
    expect(tuiRunMock).toHaveBeenNthCalledWith(1, expect.objectContaining(options));
  }

  async function expectRejected(argv: string[], message: string) {
    await expect(runProgram(argv)).rejects.toThrow("exit");
    expect(runtime.error).toHaveBeenCalledWith(message);
    expect(tuiRunMock).not.toHaveBeenCalled();
  }

  beforeEach(() => {
    program = buildProgram();
    vi.clearAllMocks();
    tuiRunMock.mockResolvedValue(undefined);
    systemAgentRunMock.mockResolvedValue(undefined);
    ensureConfigReadyMock.mockResolvedValue(undefined);
  });

  it("runs tui with explicit timeout override", async () => {
    await runProgram(["tui", "--timeout-ms", "45000"]);
    expectTui({ timeoutMs: 45000, historyLimit: 200 });
    expect(tuiRunMock.mock.calls[0]?.[0]).not.toHaveProperty("agentId");
  });

  it("resolves a positional tui short reference before launch", async () => {
    programGatewayCallMock.mockResolvedValue({ ok: true, key: "agent:main:thread:resolved" });

    await runProgram(["tui", "movies-a1166b81"]);

    expect(programGatewayCallMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "sessions.resolve",
        params: { shortId: "a1166b81", slugHint: "movies" },
      }),
    );
    expectTui({
      local: false,
      session: "agent:main:thread:resolved",
    });
  });

  it("preserves a global-scope URL main session when launching tui", async () => {
    programGatewayCallMock.mockResolvedValue({
      defaultId: "main",
      mainKey: "main",
      scope: "global",
      agents: [],
    });

    await runProgram(["tui", "https://gateway.example/dashboard/ops"]);

    expect(programGatewayCallMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "agents.list",
        params: {},
      }),
    );
    expectTui({
      local: false,
      session: "global",
      agentId: "ops",
    });
  });

  it("preserves the resolved global owner when launching tui from an agent key", async () => {
    programGatewayCallMock.mockResolvedValue({ ok: true, key: "global", agentId: "ops" });

    await runProgram(["tui", "agent:ops:main"]);

    expectTui({ session: "global", agentId: "ops" });
  });

  it("rejects a URL target combined with --url", async () => {
    await expect(
      runProgram([
        "tui",
        "https://gateway.example/dashboard/main/movies-a1166b81",
        "--url",
        "wss://other.example",
      ]),
    ).rejects.toThrow("exit");

    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("pass one target"));
    expect(tuiRunMock).not.toHaveBeenCalled();
  });

  it("runs setup one-shot requests", async () => {
    await runProgram(["setup", "--message", "status"]);
    expect(systemAgentRunMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ message: "status", yes: false, json: false }),
      runtime,
    );
  });

  it("warns and ignores invalid tui timeout override", async () => {
    await runProgram(["tui", "--timeout-ms", "nope"]);
    expect(runtime.error).toHaveBeenCalledWith('warning: invalid --timeout-ms "nope"; ignoring');
    expectTui({ timeoutMs: undefined });
  });

  it("rejects partial tui history limits", async () => {
    await expectRejected(
      ["tui", "--history-limit", "10x"],
      "--history-limit must be a positive integer.",
    );
  });

  it("preserves oversized history limits for local chat", async () => {
    await runProgram(["chat", "--history-limit", "1001"]);

    expectTui({ local: true, historyLimit: 1001 });
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("rejects tui history limits above the Gateway maximum", async () => {
    await expectRejected(
      ["tui", "--history-limit", "1001"],
      "--history-limit must be at most 1000.",
    );
  });

  it("runs setup wizard when wizard flags are present", async () => {
    await runProgram(["setup", "--remote-url", "ws://example"]);

    expect(setupCommandMock).not.toHaveBeenCalled();
    expect(setupWizardCommandMock).toHaveBeenCalledTimes(1);
  });
});
