import { describe, expect, it } from "vitest";
import { classifySignalCliLogLine, spawnSignalDaemon } from "./daemon.js";

describe("classifySignalCliLogLine", () => {
  it("treats INFO/DEBUG as log (even if emitted on stderr)", () => {
    expect(classifySignalCliLogLine("INFO  DaemonCommand - Started")).toBe("log");
    expect(classifySignalCliLogLine("DEBUG Something")).toBe("log");
  });

  it("treats WARN/ERROR as error", () => {
    expect(classifySignalCliLogLine("WARN  Something")).toBe("error");
    expect(classifySignalCliLogLine("WARNING Something")).toBe("error");
    expect(classifySignalCliLogLine("ERROR Something")).toBe("error");
  });

  it("treats failures without explicit severity as error", () => {
    expect(classifySignalCliLogLine("Failed to initialize HTTP Server - oops")).toBe("error");
    expect(classifySignalCliLogLine('Exception in thread "main"')).toBe("error");
  });

  it("returns null for empty lines", () => {
    expect(classifySignalCliLogLine("")).toBe(null);
    expect(classifySignalCliLogLine("   ")).toBe(null);
  });
});

describe("spawnSignalDaemon cliPath validation", () => {
  it("rejects paths with null bytes", () => {
    expect(() =>
      spawnSignalDaemon({
        cliPath: "signal-cli\0--malicious",
        httpHost: "127.0.0.1",
        httpPort: 8080,
      }),
    ).toThrow(/invalid.*cli.*path/i);
  });

  it("rejects paths with shell metacharacters", () => {
    expect(() =>
      spawnSignalDaemon({
        cliPath: "signal-cli; rm -rf /",
        httpHost: "127.0.0.1",
        httpPort: 8080,
      }),
    ).toThrow(/invalid.*cli.*path/i);
  });

  it("rejects paths with newlines", () => {
    expect(() =>
      spawnSignalDaemon({
        cliPath: "signal-cli\n--malicious",
        httpHost: "127.0.0.1",
        httpPort: 8080,
      }),
    ).toThrow(/invalid.*cli.*path/i);
  });

  it("rejects paths starting with dash (flag injection)", () => {
    expect(() =>
      spawnSignalDaemon({
        cliPath: "-malicious",
        httpHost: "127.0.0.1",
        httpPort: 8080,
      }),
    ).toThrow(/invalid.*cli.*path/i);
  });
});
