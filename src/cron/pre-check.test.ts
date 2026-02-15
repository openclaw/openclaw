import { describe, it, expect } from "vitest";
import { runPreCheck, applyPreCheckOutput } from "./pre-check.js";

const isWindows = process.platform === "win32";

describe("cron pre-check gate", () => {
  describe("runPreCheck", () => {
    it("passes when command exits 0 with output", async () => {
      const result = await runPreCheck({ command: 'echo "hello world"' });
      expect(result.passed).toBe(true);
      if (result.passed) {
        expect(result.output).toContain("hello world");
      }
    });

    it("fails when command exits non-zero", async () => {
      const cmd = isWindows ? "exit /b 1" : "exit 1";
      const result = await runPreCheck({ command: cmd });
      expect(result.passed).toBe(false);
      if (!result.passed) {
        expect(result.reason).toContain("exited with code 1");
      }
    });

    it("fails when command produces empty stdout", async () => {
      // node -e "" produces no output on all platforms
      const result = await runPreCheck({ command: 'node -e ""' });
      expect(result.passed).toBe(false);
      if (!result.passed) {
        expect(result.reason).toContain("empty output");
      }
    });

    it("fails on timeout", async () => {
      const cmd = isWindows ? "ping -n 11 127.0.0.1 > nul" : "sleep 10";
      const result = await runPreCheck({
        command: cmd,
        timeoutSeconds: 1,
      });
      expect(result.passed).toBe(false);
      if (!result.passed) {
        expect(result.reason).toMatch(/timed out|error/i);
      }
    });

    it("passes with multi-line output", async () => {
      const cmd = isWindows
        ? "node -e \"console.log('line1');console.log('line2');console.log('line3')\""
        : 'echo "line1"; echo "line2"; echo "line3"';
      const result = await runPreCheck({ command: cmd });
      expect(result.passed).toBe(true);
      if (result.passed) {
        expect(result.output).toContain("line1");
        expect(result.output).toContain("line3");
      }
    });

    it("includes stderr hint on non-zero exit", async () => {
      const cmd = isWindows
        ? "node -e \"process.stderr.write('oops');process.exit(2)\""
        : 'echo "oops" >&2; exit 2';
      const result = await runPreCheck({ command: cmd });
      expect(result.passed).toBe(false);
      if (!result.passed) {
        expect(result.reason).toContain("oops");
        expect(result.reason).toContain("code 2");
      }
    });

    it("handles command not found", async () => {
      const result = await runPreCheck({
        command: "nonexistent_command_xyz_12345",
      });
      expect(result.passed).toBe(false);
    });
  });

  describe("applyPreCheckOutput", () => {
    it("prepends output by default", () => {
      const result = applyPreCheckOutput("original message", "check data", undefined);
      expect(result).toContain("[Pre-check context]");
      expect(result).toContain("check data");
      expect(result).toContain("original message");
      // Pre-check comes before original
      expect(result.indexOf("check data")).toBeLessThan(result.indexOf("original message"));
    });

    it("prepends output with explicit 'prepend' mode", () => {
      const result = applyPreCheckOutput("original", "data", "prepend");
      expect(result).toContain("data");
      expect(result).toContain("original");
    });

    it("replaces original with 'replace' mode", () => {
      const result = applyPreCheckOutput("original", "replacement", "replace");
      expect(result).toBe("replacement");
    });

    it("ignores output with 'ignore' mode", () => {
      const result = applyPreCheckOutput("original", "ignored data", "ignore");
      expect(result).toBe("original");
    });
  });
});
