import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT_PATH = fileURLToPath(new URL("../../scripts/clawlog.sh", import.meta.url));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type MockLogOptions = Partial<
  Record<"stdout" | "stderr" | "preflightStderr" | "existingOutput", string> &
    Record<"status" | "preflightStatus", number>
>;

function runClawlog(args: string[] = [], options: MockLogOptions = {}) {
  const cwd = tempDirs.make("openclaw-clawlog-test-");
  const binDir = path.join(cwd, "bin");
  const callsPath = path.join(cwd, "backend-calls");
  fs.mkdirSync(binDir);
  const sudoPath = path.join(binDir, "sudo");
  fs.writeFileSync(
    sudoPath,
    `#!/bin/sh
[ "$1" = "-n" ] && { printf "%s" "$MOCK_PREFLIGHT_STDERR" >&2; exit "$MOCK_PREFLIGHT_STATUS"; }
printf "%s\\n" "$@" >> "$MOCK_LOG_CALLS"
printf "%s" "$MOCK_LOG_STDOUT"
printf "%s" "$MOCK_LOG_STDERR" >&2
exit "$MOCK_LOG_STATUS"
`,
  );
  fs.chmodSync(sudoPath, 0o755);
  if (options.existingOutput !== undefined) {
    fs.writeFileSync(path.join(cwd, "logs.json"), options.existingOutput);
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
  return {
    ...result,
    callsPath,
    read: (name: string) => fs.readFileSync(path.join(cwd, name), "utf8"),
    files: (name = ".") => fs.readdirSync(path.join(cwd, name)),
  };
}

function encodeRecords(count: number): string {
  const records = Array.from({ length: count }, (_, index) =>
    JSON.stringify({ index, message: `line ${index}\ncontinued` }),
  );
  return [...records, JSON.stringify({ count, finished: 1 })].join("\n");
}

describe("clawlog.sh argument parsing", () => {
  it("uses the documented default view when run without arguments", () => {
    const { stdout, stderr } = runClawlog();
    const output = stdout + stderr;
    expect(output).toContain("Showing last 50 log lines from the past 5m");
    expect(output).not.toContain("USAGE:");
  });

  for (const option of ["-n", "-l", "-c", "-s", "-o"]) {
    it(`reports a clear error when ${option} is missing a value`, () => {
      const result = runClawlog([option]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`Error: ${option} requires a value`);
    });
  }

  it.each([
    ["-s", "-failed"],
    ["-c", "-ServerManager"],
    ["-o", "-debug.log"],
  ])("accepts a dash-prefixed value for %s", (option, value) => {
    const result = runClawlog([option, value]);
    if (option === "-o") {
      expect(result.status).toBe(0);
    }
    expect(result.stderr).not.toContain("requires a value");
  });
});

describe("clawlog.sh JSON output", () => {
  it("limits complete records and frames them as one clean JSON array", () => {
    const result = runClawlog(["--json", "--lines", "1"], {
      stdout: encodeRecords(3),
      stderr: "backend warning\n",
    });
    expect(result).toMatchObject({ status: 0, stderr: "backend warning\n" });
    expect(JSON.parse(result.stdout)).toEqual([{ index: 2, message: "line 2\ncontinued" }]);
    expect(result.read("backend-calls")).toContain("--style\nndjson\n");
    expect(result.stdout).not.toContain("backend warning");
  });

  it.each([
    ["success", 0, "backend warning\n", false],
    ["backend failure", 37, "backend failed\n", false],
    ["preflight failure", 64, "log preflight failed\n", true],
  ] as const)("publishes or preserves JSON output on %s", (_name, status, stderr, preflight) => {
    const backend = preflight
      ? { preflightStatus: status, preflightStderr: stderr }
      : { stdout: encodeRecords(2), status, stderr };
    const result = runClawlog(["--json", "--output", "logs.json"], {
      ...backend,
      existingOutput: "previous output",
    });
    expect(result).toMatchObject({ status, stdout: "", stderr });
    if (status === 0) {
      expect(JSON.parse(result.read("logs.json"))).toHaveLength(2);
    } else {
      expect(result.read("logs.json")).toBe("previous output");
    }
    if (preflight) {
      expect(fs.existsSync(result.callsPath)).toBe(false);
    }
    expect(result.files().filter((name) => name.includes(".tmp."))).toEqual([]);
  });

  it("preserves backend failure without publishing partial stdout", () => {
    const result = runClawlog(["--json"], {
      stdout: encodeRecords(2),
      stderr: "backend failed\n",
      status: 23,
    });
    expect(result).toMatchObject({ status: 23, stdout: "", stderr: "backend failed\n" });
    expect(result.files().filter((name) => name.startsWith("clawlog."))).toEqual([]);
  });

  it("rejects directory output without moving a staged file into it", () => {
    const result = runClawlog(["--json", "--output", "bin"], { stdout: encodeRecords(1) });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("directory");
    expect(result.files("bin")).toEqual(["sudo"]);
    expect(result.files().filter((name) => name.includes(".tmp."))).toEqual([]);
  });

  it.each(["--follow", "--list-categories"])("rejects --json with %s", (option) => {
    const result = runClawlog(["--json", option]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--json");
    expect(result.stderr).toContain(option);
    expect(fs.existsSync(result.callsPath)).toBe(false);
  });
});
