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

    const { registerLogsCli } = await import("./logs-cli.js");
    const program = new Command();
    program.exitOverride();
    registerLogsCli(program);

    await program.parseAsync(["logs"], { from: "user" });

    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();

    expect(stdoutWrites.join("")).toContain("Log file:");
    expect(stdoutWrites.join("")).toContain("raw line");
    expect(stderrWrites.join("")).toContain("Log tail truncated");
    expect(stderrWrites.join("")).toContain("Log cursor reset");
  });

  it("wires --local-time through CLI parsing and emits local timestamps", async () => {
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

    const { registerLogsCli } = await import("./logs-cli.js");
    const program = new Command();
    program.exitOverride();
    registerLogsCli(program);

    await program.parseAsync(["logs", "--local-time", "--plain"], { from: "user" });

    stdoutSpy.mockRestore();

    const output = stdoutWrites.join("");
    expect(output).toContain("line one");
    const timestamp = output.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z?/u)?.[0];
    expect(timestamp).toBeTruthy();
    expect(timestamp?.endsWith("Z")).toBe(false);
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

    const { registerLogsCli } = await import("./logs-cli.js");
    const program = new Command();
    program.exitOverride();
    registerLogsCli(program);

    await program.parseAsync(["logs"], { from: "user" });

    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();

    expect(stderrWrites.join("")).toContain("output stdout closed");
  });

  describe("formatLogTimestamp", () => {
    it("formats UTC timestamp in plain mode by default", () => {
      const result = formatLogTimestamp("2025-01-01T12:00:00.000Z");
      expect(result).toBe("2025-01-01T12:00:00.000Z");
    });

    it("formats UTC timestamp in pretty mode", () => {
      const result = formatLogTimestamp("2025-01-01T12:00:00.000Z", "pretty");
      expect(result).toBe("12:00:00");
    });

    it("formats local time in plain mode when localTime is true", () => {
      const utcTime = "2025-01-01T12:00:00.000Z";
      const result = formatLogTimestamp(utcTime, "plain", true);
      // Should be local time with explicit timezone offset (not 'Z' suffix).
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
      // The exact time depends on timezone, but should be different from UTC
      expect(result).not.toBe(utcTime);
    });

    it("formats local time in pretty mode when localTime is true", () => {
      const utcTime = "2025-01-01T12:00:00.000Z";
      const result = formatLogTimestamp(utcTime, "pretty", true);
      // Should be HH:MM:SS format
      expect(result).toMatch(/^\d{2}:\d{2}:\d{2}$/);
      // Should be different from UTC time (12:00:00) if not in UTC timezone
      const tzOffset = new Date(utcTime).getTimezoneOffset();
      if (tzOffset !== 0) {
        expect(result).not.toBe("12:00:00");
      }
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
