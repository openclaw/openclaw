import net from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../terminal/ansi.js";

const runCommandWithTimeoutMock = vi.hoisted(() => vi.fn());

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));
import { formatPortListener } from "./ports-format.js";
import { inspectPortUsage } from "./ports-inspect.js";
import {
  buildPortHints,
  classifyPortListener,
  ensurePortAvailable,
  formatPortDiagnostics,
  handlePortError,
  PortInUseError,
} from "./ports.js";

const describeUnix = process.platform === "win32" ? describe.skip : describe;

describe("ports helpers", () => {
  it("ensurePortAvailable rejects when port busy", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, () => resolve()));
    const port = (server.address() as net.AddressInfo).port;
    await expect(ensurePortAvailable(port)).rejects.toBeInstanceOf(PortInUseError);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("handlePortError exits nicely on EADDRINUSE", async () => {
    const runtime = {
      error: vi.fn(),
      log: vi.fn(),
      exit: vi.fn() as unknown as (code: number) => never,
    };
    // Avoid slow OS port inspection; this test only cares about messaging + exit behavior.
    await handlePortError(new PortInUseError(1234, "details"), 1234, "context", runtime).catch(
      () => {},
    );
    const messages = runtime.error.mock.calls.map((call) => stripAnsi(String(call[0] ?? "")));
    expect(messages.join("\n")).toContain("context failed: port 1234 is already in use.");
    expect(messages.join("\n")).toContain("Resolve by stopping the process");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("prints an OpenClaw-specific hint when port details look like another OpenClaw instance", async () => {
    const runtime = {
      error: vi.fn(),
      log: vi.fn(),
      exit: vi.fn() as unknown as (code: number) => never,
    };

    await handlePortError(
      new PortInUseError(18789, "node dist/index.js openclaw gateway"),
      18789,
      "gateway start",
      runtime,
    ).catch(() => {});

    const messages = runtime.error.mock.calls.map((call) => stripAnsi(String(call[0] ?? "")));
    expect(messages.join("\n")).toContain("another OpenClaw instance is already running");
  });

  it("classifies port listeners across gateway, ssh, and unknown cases", () => {
    const cases = [
      {
        listener: { commandLine: "ssh -N -L 18789:127.0.0.1:18789 user@host" },
        expected: "ssh",
      },
      {
        listener: { command: "ssh" },
        expected: "ssh",
      },
      {
        listener: { commandLine: "node /Users/me/Projects/openclaw/dist/entry.js gateway" },
        expected: "gateway",
      },
      {
        listener: { commandLine: "python -m http.server 18789" },
        expected: "unknown",
      },
    ] as const;

    for (const testCase of cases) {
      expect(
        classifyPortListener(testCase.listener, 18789),
        JSON.stringify(testCase.listener),
      ).toBe(testCase.expected);
    }
  });

  it("builds ordered hints for mixed listener kinds and multiple listeners", () => {
    expect(
      buildPortHints(
        [
          { commandLine: "node dist/index.js openclaw gateway" },
          { commandLine: "ssh -N -L 18789:127.0.0.1:18789" },
          { commandLine: "python -m http.server 18789" },
        ],
        18789,
      ),
    ).toEqual([
      expect.stringContaining("Gateway already running locally."),
      "SSH tunnel already bound to this port. Close the tunnel or use a different local port in -L.",
      "Another process is listening on this port.",
      expect.stringContaining("Multiple listeners detected"),
    ]);
    expect(buildPortHints([], 18789)).toEqual([]);
  });

  it("formats port listeners and diagnostics for free and busy ports", () => {
    expect(formatPortListener({ command: "ssh", address: "127.0.0.1:18789" })).toBe(
      "pid ?: ssh (127.0.0.1:18789)",
    );

    expect(
      formatPortDiagnostics({
        port: 18789,
        status: "free",
        listeners: [],
        hints: [],
      }),
    ).toEqual(["Port 18789 is free."]);

    const lines = formatPortDiagnostics({
      port: 18789,
      status: "busy",
      listeners: [{ pid: 123, user: "alice", commandLine: "ssh -N -L 18789:127.0.0.1:18789" }],
      hints: buildPortHints([{ pid: 123, commandLine: "ssh -N -L 18789:127.0.0.1:18789" }], 18789),
    });
    expect(lines[0]).toContain("Port 18789 is already in use");
    expect(lines).toContain("- pid 123 alice: ssh -N -L 18789:127.0.0.1:18789");
    expect(lines.some((line) => line.includes("SSH tunnel"))).toBe(true);
  });
});

describeUnix("inspectPortUsage", () => {
  beforeEach(() => {
    runCommandWithTimeoutMock.mockClear();
  });

  it("reports busy when lsof is missing but loopback listener exists", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;

    runCommandWithTimeoutMock.mockRejectedValueOnce(
      Object.assign(new Error("spawn lsof ENOENT"), { code: "ENOENT" }),
    );

    try {
      const result = await inspectPortUsage(port);
      expect(result.status).toBe("busy");
      expect(result.errors?.some((err) => err.includes("ENOENT"))).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("falls back to ss when lsof is unavailable", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;

    runCommandWithTimeoutMock.mockImplementation(async (argv: string[]) => {
      const command = argv[0];
      if (typeof command !== "string") {
        return { stdout: "", stderr: "", code: 1 };
      }
      if (command.includes("lsof")) {
        throw Object.assign(new Error("spawn lsof ENOENT"), { code: "ENOENT" });
      }
      if (command === "ss") {
        return {
          stdout: `LISTEN 0 511 127.0.0.1:${port} 0.0.0.0:* users:(("node",pid=${process.pid},fd=23))`,
          stderr: "",
          code: 0,
        };
      }
      if (command === "ps") {
        if (argv.includes("command=")) {
          return {
            stdout: "node /tmp/openclaw/dist/index.js gateway --port 18789\n",
            stderr: "",
            code: 0,
          };
        }
        if (argv.includes("user=")) {
          return {
            stdout: "debian\n",
            stderr: "",
            code: 0,
          };
        }
        if (argv.includes("ppid=")) {
          return {
            stdout: "1\n",
            stderr: "",
            code: 0,
          };
        }
      }
      return { stdout: "", stderr: "", code: 1 };
    });

    try {
      const result = await inspectPortUsage(port);
      expect(result.status).toBe("busy");
      expect(result.listeners.length).toBeGreaterThan(0);
      expect(result.listeners[0]?.pid).toBe(process.pid);
      expect(result.listeners[0]?.commandLine).toContain("openclaw");
      expect(result.errors).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
