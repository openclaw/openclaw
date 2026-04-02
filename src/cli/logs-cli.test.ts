import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runRegisteredCli } from "../test-utils/command-runner.js";
import { formatLogTimestamp } from "./logs-cli.js";

const callGatewayFromCli = vi.fn();
const resolveGatewayClientConnection = vi.fn();
const gatewayClientRequest = vi.fn();
const gatewayClientStopAndWait = vi.fn();
let lastGatewayClientOptions: Record<string, unknown> | undefined;
let mockGatewayMethods: string[] = [];
let gatewayClientStartImpl: ((opts: Record<string, unknown>) => void) | undefined;

vi.mock("./gateway-rpc.js", async () => {
  const actual = await vi.importActual<typeof import("./gateway-rpc.js")>("./gateway-rpc.js");
  return {
    ...actual,
    callGatewayFromCli: (...args: Parameters<typeof actual.callGatewayFromCli>) =>
      callGatewayFromCli(...args),
  };
});

vi.mock("../gateway/call.js", async () => {
  const actual = await vi.importActual<typeof import("../gateway/call.js")>("../gateway/call.js");
  return {
    ...actual,
    resolveGatewayClientConnection: (...args: unknown[]) => resolveGatewayClientConnection(...args),
  };
});

vi.mock("../gateway/client.js", () => {
  class MockGatewayClient {
    constructor(opts: Record<string, unknown>) {
      lastGatewayClientOptions = opts;
    }

    start() {
      if (gatewayClientStartImpl) {
        gatewayClientStartImpl(lastGatewayClientOptions ?? {});
        return;
      }
      void (
        lastGatewayClientOptions?.onHelloOk as
          | ((hello: { features?: { methods?: string[] } }) => void)
          | undefined
      )?.({ features: { methods: mockGatewayMethods } });
    }

    request(...args: unknown[]) {
      return gatewayClientRequest(...args);
    }

    stopAndWait() {
      return gatewayClientStopAndWait();
    }

    stop() {}
  }

  return {
    GatewayClient: MockGatewayClient,
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
    resolveGatewayClientConnection.mockReset();
    gatewayClientRequest.mockReset();
    gatewayClientStopAndWait.mockReset();
    lastGatewayClientOptions = undefined;
    mockGatewayMethods = [];
    gatewayClientStartImpl = undefined;
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

  it("falls back to logs.tail polling when follow streaming is unavailable", async () => {
    resolveGatewayClientConnection.mockResolvedValueOnce({
      clientOptions: {
        url: "ws://127.0.0.1:18789",
      },
      connectionDetails: {
        message: "Gateway URL: ws://127.0.0.1:18789",
      },
    });
    gatewayClientRequest.mockResolvedValueOnce({
      file: "/tmp/openclaw.log",
      lines: ["line one"],
    });
    gatewayClientStopAndWait.mockResolvedValueOnce(undefined);

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

    await runLogsCli(["logs", "--follow"]);

    expect(resolveGatewayClientConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "logs.tail",
      }),
    );
    expect(gatewayClientRequest).toHaveBeenCalledWith("logs.tail", {
      file: undefined,
      cursor: undefined,
      limit: 200,
      maxBytes: 250_000,
    });
    expect(callGatewayFromCli).not.toHaveBeenCalled();
    expect(gatewayClientStopAndWait).toHaveBeenCalledTimes(1);
    expect(stderrWrites.join("")).toContain("output stdout closed");
  });

  it("uses logs.subscribe when the gateway advertises follow streaming", async () => {
    mockGatewayMethods = ["logs.subscribe", "logs.unsubscribe"];
    resolveGatewayClientConnection.mockResolvedValueOnce({
      clientOptions: {
        url: "ws://127.0.0.1:18789",
      },
      connectionDetails: {
        message: "Gateway URL: ws://127.0.0.1:18789",
      },
    });
    gatewayClientRequest.mockResolvedValueOnce({
      file: "/tmp/openclaw.log",
      cursor: 1,
      lines: ["line one"],
      subscribed: true,
    });
    gatewayClientStopAndWait.mockResolvedValueOnce(undefined);

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

    await runLogsCli(["logs", "--follow"]);

    expect(gatewayClientRequest).toHaveBeenNthCalledWith(1, "logs.subscribe", {
      file: undefined,
      cursor: undefined,
      limit: 200,
      maxBytes: 250_000,
    });
    expect(gatewayClientRequest).toHaveBeenNthCalledWith(2, "logs.unsubscribe");
    expect(callGatewayFromCli).not.toHaveBeenCalled();
    expect(stderrWrites.join("")).toContain("output stdout closed");
  });

  it("keeps retrying follow startup until the gateway appears", async () => {
    vi.useFakeTimers();
    try {
      resolveGatewayClientConnection.mockResolvedValue({
        clientOptions: {
          url: "ws://127.0.0.1:18789",
        },
        connectionDetails: {
          message: "Gateway URL: ws://127.0.0.1:18789",
        },
      });
      let startAttempts = 0;
      gatewayClientStartImpl = (opts) => {
        startAttempts += 1;
        if (startAttempts < 3) {
          void (opts.onConnectError as ((err: Error) => void) | undefined)?.(
            new Error("connect ECONNREFUSED 127.0.0.1:18789"),
          );
          return;
        }
        void (
          opts.onHelloOk as ((hello: { features?: { methods?: string[] } }) => void) | undefined
        )?.({
          features: { methods: [] },
        });
      };
      gatewayClientRequest.mockResolvedValueOnce({
        file: "/tmp/openclaw.log",
        lines: ["line one"],
      });
      gatewayClientStopAndWait.mockResolvedValue(undefined);

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

      const runPromise = runLogsCli(["logs", "--follow"]);
      await vi.advanceTimersByTimeAsync(4_000);
      await runPromise;

      expect(resolveGatewayClientConnection).toHaveBeenCalledTimes(3);
      expect(startAttempts).toBe(3);
      expect(gatewayClientRequest).toHaveBeenCalledWith("logs.tail", {
        file: undefined,
        cursor: undefined,
        limit: 200,
        maxBytes: 250_000,
      });
      const stderr = stderrWrites.join("");
      expect(stderr).toContain("Gateway not reachable yet; waiting for it before following logs.");
      expect(stderr).toContain("Retrying every 2s. Press Ctrl+C to stop.");
      expect(stderr).toContain(
        "Still waiting for gateway (connect ECONNREFUSED 127.0.0.1:18789). Retrying in 2s...",
      );
    } finally {
      vi.useRealTimers();
    }
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
