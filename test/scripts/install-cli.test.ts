import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isSupportedOpenClawNodeVersion } from "../../node-version.mjs";
import { readStandaloneInstaller } from "../../scripts/lib/standalone-installers.mjs";
import { requireNodeTool } from "../helpers/node-toolchain.js";
import { NODE_RELEASE_VERSION_CASES } from "../helpers/node-version-cases.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { writeNpmLifecycleFixture } from "./install-npm-fixtures.js";
import { findDarwinReexecBash } from "./install-reexec-fixtures.js";
import {
  defineInstallerNpmConfigContract,
  defineInstallerNpmFreshnessContract,
  defineInstallerNpmRetryContract,
  defineInstallerPnpmContract,
  defineInstallerShellIsolationContract,
} from "./install-test-contract.js";

const SCRIPT_PATH = "scripts/install-cli.sh";
const nodeExecutable = requireNodeTool("node");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function runShell(script: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      ZDOTDIR: undefined,
      OPENCLAW_INSTALL_CLI_SH_NO_RUN: "1",
      ...env,
      BASH_ENV: "",
      ENV: "",
    },
  });
}

function runInstallCliShell(script: string, env: NodeJS.ProcessEnv = {}) {
  return runShell(`source "${join(process.cwd(), SCRIPT_PATH)}"\n${script}`, env);
}

function writeShell(path: string, body: string) {
  writeFileSync(path, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
}

function makeFixture(name: string) {
  const root = tempDirs.make(`openclaw-install-cli-${name}-`);
  const write = (relative: string, content: string, mode = 0o644) => {
    const file = join(root, relative);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content, { mode });
    return file;
  };
  const shell = (relative: string, body: string, interpreter = "/bin/bash") =>
    write(relative, `#!${interpreter}\n${body}\n`, 0o755);
  return {
    root,
    write,
    shell,
    node(relative: string, version: string, sqliteExit = 0) {
      const file = join(root, relative);
      mkdirSync(dirname(file), { recursive: true });
      writeNodeFixture(file, version, sqliteExit);
    },
    runtime(relative: string, npm = "exit 0", interpreter = "/bin/bash") {
      const bin = join(root, relative);
      shell(`${relative}/npm`, npm, interpreter);
      symlinkSync(nodeExecutable, join(bin, "node"));
      return bin;
    },
    run: (body: string, env: NodeJS.ProcessEnv = {}) =>
      runInstallCliShell(body, { ROOT: root, FIXTURE_NODE: nodeExecutable, ...env }),
  };
}

function linkRequiredShellTools(bin: string) {
  for (const tool of ["ln", "mkdir"]) {
    symlinkSync(`/bin/${tool}`, join(bin, tool));
  }
}

function writeNodeFixture(filePath: string, version: string, sqliteExit = 0) {
  writeShell(
    filePath,
    `
    if [[ "\${1:-}" == -v ]]; then printf '%s\\n' '${version}';
    elif [[ "\${1:-}" == -e ]]; then exit ${sqliteExit}; fi
    exit 0
  `,
  );
}

function runNpmPolicy(spec: string) {
  const f = makeFixture("lifecycle");
  writeNpmLifecycleFixture(join(f.root, "npm"));
  return f.run(
    `
    node_bin() { printf '%s\\n' "$FIXTURE_NODE"; }
    cd "$ROOT"
    npm_lifecycle_allow_arg "$ROOT/npm" "$FIXTURE_SPEC" "$PWD"
  `,
    {
      FIXTURE_SPEC: spec,
      NPM_FAKE_VERSION: "12.0.0",
      NPM_FAKE_ARGS: join(f.root, "args"),
    },
  );
}

