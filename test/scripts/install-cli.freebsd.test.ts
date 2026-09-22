import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
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

function fixture() {
  const root = tempDirs.make("openclaw-freebsd-installer-");
  const bin = join(root, "system bin");
  const prefix = join(root, "prefix");
  mkdirSync(bin);
  symlinkSync(nodeExecutable, join(bin, "node"));
  writeFileSync(join(bin, "npm"), "#!/usr/bin/env node\nconsole.log('11.19.1');\n", {
    mode: 0o755,
  });
  return { root, bin, prefix };
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

  it.each(["missing", "unsupported", "npm", "sqlite", "requested"])(
    "rejects an unusable %s prerequisite without replacing an existing runtime",
    (failure) => {
      const { root, bin, prefix } = fixture();
      const oldRuntime = join(root, "old-runtime");
      mkdirSync(oldRuntime);
      mkdirSync(join(prefix, "tools"), { recursive: true });
      symlinkSync(oldRuntime, join(prefix, "tools", "node"));
      const node = join(bin, "candidate");
      const npm = join(bin, "candidate-npm");
      writeFileSync(
        node,
        failure === "unsupported"
          ? "#!/usr/bin/env bash\nprintf 'v22.18.0\\n'\n"
          : `#!/usr/bin/env bash\nif [[ "$1" == -e ]]; then exit 1; fi\nexec "$FIXTURE_NODE" "$@"\n`,
        { mode: 0o755 },
      );
      writeFileSync(npm, "#!/usr/bin/env bash\nexit 42\n", { mode: 0o755 });
      const result = install(
        bin,
        prefix,
        `
        JSON=1
        command_path_without_node_prefix() {
          case "$1" in
            node) printf '%s\\n' "$FIXTURE_CANDIDATE_NODE" ;;
            npm) printf '%s\\n' "$FIXTURE_CANDIDATE_NPM" ;;
          esac
        }
        ${failure === "requested" ? "NODE_VERSION=99.0.0; NODE_VERSION_REQUESTED=1" : ""}
        `,
        {
          FIXTURE_NODE: nodeExecutable,
          FIXTURE_CANDIDATE_NODE:
            failure === "missing"
              ? ""
              : ["unsupported", "sqlite"].includes(failure)
                ? node
                : join(bin, "node"),
          FIXTURE_CANDIDATE_NPM: failure === "npm" ? npm : join(bin, "npm"),
        },
      );
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stdout).toContain("npm-node24");
      expect(result.stdout).not.toContain("unexpected");
      expect(readlinkSync(join(prefix, "tools", "node"))).toBe(oldRuntime);
      expect(existsSync(join(prefix, "tools", "node-v24.19.0"))).toBe(false);
    },
  );

  it("refuses private Node recovery before linking or changing packages", () => {
    const { bin, prefix } = fixture();
    const result = install(bin, prefix, "NODE_ONLY=1");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Private Node.js recovery is unavailable on FreeBSD");
    expect(result.stdout).not.toContain("unexpected");
    expect(existsSync(prefix)).toBe(false);
  });

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
