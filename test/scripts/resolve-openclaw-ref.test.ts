// Resolve OpenClaw ref tests cover the release workflow ref resolver script.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT_PATH = "scripts/github/resolve-openclaw-ref.sh";
const BASH_PATH = "/bin/bash";
const tempDirs = createTempDirTracker();
let remoteRepo: string;
let remoteSha: string;

afterAll(() => {
  tempDirs.cleanup();
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function createRemoteRepo() {
  const repo = tempDirs.make("openclaw-ref-remote-");
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "test-user"]);
  git(repo, ["config", "user.name", "Test User"]);
  execFileSync("bash", ["-c", "printf seed > seed.txt"], { cwd: repo });
  git(repo, ["add", "seed.txt"]);
  git(repo, ["commit", "-qm", "seed"]);
  const sha = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["branch", "release/test"]);
  git(repo, ["branch", "ambiguous"]);
  git(repo, ["-c", "tag.gpgSign=false", "tag", "v2026.6.21"]);
  git(repo, ["-c", "tag.gpgSign=false", "tag", "ambiguous"]);
  return { repo, sha };
}

beforeAll(() => {
  ({ repo: remoteRepo, sha: remoteSha } = createRemoteRepo());
});

function runResolver(remote: string, args: string[], envOverrides: Record<string, string> = {}) {
  return spawnSync(BASH_PATH, [SCRIPT_PATH, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_OUTPUT: "",
      OPENCLAW_REF_REMOTE: remote,
      ...envOverrides,
    },
  });
}

function exposeCommandsWithoutTimeout(toolDir: string): void {
  for (const command of ["awk", "cat", "mktemp", "rm", "tr"]) {
    const candidate = [`/usr/bin/${command}`, `/bin/${command}`].find((path) => existsSync(path));
    if (!candidate) {
      throw new Error(`Could not find ${command} for fallback test`);
    }
    symlinkSync(candidate, join(toolDir, command));
  }
}

