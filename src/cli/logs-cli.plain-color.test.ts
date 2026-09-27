import { Chalk } from "chalk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultRuntime } from "../runtime.js";
import { runRegisteredCli } from "../test-utils/command-runner.js";
import { registerLogsCli } from "./logs-cli.js";

const { callGatewayFromCli } = vi.hoisted(() => ({ callGatewayFromCli: vi.fn() }));

vi.mock("../../packages/terminal-core/src/theme.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../packages/terminal-core/src/theme.js")>();
  // Force real ANSI styling independently of the test runner's terminal settings.
  const styled = new Chalk({ level: 1 });
  return {
    ...actual,
    isRich: () => true,
    theme: { ...actual.theme, error: styled.red, warn: styled.yellow, muted: styled.gray },
  };
});

vi.mock("../gateway/call.js", () => ({
  buildGatewayConnectionDetails: () => ({
    url: "ws://127.0.0.1:1",
    urlSource: "cli",
    message: "",
  }),
  isGatewayTransportError: () => false,
}));

vi.mock("./gateway-rpc.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./gateway-rpc.js")>()),
  callGatewayFromCli,
}));

vi.mock("../infra/backoff.js", () => ({ computeBackoff: () => 0 }));

async function runLogsCli(args: string[]) {
  await runRegisteredCli({
    register: registerLogsCli,
    argv: ["logs", ...args, "--url", "ws://127.0.0.1:1", "--timeout", "100"],
  });
}

describe("registerLogsCli forced-color diagnostics", () => {
  const stderrWrites: string[] = [];

  beforeEach(() => {
    stderrWrites.length = 0;
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    vi.spyOn(defaultRuntime, "exit").mockReturnValue(undefined);
  });

  afterEach(() => {
    callGatewayFromCli.mockReset();
    vi.restoreAllMocks();
  });

  it("preserves colored error text and exit status by default", async () => {
    callGatewayFromCli.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:1"));

    await runLogsCli([]);

    const stderr = stderrWrites.join("");
    expect(stderr).toContain("ECONNREFUSED");
    expect(stderr).toContain("Hint: run");
    expect(stderr).toContain("\u001b[");
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1, { resetStream: undefined });
  });

  it("keeps reconnect notices and terminal errors plain during --follow", async () => {
    callGatewayFromCli
      .mockRejectedValueOnce(new Error("gateway closed (1006): connection lost"))
      .mockResolvedValueOnce({ lines: [] })
      .mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:1"));

    await runLogsCli(["--plain", "--follow", "--interval", "1"]);

    const stderr = stderrWrites.join("");
    expect(stderr).toContain("[logs] gateway disconnected, reconnecting");
    expect(stderr).toContain("[logs] gateway reconnected");
    expect(stderr).toContain("ECONNREFUSED");
    expect(stderr).toContain("Hint: run");
    expect(stderr).not.toContain("\u001b[");
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1, { resetStream: undefined });
  });
});
