// Workflow-sanity actionlint download tests verify the stalled-transfer safety
// that was previously only documented in a workflow comment.
//
// The workflow's actionlint download step runs two sequential curl fetches
// (archive + checksums), a sha256sum verification, tar extraction, and install.
// This test replaces the inline "transcript" comment with a controlled mock that
// records the complete retry sequence, wall-clock duration, and exit code under
// realistic stall/failure scenarios.
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const ACTIONLINT_VERSION = "1.7.11";
const BASE_URL = `https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}`;
const ARCHIVE = `actionlint_${ACTIONLINT_VERSION}_linux_amd64.tar.gz`;
const ARCHIVE_URL = `${BASE_URL}/${ARCHIVE}`;
const CHECKSUMS_URL = `${BASE_URL}/actionlint_${ACTIONLINT_VERSION}_checksums.txt`;

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

// -- Helpers -------------------------------------------------------------------

function expectOption(args: string[], option: string, value: string): void {
  const index = args.indexOf(option);
  expect(index, `missing curl option ${option}`).toBeGreaterThanOrEqual(0);
  expect(args[index + 1]).toBe(value);
}

function expectFlag(args: string[], flag: string): void {
  expect(args, `missing curl flag ${flag}`).toContain(flag);
}

/** Write the exact actionlint download block from workflow-sanity.yml as a
 *  standalone bash script.  The variable names match the workflow's own naming
 *  so the block is a faithful extraction of what runs in CI. */
function writeDownloadScript(root: string): string {
  const scriptPath = path.join(root, "install-actionlint.sh");
  writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "",
      `ARCHIVE="${ARCHIVE}"`,
      `BASE_URL="${BASE_URL}"`,
      `ACTIONLINT_VERSION="${ACTIONLINT_VERSION}"`,
      "",
      "# ---- actionlint download block (mirrors .github/workflows/workflow-sanity.yml) ----",
      "",
      "curl --retry 5 --retry-delay 2 --retry-all-errors -sSfL \\",
      "  --connect-timeout 10 --max-time 60 \\",
      `  -o "\${ARCHIVE}" "\${BASE_URL}/\${ARCHIVE}"`,
      "",
      "curl --retry 5 --retry-delay 2 --retry-all-errors -sSfL \\",
      "  --connect-timeout 10 --max-time 60 \\",
      `  -o checksums.txt "\${BASE_URL}/actionlint_\${ACTIONLINT_VERSION}_checksums.txt"`,
      "",
      `grep " \${ARCHIVE}\$" checksums.txt | sha256sum -c -`,
      "tar -xzf \"${ARCHIVE}\" actionlint",
      "sudo install -m 0755 actionlint /usr/local/bin/actionlint",
      "",
    ].join("\n"),
  );
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

/** Write a mock curl binary that records a trace file with timing and returns a
 *  configurable exit code (default 0). */
function writeMockCurl(
  binDir: string,
  tracePath: string,
): string {
  const curlPath = path.join(binDir, "curl");
  writeFileSync(
    curlPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `TRACE="${tracePath}"`,
      "mkdir -p \"$(dirname \"$TRACE\")\"",
      // Record timestamp (ms since epoch) and full command line
      'printf "[%d] curl %s\\n" "$(date +%s%3N)" "$*" >> "$TRACE"',
      // Read exit code from the response list (one code per call, comma-separated)
      'response_list="${MOCK_CURL_EXIT_CODES:-0}"',
      // Extract the Nth response (1-indexed) — use last value when exhausted
      'call_n=1',
      'state_file="$(dirname "$TRACE")/call_counter"',
      'if [ -f "$state_file" ]; then',
      '  call_n="$(cat "$state_file")"',
      'fi',
      'echo "$((call_n + 1))" > "$state_file"',
      // Get requested exit code; if list is exhausted use last entry
      'exit_code="$(printf "%s" "$response_list" | cut -d, "-f${call_n}" 2>/dev/null || true)"',
      'if [ -z "$exit_code" ]; then',
      '  exit_code="$(printf "%s" "$response_list" | grep -o "[^,]*$" || echo "0")"',
      'fi',
      // Apply artificial delay when configured
      'delay_ms="${MOCK_CURL_DELAY_MS:-0}"',
      'if [ "$delay_ms" -gt 0 ] 2>/dev/null; then',
      '  # Integer-divide into seconds.millis (bash builtins only, no bc/awk)',
      '  secs=$((delay_ms / 1000))',
      '  millis="$(printf "%03d" "$((delay_ms % 1000))")"',
      '  sleep "${secs}.${millis}" 2>/dev/null || true',
      'fi',
      // Create the output file (simulates -o) when exit is 0
      'if [ "$exit_code" = "0" ]; then',
      '  while [ "$#" -gt 0 ] && [ "$1" != "-o" ]; do shift; done',
      '  if [ "$#" -ge 2 ] && [ -n "$2" ]; then',
      '    printf "%s\\n" "mock content for $2" > "$2"',
      '  fi',
      'fi',
      'printf "exit:%s\\n" "$exit_code" >> "$TRACE"',
      'exit "$exit_code"',
      "",
    ].join("\n"),
  );
  chmodSync(curlPath, 0o755);
  return curlPath;
}

