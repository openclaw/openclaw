import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT_PATH = path.resolve("scripts/ci-live-command-retry.sh");
const tempDirs: string[] = [];

function bashPrintfValue(value: string): string {
  return JSON.stringify(value).replaceAll("\\u001b", "\\x1b");
}

function writeCommand(
  prefix: string,
  lines: string[],
): { commandPath: string; counterPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  const commandPath = path.join(dir, "command.sh");
  const counterPath = path.join(dir, "attempts.txt");
  writeFileSync(
    commandPath,
    [
      "#!/bin/bash",
      "set -euo pipefail",
      "attempts=0",
      'if [[ -f "$OPENCLAW_RETRY_TEST_COUNTER" ]]; then',
      '  attempts="$(<"$OPENCLAW_RETRY_TEST_COUNTER")"',
      "fi",
      'attempts="$((attempts + 1))"',
      'printf "%s" "$attempts" > "$OPENCLAW_RETRY_TEST_COUNTER"',
      ...lines,
      "",
    ].join("\n"),
  );
  chmodSync(commandPath, 0o755);
  return { commandPath, counterPath };
}

function runRetryHelper(
  commandPath: string,
  counterPath: string,
  overrides: Record<string, string> = {},
) {
  const env = { ...process.env };
  delete env.OPENCLAW_LIVE_COMMAND_RETRY_PATTERN;
  delete env.OPENCLAW_LIVE_COMMAND_RATE_LIMIT_PATTERN;
  return spawnSync("/bin/bash", [SCRIPT_PATH], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...env,
      OPENCLAW_LIVE_COMMAND: `/bin/bash ${JSON.stringify(commandPath)}`,
      OPENCLAW_LIVE_COMMAND_ATTEMPTS: "2",
      OPENCLAW_LIVE_COMMAND_RETRY_DELAY_SECONDS: "0",
      OPENCLAW_LIVE_COMMAND_RATE_LIMIT_RETRY_DELAY_SECONDS: "0",
      OPENCLAW_RETRY_TEST_COUNTER: counterPath,
      ...overrides,
    },
  });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { force: true, recursive: true });
  }
});

