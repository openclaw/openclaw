import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  it("leaves an existing git checkout on its current ref when git updates are disabled", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openclaw-install-cli-no-git-update-"));
    const repo = join(tmp, "repo");
    const prefix = join(tmp, "prefix");
    try {
      expect(spawnSync("git", ["init", repo], { encoding: "utf8" }).status).toBe(0);
      writeFileSync(join(repo, "README.md"), "fixture\n");
      expect(spawnSync("git", ["-C", repo, "add", "README.md"], { encoding: "utf8" }).status).toBe(
        0,
      );
      expect(
        spawnSync(
          "git",
          [
            "-C",
            repo,
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-m",
            "init",
          ],
          {
            encoding: "utf8",
          },
        ).status,
      ).toBe(0);
      mkdirSync(join(prefix, "tools", "node", "bin"), { recursive: true });
      const nodeShim = join(prefix, "tools", "node", "bin", "node");
      writeFileSync(nodeShim, "#!/bin/sh\nexit 0\n");
      chmodSync(nodeShim, 0o755);

      const result = runInstallCliShell(
        `
          set -euo pipefail
          source "${SCRIPT_PATH}"
          PREFIX=${JSON.stringify(prefix)}
          GIT_UPDATE=0
          ensure_git() { :; }
          ensure_pnpm() { :; }
          ensure_pnpm_binary_for_scripts() { :; }
          cleanup_legacy_submodules() { :; }
          ensure_pnpm_git_prepare_allowlist() { :; }
          activate_repo_pnpm_version() { :; }
          resolve_git_openclaw_ref() { echo SHOULD_NOT_RESOLVE; }
          checkout_git_openclaw_ref() { echo CHECKOUT_CALLED; return 0; }
          run_pnpm() { :; }
          log() { printf 'log:%s\\n' "$*"; }
          emit_json() { :; }
          install_openclaw_from_git ${JSON.stringify(repo)}
        `,
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Git update disabled; leaving existing checkout unchanged");
      expect(result.stdout).not.toContain("SHOULD_NOT_RESOLVE");
      expect(result.stdout).not.toContain("CHECKOUT_CALLED");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("uses frozen lockfile installs for git installs", () => {
    expect(script).toContain('run_pnpm -C "$repo_dir" install --frozen-lockfile');
  });

  it("aligns pnpm to the checked-out repo packageManager before installing", () => {
    expect(script).toContain("activate_repo_pnpm_version()");
    expect(script).toContain('"$corepack_cmd" prepare "pnpm@${version}" --activate');
    expect(script).toContain('activate_repo_pnpm_version "$repo_dir"');
  });
});