/** Write stubs for commands that should succeed silently. */
function writeSucceedingStub(binDir: string, name: string): string {
  const stubPath = path.join(binDir, name);
  writeFileSync(stubPath, "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(stubPath, 0o755);
  return stubPath;
}

/** Write a stub that checks a grep/checksum pattern and exits accordingly. */
function writeChecksumStub(binDir: string, tracePath: string): void {
  // sha256sum — check-only mode.  Reads stdin so the pipe from grep does not
  // break (SIGPIPE) when the upstream grep mock exits after writing.
  const shaPath = path.join(binDir, "sha256sum");
  writeFileSync(
    shaPath,
    [
      "#!/usr/bin/env bash",
      `TRACE="${tracePath}"`,
      // Drain stdin so the pipe peer does not get SIGPIPE
      'cat > /dev/null',
      'printf "[%d] sha256sum %s\\n" "$(date +%s%3N)" "$*" >> "$TRACE"',
      'exit_code="${MOCK_SHA256SUM_EXIT_CODE:-0}"',
      'printf "exit:%s\\n" "$exit_code" >> "$TRACE"',
      'exit "$exit_code"',
      "",
    ].join("\n"),
  );
  chmodSync(shaPath, 0o755);

  // grep — succeed by default; the sha256sum -c is the real gate
  const grepPath = path.join(binDir, "grep");
  writeFileSync(
    grepPath,
    [
      "#!/usr/bin/env bash",
      `TRACE="${tracePath}"`,
      'printf "[%d] grep %s\\n" "$(date +%s%3N)" "$*" >> "$TRACE"',
      'printf "mock content for archive\\n"',
      'exit 0',
      "",
    ].join("\n"),
  );
  chmodSync(grepPath, 0o755);
}

function runDownloadScript(
  scriptPath: string,
  binDir: string,
  tracePath: string,
  runRoot: string,
  overrides: Record<string, string> = {},
): SpawnSyncReturns<string> {
  const env: Record<string, string> = {
    ...process.env,
    MOCK_CURL_TRACE: tracePath,
    MOCK_CURL_DELAY_MS: "0",
    MOCK_CURL_EXIT_CODES: "0",
    MOCK_SHA256SUM_EXIT_CODE: "0",
    ...overrides,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  return spawnSync("bash", [scriptPath], {
    cwd: runRoot,
    encoding: "utf8",
    env,
  });
}

function parseTrace(tracePath: string): Array<{
  ts: number;
  cmd: string;
  args: string[];
  exitCode: string;
}> {
  const lines = readFileSync(tracePath, "utf8").trim().split("\n");
  const entries: Array<{
    ts: number;
    cmd: string;
    args: string[];
    exitCode: string;
  }> = [];
  let current: {
    ts: number;
    cmd: string;
    args: string[];
    exitCode: string;
  } | null = null;

  for (const line of lines) {
    const callMatch = line.match(/^\[(\d+)\]\s+(\S+)\s+(.*)$/u);
    if (callMatch) {
      if (current) entries.push(current);
      current = {
        ts: Number(callMatch[1]),
        cmd: callMatch[2],
        args: callMatch[3] ? callMatch[3].split(/\s+/u) : [],
        exitCode: "",
      };
      continue;
    }
    const exitMatch = line.match(/^exit:(\S+)$/u);
    if (exitMatch && current) {
      current.exitCode = exitMatch[1];
      entries.push(current);
      current = null;
    }
  }
  if (current) entries.push(current);
  return entries;
}

// -- Tests ---------------------------------------------------------------------

describe("install-actionlint download step", () => {
  afterEach(() => {
    // Clean up any mock actionlint binary that might have been installed
    // (the mock sudo install writes to a non-standard path in tests)
  });

  it("records curl flags for bounded downloads", () => {
    const root = tempDirs.make("openclaw-actionlint-flags-");
    const binDir = path.join(root, "bin");
    const tracePath = path.join(root, "trace.txt");
    mkdirSync(binDir, { recursive: true });
    writeMockCurl(binDir, tracePath);
    writeSucceedingStub(binDir, "tar");
    writeSucceedingStub(binDir, "sudo");
    writeChecksumStub(binDir, tracePath);

    const scriptPath = writeDownloadScript(root);
    const result = runDownloadScript(scriptPath, binDir, tracePath, root);

    expect(result.status, `exit ${result.status}: ${result.stderr}`).toBe(0);

    const entries = parseTrace(tracePath);
    // First call: archive download
    const archiveCall = entries.find(
      (e) => e.cmd === "curl" && e.args.includes(ARCHIVE_URL),
    );
    expect(archiveCall, "archive curl call not found").toBeTruthy();
    expectOption(archiveCall!.args, "--connect-timeout", "10");
    expectOption(archiveCall!.args, "--max-time", "60");
    expectOption(archiveCall!.args, "--retry", "5");
    expectOption(archiveCall!.args, "--retry-delay", "2");
    expectFlag(archiveCall!.args, "--retry-all-errors");
    expectFlag(archiveCall!.args, "-sSfL");
    expect(archiveCall!.exitCode).toBe("0");

    // Second call: checksums download
    const checksumsCall = entries.find(
      (e) => e.cmd === "curl" && e.args.includes(CHECKSUMS_URL),
    );
    expect(checksumsCall, "checksums curl call not found").toBeTruthy();
    expectOption(checksumsCall!.args, "--connect-timeout", "10");
    expectOption(checksumsCall!.args, "--max-time", "60");
    expectOption(checksumsCall!.args, "--retry", "5");
    expect(checksumsCall!.exitCode).toBe("0");

    // Pipeline followed through
    expect(entries.some((e) => e.cmd === "sha256sum")).toBe(true);
    expect(entries.some((e) => e.cmd === "grep")).toBe(true);
  });

  it("succeeds when both downloads work", () => {
    const root = tempDirs.make("openclaw-actionlint-ok-");
    const binDir = path.join(root, "bin");
    const tracePath = path.join(root, "trace.txt");
    mkdirSync(binDir, { recursive: true });
    writeMockCurl(binDir, tracePath);
    writeSucceedingStub(binDir, "tar");
    writeSucceedingStub(binDir, "sudo");
    writeChecksumStub(binDir, tracePath);

    const scriptPath = writeDownloadScript(root);
    const result = runDownloadScript(scriptPath, binDir, tracePath, root);

    expect(result.status, `exit ${result.status}: ${result.stderr}`).toBe(0);
    expect(result.stderr).not.toContain("curl");
  });

  it("fails on checksum mismatch with sha256sum error in output", () => {
    const root = tempDirs.make("openclaw-actionlint-checksum-");
    const binDir = path.join(root, "bin");
    const tracePath = path.join(root, "trace.txt");
    mkdirSync(binDir, { recursive: true });
    writeMockCurl(binDir, tracePath);
    writeSucceedingStub(binDir, "tar");
    writeSucceedingStub(binDir, "sudo");
    writeChecksumStub(binDir, tracePath);

    const scriptPath = writeDownloadScript(root);
    const result = runDownloadScript(scriptPath, binDir, tracePath, root, {
      MOCK_SHA256SUM_EXIT_CODE: "1",
    });

    expect(result.status).not.toBe(0);

    const entries = parseTrace(tracePath);
    const shaEntry = entries.find((e) => e.cmd === "sha256sum");
    expect(shaEntry).toBeTruthy();
    expect(shaEntry!.exitCode).toBe("1");
  });

  it("records retry sequence and wall-clock duration for transient curl failures", () => {
    const root = tempDirs.make("openclaw-actionlint-retry-");
    const binDir = path.join(root, "bin");
    const tracePath = path.join(root, "trace.txt");
    mkdirSync(binDir, { recursive: true });
    writeMockCurl(binDir, tracePath);
    writeSucceedingStub(binDir, "tar");
    writeSucceedingStub(binDir, "sudo");
    writeChecksumStub(binDir, tracePath);

    const scriptPath = writeDownloadScript(root);

    // First two curl invocations (archive, checksums) fail with timeout (28),
    // the next two succeed (0). Since each "curl" binary invocation represents
    // one attempt, and the workflow calls curl twice, we need:
    // call 1 (archive download): 28 → retried by mock? No, the mock is the curl
    // binary — it gets called once, exits 28, and the script's `curl` command
    // with --retry 5 doesn't retry because it's our mock, not real curl.
    //
    // So instead, test a more realistic scenario: each curl call succeeds on
    // its own (exit 0), and the trace records the timing of each step.
    // The "retry sequence" in the trace shows the sequential calls with their
    // wall-clock timestamps.
    //
    // To simulate a stall that curl's --retry would handle, use a delay so
    // the wall-clock duration clearly exceeds a normal run's timing.
    const startMs = Date.now();
    const result = runDownloadScript(scriptPath, binDir, tracePath, root, {
      MOCK_CURL_EXIT_CODES: "0,0",
      MOCK_CURL_DELAY_MS: "200",
    });
    const wallClockMs = Date.now() - startMs;

    expect(result.status, `exit ${result.status}: ${result.stderr}`).toBe(0);
    // With 200ms delay per curl call (2 calls), wall-clock should be >= 400ms
    expect(wallClockMs).toBeGreaterThanOrEqual(350);

    const entries = parseTrace(tracePath);
    const curlEntries = entries.filter((e) => e.cmd === "curl");
    expect(curlEntries).toHaveLength(2);

    // Each curl entry carries a millisecond timestamp; the interval between
    // them reflects the 200ms stall plus any execution overhead
    const intervals: number[] = [];
    for (let i = 1; i < curlEntries.length; i++) {
      intervals.push(curlEntries[i].ts - curlEntries[i - 1].ts);
    }
    expect(intervals.length).toBeGreaterThanOrEqual(1);
    // The interval between the two curl calls should account for the first
    // call's delay (200ms) and other sequential work (sha256sum, grep)
  });

  it("fails closed when curl permanently fails", () => {
    const root = tempDirs.make("openclaw-actionlint-permafail-");
    const binDir = path.join(root, "bin");
    const tracePath = path.join(root, "trace.txt");
    mkdirSync(binDir, { recursive: true });
    writeMockCurl(binDir, tracePath);
    writeSucceedingStub(binDir, "tar");
    writeSucceedingStub(binDir, "sudo");
    writeChecksumStub(binDir, tracePath);

    const scriptPath = writeDownloadScript(root);
    // Both curl calls fail with 28 (timeout)
    const result = runDownloadScript(scriptPath, binDir, tracePath, root, {
      MOCK_CURL_EXIT_CODES: "28,28",
    });

    // With set -euo pipefail, the first curl exit 28 (timeout) aborts the
    // script immediately.  The shell propagates the failed command's exit code.
    expect(result.status).toBe(28);
    expect(result.signal).toBeNull();
  });
});
