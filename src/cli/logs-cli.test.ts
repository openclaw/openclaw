import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { colorize, theme } from "../terminal/theme.js";
import { runRegisteredCli } from "../test-utils/command-runner.js";
import { formatLogTimestamp, formatPrettyJson } from "./logs-cli.js";

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
    callGatewayFromCli.mockClear();
    vi.restoreAllMocks();
  });

  it("writes output directly to stdout/stderr", async () => {
    callGatewayFromCli.mockResolvedValueOnce({
      file: "/tmp/openclaw.log",
      source: "gateway",
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
    expect(stderrWrites.join("")).toContain("older lines were omitted");
    expect(stderrWrites.join("")).toContain("Log cursor reset");
  });

  it("wires --local-time through CLI parsing and emits local timestamps", async () => {
    callGatewayFromCli.mockResolvedValueOnce({
      file: "/tmp/openclaw.log",
      source: "gateway",
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

    await runLogsCli(["logs", "--local-time", "--plain"]);

    const output = stdoutWrites.join("");
    expect(output).toContain("line one");
    const timestamp = output.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z?/u)?.[0];
    expect(timestamp).toBeTruthy();
    expect(timestamp?.endsWith("Z")).toBe(false);
  });

  it("warns when the output pipe closes", async () => {
    callGatewayFromCli.mockResolvedValueOnce({
      file: "/tmp/openclaw.log",
      source: "gateway",
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

  it("renders llm trace lines as pretty-printed json blocks", async () => {
    callGatewayFromCli.mockResolvedValueOnce({
      file: "/tmp/cache-trace.jsonl",
      source: "llm",
      lines: [
        JSON.stringify({
          ts: "2025-01-01T12:00:00.000Z",
          stage: "prompt:before",
          provider: "openai",
          modelId: "gpt-5.4",
          prompt: "hello world",
          messages: [{ role: "user", content: "check token usage" }],
        }),
      ],
    });

    const stdoutWrites: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutWrites.push(String(chunk));
      return true;
    });

    await runLogsCli(["logs", "--source", "llm", "--plain"]);

    const output = stdoutWrites.join("");
    expect(output).toContain("cache-trace.jsonl");
    expect(output).toContain("(llm)");
    expect(output).toContain("prompt:before openai/gpt-5.4");
    expect(output).toContain('  "prompt": "hello world"');
    expect(output).toContain('  "messages": [');
    expect(output).toContain("    {");
  });

  it("colors JSON string values even when they are followed by commas", () => {
    const output = formatPrettyJson(
      {
        type: "thinking",
        thinking: "waiting for new content",
        thinkingSignature: "reasoning",
      },
      true,
    );

    expect(output).toContain(colorize(true, theme.success, '"thinking"'));
    expect(output).toContain(colorize(true, theme.success, '"waiting for new content"'));
    expect(output).toContain(colorize(true, theme.success, '"reasoning"'));
  });

  it("prints a hint when llm trace is disabled", async () => {
    callGatewayFromCli.mockResolvedValueOnce({
      file: "/tmp/cache-trace.jsonl",
      source: "llm",
      lines: [],
      hint: "LLM logs are disabled. Enable diagnostics.cacheTrace.enabled=true.",
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

    await runLogsCli(["logs", "--source", "llm", "--plain"]);

    expect(stdoutWrites.join("")).toContain("cache-trace.jsonl");
    expect(stderrWrites.join("")).toContain("llm: LLM logs are disabled");
  });

  it("uses a larger default max-bytes window for llm logs", async () => {
    callGatewayFromCli.mockResolvedValueOnce({
      file: "/tmp/cache-trace.jsonl",
      source: "llm",
      lines: [],
    });

    await runLogsCli(["logs", "--source", "llm"]);

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "logs.tail",
      expect.objectContaining({ source: "llm" }),
      expect.objectContaining({ maxBytes: 1_000_000, source: "llm" }),
      expect.anything(),
    );
  });

  it("explains when a trace line is larger than the current tail window", async () => {
    callGatewayFromCli.mockResolvedValueOnce({
      file: "/tmp/cache-trace.jsonl",
      source: "llm",
      lines: [],
      truncated: true,
    });

    const stderrWrites: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrWrites.push(String(chunk));
      return true;
    });

    await runLogsCli(["logs", "--source", "llm", "--plain", "--max-bytes", "200000"]);

    expect(stderrWrites.join("")).toContain("before a full trace line was captured");
  });

  it("suppresses truncation noise when llm tail already includes complete events", async () => {
    callGatewayFromCli.mockResolvedValueOnce({
      file: "/tmp/cache-trace.jsonl",
      source: "llm",
      truncated: true,
      lines: [
        JSON.stringify({
          ts: "2025-01-01T12:00:00.000Z",
          stage: "session:after",
          provider: "openai",
          modelId: "gpt-5.4",
          messages: [{ role: "assistant", content: "latest answer" }],
          usage: { input: 10, output: 5, totalTokens: 15 },
        }),
      ],
    });

    const stderrWrites: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrWrites.push(String(chunk));
      return true;
    });

    await runLogsCli(["logs", "--source", "llm", "--plain"]);

    expect(stderrWrites.join("")).not.toContain("Log tail truncated");
  });

  it("combines all sources in chronological order", async () => {
    callGatewayFromCli
      .mockResolvedValueOnce({
        file: "/tmp/openclaw.log",
        source: "gateway",
        lines: [
          JSON.stringify({
            time: "2025-01-01T12:00:02.000Z",
            _meta: { logLevelName: "INFO", name: JSON.stringify({ subsystem: "gateway" }) },
            0: "gateway line",
          }),
        ],
      })
      .mockResolvedValueOnce({
        file: "/tmp/cache-trace.jsonl",
        source: "llm",
        lines: [
          JSON.stringify({
            ts: "2025-01-01T12:00:01.000Z",
            stage: "prompt:before",
            provider: "openai",
            modelId: "gpt-5.4",
            prompt: "first",
          }),
        ],
      });

    const stdoutWrites: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutWrites.push(String(chunk));
      return true;
    });

    await runLogsCli(["logs", "--source", "all", "--plain"]);

    expect(callGatewayFromCli).toHaveBeenNthCalledWith(
      1,
      "logs.tail",
      expect.objectContaining({ source: "all" }),
      expect.objectContaining({ source: "gateway" }),
      expect.anything(),
    );
    expect(callGatewayFromCli).toHaveBeenNthCalledWith(
      2,
      "logs.tail",
      expect.objectContaining({ source: "all" }),
      expect.objectContaining({ source: "llm" }),
      expect.anything(),
    );
    const output = stdoutWrites.join("");
    const llmIndex = output.indexOf("prompt:before openai/gpt-5.4");
    const gatewayIndex = output.indexOf("gateway line");
    expect(llmIndex).toBeGreaterThan(-1);
    expect(gatewayIndex).toBeGreaterThan(llmIndex);
  });

  it("prints the llm-disabled hint during --source all even when llm lines exist", async () => {
    callGatewayFromCli
      .mockResolvedValueOnce({
        file: "/tmp/openclaw.log",
        source: "gateway",
        lines: [],
      })
      .mockResolvedValueOnce({
        file: "/tmp/cache-trace.jsonl",
        source: "llm",
        lines: [
          JSON.stringify({
            ts: "2025-01-01T12:00:01.000Z",
            stage: "session:after",
            provider: "openai",
            modelId: "gpt-5.4",
            messages: [{ role: "assistant", content: "old output" }],
          }),
        ],
        hint: "LLM logs are disabled for the current gateway process. Existing cache-trace.jsonl contents may be historical.",
      });

    const stderrWrites: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrWrites.push(String(chunk));
      return true;
    });

    await runLogsCli(["logs", "--source", "all", "--plain"]);

    expect(stderrWrites.join("")).toContain(
      "llm: LLM logs are disabled for the current gateway process",
    );
    expect(stderrWrites.join("")).toContain("historical");
  });

  it("tags truncation notices with their source during --source all", async () => {
    callGatewayFromCli
      .mockResolvedValueOnce({
        file: "/tmp/openclaw.log",
        source: "gateway",
        lines: ["raw line"],
        truncated: true,
      })
      .mockResolvedValueOnce({
        file: "/tmp/cache-trace.jsonl",
        source: "llm",
        lines: [],
      });

    const stderrWrites: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrWrites.push(String(chunk));
      return true;
    });

    await runLogsCli(["logs", "--source", "all", "--plain"]);

    expect(stderrWrites.join("")).toContain("gateway: Showing only the most recent log tail");
  });

  describe("formatLogTimestamp", () => {
    it("formats UTC timestamp in plain mode by default", () => {
      const result = formatLogTimestamp("2025-01-01T12:00:00.000Z");
      expect(result).toBe("2025-01-01T12:00:00.000Z");
    });

    it("formats UTC timestamp in pretty mode", () => {
      const result = formatLogTimestamp("2025-01-01T12:00:00.000Z", "pretty");
      expect(result).toBe("12:00:00+00:00");
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
      // Should be HH:MM:SS±HH:MM format with timezone offset.
      expect(result).toMatch(/^\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
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
