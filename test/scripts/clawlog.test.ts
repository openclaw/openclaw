// Clawlog tests cover argument parsing contracts in the macOS logging helper.
// These tests do not require a real macOS log(1) binary; they verify that the
// script reaches the expected code paths before any platform-specific command.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT_PATH = fileURLToPath(new URL("../../scripts/clawlog.sh", import.meta.url));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type MockLogOptions = {
  stdout?: string;
  stderr?: string;
  status?: number;
  preflightStderr?: string;
  preflightStatus?: number;
  existingOutput?: string;
};

function runClawlog(args: string[] = [], options: MockLogOptions = {}) {
  const cwd = tempDirs.make("openclaw-clawlog-test-");
  const binDir = path.join(cwd, "bin");
  const callsPath = path.join(cwd, "backend-calls");
  mkdirSync(binDir);
  const sudoPath = path.join(binDir, "sudo");
  writeFileSync(
    sudoPath,
    [
      "#!/bin/sh",
      '[ "$1" = "-n" ] && { printf "%s" "$MOCK_PREFLIGHT_STDERR" >&2; exit "$MOCK_PREFLIGHT_STATUS"; }',
      'printf "%s\\n" "$@" >> "$MOCK_LOG_CALLS"',
      'printf "%s" "$MOCK_LOG_STDOUT"',
      'printf "%s" "$MOCK_LOG_STDERR" >&2',
      'exit "$MOCK_LOG_STATUS"',
      "",
    ].join("\n"),
  );
  chmodSync(sudoPath, 0o755);
  if (options.existingOutput !== undefined) {
    writeFileSync(path.join(cwd, "logs.json"), options.existingOutput);
  }

  const result = spawnSync("/bin/bash", [SCRIPT_PATH, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      TMPDIR: cwd,
      MOCK_LOG_CALLS: callsPath,
      MOCK_LOG_STDOUT: options.stdout ?? "",
      MOCK_LOG_STDERR: options.stderr ?? "",
      MOCK_LOG_STATUS: String(options.status ?? 0),
      MOCK_PREFLIGHT_STDERR: options.preflightStderr ?? "",
      MOCK_PREFLIGHT_STATUS: String(options.preflightStatus ?? 0),
    },
  });

  return { ...result, cwd, callsPath };
}

function encodeRecords(count: number): string {
  const records = Array.from({ length: count }, (_, index) =>
    JSON.stringify({ index, message: `line ${index}\ncontinued` }),
  );
  return [...records, JSON.stringify({ count, finished: 1 })].join("\n");
}

describe("clawlog.sh argument parsing", () => {
  it("uses the documented default view when run without arguments", () => {
    const result = runClawlog();
    const output = result.stdout + result.stderr;

    // Should reach the default log-view path, not print usage.
    expect(output).toContain("Showing last 50 log lines from the past 5m");
    expect(output).not.toContain("USAGE:");
  });

  const valueOptions = ["-n", "-l", "-c", "-s", "-o"];
  for (const option of valueOptions) {
    it(`reports a clear error when ${option} is missing a value`, () => {
      const result = runClawlog([option]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`Error: ${option} requires a value`);
    });
  }

  it("accepts dash-prefixed search text", () => {
    const result = runClawlog(["-s", "-failed"]);

    expect(result.stderr).not.toContain("requires a value");
  });

  it("accepts dash-prefixed category", () => {
    const result = runClawlog(["-c", "-ServerManager"]);

    expect(result.stderr).not.toContain("requires a value");
  });

  it("accepts a dash-prefixed output path", () => {
    const result = runClawlog(["-o", "-debug.log"]);

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("requires a value");
  });
});

describe("clawlog.sh JSON output", () => {
  it("limits complete records and frames them as one clean JSON array", () => {
    const result = runClawlog(["--json", "--lines", "1"], {
      stdout: encodeRecords(3),
      stderr: "backend warning\n",
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([{ index: 2, message: "line 2\ncontinued" }]);
    expect(readFileSync(result.callsPath, "utf8")).toContain("--style\nndjson\n");
    expect(result.stdout).not.toContain("backend warning");
    expect(result.stderr).toBe("backend warning\n");
  });

  it("atomically writes an output file without printing JSON or status to stdout", () => {
    const result = runClawlog(["--json", "--output", "logs.json"], {
      stdout: encodeRecords(2),
      stderr: "backend warning\n",
      existingOutput: "previous output",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("backend warning\n");
    expect(JSON.parse(readFileSync(path.join(result.cwd, "logs.json"), "utf8"))).toHaveLength(2);
    expect(readdirSync(result.cwd).filter((name) => name.includes(".tmp."))).toEqual([]);
  });

  it("preserves the exact backend failure and publishes no partial stdout", () => {
    const result = runClawlog(["--json"], {
      stdout: encodeRecords(2),
      stderr: "backend failed\n",
      status: 23,
    });

    expect(result.status).toBe(23);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("backend failed\n");
    expect(readdirSync(result.cwd).filter((name) => name.startsWith("clawlog."))).toEqual([]);
  });

  it("leaves an existing destination unchanged when the backend fails", () => {
    const result = runClawlog(["--json", "--output", "logs.json"], {
      stdout: encodeRecords(2),
      stderr: "backend failed\n",
      status: 37,
      existingOutput: "previous output",
    });

    expect(result.status).toBe(37);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("backend failed\n");
    expect(readFileSync(path.join(result.cwd, "logs.json"), "utf8")).toBe("previous output");
    expect(readdirSync(result.cwd).filter((name) => name.includes(".tmp."))).toEqual([]);
  });

  it("preserves failed preflight status without staging output", () => {
    const status = 64;
    const result = runClawlog(["--json", "--output", "logs.json"], {
      preflightStderr: "log preflight failed\n",
      preflightStatus: status,
      existingOutput: "previous output",
    });

    expect(result.status).toBe(status);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("log preflight failed\n");
    expect(readFileSync(path.join(result.cwd, "logs.json"), "utf8")).toBe("previous output");
    expect(existsSync(result.callsPath)).toBe(false);
    expect(readdirSync(result.cwd).filter((name) => name.includes(".tmp."))).toEqual([]);
  });

  it("rejects directory output without moving a staged file into it", () => {
    const result = runClawlog(["--json", "--output", "bin"], { stdout: encodeRecords(1) });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("directory");
    expect(readdirSync(path.join(result.cwd, "bin"))).toEqual(["sudo"]);
    expect(readdirSync(result.cwd).filter((name) => name.includes(".tmp."))).toEqual([]);
  });

  it.each([
    ["--json", "--follow"],
    ["--json", "--list-categories"],
  ])("rejects incompatible JSON options before backend invocation: %s %s", (...args) => {
    const result = runClawlog(args);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--json");
    expect(result.stderr).toContain(args.includes("--follow") ? "--follow" : "--list-categories");
    expect(existsSync(result.callsPath)).toBe(false);
  });
});
