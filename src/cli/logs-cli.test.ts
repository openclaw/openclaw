import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatLogTimestamp } from "./logs-cli.js";

const callGatewayFromCli = vi.fn();

vi.mock("./gateway-rpc.js", async () => {
  const actual = await vi.importActual<typeof import("./gateway-rpc.js")>("./gateway-rpc.js");
  return {
    ...actual,
    callGatewayFromCli: (...args: unknown[]) => callGatewayFromCli(...args),
  };
});

async function runLogsCli(argv: string[]) {
  const { registerLogsCli } = await import("./logs-cli.js");
  const program = new Command();
  program.exitOverride();
  registerLogsCli(program);
  await program.parseAsync(argv, { from: "user" });
}

describe("logs cli", () => {
  afterEach(() => {
    callGatewayFromCli.mockReset();
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
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutWrites.push(String(chunk));
      return true;
    });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrWrites.push(String(chunk));
      return true;
    });

    await runLogsCli(["logs"]);

    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();

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
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutWrites.push(String(chunk));
      return true;
    });

    await runLogsCli(["logs", "--plain"]);

    stdoutSpy.mockRestore();

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
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => {
      const err = new Error("EPIPE") as NodeJS.ErrnoException;
      err.code = "EPIPE";
      throw err;
    });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrWrites.push(String(chunk));
      return true;
    });

    await runLogsCli(["logs"]);

    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();

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

    it("handles empty or invalid timestamps", () => {
      expect(formatLogTimestamp(undefined)).toBe("");
      expect(formatLogTimestamp("")).toBe("");
      expect(formatLogTimestamp("invalid-date")).toBe("invalid-date");
    });

    it("preserves original value for invalid dates", () => {
      const result = formatLogTimestamp("not-a-date");
      expect(result).toBe("not-a-date");
    });
  });
});
