import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT_PATH = "scripts/install-cli.sh";

function runInstallCliShell(script: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCLAW_INSTALL_CLI_SH_NO_RUN: "1",
      ...env,
    },
  });
}

describe("install-cli.sh", () => {
  const script = readFileSync(SCRIPT_PATH, "utf8");

  it("keeps HOME for default prefix while OPENCLAW_HOME controls git checkout paths", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-cli-home-"));
    const osHome = join(tmp, "os-home");
    const openclawHome = join(tmp, "openclaw-home");
    mkdirSync(osHome, { recursive: true });
    mkdirSync(openclawHome, { recursive: true });

    let result: ReturnType<typeof runInstallCliShell> | undefined;
    try {
      result = runInstallCliShell(
        [
          `cd ${JSON.stringify(process.cwd())}`,
          `source ${JSON.stringify(SCRIPT_PATH)}`,
          'printf "prefix=%s\\ngit=%s\\n" "$PREFIX" "$GIT_DIR"',
        ].join("\n"),
        {
          HOME: osHome,
          OPENCLAW_HOME: openclawHome,
          OPENCLAW_GIT_DIR: undefined,
          OPENCLAW_PREFIX: undefined,
        },
      );
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }

    expect(result?.status).toBe(0);
    const output = result?.stdout ?? "";
    expect(output).toContain(`prefix=${join(osHome, ".openclaw")}`);
    expect(output).toContain(`git=${join(openclawHome, "openclaw")}`);
  });

  it("resolves requested git install versions to checkout refs", () => {
    const result = runInstallCliShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
      npm_bin() { echo npm; }
      npm() {
        if [[ "$1" == "view" && "$2" == "openclaw" && "$3" == "dist-tags.beta" ]]; then
          printf '2026.5.12-beta.3\\n'
          return 0
        fi
        return 1
      }
      OPENCLAW_VERSION=v2026.5.12-beta.3
      printf 'tag=%s\\n' "$(resolve_git_openclaw_ref)"
      OPENCLAW_VERSION=2026.5.12-beta.3
      printf 'semver=%s\\n' "$(resolve_git_openclaw_ref)"
      OPENCLAW_VERSION=beta
      printf 'beta=%s\\n' "$(resolve_git_openclaw_ref)"
      OPENCLAW_VERSION=main
      printf 'main=%s\\n' "$(resolve_git_openclaw_ref)"
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("tag=v2026.5.12-beta.3");
    expect(result.stdout).toContain("semver=v2026.5.12-beta.3");
    expect(result.stdout).toContain("beta=v2026.5.12-beta.3");
    expect(result.stdout).toContain("main=main");
  });

  it("fetches moving git refs without tags for git installs", () => {
    expect(script).toContain('git -C "$repo_dir" fetch --no-tags origin main');
    expect(script).toContain(
      'git -C "$repo_dir" fetch --no-tags origin "refs/heads/${ref}:refs/remotes/origin/${ref}"',
    );
    expect(script).toContain('git -C "$repo_dir" pull --rebase --no-tags || true');

    const branchCheckIndex = script.indexOf('ls-remote --exit-code --heads origin "$ref"');
    const tagFetchIndex = script.indexOf("fetch --tags origin");
    expect(branchCheckIndex).toBeGreaterThan(-1);
    expect(tagFetchIndex).toBeGreaterThan(-1);
    expect(branchCheckIndex).toBeLessThan(tagFetchIndex);
  });

  it("uses non-frozen lockfile installs only for moving git refs", () => {
    const result = runInstallCliShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
      git() {
        if [[ "$1" == "-C" && "$3" == "ls-remote" && "\${7:-}" == "feature" ]]; then
          return 0
        fi
        return 1
      }
      printf 'main=%s\\n' "$(git_install_lockfile_flag /repo main)"
      printf 'branch=%s\\n' "$(git_install_lockfile_flag /repo feature)"
      printf 'tag=%s\\n' "$(git_install_lockfile_flag /repo v2026.5.12)"
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("main=--no-frozen-lockfile");
    expect(result.stdout).toContain("branch=--no-frozen-lockfile");
    expect(result.stdout).toContain("tag=--frozen-lockfile");
    expect(script).toContain(
      'CI="${CI:-true}" SHARP_IGNORE_GLOBAL_LIBVIPS="$SHARP_IGNORE_GLOBAL_LIBVIPS" run_pnpm -C "$repo_dir" install "$install_lockfile_flag"',
    );
  });

  it("aligns pnpm to the checked-out repo packageManager before installing", () => {
    expect(script).toContain("activate_repo_pnpm_version()");
    expect(script).toContain('"$corepack_cmd" prepare "pnpm@${version}" --activate');
    expect(script).toContain('activate_repo_pnpm_version "$repo_dir"');
  });

  it("clears npm freshness filters for package installs", () => {
    expect(script).toContain('freshness_flag="--min-release-age=0"');
    expect(script).toContain('npm_raw_config_has_key "min-release-age"');
    expect(script).toContain('freshness_flag="--before=$(date -u');
    expect(script).toContain("env -u NPM_CONFIG_BEFORE -u npm_config_before");
  });

  it("does not emit --before when raw user npmrc config contains min-release-age", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-cli-npmrc-"));
    const bin = join(tmp, "bin");
    const npmrc = join(tmp, "user.npmrc");
    const installArgs = join(tmp, "npm-install-args.txt");
    const prefix = join(tmp, "prefix");
    const nodeDir = join(tmp, "node");
    mkdirSync(bin, { recursive: true });
    mkdirSync(nodeDir, { recursive: true });
    writeFileSync(npmrc, "min-release-age=7\n");
    const fakeNpm = join(bin, "npm");
    writeFileSync(
      fakeNpm,
      [
        "#!/usr/bin/env bash",
        'if [[ "$1" == "config" && "$2" == "get" ]]; then',
        '  if [[ "$3" == "min-release-age" ]]; then',
        "    printf 'null\\n'",
        "    exit 0",
        "  fi",
        '  if [[ "$3" == "before" ]]; then',
        "    printf '2026-01-01T00:00:00.000Z\\n'",
        "    exit 0",
        "  fi",
        "fi",
        'printf "%s\\n" "$@" > "$NPM_FAKE_INSTALL_ARGS"',
        "exit 0",
        "",
      ].join("\n"),
    );
    chmodSync(fakeNpm, 0o755);

    try {
      const result = runInstallCliShell(
        [
          "set -euo pipefail",
          `cd ${JSON.stringify(process.cwd())}`,
          `source ${JSON.stringify(SCRIPT_PATH)}`,
          `npm_bin() { printf '%s\\n' ${JSON.stringify(fakeNpm)}; }`,
          `node_dir() { printf '%s\\n' ${JSON.stringify(nodeDir)}; }`,
          "emit_json() { :; }",
          "log() { :; }",
          `PREFIX=${JSON.stringify(prefix)}`,
          "SET_NPM_PREFIX=0",
          "OPENCLAW_VERSION=1.2.3",
          "install_openclaw",
        ].join("\n"),
        {
          NPM_CONFIG_USERCONFIG: npmrc,
          NPM_FAKE_INSTALL_ARGS: installArgs,
          PATH: `${bin}:${process.env.PATH}`,
        },
      );

      expect(result.status).toBe(0);
      expect(readFileSync(installArgs, "utf8")).toContain("--min-release-age=0\n");
      expect(readFileSync(installArgs, "utf8")).not.toContain("--before=");
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }
  });

  it("does not emit --before when default global npmrc config contains min-release-age", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-cli-global-npmrc-"));
    const bin = join(tmp, "bin");
    const home = join(tmp, "home");
    const prefix = join(tmp, "prefix");
    const npmrc = join(prefix, "etc", "npmrc");
    const calls = join(tmp, "npm-calls.txt");
    const installArgs = join(tmp, "npm-install-args.txt");
    const installPrefix = join(tmp, "install-prefix");
    const nodeDir = join(tmp, "node");
    mkdirSync(bin, { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(nodeDir, { recursive: true });
    mkdirSync(join(prefix, "etc"), { recursive: true });
    writeFileSync(npmrc, "min-release-age=7\n");
    const fakeNpm = join(bin, "npm");
    writeFileSync(
      fakeNpm,
      [
        "#!/usr/bin/env bash",
        'printf "%s\\n" "$*" >> "$NPM_FAKE_CALLS"',
        'if [[ "$1" == "config" && "$2" == "get" ]]; then',
        '  if [[ "$3" == "min-release-age" ]]; then',
        "    printf 'null\\n'",
        "    exit 0",
        "  fi",
        '  if [[ "$3" == "globalconfig" ]]; then',
        '    printf "%s\\n" "$NPM_FAKE_GLOBALCONFIG"',
        "    exit 0",
        "  fi",
        '  if [[ "$3" == "before" ]]; then',
        "    printf '2026-01-01T00:00:00.000Z\\n'",
        "    exit 0",
        "  fi",
        "fi",
        'printf "%s\\n" "$@" > "$NPM_FAKE_INSTALL_ARGS"',
        "exit 0",
        "",
      ].join("\n"),
    );
    chmodSync(fakeNpm, 0o755);

    try {
      const result = runInstallCliShell(
        [
          "set -euo pipefail",
          `cd ${JSON.stringify(process.cwd())}`,
          `source ${JSON.stringify(SCRIPT_PATH)}`,
          `npm_bin() { printf '%s\\n' ${JSON.stringify(fakeNpm)}; }`,
          `node_dir() { printf '%s\\n' ${JSON.stringify(nodeDir)}; }`,
          "emit_json() { :; }",
          "log() { :; }",
          `PREFIX=${JSON.stringify(installPrefix)}`,
          "SET_NPM_PREFIX=0",
          "OPENCLAW_VERSION=1.2.3",
          "install_openclaw",
        ].join("\n"),
        {
          HOME: home,
          NPM_CONFIG_GLOBALCONFIG: undefined,
          NPM_CONFIG_PREFIX: undefined,
          npm_config_globalconfig: undefined,
          npm_config_prefix: undefined,
          NPM_FAKE_CALLS: calls,
          NPM_FAKE_GLOBALCONFIG: npmrc,
          NPM_FAKE_INSTALL_ARGS: installArgs,
          PATH: `${bin}:${process.env.PATH}`,
        },
      );

      expect(result.status).toBe(0);
      expect(readFileSync(installArgs, "utf8")).toContain("--min-release-age=0\n");
      expect(readFileSync(installArgs, "utf8")).not.toContain("--before=");
      expect(readFileSync(calls, "utf8")).not.toContain("config get before");
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }
  });

  it("does not emit --before when builtin npmrc config contains min-release-age", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-cli-builtin-npmrc-"));
    const bin = join(tmp, "bin");
    const home = join(tmp, "home");
    const npmrc = join(tmp, "npmrc");
    const calls = join(tmp, "npm-calls.txt");
    const installArgs = join(tmp, "npm-install-args.txt");
    const installPrefix = join(tmp, "install-prefix");
    const nodeDir = join(tmp, "node");
    mkdirSync(bin, { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(nodeDir, { recursive: true });
    writeFileSync(npmrc, "min-release-age=7\n");
    const fakeNpm = join(bin, "npm");
    writeFileSync(
      fakeNpm,
      [
        "#!/usr/bin/env bash",
        'printf "%s\\n" "$*" >> "$NPM_FAKE_CALLS"',
        'if [[ "$1" == "config" && "$2" == "get" ]]; then',
        '  if [[ "$3" == "min-release-age" ]]; then',
        "    printf 'null\\n'",
        "    exit 0",
        "  fi",
        '  if [[ "$3" == "globalconfig" ]]; then',
        '    printf "%s\\n" "$NPM_FAKE_GLOBALCONFIG"',
        "    exit 0",
        "  fi",
        '  if [[ "$3" == "before" ]]; then',
        "    printf '2026-01-01T00:00:00.000Z\\n'",
        "    exit 0",
        "  fi",
        "fi",
        'printf "%s\\n" "$@" > "$NPM_FAKE_INSTALL_ARGS"',
        "exit 0",
        "",
      ].join("\n"),
    );
    chmodSync(fakeNpm, 0o755);

    try {
      const result = runInstallCliShell(
        [
          "set -euo pipefail",
          `cd ${JSON.stringify(process.cwd())}`,
          `source ${JSON.stringify(SCRIPT_PATH)}`,
          `npm_bin() { printf '%s\\n' ${JSON.stringify(fakeNpm)}; }`,
          `node_dir() { printf '%s\\n' ${JSON.stringify(nodeDir)}; }`,
          "emit_json() { :; }",
          "log() { :; }",
          `PREFIX=${JSON.stringify(installPrefix)}`,
          "SET_NPM_PREFIX=0",
          "OPENCLAW_VERSION=1.2.3",
          "install_openclaw",
        ].join("\n"),
        {
          HOME: home,
          NPM_CONFIG_GLOBALCONFIG: undefined,
          NPM_CONFIG_PREFIX: undefined,
          npm_config_globalconfig: undefined,
          npm_config_prefix: undefined,
          NPM_FAKE_CALLS: calls,
          NPM_FAKE_GLOBALCONFIG: join(tmp, "missing-global-npmrc"),
          NPM_FAKE_INSTALL_ARGS: installArgs,
          PATH: `${bin}:${process.env.PATH}`,
        },
      );

      expect(result.status).toBe(0);
      expect(readFileSync(installArgs, "utf8")).toContain("--min-release-age=0\n");
      expect(readFileSync(installArgs, "utf8")).not.toContain("--before=");
      expect(readFileSync(calls, "utf8")).not.toContain("config get before");
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }
  });

  it("rejects OpenClaw GitHub source targets for npm installs", () => {
    const result = runInstallCliShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
      OPENCLAW_VERSION=main
      install_openclaw
    `);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("npm installs do not support OpenClaw GitHub source targets");
    expect(result.stdout).toContain("--install-method git --version main");
  });
});
