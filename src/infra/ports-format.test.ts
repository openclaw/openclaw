import { describe, expect, it } from "vitest";
import {
  buildPortHints,
  classifyPortListener,
  formatPortDiagnostics,
  formatPortListener,
  isDualStackLoopbackGatewayListeners,
} from "./ports-format.js";

describe("ports-format", () => {
  it.each([
    [{ commandLine: "ssh -N -L 18790:127.0.0.1:18790 user@host" }, "ssh"],
    [{ command: "ssh" }, "ssh"],
    [{ commandLine: "node /Users/me/Projects/mullusi/dist/entry.js gateway" }, "gateway"],
    [{ commandLine: "python -m http.server 18790" }, "unknown"],
  ] as const)("classifies port listener %j", (listener, expected) => {
    expect(classifyPortListener(listener, 18790)).toBe(expected);
  });

  it("builds ordered hints for mixed listener kinds and multiplicity", () => {
    expect(
      buildPortHints(
        [
          { commandLine: "node dist/index.js mullusi gateway" },
          { commandLine: "ssh -N -L 18790:127.0.0.1:18790" },
          { commandLine: "python -m http.server 18790" },
        ],
        18790,
      ),
    ).toEqual([
      expect.stringContaining("Gateway already running locally."),
      "SSH tunnel already bound to this port. Close the tunnel or use a different local port in -L.",
      "Another process is listening on this port.",
      expect.stringContaining("Multiple listeners detected"),
    ]);
    expect(buildPortHints([], 18790)).toEqual([]);
  });

  it("treats single-process loopback dual-stack gateway listeners as benign", () => {
    const listeners = [
      { pid: 4242, commandLine: "mullusi-gateway", address: "127.0.0.1:18790" },
      { pid: 4242, commandLine: "mullusi-gateway", address: "[::1]:18790" },
    ];
    expect(isDualStackLoopbackGatewayListeners(listeners, 18790)).toBe(true);
    expect(buildPortHints(listeners, 18790)).toEqual([
      expect.stringContaining("Gateway already running locally."),
    ]);
  });

  it.each([
    [
      { pid: 123, user: "alice", commandLine: "ssh -N", address: "::1" },
      "pid 123 alice: ssh -N (::1)",
    ],
    [{ command: "ssh", address: "127.0.0.1:18790" }, "pid ?: ssh (127.0.0.1:18790)"],
    [{}, "pid ?: unknown"],
  ] as const)("formats port listener %j", (listener, expected) => {
    expect(formatPortListener(listener)).toBe(expected);
  });

  it("formats free and busy port diagnostics", () => {
    expect(
      formatPortDiagnostics({
        port: 18790,
        status: "free",
        listeners: [],
        hints: [],
      }),
    ).toEqual(["Port 18790 is free."]);

    const lines = formatPortDiagnostics({
      port: 18790,
      status: "busy",
      listeners: [{ pid: 123, user: "alice", commandLine: "ssh -N -L 18790:127.0.0.1:18790" }],
      hints: buildPortHints([{ pid: 123, commandLine: "ssh -N -L 18790:127.0.0.1:18790" }], 18790),
    });
    expect(lines[0]).toContain("Port 18790 is already in use");
    expect(lines).toContain("- pid 123 alice: ssh -N -L 18790:127.0.0.1:18790");
    expect(lines.some((line) => line.includes("SSH tunnel"))).toBe(true);
  });
});
