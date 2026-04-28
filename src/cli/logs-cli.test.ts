import { afterEach, describe, expect, it, vi } from "vitest";
import { runRegisteredCli } from "../test-utils/command-runner.js";
import { formatLogTimestamp, registerLogsCli } from "./logs-cli.js";

const { callGatewayFromCli, readConfiguredLogTail, buildGatewayConnectionDetails } = vi.hoisted(
  () => ({
    callGatewayFromCli: vi.fn(),
    readConfiguredLogTail: vi.fn(),
    buildGatewayConnectionDetails: vi.fn(
      (_options?: {
        configPath?: string;
        config?: unknown;
        url?: string;
        urlSource?: "cli" | "env";
      }) => ({
        url: "ws://127.0.0.1:18789",
        urlSource: "local loopback",
        message: "",
      }),
    ),
  }),
);

vi.mock("../gateway/call.js", () => ({
  buildGatewayConnectionDetails: (
    ...args: Parameters<typeof import("../gateway/call.js").buildGatewayConnectionDetails>
  ) => buildGatewayConnectionDetails(...args),
}));

vi.mock("../logging/log-tail.js", () => ({
  readConfiguredLogTail: (
    ...args: Parameters<typeof import("../logging/log-tail.js").readConfiguredLogTail>
  ) => readConfiguredLogTail(...args),
}));

vi.mock("./gateway-rpc.js", async () => {
  const actual = await vi.importActual<typeof import("./gateway-rpc.js")>("./gateway-rpc.js");
  return {
    ...actual,
    callGatewayFromCli: (...args: Parameters<typeof actual.callGatewayFromCli>) =>
      callGatewayFromCli(...args),
  };
});

async function runLogsCli(argv: string[]) {
  await runRegisteredCli({
    register: registerLogsCli as (program: import("commander").Command) => void,
    argv,
  });
}

function captureStdoutWrites() {
  const writes: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  });
  return writes;
}

function captureStderrWrites() {
  const writes: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  });
  return writes;
}

describe("logs cli", () => {
  afterEach(() => {
    callGatewayFromCli.mockClear();
    readConfiguredLogTail.mockClear();
    buildGatewayConnectionDetails.mockClear();
    vi.restoreAllMocks();
  });

  it("writes output directly to stdout/stderr", async () => {
    callGatewayFromCli.mockResolvedValueOnce({
      file: "/tmp/openclaw.log",
      cursor: 1,
      size: 123,
      lines: ["raw line"],
      truncated: true,
    });
    readConfiguredLogTail.mockReturnValue(["hello"]);

    await runLogsCli(["logs", "tail", "-f", "stdout"]);

    expect(callGatewayFromCli).toHaveBeenCalled();
    expect(buildGatewayConnectionDetails).toHaveBeenCalled();
    expect(readConfiguredLogTail).toHaveBeenCalled();
  });

  it("prints --help without erroring", async () => {
    const stderrWrites = captureStderrWrites();
    const stdoutWrites = captureStdoutWrites();

    await runLogsCli(["logs", "tail", "--help"]);

    expect(stderrWrites.join("")).toBe("");
    expect(stdoutWrites.join("")).toContain("Tail the OpenClaw gateway log");
  });

  it("supports --since flag", async () => {
    callGatewayFromCli.mockResolvedValueOnce({
      file: "/tmp/openclaw.log",
      cursor: 1,
      size: 123,
      lines: ["2024-01-01 12:00:00 hello"],
      truncated: false,
    });

    const stdoutWrites = captureStdoutWrites();
    await runLogsCli(["logs", "tail", "--since", "2024-01-01"]);

    expect(stdoutWrites.join("")).toContain("2024-01-01");
  });

  it("filters by log level", async () => {
    callGatewayFromCli.mockResolvedValueOnce({
      file: "/tmp/openclaw.log",
      cursor: 1,
      size: 123,
      lines: ["INFO hello", "ERROR world"],
      truncated: false,
    });

    const stdoutWrites = captureStdoutWrites();
    await runLogsCli(["logs", "tail", "--level", "error"]);

    expect(stdoutWrites.join("")).toContain("ERROR");
    expect(stdoutWrites.join("")).not.toContain("INFO");
  });
});
