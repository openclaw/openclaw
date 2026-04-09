import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runRegisteredCli } from "../test-utils/command-runner.js";
import { __testing, formatLogTimestamp } from "./logs-cli.js";

const callGatewayFromCli = vi.fn();
const buildGatewayConnectionDetails = vi.fn();
const resolveGatewayClientConnection = vi.fn();
const gatewayClientRequest = vi.fn();
const gatewayClientStopAndWait = vi.fn();
let lastGatewayClientOptions: Record<string, unknown> | undefined;
let mockGatewayMethods: string[] = [];
let gatewayClientStartImpl: ((opts: Record<string, unknown>) => void) | undefined;

function emitGatewayHello(
  methods: string[] = mockGatewayMethods,
  opts: Record<string, unknown> | undefined = lastGatewayClientOptions,
) {
  void (opts?.onHelloOk as ((hello: { features?: { methods?: string[] } }) => void) | undefined)?.({
    features: { methods },
  });
}

function emitGatewayConnectError(
  message: string,
  opts: Record<string, unknown> | undefined = lastGatewayClientOptions,
) {
  void (opts?.onConnectError as ((err: Error) => void) | undefined)?.(new Error(message));
}

vi.mock("./gateway-rpc.js", async () => {
  const actual = await vi.importActual<typeof import("./gateway-rpc.js")>("./gateway-rpc.js");
  return {
    ...actual,
    callGatewayFromCli: (...args: Parameters<typeof actual.callGatewayFromCli>) =>
      callGatewayFromCli(...args),
  };
});

