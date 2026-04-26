import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SCRIPT_PATH = "scripts/install.sh";

function runInstallShell(script: string) {
  return spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCLAW_INSTALL_SH_NO_RUN: "1",
    },
  });
}

describe("install.sh apt behavior", () => {
  const script = readFileSync(SCRIPT_PATH, "utf8");

  it("runs apt-get through noninteractive wrappers", () => {
    expect(script).toContain("apt_get()");
    expect(script).toContain('DEBIAN_FRONTEND="${DEBIAN_FRONTEND:-noninteractive}"');
    expect(script).toContain('NEEDRESTART_MODE="${NEEDRESTART_MODE:-a}"');
    expect(script).toContain("sudo env DEBIAN_FRONTEND=");
    expect(script).toContain("-o Dpkg::Options::=--force-confdef");
    expect(script).toContain("-o Dpkg::Options::=--force-confold");

    const rawAptInstalls = script
      .split("\n")
      .filter((line) => /\b(?:sudo\s+)?apt-get\s+install\b/.test(line));
    expect(rawAptInstalls).toEqual([]);
  });

  it("exports noninteractive apt env during Linux startup", () => {
    expect(script).toMatch(
      /detect_os_or_die\s+if \[\[ "\$OS" == "linux" \]\]; then\s+export DEBIAN_FRONTEND="\$\{DEBIAN_FRONTEND:-noninteractive\}"\s+export NEEDRESTART_MODE="\$\{NEEDRESTART_MODE:-a\}"\s+fi/m,
    );
    expect(script).toContain(
      'run_quiet_step "Configuring NodeSource repository" sudo -E bash "$tmp"',
    );
  });
});

describe("install.sh macOS Homebrew Node behavior", () => {
  const script = readFileSync(SCRIPT_PATH, "utf8");

  it("stops when Homebrew node installation fails", () => {
    expect(script).toContain(
      'if ! run_quiet_step "Installing node@${NODE_DEFAULT_MAJOR}" brew install "node@${NODE_DEFAULT_MAJOR}"; then',
    );

    const failedInstallIndex = script.indexOf(
      'if ! run_quiet_step "Installing node@${NODE_DEFAULT_MAJOR}" brew install "node@${NODE_DEFAULT_MAJOR}"; then',
    );
    const brewLinkIndex = script.indexOf(
      'brew link "node@${NODE_DEFAULT_MAJOR}" --overwrite --force',
    );
    expect(failedInstallIndex).toBeGreaterThanOrEqual(0);
    expect(brewLinkIndex).toBeGreaterThan(failedInstallIndex);
  });

  it("aborts before brew link when Homebrew node installation fails at runtime", () => {
    const result = runInstallShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
      OS=macos
      run_quiet_step() { echo "run_quiet_step:$*"; return 1; }
      brew() { echo "brew:$*"; return 0; }
      ensure_macos_default_node_active() { echo "ensure-called"; return 0; }
      if install_node; then
        echo "install_node returned success"
      else
        echo "install_node returned failure"
      fi
    `);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "Re-run with --verbose or run 'brew install node@24' directly, then rerun the installer.",
    );
    expect(result.stdout).not.toContain("brew:link");
    expect(result.stdout).not.toContain("ensure-called");
  });

  it("separates missing Homebrew node from PATH shadowing", () => {
    const missingNodeGuardIndex = script.indexOf(
      'if [[ -z "$brew_node_prefix" || ! -x "${brew_node_prefix}/bin/node" ]]; then',
    );
    const pathAdviceIndex = script.indexOf("Add this to your shell profile and restart shell:");

    expect(missingNodeGuardIndex).toBeGreaterThanOrEqual(0);
    expect(script).toContain(
      'ui_error "Homebrew node@${NODE_DEFAULT_MAJOR} is not installed on disk"',
    );
    expect(script).toContain('echo "  export PATH=\\"${brew_node_prefix}/bin:\\$PATH\\""');
    expect(pathAdviceIndex).toBeGreaterThan(missingNodeGuardIndex);
  });

  it("does not print PATH advice when Homebrew node is missing at runtime", () => {
    const result = runInstallShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
      OS=macos
      missing_prefix="$(mktemp -d)/node@24"
      brew() {
        if [[ "$1" == "--prefix" ]]; then
          echo "$missing_prefix"
          return 0
        fi
        return 0
      }
      node_major_version() { echo 16; }
      if ensure_macos_default_node_active; then
        echo "ensure returned success"
      else
        echo "ensure returned failure"
      fi
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Homebrew node@24 is not installed on disk");
    expect(result.stdout).toContain("ensure returned failure");
    expect(result.stdout).not.toContain("Node.js v24 was installed");
    expect(result.stdout).not.toContain("Add this to your shell profile");
  });
});
