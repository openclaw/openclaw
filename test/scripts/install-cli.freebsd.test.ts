import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
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

describe("FreeBSD source-install admission", () => {
  it.each(
    ["--install-method git", "--method git", "--git", "--github", "--npm --git", ""].flatMap(
      (args) => [false, true].map((json) => ({ args, json })),
    ),
  )("refuses $args before installation side effects (JSON: $json)", ({ args, json }) => {
    const { root, prefix } = fixture();
    const oldRuntime = join(root, "old-runtime");
    const checkout = join(root, "checkout");
    const temporary = join(root, "temporary");
    mkdirSync(oldRuntime);
    mkdirSync(checkout);
    mkdirSync(temporary);
    mkdirSync(join(prefix, "bin"), { recursive: true });
    mkdirSync(join(prefix, "tools"));
    symlinkSync(oldRuntime, join(prefix, "tools", "node"));
    writeFileSync(join(prefix, "bin", "openclaw"), "preserve installed CLI");
    writeFileSync(join(checkout, "pnpm-workspace.yaml"), "preserve source allowlist");
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
        TMPDIR: temporary,
        OPENCLAW_PREFIX: prefix,
        OPENCLAW_GIT_DIR: checkout,
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
    expect(message).toContain("published version or compatible built .tgz");
    expect(message).toContain("same --prefix");
    expect(message).toContain("pkg/Ports-managed");
    expect(result.stdout).not.toContain("unexpected");
    expect(readFileSync(join(prefix, "bin", "openclaw"), "utf8")).toBe("preserve installed CLI");
    expect(readlinkSync(join(prefix, "tools", "node"))).toBe(oldRuntime);
    expect(readdirSync(join(prefix, "tools"))).toEqual(["node"]);
    expect(readFileSync(join(checkout, "pnpm-workspace.yaml"), "utf8")).toBe(
      "preserve source allowlist",
    );
    expect(readdirSync(checkout)).toEqual(["pnpm-workspace.yaml"]);
    expect(readdirSync(temporary)).toEqual([]);
  });

  it.each([
    ["freebsd", "--git --npm"],
    ["freebsd", "--github --install-method npm"],
    ["freebsd", "--method npm"],
    ["linux", "--git"],
    ["darwin", "--git"],
    ["linux", "--npm"],
    ["darwin", "--npm"],
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

  it("keeps the FreeBSD Node-only refusal ahead of the ignored git method", () => {
    const { root, prefix } = fixture();
    const result = run(
      `
      os_detect() { printf 'freebsd\\n'; }
      arch_detect() { printf 'x64\\n'; }
      main --node-only --git
      `,
      { HOME: root, TMPDIR: root, OPENCLAW_PREFIX: prefix },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Private Node.js recovery is unavailable on FreeBSD");
    expect(result.stdout).not.toContain("Source/git");
    expect(existsSync(prefix)).toBe(false);
  });

  it.each(["main", "github:openclaw/openclaw#main"])(
    "does not recommend git for the rejected npm source target %s",
    (version) => {
      const result = run(
        `
        os_detect() { printf 'freebsd\\n'; }
        JSON=1
        install_openclaw
        `,
        { OPENCLAW_VERSION: version },
      );
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        event: "error",
        message: expect.stringContaining("--install-method npm"),
      });
      expect(result.stdout).not.toContain("--install-method git");
    },
  );
});