function parseOutput(output: string): Record<string, string> {
  return Object.fromEntries(
    output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function expectSuccessfulOutput(result: ReturnType<typeof runResolver>): Record<string, string> {
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  return parseOutput(result.stdout);
}

describe("scripts/github/resolve-openclaw-ref.sh", () => {
  it("bounds remote lookups and preserves the resolved ref contract", () => {
    const toolDir = tempDirs.make("openclaw-ref-tools-");
    const timeoutLog = join(toolDir, "timeout.log");
    const gitLog = join(toolDir, "git.log");
    const gitPath = join(toolDir, "git");
    const timeoutPath = join(toolDir, "timeout");
    mkdirSync(toolDir, { recursive: true });
    writeFileSync(
      gitPath,
      `#!/bin/sh
printf 'args=%s limit=%s time=%s\\n' "$*" "$GIT_HTTP_LOW_SPEED_LIMIT" "$GIT_HTTP_LOW_SPEED_TIME" >> "$OPENCLAW_TEST_GIT_LOG"
if [ "\${3:-}" = "refs/heads/main" ]; then
  printf '%s refs/heads/main\\n' '${"a".repeat(40)}'
fi
`,
      { mode: 0o755 },
    );
    writeFileSync(
      timeoutPath,
      `#!/bin/sh
printf '%s\\n' "$*" >> "$OPENCLAW_TEST_TIMEOUT_LOG"
if [ "\${OPENCLAW_TEST_TIMEOUT_FAIL:-}" = "1" ]; then
  exit 124
fi
while [ "\${1:-}" = "--signal=TERM" ] || [ "\${1:-}" = "--kill-after=5s" ]; do
  shift
done
shift
exec "$@"
`,
      { mode: 0o755 },
    );

    const result = runResolver("https://example.invalid/openclaw.git", ["--ref", "main"], {
      PATH: `${toolDir}:${process.env.PATH ?? ""}`,
      OPENCLAW_TEST_GIT_LOG: gitLog,
      OPENCLAW_TEST_TIMEOUT_LOG: timeoutLog,
    });

    expect(expectSuccessfulOutput(result)).toEqual({
      fallback: "false",
      fast: "true",
      ref_kind: "branch",
      sha: "a".repeat(40),
    });
    const timeoutSeconds = Number(
      /--kill-after=5s (\d+)s\b/u.exec(readFileSync(timeoutLog, "utf8"))?.[1],
    );
    expect(timeoutSeconds).toBeGreaterThan(0);
    expect(timeoutSeconds).toBeLessThanOrEqual(119);
    expect(readFileSync(gitLog, "utf8")).toContain(
      `args=ls-remote https://example.invalid/openclaw.git refs/heads/main limit=1 time=30`,
    );
  });

  it("reports a remote lookup timeout without changing the exit contract", () => {
    const toolDir = tempDirs.make("openclaw-ref-timeout-tools-");
    const timeoutPath = join(toolDir, "timeout");
    mkdirSync(toolDir, { recursive: true });
    writeFileSync(
      timeoutPath,
      `#!/bin/sh
exit 124
`,
      { mode: 0o755 },
    );

    const result = runResolver("https://example.invalid/openclaw.git", ["--ref", "main"], {
      PATH: `${toolDir}:${process.env.PATH ?? ""}`,
      OPENCLAW_TEST_TIMEOUT_FAIL: "1",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("git ls-remote timed out within the 120s resolver budget");
  });

  it("keeps Git low-speed guards when GNU timeout is unavailable", () => {
    const toolDir = tempDirs.make("openclaw-ref-no-timeout-tools-");
    const gitLog = join(toolDir, "git.log");
    const gitPath = join(toolDir, "git");
    mkdirSync(toolDir, { recursive: true });
    exposeCommandsWithoutTimeout(toolDir);
    writeFileSync(
      gitPath,
      `#!/bin/sh
printf 'args=%s limit=%s time=%s\\n' "$*" "$GIT_HTTP_LOW_SPEED_LIMIT" "$GIT_HTTP_LOW_SPEED_TIME" >> "$OPENCLAW_TEST_GIT_LOG"
if [ "\${3:-}" = "refs/heads/main" ]; then
  printf '%s refs/heads/main\\n' '${"b".repeat(40)}'
fi
`,
      { mode: 0o755 },
    );

    const result = runResolver("https://example.invalid/openclaw.git", ["--ref", "main"], {
      PATH: toolDir,
      OPENCLAW_TEST_GIT_LOG: gitLog,
    });

    expect(expectSuccessfulOutput(result)).toEqual({
      fallback: "false",
      fast: "true",
      ref_kind: "branch",
      sha: "b".repeat(40),
    });
    expect(readFileSync(gitLog, "utf8")).toContain(
      `args=ls-remote https://example.invalid/openclaw.git refs/heads/main limit=1 time=30`,
    );
  });

  it("shares the resolver deadline across multiple remote refspecs", () => {
    const toolDir = tempDirs.make("openclaw-ref-shared-deadline-tools-");
    const timeoutLog = join(toolDir, "timeout.log");
    const countPath = join(toolDir, "timeout.count");
    const gitPath = join(toolDir, "git");
    const timeoutPath = join(toolDir, "timeout");
    mkdirSync(toolDir, { recursive: true });
    writeFileSync(countPath, "0");
    writeFileSync(
      gitPath,
      `#!/bin/sh
exit 0
`,
      { mode: 0o755 },
    );
    writeFileSync(
      timeoutPath,
      `#!/bin/sh
count=$(cat "$OPENCLAW_TEST_TIMEOUT_COUNT")
count=$((count + 1))
printf '%s\\n' "$*" >> "$OPENCLAW_TEST_TIMEOUT_LOG"
printf '%s' "$count" > "$OPENCLAW_TEST_TIMEOUT_COUNT"
if [ "$count" -eq 1 ]; then
  /bin/sleep 2
fi
while [ "\${1:-}" = "--signal=TERM" ] || [ "\${1:-}" = "--kill-after=5s" ]; do
  shift
done
shift
exec "$@"
`,
      { mode: 0o755 },
    );

    const result = runResolver(
      "https://example.invalid/openclaw.git",
      ["--ref", "refs/tags/missing"],
      {
        PATH: `${toolDir}:${process.env.PATH ?? ""}`,
        OPENCLAW_TEST_TIMEOUT_LOG: timeoutLog,
        OPENCLAW_TEST_TIMEOUT_COUNT: countPath,
      },
    );

    expect(result.status).toBe(1);
    const durations = readFileSync(timeoutLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => Number(/--kill-after=5s (\d+)s\b/u.exec(line)?.[1]));
    expect(durations).toHaveLength(2);
    expect(durations[0]).toBeGreaterThan(durations[1]);
  });

  it("resolves branch and tag refs with git ls-remote", () => {
    expect(expectSuccessfulOutput(runResolver(remoteRepo, ["--ref", "release/test"]))).toEqual({
      fallback: "false",
      fast: "true",
      ref_kind: "branch",
      sha: remoteSha,
    });
    expect(expectSuccessfulOutput(runResolver(remoteRepo, ["--ref", "v2026.6.21"]))).toEqual({
      fallback: "false",
      fast: "true",
      ref_kind: "tag",
      sha: remoteSha,
    });
  });

  it("accepts full commit SHA refs without remote lookup", () => {
    const result = runResolver(remoteRepo, ["--ref", remoteSha.toUpperCase()]);

    expect(expectSuccessfulOutput(result)).toEqual({
      fallback: "true",
      fast: "false",
      ref_kind: "sha",
      sha: remoteSha,
    });
  });

  it("writes fallback outputs for unresolved refs when a caller supplies an expected SHA", () => {
    const outputPath = join(tempDirs.make("openclaw-ref-output-"), "github-output.txt");
    const result = runResolver(remoteRepo, [
      "--ref",
      "missing-ref",
      "--expected-sha",
      remoteSha,
      "--fallback-ok",
      "--github-output",
      outputPath,
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(parseOutput(execFileSync("cat", [outputPath], { encoding: "utf8" }))).toEqual({
      fallback: "true",
      fast: "false",
      ref_kind: "unknown",
      sha: remoteSha,
    });
  });

  it("does not let fallback mode hide remote lookup failures", () => {
    const missingRemote = join(tempDirs.make("openclaw-ref-missing-"), "missing.git");
    const result = runResolver(missingRemote, [
      "--ref",
      "missing-ref",
      "--expected-sha",
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "--fallback-ok",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not appear to be a git repository");
    expect(result.stdout).toBe("");
  });

  it("rejects ambiguous branch and tag names before emitting outputs", () => {
    const result = runResolver(remoteRepo, ["--ref", "ambiguous"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Ref resolved ambiguously as both branch and tag: ambiguous");
    expect(result.stdout).toBe("");
  });
});
