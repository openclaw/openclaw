import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runRegisteredCli } from "../test-utils/command-runner.js";
import { formatLogTimestamp } from "./logs-cli.js";

const callGatewayFromCli = vi.fn();

vi.mock("./gateway-rpc.js", async () => {
  const actual = await vi.importActual<typeof import("./gateway-rpc.js")>("./gateway-rpc.js");
  return {
    ...actual,
    callGatewayFromCli: (...args: unknown[]) => callGatewayFromCli(...args),
  };
});

let registerLogsCli: typeof import("./logs-cli.js").registerLogsCli;

beforeAll(async () => {
  ({ registerLogsCli } = await import("./logs-cli.js"));
});

async function runLogsCli(argv: string[]) {
  await runRegisteredCli({
    register: registerLogsCli as (program: import("commander").Command) => void,
    argv,
  });
}

describe("logs cli", () => {
  afterEach(() => {
    callGatewayFromCli.mockReset();
    vi.restoreAllMocks();
  });

  it("writes output directly to stdout/stderr", async () => {
    callGatewayFromCli.mockResolvedValueOnce({
      file: "/tmp/openclaw.log",
      cursor: 1,
      size: 123,
      lines: ["raw line"],
      truncated: true,
      reset: true,
    });

    const stdoutWrites: string[] = [];
    const stderrWrites: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutWrites.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrWrites.push(String(chunk));
      return true;
    });

    await runLogsCli(["logs"]);

    expect(stdoutWrites.join("")).toContain("Log file:");
    expect(stdoutWrites.join("")).toContain("raw line");
    expect(stderrWrites.join("")).toContain("Log tail truncated");
    expect(stderrWrites.join("")).toContain("Log cursor reset");
  });

  it("emits local timestamps in plain mode", async () => {
    callGatewayFromCli.mockResolvedValueOnce({
      file: "/tmp/openclaw.log",
      lines: [
        JSON.stringify({
          time: "2025-01-01T12:00:00.000Z",
          _meta: { logLevelName: "INFO", name: JSON.stringify({ subsystem: "gateway" }) },
          0: "line one",
        }),
      ],
    });

    const stdoutWrites: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutWrites.push(String(chunk));
      return true;
    });

    await runLogsCli(["logs", "--plain"]);

    const output = stdoutWrites.join("");
    expect(output).toContain("line one");
    // Timestamps should be local ISO format (no trailing Z)
    const timestamp = output.match(
      /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}/u,
    )?.[0];
    expect(timestamp).toBeTruthy();
  });

  it("warns when the output pipe closes", async () => {
    callGatewayFromCli.mockResolvedValueOnce({
      file: "/tmp/openclaw.log",
      lines: ["line one"],
    });

    const stderrWrites: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(() => {
      const err = new Error("EPIPE") as NodeJS.ErrnoException;
      err.code = "EPIPE";
      throw err;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrWrites.push(String(chunk));
      return true;
    });

    await runLogsCli(["logs"]);

    expect(stderrWrites.join("")).toContain("output stdout closed");
  });

  describe("formatLogTimestamp", () => {
    it("formats timestamp in local ISO format in plain mode", () => {
      const result = formatLogTimestamp("2025-01-01T12:00:00.000Z");
      // Should be local ISO time with timezone offset, no trailing Z
      expect(result).not.toContain("Z");
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
    });

    it("formats timestamp in local HH:MM:SS in pretty mode", () => {
      const result = formatLogTimestamp("2025-01-01T12:00:00.000Z", "pretty");
      expect(result).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    });

    it.each([
      { input: undefined, expected: "" },
      { input: "", expected: "" },
      { input: "invalid-date", expected: "invalid-date" },
      { input: "not-a-date", expected: "not-a-date" },
    ])("preserves timestamp fallback for $input", ({ input, expected }) => {
      expect(formatLogTimestamp(input)).toBe(expected);
    });
  });
});