vi.mock("./logs-cli.runtime.js", () => {
  class MockGatewayClient {
    constructor(opts: Record<string, unknown>) {
      lastGatewayClientOptions = opts;
    }

    start() {
      if (gatewayClientStartImpl) {
        gatewayClientStartImpl(lastGatewayClientOptions ?? {});
        return;
      }
      emitGatewayHello();
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
    buildGatewayConnectionDetails: (...args: unknown[]) => buildGatewayConnectionDetails(...args),
    resolveGatewayClientConnection: (...args: unknown[]) => resolveGatewayClientConnection(...args),
    GatewayClient: MockGatewayClient,
  };
});

let registerLogsCli: typeof import("./logs-cli.js").registerLogsCli;

beforeAll(async () => {
  buildGatewayConnectionDetails.mockImplementation(() => ({
    message: "Gateway URL: ws://127.0.0.1:18789",
  }));
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
    buildGatewayConnectionDetails.mockReset();
    buildGatewayConnectionDetails.mockImplementation(() => ({
      message: "Gateway URL: ws://127.0.0.1:18789",
    }));
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

  it("sanitizes terminal control sequences in text log output", async () => {
    callGatewayFromCli.mockResolvedValueOnce({
      file: "/tmp/openclaw.log",
      lines: ['{"time":"2025-01-01T12:00:00.000Z","0":"hi \\u001b]52;;c2VjcmV0\\u0007","_meta":{"logLevelName":"INFO","name":"{\\"subsystem\\":\\"gate\\u001b[2Kway\\"}"}}'],
    });

    const stdoutWrites: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutWrites.push(String(chunk));
      return true;
    });

    await runLogsCli(["logs", "--plain"]);

    const output = stdoutWrites.join("");
    expect(output).toContain("gateway");
    expect(output).toContain("hi");
    expect(output).not.toContain("c2VjcmV0");
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("\u0007");
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
      cursor: undefined,
      limit: 200,
      maxBytes: 250_000,
    });
    expect(callGatewayFromCli).not.toHaveBeenCalled();
    expect(gatewayClientStopAndWait).toHaveBeenCalledTimes(1);
    expect(stderrWrites.join("")).toContain("output stdout closed");
  });

  it("omits file when polling logs.tail in follow fallback mode", async () => {
    vi.useFakeTimers();
    try {
      resolveGatewayClientConnection.mockResolvedValueOnce({
        clientOptions: {
          url: "ws://127.0.0.1:18789",
        },
        connectionDetails: {
          message: "Gateway URL: ws://127.0.0.1:18789",
        },
      });
      gatewayClientRequest
        .mockResolvedValueOnce({
          file: "/tmp/openclaw.log",
          cursor: 1,
          lines: ["line one"],
        })
        .mockResolvedValueOnce({
          file: "/tmp/openclaw.log",
          cursor: 2,
          lines: ["line two"],
        });
      gatewayClientStopAndWait.mockResolvedValueOnce(undefined);

      vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
        if (String(chunk).includes("line two")) {
          const err = new Error("EPIPE") as NodeJS.ErrnoException;
          err.code = "EPIPE";
          throw err;
        }
        return true;
      });
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      const runPromise = runLogsCli(["logs", "--follow"]);
      await vi.advanceTimersByTimeAsync(1_000);
      await runPromise;

      expect(gatewayClientRequest).toHaveBeenNthCalledWith(1, "logs.tail", {
        cursor: undefined,
        limit: 200,
        maxBytes: 250_000,
      });
      expect(gatewayClientRequest).toHaveBeenNthCalledWith(2, "logs.tail", {
        cursor: 1,
        limit: 200,
        maxBytes: 250_000,
      });
    } finally {
      vi.useRealTimers();
    }
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
          emitGatewayConnectError("connect ECONNREFUSED 127.0.0.1:18789", opts);
          return;
        }
        emitGatewayHello([], opts);
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

  it("surfaces startup close errors before hello-ok", async () => {
    resolveGatewayClientConnection.mockResolvedValueOnce({
      clientOptions: {
        url: "ws://127.0.0.1:18789",
      },
      connectionDetails: {
        message: "Gateway URL: ws://127.0.0.1:18789",
      },
    });
    gatewayClientStartImpl = (opts) => {
      void (opts.onClose as ((code: number, reason: string) => void) | undefined)?.(
        1008,
        "invalid token",
      );
    };

    const stderrWrites: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as (code?: string | number | null) => never);

    await runLogsCli(["logs", "--follow"]);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderrWrites.join("")).toContain("Gateway not reachable. Is it running and accessible?");
    expect(stderrWrites.join("")).toContain("Reason: gateway closed (1008): invalid token");
  });

  it("keeps waiting for reconnects after a follow wait timeout", async () => {
    vi.useFakeTimers();
    try {
      const waitUntilReady = vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(new Error("gateway timeout after 25ms"))
        .mockResolvedValueOnce(undefined);
      const stderrWrites: string[] = [];

      const waitPromise = __testing.waitForFollowClientReconnect({
        followClient: { waitUntilReady },
        opts: { timeout: "25" },
        rich: false,
        jsonMode: false,
        retryMs: 2_000,
        emitJsonLine: () => true,
        errorLine: (text) => {
          stderrWrites.push(text);
          return true;
        },
      });

      await vi.advanceTimersByTimeAsync(2_000);
      await waitPromise;

      expect(waitUntilReady).toHaveBeenCalledTimes(2);
      expect(waitUntilReady).toHaveBeenNthCalledWith(1, {
        timeoutMs: 2_000,
        keepAlive: true,
      });
      expect(stderrWrites.join("")).toContain("gateway timeout after 25ms");
      expect(stderrWrites.join("")).toContain("Retrying in 2s");
      expect(stderrWrites.join("")).not.toContain("Gateway target:");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps waiting for reconnects after a stream disconnect", async () => {
    vi.useFakeTimers();
    try {
      const waitUntilReady = vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(new Error("gateway log stream disconnected"))
        .mockResolvedValueOnce(undefined);
      const stderrWrites: string[] = [];

      const waitPromise = __testing.waitForFollowClientReconnect({
        followClient: { waitUntilReady },
        opts: { timeout: "25" },
        rich: false,
        jsonMode: false,
        retryMs: 2_000,
        emitJsonLine: () => true,
        errorLine: (text) => {
          stderrWrites.push(text);
          return true;
        },
      });

      await vi.advanceTimersByTimeAsync(2_000);
      await waitPromise;

      expect(waitUntilReady).toHaveBeenCalledTimes(2);
      expect(waitUntilReady).toHaveBeenNthCalledWith(1, {
        timeoutMs: 2_000,
        keepAlive: true,
      });
      expect(stderrWrites.join("")).toContain("gateway log stream disconnected");
      expect(stderrWrites.join("")).toContain("Retrying in 2s");
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-evaluates stream support from the current gateway method set", () => {
    const methods = new Set(["logs.subscribe", "logs.unsubscribe"]);
    expect(__testing.supportsStreamingFollow(methods)).toBe(true);

    methods.delete("logs.unsubscribe");
    expect(__testing.supportsStreamingFollow(methods)).toBe(false);
  });

  it("treats non-retryable startup closes as fatal", () => {
    const err = new Error("gateway closed (1008): invalid token") as Error & {
      followRetryable?: boolean;
    };
    err.followRetryable = false;

    expect(__testing.isRetryableFollowStartupError(err)).toBe(false);
    expect(__testing.isRetryableFollowStartupError(new Error("gateway not connected"))).toBe(true);
  });

  describe("formatLogTimestamp", () => {
    it("preserves the logged timestamp in plain mode by default", () => {
      const result = formatLogTimestamp("2025-01-01T12:00:00.000Z");
      expect(result).toBe("2025-01-01T12:00:00.000Z");
    });

    it("renders a compact timestamp while preserving the logged offset in pretty mode", () => {
      const result = formatLogTimestamp("2025-01-01T12:00:00.000Z", "pretty");
      expect(result).toBe("12:00:00+00:00");
    });

    it("keeps the original offset in plain mode for offset-bearing timestamps", () => {
      const result = formatLogTimestamp("2025-01-01T08:00:00.000-04:00");
      expect(result).toBe("2025-01-01T08:00:00.000-04:00");
    });

    it("keeps the original offset in pretty mode for offset-bearing timestamps", () => {
      const result = formatLogTimestamp("2025-01-01T08:00:00.000-04:00", "pretty");
      expect(result).toBe("08:00:00-04:00");
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
