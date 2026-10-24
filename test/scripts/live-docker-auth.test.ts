import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function writeExecutable(filePath: string, contents: string) {
  writeFileSync(filePath, contents, "utf8");
  chmodSync(filePath, 0o755);
}

function runBash(
  commands: string[],
  env: NodeJS.ProcessEnv = {},
  args: string[] = [],
  flags = "-c",
) {
  return spawnSync("/bin/bash", [flags, commands.join("\n"), ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

const sourceAuth = "source scripts/lib/live-docker-auth.sh";
const printArgs = "printf '%s\\n' \"${ARGS[@]}\"";
const initArgs = [sourceAuth, "ARGS=()", "openclaw_live_init_docker_run_args ARGS 42s", printArgs];

function makeTimeoutBin(command = "timeout", plain = false) {
  const dir = tempDirs.make("openclaw-live-docker-auth-timeout-");
  writeExecutable(
    path.join(dir, command),
    [
      "#!/bin/sh",
      plain
        ? 'if [ "$1" = "--kill-after=1s" ]; then'
        : 'if [ "$1" = "--kill-after=1s" ] && [ "$2" = "1s" ] && [ "$3" = "true" ]; then',
      plain ? "  exit 1" : "  exit 0",
      "fi",
      plain ? "exit 0" : "exit 64",
      "",
    ].join("\n"),
  );
  return dir;
}

function expectedRunArgs(wrapper: string[], cpus = "16", pids = "2048") {
  return [
    ...wrapper,
    "42s",
    "docker",
    "run",
    "--init",
    "--memory",
    "8g",
    "--cpus",
    cpus,
    "--pids-limit",
    pids,
  ];
}

function runDockerRunArgs(pathPrefix: string) {
  const script = [
    sourceAuth,
    "unset OPENCLAW_LIVE_DOCKER_DISABLE_RESOURCE_LIMITS OPENCLAW_DOCKER_E2E_DISABLE_RESOURCE_LIMITS",
    "unset OPENCLAW_LIVE_DOCKER_MEMORY OPENCLAW_DOCKER_E2E_MEMORY",
    "unset OPENCLAW_LIVE_DOCKER_CPUS OPENCLAW_DOCKER_E2E_CPUS",
    "unset OPENCLAW_LIVE_DOCKER_PIDS_LIMIT OPENCLAW_DOCKER_E2E_PIDS_LIMIT",
    "ARGS=()",
    "openclaw_live_init_docker_run_args ARGS 42s || exit $?",
    printArgs,
  ];
  return runBash(script, { PATH: pathPrefix });
}

function resolveDockerRunArgs(pathPrefix: string) {
  const result = runDockerRunArgs(pathPrefix);
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
  return result.stdout.trimEnd().split("\n");
}

describe("scripts/lib/live-docker-auth.sh", () => {
  it("reads positive integer env values before live Docker setup", () => {
    const result = runBash([
      sourceAuth,
      'fallback="$(openclaw_live_read_positive_int_env OPENCLAW_LIVE_SAMPLE_SECONDS 180)"',
      'leading_zero="$(OPENCLAW_LIVE_SAMPLE_SECONDS=008 openclaw_live_read_positive_int_env OPENCLAW_LIVE_SAMPLE_SECONDS 180)"',
      'printf "%s\\n%s\\n" "$fallback" "$leading_zero"',
    ]);
    const invalid = runBash([
      sourceAuth,
      "OPENCLAW_LIVE_SAMPLE_SECONDS=30s openclaw_live_read_positive_int_env OPENCLAW_LIVE_SAMPLE_SECONDS 180",
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout.trimEnd().split("\n")).toEqual(["180", "008"]);
    expect(invalid.status).toBe(2);
    expect(invalid.stderr).toContain("invalid OPENCLAW_LIVE_SAMPLE_SECONDS: 30s");
  });

  it("collects default and disabled auth under Bash 3 nounset", () => {
    const homeDir = tempDirs.make("openclaw-live-docker-auth-home-");
    const result = runBash(
      [
        "set -euo pipefail",
        sourceAuth,
        "unset OPENCLAW_DOCKER_AUTH_DIRS DOCKER_HOME_DIR",
        'openclaw_live_collect_auth_for_providers ","',
        "openclaw_live_finalize_auth_mounts",
        'printf "default-dirs=%s\\ndefault-files=%s\\ndefault-mounts=%s\\n" "$AUTH_DIRS_CSV" "$AUTH_FILES_CSV" "${#EXTERNAL_AUTH_MOUNTS[@]}"',
        "OPENCLAW_DOCKER_AUTH_DIRS=none",
        "openclaw_live_collect_auth_for_providers openai",
        "openclaw_live_finalize_auth_mounts",
        'printf "none-dirs=%s\\nnone-files=%s\\nnone-mounts=%s\\n" "$AUTH_DIRS_CSV" "$AUTH_FILES_CSV" "${#EXTERNAL_AUTH_MOUNTS[@]}"',
      ],
      { HOME: homeDir },
    );

    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout.trimEnd().split("\n")).toEqual([
      "default-dirs=.factory,.gemini,.minimax",
      "default-files=.codex/auth.json,.codex/config.toml,.claude.json,.claude/.credentials.json,.claude/settings.json,.claude/settings.local.json,.gemini/settings.json",
      "default-mounts=0",
      "none-dirs=",
      "none-files=",
      "none-mounts=0",
    ]);
  });

  it("prestages selected auth and preserves equivalent external mounts", () => {
    const homeDir = tempDirs.make("openclaw-live-docker-auth-source-");
    const dockerHomeDir = tempDirs.make("openclaw-live-docker-auth-target-");
    const authFiles = { ".gemini/token": "gemini-token\n", ".codex/auth.json": "codex-token\n" };
    for (const [file, contents] of Object.entries(authFiles)) {
      mkdirSync(path.dirname(path.join(homeDir, file)), { recursive: true });
      writeFileSync(path.join(homeDir, file), contents, "utf8");
    }

    const result = runBash(
      [
        "set -euo pipefail",
        sourceAuth,
        "unset OPENCLAW_DOCKER_AUTH_DIRS",
        "DOCKER_AUTH_PRESTAGED=0",
        'openclaw_live_collect_auth_for_providers "openai, gemini"',
        "openclaw_live_finalize_auth_mounts",
        'printf "dirs=%s\\nfiles=%s\\nprestaged=%s\\n" "$AUTH_DIRS_CSV" "$AUTH_FILES_CSV" "$DOCKER_AUTH_PRESTAGED"',
        'printf "%s\\n" "${EXTERNAL_AUTH_MOUNTS[@]}"',
      ],
      { DOCKER_HOME_DIR: dockerHomeDir, HOME: homeDir },
    );

    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout.trimEnd().split("\n")).toEqual([
      "dirs=.gemini",
      "files=.codex/auth.json,.codex/config.toml",
      "prestaged=1",
      "-v",
      `${homeDir}/.gemini:/host-auth/.gemini:ro`,
      "-v",
      `${homeDir}/.codex/auth.json:/host-auth-files/.codex/auth.json:ro`,
    ]);
    for (const [file, contents] of Object.entries(authFiles)) {
      expect(readFileSync(path.join(dockerHomeDir, file), "utf8")).toBe(contents);
    }
  });

  it("normalizes pids and caps default CPUs using live capacity before shared capacity", () => {
    const result = runBash(initArgs, {
      PATH: makeTimeoutBin(),
      OPENCLAW_LIVE_DOCKER_AVAILABLE_CPUS: "8",
      OPENCLAW_DOCKER_E2E_AVAILABLE_CPUS: "6",
      OPENCLAW_LIVE_DOCKER_PIDS_LIMIT: "0008",
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trimEnd().split("\n")).toEqual(
      expectedRunArgs(["timeout", "--kill-after=30s"], "8", "8"),
    );
  });

  it.each([
    ["timeout", true, ["timeout"]],
    ["gtimeout", false, ["gtimeout", "--kill-after=30s"]],
  ] as const)("uses %s (plain=%s)", (command, plain, wrapper) => {
    expect(resolveDockerRunArgs(makeTimeoutBin(command, plain))).toEqual(
      expectedRunArgs([...wrapper]),
    );
  });

  it("prepares bind ownership with resource limits disabled under nounset", () => {
    const dir = tempDirs.make("openclaw-live-bind-dir-");
    const result = runBash(
      [
        sourceAuth,
        // Capture the real helper's argv without starting Docker or changing ownership.
        "docker() { printf '%s\\0' \"$@\"; }",
        'openclaw_live_chown_bind_dirs_for_container_user fixture-image 1000:1000 "$1"',
      ],
      {
        OPENCLAW_LIVE_DOCKER_DISABLE_RESOURCE_LIMITS: "1",
        OPENCLAW_LIVE_DOCKER_MEMORY: "8g",
        OPENCLAW_LIVE_DOCKER_CPUS: "16",
        OPENCLAW_LIVE_DOCKER_PIDS_LIMIT: "2048",
      },
      ["bind-dir-test", dir],
      "-uc",
    );
    expect(result.status, result.stderr).toBe(0);
    const args = result.stdout.split("\0").slice(0, -1);
    expect(args).toEqual(
      expect.arrayContaining([
        `${dir}:/openclaw-bind-dir-0`,
        "OPENCLAW_BIND_DIR_USER=1000:1000",
        "fixture-image",
      ]),
    );
    expect(args).not.toContain("");
    expect(args).not.toContain("--memory");
  });

  it("rejects invalid live Docker pids limits before live Docker setup", () => {
    const result = runBash(initArgs.slice(0, -1), {
      OPENCLAW_DOCKER_E2E_PIDS_LIMIT: "",
      OPENCLAW_LIVE_DOCKER_PIDS_LIMIT: "many",
      PATH: makeTimeoutBin(),
    });

    expect(result).toMatchObject({
      status: 2,
      stdout: "",
      stderr: expect.stringContaining("invalid OPENCLAW_LIVE_DOCKER_PIDS_LIMIT: many"),
    });
  });

  it("fails fast when no timeout wrapper is available", () => {
    const binDir = tempDirs.make("openclaw-live-docker-auth-no-timeout-");

    const result = runDockerRunArgs(binDir);
    expect(result.status).toBe(127);
    expect(result.stderr).toContain(
      "timeout command not found; cannot bound live Docker run after 42s",
    );
  });
});
