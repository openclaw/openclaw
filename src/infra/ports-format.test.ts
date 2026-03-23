import { describe, expect, it } from "vitest";
import {
  buildPortHints,
  classifyPortListener,
  formatPortDiagnostics,
  formatPortListener,
} from "./ports-format.js";

describe("ports-format", () => {
  it("classifies listeners across gateway, ssh, and unknown command lines", () => {
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

  it("builds ordered hints for mixed listener kinds and multiplicity", () => {
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

  it("formats listeners with pid, user, command, and address fallbacks", () => {
    expect(
      formatPortListener({ pid: 123, user: "alice", commandLine: "ssh -N", address: "::1" }),
    ).toBe("pid 123 alice: ssh -N (::1)");
    expect(formatPortListener({ command: "ssh", address: "127.0.0.1:18789" })).toBe(
      "pid ?: ssh (127.0.0.1:18789)",
    );
    expect(formatPortListener({})).toBe("pid ?: unknown");
  });

  it("formats free and busy port diagnostics", () => {
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
