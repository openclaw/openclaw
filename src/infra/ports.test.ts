import net from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../terminal/ansi.js";

const runCommandWithTimeoutMock = vi.hoisted(() => vi.fn());

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));
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

  it("classifies ssh and gateway listeners", () => {
    expect(
      classifyPortListener({ commandLine: "ssh -N -L 18789:127.0.0.1:18789 user@host" }, 18789),
    ).toBe("ssh");
    expect(
      classifyPortListener(
        {
          commandLine: "node /Users/me/Projects/openclaw/dist/entry.js gateway",
        },
        18789,
      ),
    ).toBe("gateway");
  });

  it("formats port diagnostics with hints", () => {
    const diagnostics = {
      port: 18789,
      status: "busy" as const,
      listeners: [{ pid: 123, commandLine: "ssh -N -L 18789:127.0.0.1:18789" }],
      hints: buildPortHints([{ pid: 123, commandLine: "ssh -N -L 18789:127.0.0.1:18789" }], 18789),
    };
    const lines = formatPortDiagnostics(diagnostics);
    expect(lines[0]).toContain("Port 18789 is already in use");
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
    // ss fallback also fails (not installed)
    runCommandWithTimeoutMock.mockRejectedValueOnce(
      Object.assign(new Error("spawn ss ENOENT"), { code: "ENOENT" }),
    );

    try {
      const result = await inspectPortUsage(port);
      expect(result.status).toBe("busy");
      expect(result.errors?.some((err) => err.includes("ENOENT"))).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("falls back to ss when lsof fails and resolves PIDs", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    const pid = process.pid;

    // lsof fails
    runCommandWithTimeoutMock.mockResolvedValueOnce({
      stdout: "",
      stderr: "lsof: permission denied",
      code: 1,
    });

    // ss succeeds with PID info
    const ssOutput = `State   Recv-Q  Send-Q  Local Address:Port  Peer Address:Port  Process\nLISTEN  0       511     127.0.0.1:${port}  0.0.0.0:*  users:(("node",pid=${pid},fd=24))`;
    runCommandWithTimeoutMock.mockResolvedValueOnce({
      stdout: ssOutput,
      stderr: "",
      code: 0,
    });

    // ps -o command= for commandLine
    runCommandWithTimeoutMock.mockResolvedValueOnce({
      stdout: "node /some/openclaw/dist/entry.js gateway\n",
      stderr: "",
      code: 0,
    });

    // ps -o user= for user
    runCommandWithTimeoutMock.mockResolvedValueOnce({
      stdout: "testuser\n",
      stderr: "",
      code: 0,
    });

    try {
      const result = await inspectPortUsage(port);
      expect(result.status).toBe("busy");
      expect(result.listeners.length).toBeGreaterThan(0);
      expect(result.listeners[0].pid).toBe(pid);
      expect(result.listeners[0].commandLine).toContain("openclaw");
      expect(result.listeners[0].user).toBe("testuser");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reports busy with empty listeners when both lsof and ss fail", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;

    // lsof fails
    runCommandWithTimeoutMock.mockResolvedValueOnce({
      stdout: "",
      stderr: "lsof: error",
      code: 1,
    });

    // ss also fails
    runCommandWithTimeoutMock.mockResolvedValueOnce({
      stdout: "",
      stderr: "ss: error",
      code: 1,
    });

    try {
      const result = await inspectPortUsage(port);
      expect(result.status).toBe("busy");
      expect(result.listeners).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