describe("scripts/ci-live-command-retry.sh", () => {
  it.each([
    ["assertion with a rate-limit token", "   \u2713 handles HTTP 429 rate limit 7ms"],
    [
      "ANSI assertion",
      " \u001b[32m\u2713\u001b[39m handles 429 \u001b[32m7\u001b[2mms\u001b[22m\u001b[39m",
    ],
    ["assertion with a network token", "   \u2713 handles ECONNRESET and fetch failed 0ms"],
    ["suite", " \u2713 HTTP 503 and rate limit handling (3)"],
    ["module", " \u2713 [core] src/http-429.test.ts (2 tests) 12ms"],
    [
      "ANSI module",
      " \u001b[32m\u2713\u001b[39m src/network.test.ts \u001b[2m(2 tests)\u001b[22m 529ms",
    ],
    ["assertion with retry metadata", "   \u2713 handles ETIMEDOUT 3ms (retry x1)"],
  ])("ignores successful %s when the command fails deterministically", (_label, row) => {
    const output = `${row}\nInvalidConfigError: invalid fixture configuration`;
    const { commandPath, counterPath } = writeCommand("openclaw-ci-live-passed-row-", [
      `printf '%b\\n' ${bashPrintfValue(output)}`,
      "exit 42",
    ]);

    const result = runRetryHelper(commandPath, counterPath);

    expect(result.status).toBe(42);
    expect(readFileSync(counterPath, "utf8")).toBe("1");
    expect(result.stdout).toBe(`${output}\n`);
    expect(result.stderr).not.toContain("retrying");
    expect(result.stderr).not.toContain("Provider rate limit detected");
  });

  it("does not choose the rate-limit delay from a passed row before a real HTTP 503", () => {
    const { commandPath, counterPath } = writeCommand("openclaw-ci-live-delay-", [
      'if [[ "$attempts" -eq 1 ]]; then',
      "  printf '%s\\n' '   \u2713 handles 429 rate limit 1ms' 'Error: HTTP 503 unavailable'",
      "  exit 42",
      "fi",
    ]);
    const directory = path.dirname(commandPath);
    const sleepPath = path.join(directory, "sleep");
    const sleepTrace = path.join(directory, "sleep-args.txt");
    writeFileSync(sleepPath, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$OPENCLAW_RETRY_TEST_SLEEP"\n');
    chmodSync(sleepPath, 0o755);

    const result = runRetryHelper(commandPath, counterPath, {
      PATH: `${directory}${path.delimiter}${process.env.PATH ?? ""}`,
      OPENCLAW_RETRY_TEST_SLEEP: sleepTrace,
      OPENCLAW_LIVE_COMMAND_RETRY_DELAY_SECONDS: "9",
      OPENCLAW_LIVE_COMMAND_RATE_LIMIT_RETRY_DELAY_SECONDS: "61",
    });

    expect(result.status).toBe(0);
    expect(readFileSync(counterPath, "utf8")).toBe("2");
    expect(readFileSync(sleepTrace, "utf8")).toBe("9\n");
    expect(result.stdout).toContain("   \u2713 handles 429 rate limit 1ms\n");
    expect(result.stderr).toContain("retrying (1/2)");
    expect(result.stderr).not.toContain("Provider rate limit detected");
  });

  it("retries a provider-internal RPC timeout", () => {
    const { commandPath, counterPath } = writeCommand("openclaw-ci-live-rpc-timeout-", [
      'if [[ "$attempts" -eq 1 ]]; then',
      '  echo "MiniMax image generation API error (1000): rpc timeout: timeout=1m0s" >&2',
      "  exit 42",
      "fi",
    ]);

    const result = runRetryHelper(commandPath, counterPath);

    expect(result.status).toBe(0);
    expect(readFileSync(counterPath, "utf8")).toBe("2");
    expect(result.stderr).toContain(
      "Live command failed with a retryable provider/network error; retrying (1/2)",
    );
  });

  it.each([
    ["provider HTTP 500", "xAI image edit failed (HTTP 500): Please try again later"],
    ["live test timeout", "Error: Test timed out in 45000ms."],
    ["live terminal timeout", "Error: terminal timeout after 300000ms"],
    ["provider HTTP 429", "Error: HTTP 429"],
    ["provider HTTP 529", "Error: HTTP 529"],
    ["network failure", "Error: ECONNRESET"],
    ["ordinary error with an embedded checkmark", "Error: HTTP 503 after stage \u2713 completed"],
    ["ordinary leading checkmark", " \u2713 upstream HTTP 503 unavailable"],
    ["failed assertion", "   \u00d7 handles HTTP 503 2ms"],
  ])("retries a transient %s", (_label, message) => {
    const { commandPath, counterPath } = writeCommand("openclaw-ci-live-transient-", [
      'if [[ "$attempts" -eq 1 ]]; then',
      `  echo ${JSON.stringify(message)} >&2`,
      "  exit 42",
      "fi",
    ]);

    const result = runRetryHelper(commandPath, counterPath);

    expect(result.status).toBe(0);
    expect(readFileSync(counterPath, "utf8")).toBe("2");
    expect(result.stderr).toContain("retrying (1/2)");
  });

  it("does not retry a MiniMax authentication failure", () => {
    const { commandPath, counterPath } = writeCommand("openclaw-ci-live-auth-failure-", [
      'echo "MiniMax image generation API error (1004): authentication failed" >&2',
      "exit 42",
    ]);

    const result = runRetryHelper(commandPath, counterPath);

    expect(result.status).toBe(42);
    expect(readFileSync(counterPath, "utf8")).toBe("1");
    expect(result.stderr).not.toContain("retrying");
  });

  it.each([
    ["empty output", "", 37],
    ["only successful rows", "   \u2713 handles HTTP 503 3ms\n", 38],
    ["deterministic config failure", "InvalidConfigError: invalid fixture\n", 39],
    ["successful first attempt", "HTTP 503\n", 0],
  ])("preserves status and invocation count for %s", (_label, output, status) => {
    const { commandPath, counterPath } = writeCommand("openclaw-ci-live-status-", [
      `printf '%b' ${bashPrintfValue(output)}`,
      `exit ${status}`,
    ]);

    const result = runRetryHelper(commandPath, counterPath);

    expect(result.status).toBe(status);
    expect(readFileSync(counterPath, "utf8")).toBe("1");
    expect(result.stdout).toBe(output);
    expect(result.stderr).not.toContain("retrying");
  });

  it("preserves the last failure status after exhausting attempts", () => {
    const { commandPath, counterPath } = writeCommand("openclaw-ci-live-exhaustion-", [
      'echo "Error: HTTP 503 unavailable"',
      "exit 43",
    ]);

    const result = runRetryHelper(commandPath, counterPath);

    expect(result.status).toBe(43);
    expect(readFileSync(counterPath, "utf8")).toBe("2");
    expect(result.stderr.match(/retrying/gu)).toHaveLength(1);
  });

  it("preserves explicit retry and rate-limit patterns", () => {
    const { commandPath, counterPath } = writeCommand("openclaw-ci-live-patterns-", [
      'if [[ "$attempts" -eq 1 ]]; then',
      '  echo "fixture provider throttled"',
      "  exit 42",
      "fi",
    ]);

    const result = runRetryHelper(commandPath, counterPath, {
      OPENCLAW_LIVE_COMMAND_RETRY_PATTERN: "fixture provider",
      OPENCLAW_LIVE_COMMAND_RATE_LIMIT_PATTERN: "fixture provider throttled",
    });

    expect(result.status).toBe(0);
    expect(readFileSync(counterPath, "utf8")).toBe("2");
    expect(result.stderr).toContain("Provider rate limit detected; waiting 0s");
  });
});
