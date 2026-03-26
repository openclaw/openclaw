import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { stripAnsi } from "../../src/terminal/ansi.js";

const SCRIPT = path.join(process.cwd(), "scripts", "shell-helpers", "clawdock-helpers.sh");
const BASH_BIN = process.platform === "win32" ? "bash" : "/bin/bash";
const BASH_PREFIX_ARGS = process.platform === "win32" ? [] : ["--noprofile", "--norc"];
const BASE_PATH = process.env.PATH ?? "/usr/bin:/bin";

type RunResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
};

/**
 * Runs `clawdock-devices` inside a clean Bash subprocess with mocked Docker helpers.
 *
 * - output: simulated `devices list` command output.
 * - exitCode: simulated exit status from `_clawdock_compose`.
 */
function runClawdockDevices(output: string, exitCode: number): RunResult {
  const script = `
source "${SCRIPT}"
_clawdock_ensure_dir() { return 0; }
_clawdock_filter_warnings() { cat; }
_cmd() { printf "%s" "$1"; }
_clawdock_compose() {
  printf "%s\\n" "$MOCK_OUTPUT"
  return "$MOCK_EXIT_CODE"
}
clawdock-devices
`;

  try {
    const stdout = execFileSync(BASH_BIN, [...BASH_PREFIX_ARGS, "-c", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        LANG: process.env.LANG ?? "C",
        PATH: BASE_PATH,
        MOCK_OUTPUT: output,
        MOCK_EXIT_CODE: String(exitCode),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout, stderr: "" };
  } catch (error) {
    const execError = error as {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    return {
      ok: false,
      stdout:
        typeof execError.stdout === "string"
          ? execError.stdout
          : (execError.stdout?.toString("utf8") ?? ""),
      stderr:
        typeof execError.stderr === "string"
          ? execError.stderr
          : (execError.stderr?.toString("utf8") ?? ""),
    };
  }
}

describe("scripts/shell-helpers/clawdock-helpers.sh", () => {
  describe("clawdock-devices", () => {
    it("shows clawdock-fix-token guidance for token mismatch failures", () => {
      const result = runClawdockDevices("unauthorized: gateway token mismatch (abc...)", 1);
      const stdout = stripAnsi(result.stdout);

      expect(result.ok).toBe(false);
      expect(stdout).toContain("Run: clawdock-fix-token");
      expect(stdout).toContain("Retry: clawdock-devices");
      expect(stdout).not.toContain("Verify token is set: clawdock-token");
    });

    it("matches gateway token mismatch case-insensitively", () => {
      const result = runClawdockDevices("GATEWAY TOKEN MISMATCH while listing devices", 1);
      const stdout = stripAnsi(result.stdout);

      expect(result.ok).toBe(false);
      expect(stdout).toContain("Run: clawdock-fix-token");
    });

    it("does not trigger mismatch hint for device token mismatch", () => {
      const result = runClawdockDevices("device token mismatch", 1);
      const stdout = stripAnsi(result.stdout);

      expect(result.ok).toBe(false);
      expect(stdout).toContain("Verify token is set: clawdock-token");
      expect(stdout).not.toContain("Run: clawdock-fix-token");
    });

    it("falls back to generic token guidance for other failures", () => {
      const result = runClawdockDevices("permission denied", 1);
      const stdout = stripAnsi(result.stdout);

      expect(result.ok).toBe(false);
      expect(stdout).toContain("Verify token is set: clawdock-token");
      expect(stdout).not.toContain("Run: clawdock-fix-token");
    });

    it("matches gateway token mismatch buried in multiline output", () => {
      const multiline =
        "Starting gateway...\nWARN: slow connection\nunauthorized: gateway token mismatch (abc)\nConnection closed";
      const result = runClawdockDevices(multiline, 1);
      const stdout = stripAnsi(result.stdout);

      expect(result.ok).toBe(false);
      expect(stdout).toContain("Run: clawdock-fix-token");
    });

    it("falls back to generic guidance on empty output with non-zero exit", () => {
      const result = runClawdockDevices("", 1);
      const stdout = stripAnsi(result.stdout);

      expect(result.ok).toBe(false);
      expect(stdout).toContain("Verify token is set: clawdock-token");
      expect(stdout).not.toContain("Run: clawdock-fix-token");
    });

    it("shows shared manual-inspection fallback for any failure", () => {
      const mismatch = stripAnsi(runClawdockDevices("gateway token mismatch", 1).stdout);
      const generic = stripAnsi(runClawdockDevices("something else", 1).stdout);

      for (const stdout of [mismatch, generic]) {
        expect(stdout).toContain("clawdock-shell");
        expect(stdout).toContain("openclaw config get gateway.remote.token");
      }
    });

    it("shows approval guidance on success", () => {
      const result = runClawdockDevices("Device list OK", 0);
      const stdout = stripAnsi(result.stdout);

      expect(result.ok).toBe(true);
      expect(stdout).toContain("clawdock-approve <request-id>");
      expect(stdout).not.toContain("clawdock-fix-token");
      expect(stdout).not.toContain("Verify token is set");
    });
  });
});
