import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { requireNodeTool } from "../helpers/node-toolchain.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const scriptPath = "scripts/install-cli.sh";
const nodeExecutable = requireNodeTool("node");

function fixture(preserveRuntime = false) {
  const root = tempDirs.make("openclaw-freebsd-installer-");
  const bin = join(root, "system bin");
  const prefix = join(root, "prefix");
  mkdirSync(bin);
  symlinkSync(nodeExecutable, join(bin, "node"));
  writeFileSync(join(bin, "npm"), "#!/usr/bin/env node\nconsole.log('11.19.1');\n", {
    mode: 0o755,
  });
  const oldRuntime = join(root, "old-runtime");
  if (preserveRuntime) {
    mkdirSync(oldRuntime);
    mkdirSync(join(prefix, "tools"), { recursive: true });
    symlinkSync(oldRuntime, join(prefix, "tools", "node"));
  }
  return { root, bin, prefix, oldRuntime };
}

function run(body: string, env: NodeJS.ProcessEnv = {}) {
  // Sourcing cannot use the installer's system-Bash re-exec guard on macOS.
  return spawnSync(
    process.platform === "darwin" ? "/bin/bash" : "bash",
    ["--noprofile", "--norc", "-c", `source ${scriptPath}\n${body}`],
    {
      encoding: "utf8",
      env: { ...process.env, OPENCLAW_INSTALL_CLI_SH_NO_RUN: "1", ...env, BASH_ENV: "", ENV: "" },
    },
  );
}

function install(bin: string, prefix: string, body = "", env: NodeJS.ProcessEnv = {}) {
  return run(
    `
    PREFIX="$FIXTURE_PREFIX"
    PATH="$FIXTURE_BIN:$PATH"
    export PATH
    uname() { printf 'FreeBSD\\n'; }
    download_file() { printf 'unexpected download\\n'; exit 91; }
    pkg() { printf 'unexpected package change\\n'; exit 92; }
    ${body}
    install_node "$(os_detect)" x64
    `,
    { FIXTURE_BIN: bin, FIXTURE_PREFIX: prefix, ...env },
  );
}

describe("FreeBSD CLI runtime installation", () => {
  it("links a usable system runtime and can reuse the resulting runtime links", () => {
    const { bin, prefix } = fixture();
    const result = install(bin, prefix, "JSON=1");
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('"method":"system"');
    const active = join(prefix, "tools", "node", "bin");
    expect(realpathSync(join(active, "node"))).toBe(realpathSync(nodeExecutable));
    expect(realpathSync(join(active, "npm"))).toBe(join(bin, "npm"));
    const rerun = install(active, prefix);
    expect(rerun.status, rerun.stdout + rerun.stderr).toBe(0);
    expect(realpathSync(join(active, "node"))).toBe(realpathSync(nodeExecutable));
    expect(realpathSync(join(active, "npm"))).toBe(join(bin, "npm"));
  });

  it.each(["missing", "requested"])(
    "rejects %s prerequisites without replacing the runtime",
    (failure) => {
      const { bin, prefix, oldRuntime } = fixture(true);
      const result = install(
        bin,
        prefix,
        `
        JSON=1
        ${
          failure === "requested"
            ? `NODE_VERSION=99.0.0; NODE_VERSION_REQUESTED=1
        command_path_without_node_prefix() { printf '%s/%s\\n' "$FIXTURE_BIN" "$1"; }`
            : "command_path_without_node_prefix() { :; }"
        }
        `,
      );
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stdout).toContain("npm-node24");
      expect(result.stdout).not.toContain("unexpected");
      expect(readlinkSync(join(prefix, "tools", "node"))).toBe(oldRuntime);
      expect(existsSync(join(prefix, "tools", "node-v24.22.1"))).toBe(false);
    },
  );

  it("explains how to install missing Git without invoking pkg", () => {
    const result = run(`
      uname() { printf 'FreeBSD\\n'; }
      command() { if [[ "$*" == '-v git' ]]; then return 1; fi; builtin command "$@"; }
      pkg() { printf 'unexpected package change\\n'; exit 92; }
      ensure_git
    `);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("pkg install git");
    expect(result.stdout).not.toContain("unexpected");
  });
});