describe("install-cli.sh", () => {
  const script = readStandaloneInstaller(process.cwd(), SCRIPT_PATH.slice("scripts/".length));

  it.each([undefined, ".config/zsh"])("persists npm prefix PATH with ZDOTDIR=%s", (suffix) => {
    const home = tempDirs.make("openclaw-cli-zdotdir-");
    const zshDir = suffix ? join(home, suffix) : home;
    mkdirSync(zshDir, { recursive: true });
    const profiles = [join(home, ".bashrc"), join(zshDir, ".zshrc")];
    for (const rc of profiles) {
      writeFileSync(rc, "# existing\n");
    }
    const result = runInstallCliShell(
      `
      os_detect() { echo linux; }
      npm_fixture() { [[ "$*" != "config get prefix" ]] || echo "$HOME/missing/prefix"; }
      npm_bin() { echo npm_fixture; }
      fix_npm_prefix_if_needed
      fix_npm_prefix_if_needed
    `,
      { HOME: home, ZDOTDIR: suffix ? zshDir : undefined },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(profiles.map((rc) => readFileSync(rc, "utf8"))).toEqual(
      Array(2).fill(`# existing\nexport PATH="${home}/.npm-global/bin:$PATH"\n`),
    );
    expect(existsSync(join(home, ".zshrc"))).toBe(!suffix);
  });
  const installerContract = {
    scriptPath: SCRIPT_PATH,
    runShell,
    nodeExecutable,
    prefix: true,
    createTempDir: (prefix: string) => tempDirs.make(prefix),
  };

  defineInstallerShellIsolationContract(installerContract);

  it("keeps runtime-only installation free of service and onboarding effects", () => {
    const f = makeFixture("runtime-only");
    f.shell(
      "prefix/bin/openclaw",
      `
      printf '%s\\n' "$*" >> "$ROOT/commands"
      if [[ "$1" == --version ]]; then printf 'OpenClaw 2026.9.4\\n'; fi
    `,
    );
    const result = f.run(
      `
      install_node() { :; }; install_openclaw() { :; }
      ensure_git() { printf 'git\\n' >> "$ROOT/commands"; }
      refresh_gateway_service_if_loaded() { printf 'service-refresh\\n' >> "$ROOT/commands"; }
      main --json --npm --onboard --runtime-only --prefix "$ROOT/prefix"
    `,
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(readFileSync(join(f.root, "commands"), "utf8").trim().split("\n")).toEqual([
      "--version",
    ]);
    expect(result.stdout).toContain('"event":"done"');
  });

  it.each([
    { tempBase: "directory", downloadFails: false },
    { tempBase: "file", downloadFails: true },
  ])(
    "owns and cleans private temporary storage with $tempBase TMPDIR (download fails: $downloadFails)",
    ({ tempBase, downloadFails }) => {
      const f = makeFixture("temp");
      const { root } = f;
      chmodSync(root, 0o775);
      const inheritedTemp = join(root, "inherited temp");
      if (tempBase === "directory") {
        mkdirSync(inheritedTemp, { mode: 0o755 });
      } else if (tempBase === "file") {
        writeFileSync(inheritedTemp, "preserve this file");
      }
      const prefix = join(root, "nested", "state");
      f.shell("node-payload/bin/node", 'if [[ "${1:-}" == "-v" ]]; then printf "v24.22.1\\n"; fi');
      f.shell("node-payload/bin/npm", "exit 0");
      const archive = join(root, "node.tgz");
      const packed = spawnSync("tar", ["-czf", archive, "-C", root, "node-payload"], {
        encoding: "utf8",
      });
      expect(packed.status, packed.stdout + packed.stderr).toBe(0);
      const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
      const observationPath = join(root, "temporary-storage.json");
      writeFileSync(
        join(root, "observe-temp.cjs"),
        `const fs = require("node:fs");
const path = require("node:path");
const tempDirectory = process.env.TMPDIR;
const metadata = fs.statSync(tempDirectory);
fs.mkdtempSync(path.join(tempDirectory, "child-"));
fs.writeFileSync(path.join(process.env.ROOT, "temporary-storage.json"), JSON.stringify({
  tempDirectory, mode: metadata.mode & 0o777, uid: metadata.uid,
  stagingDirectory: path.dirname(process.argv[2]),
}));
`,
      );

      try {
        const result = f.run(
          `
          is_musl_linux() { return 1; }
          umask 0002
          detect_downloader() { :; }
          preflight_fresh_git_disk_space() { exit 91; }
          install_openclaw_from_git() { exit 92; }
          install_openclaw() { exit 93; }
          refresh_gateway_service_if_loaded() { exit 94; }
          download_file() {
            "$FIXTURE_NODE" "$ROOT/observe-temp.cjs" "$2" || return
            if [[ "${downloadFails ? 1 : 0}" == 1 ]]; then return 42; fi
            case "$1" in
              */SHASUMS256.txt)
                printf '%s  node-v24.22.1-%s-%s.tar.gz\\n' "$FIXTURE_SHA" "$(os_detect)" "$(arch_detect)" > "$2"
                ;;
              *) cp "$ROOT/node.tgz" "$2" ;;
            esac
          }
          main --json --node-only --git --onboard --node-version 24.22.1 --prefix "$ROOT/nested/state"
          `,
          {
            HOME: root,
            TMPDIR: inheritedTemp,
            FIXTURE_SHA: digest,
          },
        );
        expect(result.status, result.stdout + result.stderr).toBe(downloadFails ? 42 : 0);
        expect(lstatSync(root).mode & 0o777).toBe(0o775);
        for (const directory of [join(root, "nested"), prefix, join(prefix, "tools")]) {
          expect(lstatSync(directory).mode & 0o777, directory).toBe(0o700);
        }
        const observation = JSON.parse(readFileSync(observationPath, "utf8")) as {
          tempDirectory: string;
          mode: number;
          uid: number;
          stagingDirectory: string;
        };
        expect(observation.tempDirectory).not.toBe(inheritedTemp);
        expect(observation.mode).toBe(0o700);
        expect(observation.uid).toBe(process.getuid?.());
        expect(observation.stagingDirectory.startsWith(`${observation.tempDirectory}/`)).toBe(true);
        expect(existsSync(observation.tempDirectory)).toBe(false);
        expect(existsSync(observation.stagingDirectory)).toBe(false);
        expect(existsSync(join(prefix, "tools", "node", "bin", "node"))).toBe(!downloadFails);
        if (tempBase === "directory") {
          expect(readdirSync(inheritedTemp)).toEqual([]);
        } else if (tempBase === "file") {
          expect(readFileSync(inheritedTemp, "utf8")).toBe("preserve this file");
        } else {
          expect(existsSync(inheritedTemp)).toBe(false);
        }
      } finally {
        if (existsSync(observationPath)) {
          const observation = JSON.parse(readFileSync(observationPath, "utf8")) as {
            tempDirectory: string;
          };
          if (observation.tempDirectory !== inheritedTemp) {
            rmSync(observation.tempDirectory, { recursive: true, force: true });
          }
        }
      }
    },
  );

  it.each([true, false])(
    "preserves the caller TMPDIR for service refresh and onboarding (originally set: %s)",
    (originallySet) => {
      const f = makeFixture("temp-lifecycle");
      const inheritedTemp = join(f.root, "inherited");
      mkdirSync(inheritedTemp);
      f.shell(
        "cli",
        `
if [[ "$1" == --version ]]; then
  printf '2026.9.12\\n'
else
  printf '%s' "\${TMPDIR-<unset>}" > "$ROOT/onboard-temp"
fi
`,
      );
      const result = f.run(
        `
        install_node() { printf '%s' "$TMPDIR" > "$ROOT/install-temp"; }
        ensure_git() { :; }
        install_openclaw() { mkdir -p "$PREFIX/bin"; cp "$ROOT/cli" "$PREFIX/bin/openclaw"; }
        refresh_gateway_service_if_loaded() { printf '%s' "\${TMPDIR-<unset>}" > "$ROOT/refresh-temp"; }
        main --onboard --prefix "$ROOT/prefix"
        printf '%s' "\${TMPDIR-<unset>}" > "$ROOT/caller-temp"
      `,
        {
          HOME: f.root,
          TMPDIR: originallySet ? inheritedTemp : undefined,
          OPENCLAW_NO_ONBOARD: "0",
        },
      );
      expect(result.status, result.stdout + result.stderr).toBe(0);
      for (const name of ["refresh-temp", "onboard-temp", "caller-temp"]) {
        expect(readFileSync(join(f.root, name), "utf8")).toBe(
          originallySet ? inheritedTemp : "<unset>",
        );
      }
      const installTemp = readFileSync(join(f.root, "install-temp"), "utf8");
      expect(installTemp).not.toBe(inheritedTemp);
      expect(existsSync(installTemp)).toBe(false);
    },
  );

  it("re-execs a streamed installer on Darwin Bash 5.3+ without leaving a temp file", (context) => {
    const bash = findDarwinReexecBash();
    if (!bash) {
      context.skip("Requires a Darwin host with Bash 5.3+ installed");
      return;
    }
    const tmp = tempDirs.make("openclaw-install-reexec-");
    const result = spawnSync(bash, ["-s", "--", "--help"], {
      input: script,
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        HOME: tmp,
        TMPDIR: tmp,
        BASH_ENV: "",
        ENV: "",
        OPENCLAW_INSTALL_SH_NO_RUN: "0",
        OPENCLAW_INSTALL_CLI_SH_NO_RUN: "0",
      },
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("Usage: install-cli.sh [options]");
    expect(result.stderr).not.toContain("Run this installer with /bin/bash");
    expect(readdirSync(tmp)).toEqual([]);
  });

  it("fails a low-space fresh Git install before Node or checkout work", () => {
    const f = makeFixture("disk-low");
    const result = f.run(`
      available_disk_kib() { printf '2097152\\n'; }
      install_node() { printf 'node\\n' >> "$ROOT/commands.log"; }
      install_openclaw_from_git() { printf 'git\\n' >> "$ROOT/commands.log"; }
      main --json --git --git-dir "$ROOT/new/openclaw"
    `);
    expect(result.status).toBe(1);
    expect(existsSync(join(f.root, "commands.log"))).toBe(false);
    const events = result.stdout
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            event: string;
            name?: string;
            message?: string;
          },
      );
    expect(events).toEqual([
      { event: "step", name: "disk-space", status: "start" },
      {
        event: "error",
        message:
          "Fresh Git installs require at least 6 GiB of free disk space; only 2.0 GiB is available. Free disk space and retry.",
      },
    ]);
  });

  it.each([false, true])(
    "rejects unknown arguments with preserved status and JSON bytes (json=%s)",
    (json) => {
      const result = runInstallCliShell(`main ${json ? "--json " : ""}--synthetic-invalid`);
      expect(result.status).toBe(1);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(
        json
          ? '{"event":"error","message":"Unknown option: --synthetic-invalid"}\n'
          : "ERROR: Unknown option: --synthetic-invalid\nSupport: https://community.openclaw.ai/\n",
      );
    },
  );

  it.each([false, true])(
    "surfaces captured npm-version support without changing JSON output (json=%s)",
    (json) => {
      const root = tempDirs.make("openclaw-install-cli-version-failure-");
      const npm = join(root, "npm"),
        args = join(root, "args");
      writeNpmLifecycleFixture(npm);
      const result = runInstallCliShell(
        `
        npm_bin() { printf '%s\\n' "$FIXTURE_NPM"; }
        npm_config_has_raw_key() { return 1; }
        JSON=${json ? 1 : 0}
        install_openclaw
      `,
        { FIXTURE_NPM: npm, NPM_FAKE_VERSION_STATUS: "1", NPM_FAKE_ARGS: args },
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(json ? "" : "Support: https://community.openclaw.ai/\n");
      expect(existsSync(args)).toBe(false);
    },
  );

  it("round-trips dynamic installer values through independent NDJSON records", () => {
    const root = tempDirs.make("openclaw-install-cli-json-events-");
    const dynamicValue = `quote"\\café项目lobster🦞${String.fromCharCode(
      ...Array.from({ length: 31 }, (_, index) => index + 1),
    )}end`;
    const fakeNode = join(root, "node");
    writeFileSync(fakeNode, '#!/bin/bash\nprintf "%s" "$EVENT_VALUE"\n');
    chmodSync(fakeNode, 0o755);

    const success = runInstallCliShell(
      [
        "JSON=1",
        "try_link_usable_node_runtime_from_path() { return 0; }",
        `node_bin() { printf '%s\\n' ${JSON.stringify(fakeNode)}; }`,
        "install_alpine_node",
        'emit_json done version "$EVENT_VALUE"',
      ].join("\n"),
      { EVENT_VALUE: dynamicValue },
    );

    expect(success.status, success.stderr || success.stdout).toBe(0);
    const successLines = success.stdout.trimEnd().split("\n");
    expect(successLines).toHaveLength(3);
    const successEvents = successLines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(successEvents).toEqual([
      { event: "step", name: "node", status: "start", method: "apk" },
      { event: "step", name: "node", status: "ok", method: "system", version: dynamicValue },
      { event: "done", ok: true, version: dynamicValue },
    ]);

    const failure = runInstallCliShell(["JSON=1", 'fail "$EVENT_VALUE"'].join("\n"), {
      EVENT_VALUE: dynamicValue,
    });

    expect(failure.status).toBe(1);
    expect(failure.stdout.trimEnd().split("\n")).toHaveLength(1);
    expect(JSON.parse(failure.stdout)).toEqual({ event: "error", message: dynamicValue });
  });

  it("keeps the full Git install on the canonical checkout after an alias is retargeted", () => {
    const root = tempDirs.make("openclaw-install-cli-retargeted-alias-");
    const result = runInstallCliShell(
      `
      set -euo pipefail
      target="$ROOT/target"
      replacement="$ROOT/replacement"
      alias_path="$ROOT/alias"
      mkdir -p "$target" "$replacement"
      ln -s "$target" "$alias_path"
      PREFIX="$ROOT/prefix"

      ensure_git() { :; }
      resolve_git_openclaw_ref() { printf 'main\\n'; }
      checkout_git_openclaw_ref() {
        [[ "$1" == "$target" && "$2" == "main" ]] || return 1
        GIT_REF_KIND=moving
      }
      ensure_pnpm() { [[ "$1" == "$target" ]]; }
      run_pnpm() {
        [[ "$1" == "-C" && "$2" == "$target" ]] || return 1
        if [[ "\${3:-}" == "install" ]]; then
          [[ " $* " == *" --no-frozen-lockfile "* ]]
        fi
      }
      git() {
        if [[ "$1" == "clone" ]]; then
          local clone_target="\${*: -1}"
          mkdir -p "$clone_target/.git"
          printf 'complete\\n' > "$clone_target/checkout.marker"
          rm "$alias_path"
          ln -s "$replacement" "$alias_path"
          return 0
        fi
        [[ "$1" == "-C" && "$2" == "$target" ]]
      }

      install_openclaw_from_git "$alias_path"
      grep -F "$target/dist/entry.js" "$PREFIX/bin/openclaw"
      [[ -z "$(ls -A "$replacement")" ]]
      [[ -z "$(find "$target" -maxdepth 1 -name '.openclaw-clone.*' -print -quit)" ]]
    `,
      { ROOT: root },
    );

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it("bounds wget stalls and propagates timeout failures", () => {
    const result = runInstallCliShell(`
      set -euo pipefail
      set +e
      wget() {
        printf 'wget=%s\n' "$*"
        return 4
      }
      DOWNLOADER=wget
      download_file "https://example.invalid/node.tar.gz" "/tmp/node.tar.gz"
      printf 'wget-status=%s\n' "$?"
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--timeout=300");
    expect(result.stdout).toContain("wget-status=4");
  });

  it("matches the canonical release-label contract for installed Node runtimes", () => {
    const result = runShell(
      [
        "set -euo pipefail",
        `source ${JSON.stringify(SCRIPT_PATH)}`,
        "set +e",
        ...NODE_RELEASE_VERSION_CASES.flatMap((version, index) => [
          `node_release_version_is_supported ${JSON.stringify(version)}`,
          `printf '${index}=%s\\n' "$?"`,
        ]),
      ].join("\n"),
    );

    expect(result.status).toBe(0);
    for (const [index, version] of NODE_RELEASE_VERSION_CASES.entries()) {
      const expectedStatus = isSupportedOpenClawNodeVersion(version) ? 0 : 1;
      expect(result.stdout, version).toContain(`${index}=${expectedStatus}`);
    }
  });

  it.each(["npm", "git"])("rejects incompatible %s before replacing the managed CLI", (method) => {
    const f = makeFixture("compatible");
    const candidate = "2026.7.1-2";
    const openclaw = f.write("prefix/bin/openclaw", "existing-managed-cli\n");
    mkdirSync(join(f.root, "repo/.git"), { recursive: true });
    f.write("repo/package.json", JSON.stringify({ version: candidate }));
    const result = f.run(`
      PREFIX="$ROOT/prefix"
      OPENCLAW_VERSION=latest
      REQUIRED_COMPATIBLE_VERSION=2026.7.2
      node_bin() { command -v node; }
      npm_bin() { printf 'npm\\n'; }
      npm_config_has_raw_key() { return 1; }
      npm() {
        if [[ "$1" == "view" ]]; then printf '%s\\n' '${candidate}'; return 0; fi
        if [[ "$1" == "config" ]]; then printf 'null\\n'; return 0; fi
        printf 'unexpected mutation: %s\\n' "$*" >&2
        return 99
      }
      ${
        method === "npm"
          ? "install_openclaw"
          : `
        ensure_git() { :; }
        resolve_git_openclaw_ref() { printf 'main\\n'; }
        checkout_git_openclaw_ref() { :; }
        git() { return 0; }
        ensure_pnpm() { printf 'unexpected mutation' >&2; return 99; }
        install_openclaw_from_git "$ROOT/repo"
      `
      }
    `);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("OpenClaw 2026.7.1-2 is older than config writer 2026.7.2");
    expect(result.stderr).not.toContain("unexpected mutation");
    expect(readFileSync(openclaw, "utf8")).toBe("existing-managed-cli\n");
  });

  it("reports runtime replacement without leaking paths or restarting again", () => {
    const f = makeFixture("refresh");
    f.shell(
      "prefix/bin/openclaw",
      `
      printf '%s\\n' "$*" >> "$ROOT/commands"
      if [[ "$*" == "gateway install --force" ]]; then
        printf '%s\\n' incidental-output-canary
        printf '%s\\n' 'Replacing unsupported Gateway service Node 22.23.1 (/old/node) with /new/node; refreshing the install.'
      fi
    `,
    );
    const result = f.run(
      `
      PREFIX="$ROOT/prefix"
      is_gateway_daemon_loaded() { return 0; }
      refresh_gateway_service_if_loaded
    `,
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("Gateway service Node runtime replaced.");
    for (const privateValue of ["incidental-output-canary", "/old/node", "/new/node"]) {
      expect(result.stdout + result.stderr).not.toContain(privateValue);
    }
    expect(readFileSync(join(f.root, "commands"), "utf8").trim().split("\n")).toEqual([
      "gateway install --force",
      "gateway status --probe --json",
    ]);
  });

  it.each([
    { error: "SERVICE_DEFINITION_SEALED: protected", args: "--json", stream: "stdout" },
    { error: "SERVICE_DEFINITION_UNKNOWN: inaccessible", args: "--json", stream: "stderr" },
  ])("handles a traced $error refresh in $stream", ({ args, error, stream }) => {
    const f = makeFixture("definition");
    const secretCanary = "installer-cli-secret-canary-never-render";
    f.shell(
      "prefix/bin/openclaw",
      [
        'printf "%s\\n" "$*" >> "$ROOT/commands"',
        'if [[ "$1" == "--version" ]]; then printf "OpenClaw 2026.8.25\\n"; exit 0; fi',
        'if [[ "$*" == "gateway install --force" ]]; then',
        '  printf "%s\\n" "Replacing unsupported Gateway service Node 22.23.1 (/old/node) with /new/node; refreshing the install."',
        '  if [[ "$SERVICE_STREAM" == stdout ]]; then printf "%s\\n" "$SERVICE_ERROR"; else printf "%s\\n" "$SERVICE_ERROR" >&2; fi',
        '  printf "%s\\n" "$SECRET_CANARY" >&2; exit 1',
        "fi",
      ].join("\n"),
    );

    const result = f.run(
      [
        "install_node() { :; }; ensure_git() { :; }; install_openclaw() { :; }",
        "is_gateway_daemon_loaded() { return 0; }",
        "set -x",
        `main ${args} --prefix "$ROOT/prefix"`,
      ].join("\n"),
      {
        SECRET_CANARY: secretCanary,
        SERVICE_ERROR: error,
        SERVICE_STREAM: stream,
      },
    );

    expect(readFileSync(join(f.root, "commands"), "utf8").split("\n")).not.toContain(
      "gateway restart",
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("+ main");
    expect(result.stdout + result.stderr).not.toContain(secretCanary);
    expect(result.stdout + result.stderr).not.toContain("Gateway service Node runtime replaced");
    expect(result.stderr).toContain("gateway service definition left unchanged");
    expect(result.stderr).toContain(
      error.includes("SEALED")
        ? "privileged deployment owner"
        : "inspect service-definition access",
    );
    expect(result.stdout).toContain('"event":"done"');
    expect(result.stdout).toContain('"reason":"definition-mutation-denied"');
  });

  it.each([false, true])(
    "rejects an unusable installed CLI before service refresh (version exits nonzero: %s)",
    (failedVersion) => {
      const f = makeFixture("invalid-package");
      const refreshLog = join(f.root, "gateway-refresh.log");
      if (failedVersion) {
        f.shell("prefix/bin/openclaw", 'printf "OpenClaw 2026.8.1\\n"\nexit 1');
      }
      const result = f.run(
        [
          "npm_lifecycle_allow_arg() { :; }",
          failedVersion
            ? "install_node() { :; }; install_openclaw() { :; }"
            : 'install_node() { mkdir -p "$(node_dir)/lib/node_modules/openclaw/dist"; : > "$(node_dir)/lib/node_modules/openclaw/dist/entry.js"; }',
          "ensure_git() { :; }",
          'npm_bin() { printf "/usr/bin/true\\n"; }',
          `refresh_gateway_service_if_loaded() { touch ${JSON.stringify(refreshLog)}; }`,
          'main --json --prefix "$ROOT/prefix" --version 0.0.0',
        ].join("\n"),
      );

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("Installed OpenClaw CLI did not return a version");
      expect(result.stdout).not.toContain('"event":"done"');
      expect(result.stdout).not.toContain("OpenClaw installed.");
      expect(existsSync(refreshLog)).toBe(false);
    },
  );

  it.each([
    { input: "environment", method: "npm" },
    { input: "literal tilde", method: "git" },
  ] as const)(
    "keeps a generated $method launcher working after $input supplied paths change cwd",
    ({ input, method }) => {
      const f = makeFixture(`relative-${method}`);
      const home = join(f.root, "home"),
        installRoot = join(f.root, "install-root");
      const tilde = input === "literal tilde";
      const prefix = join(tilde ? home : installRoot, "openclaw-local");
      const repo = join(tilde ? home : installRoot, "openclaw-source");
      const nodeDir = join(prefix, "tools", "node-v24.22.1");
      const legacy = join(home, "openclaw", "Peekaboo", "user.txt");
      for (const dir of [
        dirname(legacy),
        installRoot,
        join(repo, ".git"),
        join(repo, "dist"),
        join(f.root, "other-root"),
      ]) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(legacy, "keep this checkout");
      f.runtime(
        `${tilde ? "home" : "install-root"}/openclaw-local/tools/node-v24.22.1/bin`,
        'if [[ "$1" == "--version" ]]; then printf "11.15.0\\n"; elif [[ "$1" == "config" ]]; then printf "null\\n"; fi',
      );
      symlinkSync("node-v24.22.1", join(prefix, "tools", "node"));
      for (const entry of [
        join(nodeDir, "lib/node_modules/openclaw/dist/entry.js"),
        join(repo, "dist/entry.js"),
      ]) {
        mkdirSync(dirname(entry), { recursive: true });
        writeFileSync(entry, 'console.log("fixture cli");\n');
      }
      const result = runShell(
        `
        set -euo pipefail
        cd "$ROOT/install-root"
        source "${join(process.cwd(), SCRIPT_PATH)}"
        install_node() { :; }; ensure_git() { :; }; refresh_gateway_service_if_loaded() { :; }
        ${
          method === "git"
            ? `
        preflight_fresh_git_disk_space() { :; }; ensure_pnpm() { :; }
        resolve_git_openclaw_ref() { printf 'main\\n'; }; checkout_git_openclaw_ref() { :; }
        git_install_lockfile_flag() { printf '%s\\n' '--no-frozen-lockfile'; }
        run_pnpm() { :; }; git() { return 0; }
        `
            : ""
        }
        main --${method} ${tilde ? '--prefix "~/openclaw-local" --git-dir "~/openclaw-source"' : ""}
        cd "$ROOT/other-root"
        "${prefix}/bin/openclaw" --version
      `,
        {
          ROOT: f.root,
          HOME: home,
          OPENCLAW_HOME: home,
          OPENCLAW_GIT_DIR: undefined,
          OPENCLAW_PREFIX: tilde ? undefined : "openclaw-local",
        },
      );
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(readFileSync(legacy, "utf8")).toBe("keep this checkout");
      expect(result.stdout.trim().split("\n").at(-1)).toBe("fixture cli");
    },
  );

  defineInstallerPnpmContract(installerContract);

  it.each([false, true])("replaces an unusable musl runtime (apk required: %s)", (useApk) => {
    const f = makeFixture("alpine");
    const managedBin = join(f.root, "prefix/tools/node-v24.22.1/bin");
    f.node("prefix/tools/node-v24.22.1/bin/node", "v24.22.1", 1);
    f.node("old-bin/node", "v18.20.0", 1);
    f.shell("old-bin/npm", "exit 0");
    f.shell("bin/npm", "exit 0");
    linkRequiredShellTools(join(f.root, "bin"));
    f.shell(
      "bin/apk",
      `
      printf '%s\\n' "$*" >> "$ROOT/apk.log"
      ${useApk ? 'printf new > "$ROOT/node-state"' : "exit 99"}
    `,
    );
    if (useApk) {
      f.shell(
        "bin/node",
        `
        if [[ "\${1:-}" == -v ]]; then
          if [[ -f "$ROOT/node-state" ]]; then printf 'v24.22.1\\n'; else printf 'v18.20.0\\n'; fi
        elif [[ "\${1:-}" == -e ]]; then [[ -f "$ROOT/node-state" ]]; exit $?; fi
        exit 0
      `,
      );
    } else {
      f.node("bin/node", "v24.22.1");
    }
    const result = f.run(`
      export PATH="$ROOT/prefix/tools/node-v24.22.1/bin:$ROOT/old-bin:$ROOT/bin"
      is_musl_linux() { return 0; }
      is_root() { return ${useApk ? 0 : 1}; }
      PREFIX="$ROOT/prefix"
      APK_NODE_BIN_DIR="$ROOT/bin"
      NODE_VERSION=24.22.1
      install_node linux x64
    `);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout.includes("Installing Node via apk")).toBe(useApk);
    if (useApk) {
      expect(readFileSync(join(f.root, "apk.log"), "utf8")).toContain("add --no-cache nodejs npm");
    } else {
      expect(existsSync(join(f.root, "apk.log"))).toBe(false);
    }
    for (const tool of ["node", "npm"]) {
      expect(lstatSync(join(managedBin, tool)).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(managedBin, tool))).toBe(join(f.root, "bin", tool));
    }
  });

  it("skips PATH runtimes whose npm cannot start and invokes npm with the selected Node", () => {
    const f = makeFixture("broken-npm");
    const { root } = f;
    const prefix = join(root, "nested", "prefix");
    f.runtime("bad", 'printf "%s\\n" "$*" >> "$ROOT/bad.log"\nexit 42');
    f.shell("good/node", 'printf "%s\\n" "$*" >> "$ROOT/node.log"\nexec "$FIXTURE_NODE" "$@"');
    f.shell(
      "good/npm",
      'require("node:fs").appendFileSync(process.env.ROOT + "/good.log", process.argv.slice(2).join(" ") + "\\n");',
      "/usr/bin/env node",
    );
    writeFileSync(join(root, "good/package.json"), '{"type":"commonjs"}\n');
    chmodSync(root, 0o775);
    const result = f.run(`
      export PATH="$ROOT/bad:$ROOT/good:${process.env.PATH ?? ""}"
      umask 0002
      PREFIX="$ROOT/nested/prefix"
      try_link_usable_node_runtime_from_path
      printf 'umask=%s\n' "$(umask)"
    `);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("umask=0002");
    expect(lstatSync(root).mode & 0o777).toBe(0o775);
    expect(readFileSync(join(root, "bad.log"), "utf8")).toBe("--version\n");
    expect(readFileSync(join(root, "good.log"), "utf8")).toBe("--version\n");
    expect(readFileSync(join(root, "node.log"), "utf8")).toContain("npm --version");
    const bin = join(prefix, "tools", "node-v24.22.1", "bin");
    for (const directory of [
      join(root, "nested"),
      prefix,
      join(prefix, "tools"),
      dirname(bin),
      bin,
    ]) {
      expect(lstatSync(directory).mode & 0o777, directory).toBe(0o700);
    }
    expect(lstatSync(join(bin, "node")).isSymbolicLink()).toBe(true);
    for (const tool of ["node", "npm"]) {
      expect(readlinkSync(join(bin, tool))).toBe(join(root, "good", tool));
    }
  });

  it("preserves the active runtime when apk provides unsafe SQLite", () => {
    const root = tempDirs.make("openclaw-install-cli-preserve-runtime-");
    const bin = join(root, "candidate");
    const prefix = join(root, "prefix");
    const oldRuntime = join(root, "old-runtime");
    mkdirSync(bin);
    linkRequiredShellTools(bin);
    mkdirSync(join(oldRuntime, "bin"), { recursive: true });
    symlinkSync(nodeExecutable, join(oldRuntime, "bin", "node"));
    mkdirSync(join(prefix, "tools"), { recursive: true });
    symlinkSync(oldRuntime, join(prefix, "tools", "node"));
    writeShell(
      join(bin, "node"),
      'if [[ "$1" == -e ]]; then exit 1; fi\nexec "$FIXTURE_NODE" "$@"',
    );
    writeShell(join(bin, "npm"), "exit 0");
    const result = runInstallCliShell(
      `
      PREFIX="$FIXTURE_PREFIX"
      PATH="$FIXTURE_BIN"
      export PATH
      APK_NODE_BIN_DIR="$FIXTURE_BIN"
      is_root() { return 0; }
      apk() { printf 'apk called\\n'; }
      install_alpine_node
      `,
      { FIXTURE_PREFIX: prefix, FIXTURE_BIN: bin, FIXTURE_NODE: nodeExecutable },
    );
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain("apk called");
    expect(result.stdout).toContain("Alpine Node package must provide Node >=");
    expect(readlinkSync(join(prefix, "tools", "node"))).toBe(oldRuntime);
    expect(readlinkSync(join(oldRuntime, "bin", "node"))).toBe(nodeExecutable);
    expect(existsSync(join(prefix, "tools", "node-v24.22.1"))).toBe(false);
  });

  it("excludes active runtime aliases reached through an empty PATH entry", () => {
    const f = makeFixture("runtime-alias");
    const bin = f.runtime("system-bin");
    const oldBin = f.runtime("old-runtime/bin");
    const old = dirname(oldBin),
      prefix = join(f.root, "prefix");
    linkRequiredShellTools(bin);
    for (const tool of ["npx", "corepack"]) {
      f.shell(`old-runtime/bin/${tool}`, "exit 0");
    }
    mkdirSync(join(prefix, "tools"), { recursive: true });
    symlinkSync(old, join(prefix, "tools", "node"));
    symlinkSync(join(prefix, "tools", "node", "bin"), join(f.root, "alias-bin"));
    const result = f.run(`
      PREFIX="$ROOT/prefix"
      cd "$ROOT/alias-bin"
      export PATH=":$ROOT/system-bin"
      try_link_usable_node_runtime_from_path
    `);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const active = join(prefix, "tools", "node", "bin");
    for (const tool of ["node", "npm"]) {
      expect(readlinkSync(join(active, tool))).toBe(join(bin, tool));
    }
    for (const tool of ["npx", "corepack"]) {
      expect(readdirSync(active)).not.toContain(tool);
      expect(readFileSync(join(oldBin, tool), "utf8")).toBe("#!/bin/bash\nexit 0\n");
    }
  });

  it("publishes usable runtime links for a relative PATH entry with spaces", () => {
    const f = makeFixture("relative-runtime");
    f.runtime("source dir/bin dir", "console.log('11.19.1');", "/usr/bin/env node");
    const fallback = f.runtime("fallback", "console.log('11.19.2');", "/usr/bin/env node");
    linkRequiredShellTools(fallback);
    mkdirSync(join(f.root, "elsewhere"));
    for (const tool of ["npx", "corepack"]) {
      f.shell(`source dir/tools dir/${tool}`, `printf '${tool}-ok\\n'`);
    }
    const result = f.run(`
      PREFIX="$ROOT/prefix"
      cd "$ROOT/source dir"
      export PATH="bin dir:tools dir:$ROOT/fallback"
      try_link_usable_node_runtime_from_path
      cd "$ROOT/elsewhere"
      PATH="$PREFIX/tools/node/bin:$ROOT/fallback"
      "$PREFIX/tools/node/bin/node" -p '"node-ok"'
      "$PREFIX/tools/node/bin/npm" --version
      "$PREFIX/tools/node/bin/npx"
      "$PREFIX/tools/node/bin/corepack"
    `);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("node-ok\n11.19.1\nnpx-ok\ncorepack-ok");
    for (const tool of ["node", "npm", "npx", "corepack"]) {
      expect(readlinkSync(join(f.root, "prefix/tools/node/bin", tool))).toMatch(/^\//);
    }
  });

  it.each(
    ["command", "runtime"].flatMap((route) =>
      ["empty", "trailing"].map((order) => ({ route, order })),
    ),
  )("preserves PATH lookup order for $route with $order entries", ({ route, order }) => {
    const f = makeFixture("path-order");
    for (const name of ["current", "other"]) {
      const bin = join(f.root, name);
      mkdirSync(bin);
      linkRequiredShellTools(bin);
      if (name !== "other" || order !== "trailing") {
        f.runtime(name, `printf '${name}-npm\\n'`);
      }
    }
    const result = f.run(`
      PREFIX="$ROOT/prefix"
      cd "$ROOT/current"
      export PATH="${order === "empty" ? "" : "$ROOT/other:"}"
      ${route === "command" ? 'selected="$(command_path_without_node_prefix npm)"' : 'try_link_usable_node_runtime_from_path; selected="$(npm_bin)"'}
      "$selected" --version
    `);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("current-npm");
  });

  it("does not invent a cwd search after filtering an empty managed PATH entry", () => {
    const f = makeFixture("filtered-path");
    f.shell("prefix/tools/node-v24.22.1/bin/npm", "exit 0");
    const result = f.run(`
      PREFIX="$ROOT/prefix"
      cd "$ROOT/prefix/tools/node-v24.22.1/bin"
      export PATH=""
      command_path_without_node_prefix npm 1
    `);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toBe("");
  });

  it("preserves the active runtime until a downloaded replacement starts, then permits retry", () => {
    const f = makeFixture("node-retry");
    const prefix = join(f.root, "prefix");
    const oldRuntime = join(prefix, "tools", "node-v22.23.2");
    const active = join(prefix, "tools", "node");
    const packageContent = '{"name":"openclaw","version":"2026.9.2"}\n';
    const packageFile = f.write(
      "prefix/tools/node-v22.23.2/lib/node_modules/openclaw/package.json",
      packageContent,
    );
    f.node("prefix/tools/node-v22.23.2/bin/node", "v22.23.2");
    symlinkSync(oldRuntime, active);
    f.shell("new-node", "exit 126");
    const install = () =>
      f.run(
        `
      is_musl_linux() { return 1; }
      detect_downloader() { :; }
      require_bin() { :; }
      download_file() {
        case "$1" in
          */SHASUMS256.txt) printf 'fixture-sha  node-v24.22.1-linux-x64.tar.gz\\n' > "$2" ;;
          *) printf 'node tarball fixture\\n' > "$2" ;;
        esac
      }
      sha256_file() { printf 'fixture-sha\\n'; }
      tar() {
        local dest=''
        while [[ $# -gt 0 ]]; do
          if [[ "$1" == '-C' ]]; then dest="$2"; shift 2; else shift; fi
        done
        mkdir -p "$dest/bin"
        cp "$ROOT/new-node" "$dest/bin/node"
        printf '#!/bin/bash\\nexit 0\\n' > "$dest/bin/npm"
        chmod +x "$dest/bin/npm"
      }
      PREFIX="$ROOT/prefix"
      NODE_VERSION=24.22.1
      install_node linux x64
    `,
      );
    const expectActive = (target: string, version: string) => {
      expect(readlinkSync(active)).toBe(target);
      expect(spawnSync(join(active, "bin/node"), ["-v"], { encoding: "utf8" }).stdout).toBe(
        `${version}\n`,
      );
      expect(readFileSync(packageFile, "utf8")).toBe(packageContent);
    };
    const failed = install();
    expect(failed.status).toBe(1);
    expect(failed.stdout).toContain(
      "Installed Node 24.22.1 must provide Node >= 24.16.0 with WAL-reset-safe SQLite",
    );
    expect(failed.stdout).toContain("found Node unknown, SQLite unavailable");
    expectActive(oldRuntime, "v22.23.2");
    f.node("new-node", "v24.22.1");
    const retried = install();
    expect(retried.status, retried.stdout + retried.stderr).toBe(0);
    expectActive(join(prefix, "tools", "node-v24.22.1"), "v24.22.1");
  });

  it.each([
    ["openclaw@npm:@scope/candidate.tgz@1.0.0", "--allow-scripts=@scope/candidate.tgz"],
    ["vendor/repo.tgz", "--allow-scripts=vendor/repo.tgz"],
    [
      "https://example.invalid/openclaw.tgz",
      "--allow-scripts=https://example.invalid/openclaw.tgz",
    ],
  ])("uses npm-resolved lifecycle identity for %s", (spec, expected) => {
    const result = runNpmPolicy(spec);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(expected);
  });

  defineInstallerNpmConfigContract(installerContract);

  it.each([
    [
      "musl recovery",
      "is_musl_linux() { return 0; }; install_node() { echo unexpected-node-install; }; main --node-only",
      "unavailable on musl Linux",
      "unexpected-node-install",
    ],
    [
      "ARMv7",
      "NODE_VERSION_REQUESTED=1; os_detect() { echo linux; }; arch_detect() { echo armv7l; }; install_node() { echo unexpected-install; }; main",
      "Linux ARMv7 is unsupported: official Node 24+ binaries are unavailable",
      "unexpected-install",
    ],
    [
      "vulnerable Node",
      "NODE_VERSION=24.14.1; install_node linux x64",
      "Node 24.14.1 is unsupported; use Node 24.16.0+ or Node 26.1.0+.",
      "Installing Node 24.14.1",
    ],
    [
      "missing option value",
      "parse_args --prefix --no-onboard",
      "Missing value for --prefix",
      "unbound variable",
    ],
    [
      "npm source target",
      "os_detect() { echo linux; }; OPENCLAW_VERSION=main; install_openclaw",
      "npm installs do not support OpenClaw GitHub source targets",
      "",
    ],
  ])("rejects %s before installation", (name, body, message, absent) => {
    const result = runInstallCliShell(body);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(message);
    if (absent) {
      expect(result.stdout + result.stderr).not.toContain(absent);
    }
    if (name === "npm source target") {
      expect(result.stdout).toContain("--install-method git --version main");
    }
  });

  defineInstallerNpmRetryContract(installerContract);

  defineInstallerNpmFreshnessContract(installerContract);
});