describe("FreeBSD source-install admission", () => {
  it.each([
    ["--install-method git", false],
    ["--npm --git", true],
    ["", false],
  ] as const)("refuses %s before installation side effects (JSON: %s)", (args, json) => {
    const root = tempDirs.make("openclaw-freebsd-admission-");
    const result = run(
      `
      os_detect() { printf 'freebsd\\n'; }
      prepare_tmpdir() { printf 'unexpected temporary setup\\n'; exit 91; }
      preflight_fresh_git_disk_space() { printf 'unexpected disk preflight\\n'; exit 92; }
      install_node() { printf 'unexpected runtime change\\n'; exit 93; }
      install_openclaw_from_git() { printf 'unexpected checkout change\\n'; exit 94; }
      refresh_gateway_service_if_loaded() { printf 'unexpected service change\\n'; exit 95; }
      main ${json ? "--json" : ""} ${args}
      `,
      {
        HOME: root,
        TMPDIR: root,
        OPENCLAW_PREFIX: join(root, "prefix"),
        OPENCLAW_GIT_DIR: join(root, "checkout"),
        OPENCLAW_INSTALL_METHOD: args ? "npm" : "git",
      },
    );
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toBe("");
    const message = json
      ? (JSON.parse(result.stdout) as { event: string; message: string }).message
      : result.stdout;
    if (json) {
      expect(JSON.parse(result.stdout)).toMatchObject({ event: "error" });
    } else {
      expect(result.stdout).toMatch(/^ERROR: /);
    }
    expect(message).toContain("Source/git installation is unsupported on FreeBSD");
    expect(message).toContain("--install-method npm");
    expect(result.stdout).not.toContain("unexpected");
    expect(readdirSync(root)).toEqual([]);
  });

  it.each([
    ["freebsd", "--git --npm"],
    ["linux", "--git"],
  ])("keeps %s %s on its selected install route", (os, args) => {
    const result = run(
      `
      os_detect() { printf '${os}\\n'; }
      arch_detect() { printf 'x64\\n'; }
      prepare_tmpdir() { :; }
      preflight_fresh_git_disk_space() { :; }
      install_node() { printf 'selected:%s:%s\\n' "$1" "$INSTALL_METHOD"; exit 73; }
      main ${args}
      `,
      { OPENCLAW_INSTALL_METHOD: "git" },
    );
    expect(result.status, result.stdout + result.stderr).toBe(73);
    expect(result.stdout.trim()).toBe(`selected:${os}:${args === "--git" ? "git" : "npm"}`);
  });

  it.each(["", "main", "github:openclaw/openclaw#main"])(
    "explains the FreeBSD refusal for version %j",
    (version) => {
      const command = version ? "install_openclaw" : "main --node-only --git";
      const message = version
        ? "--install-method npm"
        : "Private Node.js recovery is unavailable on FreeBSD";
      const forbidden = version ? "--install-method git" : "Source/git";
      const { root, prefix } = fixture();
      const result = run(
        `
      os_detect() { printf 'freebsd\\n'; }
      arch_detect() { printf 'x64\\n'; }
      JSON=${version ? "1" : "0"}
      ${command}
      `,
        { HOME: root, TMPDIR: root, OPENCLAW_PREFIX: prefix, OPENCLAW_VERSION: version },
      );
      expect(result.status).toBe(1);
      if (version) {
        expect(JSON.parse(result.stdout)).toMatchObject({
          event: "error",
          message: expect.stringContaining(message),
        });
      } else {
        expect(result.stdout).toContain(message);
        expect(existsSync(prefix)).toBe(false);
      }
      expect(result.stdout).not.toContain(forbidden);
    },
  );
});
