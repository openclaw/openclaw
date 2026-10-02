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
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isSupportedOpenClawNodeVersion } from "../../node-version.mjs";
import { readStandaloneInstaller } from "../../scripts/lib/standalone-installers.mjs";
import { requireNodeTool } from "../helpers/node-toolchain.js";
import { NODE_RELEASE_VERSION_CASES } from "../helpers/node-version-cases.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  createInstallGitBranchFallbackFixtureScript,
  createInstallGitCloneFixtureScript,
  createInstallGitUpdateFixtureScript,
  createInstallGitRebaseRecoveryFixtureScript,
  createInstallGitHookRefusalFixtureScript,
  createInstallGitCommitFixtureScript,
  createInstallGitTagPreferenceFixtureScript,
} from "./install-git-fixtures.js";
import {
  writeNpmInstallRetryFixture,
  writeNpmLifecycleFixture,
  writeNpmRawConfigFixture,
} from "./install-npm-fixtures.js";
import { findDarwinReexecBash } from "./install-reexec-fixtures.js";
import {
  defineInstallerNpmDirectoryIdentityContract,
  defineInstallerNpmFreshnessContract,
  defineInstallerShellIsolationContract,
} from "./install-test-contract.js";
import { linkPnpmBootstrapShellTools } from "./test-helpers.js";

const SCRIPT_PATH = "scripts/install-cli.sh";
const nodeExecutable = requireNodeTool("node");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function runShell(script: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", script], {
    encoding: "utf8",
    env: {
      ...process.env,
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

function npmPolicyFixture(prefix = "openclaw-install-cli-lifecycle-") {
  const root = tempDirs.make(prefix),
    npm = join(root, "npm"),
    args = join(root, "args");
  writeNpmLifecycleFixture(npm);
  return {
    root,
    args,
    run(spec: string, version: string, exact = "") {
      return runInstallCliShell(
        `
        node_bin() { printf '%s\\n' "$FIXTURE_NODE"; }
        cd "$FIXTURE_ROOT"
        npm_lifecycle_allow_arg "$FIXTURE_NPM" "$FIXTURE_SPEC" "$PWD" "$FIXTURE_EXACT"
      `,
        {
          FIXTURE_NODE: nodeExecutable,
          FIXTURE_ROOT: root,
          FIXTURE_NPM: npm,
          FIXTURE_SPEC: spec,
          FIXTURE_EXACT: exact,
          NPM_FAKE_VERSION: version,
          NPM_FAKE_ARGS: args,
        },
      );
    },
  };
}

describe("install-cli.sh", () => {
  const script = readStandaloneInstaller(process.cwd(), SCRIPT_PATH.slice("scripts/".length));
  const installerContract = {
    scriptPath: SCRIPT_PATH,
    runShell,
    nodeExecutable,
    prefix: true,
    createTempDir: (prefix: string) => tempDirs.make(prefix),
  };

  defineInstallerShellIsolationContract(installerContract);

  it("keeps runtime-only installation free of service and onboarding effects", () => {
    const root = tempDirs.make("openclaw-browser-runtime-install-");
    const prefix = join(root, "prefix"),
      commands = join(root, "commands");
    mkdirSync(join(prefix, "bin"), { recursive: true });
    writeShell(
      join(prefix, "bin", "openclaw"),
      `
      printf '%s\\n' "$*" >> "$COMMAND_LOG"
      if [[ "$1" == --version ]]; then printf 'OpenClaw 2026.9.4\\n'; fi
    `,
    );
    const result = runInstallCliShell(
      `
      install_node() { :; }; install_openclaw() { :; }
      ensure_git() { printf 'git\\n' >> "$COMMAND_LOG"; }
      refresh_gateway_service_if_loaded() { printf 'service-refresh\\n' >> "$COMMAND_LOG"; }
      main --json --npm --onboard --runtime-only --prefix "$FIXTURE_PREFIX"
    `,
      { COMMAND_LOG: commands, FIXTURE_PREFIX: prefix },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(readFileSync(commands, "utf8").trim().split("\n")).toEqual(["--version"]);
    expect(result.stdout).toContain('"event":"done"');
  });

  it("refuses musl Node-only recovery before an installer can invoke system package changes", () => {
    const result = runInstallCliShell(`
      is_musl_linux() { return 0; }
      install_node() { echo unexpected-node-install; }
      main --node-only
    `);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain("unavailable on musl Linux");
    expect(result.stdout).not.toContain("unexpected-node-install");
  });

  it.each([
    { tempBase: "directory", downloadFails: false },
    { tempBase: "file", downloadFails: true },
  ])(
    "owns and cleans private temporary storage with $tempBase TMPDIR (download fails: $downloadFails)",
    ({ tempBase, downloadFails }) => {
      const root = tempDirs.make("openclaw-install-cli-temp-");
      const inheritedTemp = join(root, "inherited temp");
      if (tempBase === "directory") {
        mkdirSync(inheritedTemp, { mode: 0o755 });
      } else if (tempBase === "file") {
        writeFileSync(inheritedTemp, "preserve this file");
      }
      const prefix = join(root, "prefix");
      const payload = join(root, "node-payload");
      mkdirSync(join(payload, "bin"), { recursive: true });
      writeFileSync(
        join(payload, "bin", "node"),
        '#!/bin/bash\nif [[ "${1:-}" == "-v" ]]; then printf "v24.19.0\\n"; fi\n',
        { mode: 0o755 },
      );
      writeFileSync(join(payload, "bin", "npm"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
      const archive = join(root, "node.tgz");
      const packed = spawnSync("tar", ["-czf", archive, "-C", root, "node-payload"], {
        encoding: "utf8",
      });
      expect(packed.status, packed.stdout + packed.stderr).toBe(0);
      const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
      const observationPath = join(root, "temporary-storage.json");
      const observer = join(root, "observe-temp.cjs");
      writeFileSync(
        observer,
        `const fs = require("node:fs");
const path = require("node:path");
const tempDirectory = process.env.TMPDIR;
const metadata = fs.statSync(tempDirectory);
fs.mkdtempSync(path.join(tempDirectory, "child-"));
fs.writeFileSync(process.env.FIXTURE_OBSERVATION, JSON.stringify({
  tempDirectory, mode: metadata.mode & 0o777, uid: metadata.uid,
  stagingDirectory: path.dirname(process.argv[2]),
}));
`,
      );

      try {
        const result = runInstallCliShell(
          `
          is_musl_linux() { return 1; }
          detect_downloader() { :; }
          preflight_fresh_git_disk_space() { exit 91; }
          install_openclaw_from_git() { exit 92; }
          install_openclaw() { exit 93; }
          refresh_gateway_service_if_loaded() { exit 94; }
          download_file() {
            "$FIXTURE_NODE" "$FIXTURE_OBSERVER" "$2" || return
            if [[ "$FIXTURE_DOWNLOAD_FAILS" == 1 ]]; then return 42; fi
            case "$1" in
              */SHASUMS256.txt)
                printf '%s  node-v24.19.0-%s-%s.tar.gz\\n' "$FIXTURE_SHA" "$(os_detect)" "$(arch_detect)" > "$2"
                ;;
              *) cp "$FIXTURE_ARCHIVE" "$2" ;;
            esac
          }
          main --json --node-only --git --onboard --node-version 24.19.0 --prefix "$FIXTURE_PREFIX"
          `,
          {
            HOME: root,
            TMPDIR: inheritedTemp,
            FIXTURE_PREFIX: prefix,
            FIXTURE_NODE: nodeExecutable,
            FIXTURE_OBSERVER: observer,
            FIXTURE_OBSERVATION: observationPath,
            FIXTURE_DOWNLOAD_FAILS: downloadFails ? "1" : "0",
            FIXTURE_ARCHIVE: archive,
            FIXTURE_SHA: digest,
          },
        );
        expect(result.status, result.stdout + result.stderr).toBe(downloadFails ? 42 : 0);
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
      const root = tempDirs.make("openclaw-install-cli-temp-lifecycle-");
      const inheritedTemp = join(root, "inherited");
      mkdirSync(inheritedTemp);
      const cli = join(root, "cli");
      writeFileSync(
        cli,
        `#!/bin/bash
if [[ "$1" == --version ]]; then
  printf '2026.9.12\\n'
else
  printf '%s' "\${TMPDIR-<unset>}" > "$FIXTURE_ONBOARD"
fi
`,
        { mode: 0o755 },
      );
      const installTempPath = join(root, "install-temp");
      const refreshPath = join(root, "refresh-temp");
      const onboardPath = join(root, "onboard-temp");
      const callerPath = join(root, "caller-temp");
      const result = runInstallCliShell(
        `
        install_node() { printf '%s' "$TMPDIR" > "$FIXTURE_INSTALL_TEMP"; }
        ensure_git() { :; }
        install_openclaw() { mkdir -p "$PREFIX/bin"; cp "$FIXTURE_CLI" "$PREFIX/bin/openclaw"; }
        refresh_gateway_service_if_loaded() { printf '%s' "\${TMPDIR-<unset>}" > "$FIXTURE_REFRESH"; }
        main --onboard --prefix "$FIXTURE_PREFIX"
        printf '%s' "\${TMPDIR-<unset>}" > "$FIXTURE_CALLER"
        `,
        {
          HOME: root,
          TMPDIR: originallySet ? inheritedTemp : undefined,
          OPENCLAW_NO_ONBOARD: "0",
          FIXTURE_PREFIX: join(root, "prefix"),
          FIXTURE_CLI: cli,
          FIXTURE_INSTALL_TEMP: installTempPath,
          FIXTURE_REFRESH: refreshPath,
          FIXTURE_ONBOARD: onboardPath,
          FIXTURE_CALLER: callerPath,
        },
      );
      expect(result.status, result.stdout + result.stderr).toBe(0);
      const originalValue = originallySet ? inheritedTemp : "<unset>";
      for (const observedPath of [refreshPath, onboardPath, callerPath]) {
        expect(readFileSync(observedPath, "utf8")).toBe(originalValue);
      }
      const installTemp = readFileSync(installTempPath, "utf8");
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
    const tmp = tempDirs.make("openclaw-install-cli-disk-low-");
    const commandLog = join(tmp, "commands.log");
    const repo = join(tmp, "new", "openclaw");

    const result = runInstallCliShell(
      [
        "available_disk_kib() { printf '2097152\\n'; }",
        `install_node() { printf 'node\\n' >> ${JSON.stringify(commandLog)}; }`,
        `install_openclaw_from_git() { printf 'git\\n' >> ${JSON.stringify(commandLog)}; }`,
        `main --json --git --git-dir ${JSON.stringify(repo)}`,
      ].join("\n"),
    );

    expect(result.status).toBe(1);
    expect(existsSync(commandLog)).toBe(false);
    const events = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: string; name?: string; message?: string });
    expect(events).toEqual([
      { event: "step", name: "disk-space", status: "start" },
      {
        event: "error",
        message:
          "Fresh Git installs require at least 6 GiB of free disk space; only 2.0 GiB is available. Free disk space and retry.",
      },
    ]);
  });

  it("round-trips dynamic installer values through independent NDJSON records", () => {
    const root = tempDirs.make("openclaw-install-cli-json-events-");
    const dynamicValue = `quote"\\café项目lobster🦞${String.fromCharCode(
      ...Array.from({ length: 31 }, (_, index) => index + 1),
    )}end`;
    const repo = join(root, dynamicValue);
    const legacyDir = join(repo, "Peekaboo");
    const fakeNode = join(root, "node");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(fakeNode, '#!/bin/bash\nprintf "%s" "$EVENT_VALUE"\n');
    chmodSync(fakeNode, 0o755);

    const success = runInstallCliShell(
      [
        "JSON=1",
        'cleanup_legacy_submodules "$REPO"',
        "try_link_usable_node_runtime_from_path() { return 0; }",
        `node_bin() { printf '%s\\n' ${JSON.stringify(fakeNode)}; }`,
        "install_alpine_node",
        'emit_json done version "$EVENT_VALUE"',
      ].join("\n"),
      { EVENT_VALUE: dynamicValue, REPO: repo },
    );

    expect(success.status, success.stderr || success.stdout).toBe(0);
    expect(existsSync(legacyDir)).toBe(false);
    const successLines = success.stdout.trimEnd().split("\n");
    expect(successLines).toHaveLength(5);
    const successEvents = successLines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(successEvents).toEqual([
      { event: "step", name: "legacy-submodule", status: "start", path: legacyDir },
      { event: "step", name: "legacy-submodule", status: "ok", path: legacyDir },
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

  it("rejects a git checkout without a commit before updating it", () => {
    const result = runInstallCliShell(`
      set -euo pipefail
      tmp="$(mktemp -d)"
      repo="$tmp/repo"
      mkdir -p "$repo/.git"
      ensure_git() { :; }
      ensure_pnpm() { :; }
      git() {
        [[ "$1" == "--git-dir=$repo/.git" ]] &&
          [[ "$2" == "--work-tree=$repo" ]] &&
          [[ "$3" == "rev-parse" ]] &&
          [[ "$4" == "--verify" ]] &&
          [[ "$5" == "--quiet" ]] &&
          [[ "$6" == "HEAD^{commit}" ]] &&
          return 1
        return 99
      }

      set +e
      (install_openclaw_from_git "$repo")
      status="$?"
      set -e
      [[ "$status" -eq 1 ]]
      [[ -d "$repo/.git" ]]
    `);

    expect(result.status).toBe(0);
  });

  it("publishes fresh Git clones only after success and cleans failed staging directories", () => {
    const root = tempDirs.make("openclaw-install-cli-transactional-clone-");
    const result = runShell(
      createInstallGitCloneFixtureScript(SCRIPT_PATH, 'root="$ROOT"') +
        `
      clone_git_checkout_transactionally https://example.invalid/openclaw.git "$CONCURRENT_REPO"
    `,
      { ROOT: root },
    );

    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain("Git install dir appeared while cloning");
    expect(readFileSync(join(root, "concurrent", "user.marker"), "utf8")).toBe("keep\n");
    expect(existsSync(join(root, "concurrent", "checkout.marker"))).toBe(false);
    expect(readdirSync(root).filter((entry) => entry.startsWith(".openclaw-clone."))).toEqual([]);
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
      cleanup_legacy_submodules() { [[ "$1" == "$target" ]]; }
      ensure_pnpm_git_prepare_allowlist() { [[ "$1" == "$target" ]]; }
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

  it.each([17])(
    "uses the configured %s-second budget for curl connection and transfer stalls",
    (budget) => {
      const result = runInstallCliShell(`
      set -euo pipefail
      UPDATE_NETWORK_TIMEOUT_SECONDS=${budget}
      DOWNLOADER=curl
      curl() { printf '%s\n' "$*"; return 28; }
      set +e
      download_file "https://example.invalid/archive.tgz" "/tmp/archive.tgz"
      printf 'status=%s\n' "$?"
    `);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`--connect-timeout ${budget}`);
      expect(result.stdout).toContain(`--speed-limit 1 --speed-time ${budget}`);
      expect(result.stdout).toContain("--retry 3 --retry-delay 1 --retry-connrefused");
      expect(result.stdout).toContain("--proto =https");
      expect(result.stdout).toContain("--tlsv1.2");
      expect(result.stdout).not.toContain("--max-time");
      expect(result.stdout).toContain("status=28");
    },
  );

  it("bounds stalled downloads and propagates timeout failures", () => {
    const result = runInstallCliShell(`
      set -euo pipefail
      curl() {
        printf 'curl=%s\n' "$*"
        return 28
      }
      DOWNLOADER=curl
      set +e
      download_file "https://example.invalid/node.tar.gz" "/tmp/node.tar.gz"
      printf 'status=%s\n' "$?"
      wget() {
        printf 'wget=%s\n' "$*"
        return 4
      }
      DOWNLOADER=wget
      download_file "https://example.invalid/node.tar.gz" "/tmp/node.tar.gz"
      printf 'wget-status=%s\n' "$?"
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--speed-limit 1 --speed-time 300");
    expect(result.stdout).toContain("--connect-timeout 300");
    expect(result.stdout).not.toContain("--max-time");
    expect(result.stdout).toContain("--retry 3 --retry-delay 1 --retry-connrefused");
    expect(result.stdout).toContain("status=28");
    expect(result.stdout).toContain("--timeout=300");
    expect(result.stdout).toContain("wget-status=4");
  });

  it("matches the canonical release-label contract for installed Node runtimes", () => {
    expect(script).toContain("SELECT sqlite_version() AS version");
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

  it("rejects Linux ARMv7 before installing an explicitly requested Node", () => {
    const result = runInstallCliShell(`
      set -euo pipefail
      NODE_VERSION_REQUESTED=1
      os_detect() { printf 'linux\\n'; }
      arch_detect() { printf 'armv7l\\n'; }
      install_node() { printf 'unexpected-install\\n'; }
      main
    `);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "Linux ARMv7 is unsupported: official Node 24+ binaries are unavailable",
    );
    expect(result.stdout).not.toContain("unexpected-install");
  });

  it("rejects an explicitly requested vulnerable Node release", () => {
    const result = runInstallCliShell(`
      set -euo pipefail
      NODE_VERSION=24.14.1
      install_node linux x64
    `);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "Node 24.14.1 is unsupported; use Node 24.16.0+ or Node 26.1.0+.",
    );
    expect(result.stdout).not.toContain("Installing Node 24.14.1");
  });

  it("rejects installer options with missing values", () => {
    const result = runInstallCliShell(`
      set -euo pipefail
      parse_args --prefix --no-onboard
    `);

    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain("Missing value for --prefix");
    expect(result.stdout + result.stderr).not.toContain("unbound variable");
  });

  it.each([
    {
      method: "npm",
      candidate: "2026.7.1-2",
      message: "OpenClaw 2026.7.1-2 is older than config writer 2026.7.2",
    },
    {
      method: "git",
      candidate: "2026.7.1-2",
      message: "OpenClaw 2026.7.1-2 is older than config writer 2026.7.2",
    },
  ])(
    "rejects $method $candidate before replacing an existing managed CLI",
    ({ candidate, message, method }) => {
      const tmp = tempDirs.make("openclaw-install-cli-compatible-");
      const prefix = join(tmp, "prefix");
      const bin = join(prefix, "bin");
      const openclaw = join(bin, "openclaw");
      mkdirSync(bin, { recursive: true });
      writeFileSync(openclaw, "existing-managed-cli\n");
      const repo = join(tmp, "repo");
      mkdirSync(join(repo, ".git"), { recursive: true });
      writeFileSync(join(repo, "package.json"), JSON.stringify({ version: candidate }));

      const result = runInstallCliShell(`
      set -euo pipefail
      PREFIX=${JSON.stringify(prefix)}
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
        install_openclaw_from_git ${JSON.stringify(repo)}
      `
      }
    `);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain(message);
      expect(result.stderr).not.toContain("unexpected mutation");
      expect(readFileSync(openclaw, "utf8")).toBe("existing-managed-cli\n");
    },
  );

  it("reports runtime replacement without leaking paths or restarting again", () => {
    const root = tempDirs.make("openclaw-install-cli-refresh-");
    const prefix = join(root, "prefix"),
      commands = join(root, "commands");
    mkdirSync(join(prefix, "bin"), { recursive: true });
    writeShell(
      join(prefix, "bin", "openclaw"),
      `
      printf '%s\\n' "$*" >> "$COMMAND_LOG"
      if [[ "$*" == "gateway install --force" ]]; then
        printf '%s\\n' incidental-output-canary
        printf '%s\\n' 'Replacing unsupported Gateway service Node 22.23.1 (/old/node) with /new/node; refreshing the install.'
      fi
    `,
    );
    const result = runInstallCliShell(
      `
      PREFIX="$FIXTURE_PREFIX"
      is_gateway_daemon_loaded() { return 0; }
      refresh_gateway_service_if_loaded
    `,
      { COMMAND_LOG: commands, FIXTURE_PREFIX: prefix },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("Gateway service Node runtime replaced.");
    for (const privateValue of ["incidental-output-canary", "/old/node", "/new/node"]) {
      expect(result.stdout + result.stderr).not.toContain(privateValue);
    }
    expect(readFileSync(commands, "utf8").trim().split("\n")).toEqual([
      "gateway install --force",
      "gateway status --probe --json",
    ]);
  });

  it.each([
    { error: "SERVICE_DEFINITION_SEALED: protected", args: "--json", stream: "stdout" },
    { error: "SERVICE_DEFINITION_UNKNOWN: inaccessible", args: "--json", stream: "stderr" },
  ])("handles a traced $error refresh in $stream", ({ args, error, stream }) => {
    const root = tempDirs.make("openclaw-install-cli-definition-");
    const prefix = join(root, "prefix");
    const openclaw = join(prefix, "bin", "openclaw");
    const secretCanary = "installer-cli-secret-canary-never-render";
    const commandLog = join(root, "commands.log");
    mkdirSync(join(prefix, "bin"), { recursive: true });
    writeFileSync(
      openclaw,
      [
        "#!/bin/bash",
        'printf "%s\\n" "$*" >> "$COMMAND_LOG"',
        'if [[ "$1" == "--version" ]]; then printf "OpenClaw 2026.8.25\\n"; exit 0; fi',
        'if [[ "$*" == "gateway install --force" ]]; then',
        '  printf "%s\\n" "Replacing unsupported Gateway service Node 22.23.1 (/old/node) with /new/node; refreshing the install."',
        '  if [[ "$SERVICE_STREAM" == stdout ]]; then printf "%s\\n" "$SERVICE_ERROR"; else printf "%s\\n" "$SERVICE_ERROR" >&2; fi',
        '  printf "%s\\n" "$SECRET_CANARY" >&2; exit 1',
        "fi",
      ].join("\n"),
    );
    chmodSync(openclaw, 0o755);

    const result = runInstallCliShell(
      [
        "install_node() { :; }; ensure_git() { :; }; install_openclaw() { :; }",
        "is_gateway_daemon_loaded() { return 0; }",
        "set -x",
        `main ${args} --prefix ${JSON.stringify(prefix)}`,
      ].join("\n"),
      {
        COMMAND_LOG: commandLog,
        SECRET_CANARY: secretCanary,
        SERVICE_ERROR: error,
        SERVICE_STREAM: stream,
      },
    );

    expect(readFileSync(commandLog, "utf8").split("\n")).not.toContain("gateway restart");
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

  it.each([{ args: "--json", mode: "JSON" }])(
    "rejects a package without a runnable CLI in $mode mode before service refresh",
    ({ args }) => {
      const tmp = tempDirs.make("openclaw-install-cli-invalid-package-");
      const prefix = join(tmp, "prefix");
      const refreshLog = join(tmp, "gateway-refresh.log");

      const result = runInstallCliShell(
        [
          "npm_lifecycle_allow_arg() { :; }",
          'install_node() { mkdir -p "$(node_dir)/lib/node_modules/openclaw/dist"; : > "$(node_dir)/lib/node_modules/openclaw/dist/entry.js"; }',
          "ensure_git() { :; }",
          'npm_bin() { printf "/usr/bin/true\\n"; }',
          `refresh_gateway_service_if_loaded() { touch ${JSON.stringify(refreshLog)}; }`,
          `main ${args} --prefix ${JSON.stringify(prefix)} --version 0.0.0`,
        ].join("\n"),
      );

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("Installed OpenClaw CLI did not return a version");
      expect(result.stdout).not.toContain('"event":"done"');
      expect(result.stdout).not.toContain("OpenClaw installed.");
      expect(existsSync(refreshLog)).toBe(false);
    },
  );

  it.each([{ args: "--json", mode: "JSON" }])(
    "rejects a version command that prints output and fails in $mode mode before service refresh",
    ({ args }) => {
      const tmp = tempDirs.make("openclaw-install-cli-failed-version-");
      const prefix = join(tmp, "prefix");
      const bin = join(prefix, "bin");
      const openclaw = join(bin, "openclaw");
      const refreshLog = join(tmp, "gateway-refresh.log");
      mkdirSync(bin, { recursive: true });
      writeFileSync(openclaw, '#!/bin/bash\nprintf "OpenClaw 2026.8.1\\n"\nexit 1\n');
      chmodSync(openclaw, 0o755);

      const result = runInstallCliShell(
        [
          "install_node() { :; }",
          "ensure_git() { :; }",
          "install_openclaw() { :; }",
          `refresh_gateway_service_if_loaded() { touch ${JSON.stringify(refreshLog)}; }`,
          `main ${args} --prefix ${JSON.stringify(prefix)} --version 0.0.0`,
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
      const tmp = tempDirs.make(`openclaw-install-cli-relative-${method}-`);
      const installRoot = join(tmp, "install-root");
      const otherRoot = join(tmp, "other-root");
      const home = join(tmp, "home");
      const prefixInput = input === "literal tilde" ? "~/openclaw-local" : "openclaw-local";
      const prefix = join(input === "literal tilde" ? home : installRoot, "openclaw-local");
      const nodeDir = join(prefix, "tools", "node-v24.21.0");
      const repoInput = input === "literal tilde" ? "~/openclaw-source" : "openclaw-source";
      const repo = join(input === "literal tilde" ? home : installRoot, "openclaw-source");
      const legacy = join(home, "openclaw", "Peekaboo", "user.txt");
      mkdirSync(join(legacy, ".."), { recursive: true });
      writeFileSync(legacy, "keep this checkout");
      mkdirSync(installRoot, { recursive: true });
      mkdirSync(join(nodeDir, "bin"), { recursive: true });
      mkdirSync(join(nodeDir, "lib", "node_modules", "openclaw", "dist"), { recursive: true });
      mkdirSync(join(repo, ".git"), { recursive: true });
      mkdirSync(join(repo, "dist"), { recursive: true });
      mkdirSync(otherRoot, { recursive: true });
      symlinkSync(nodeExecutable, join(nodeDir, "bin", "node"));
      symlinkSync("node-v24.21.0", join(prefix, "tools", "node"));
      writeFileSync(
        join(nodeDir, "bin", "npm"),
        '#!/bin/bash\nif [[ "$1" == "--version" ]]; then printf "11.15.0\\n"; elif [[ "$1" == "config" ]]; then printf "null\\n"; fi\n',
      );
      chmodSync(join(nodeDir, "bin", "npm"), 0o755);
      for (const entry of [
        join(nodeDir, "lib", "node_modules", "openclaw", "dist", "entry.js"),
        join(repo, "dist", "entry.js"),
      ]) {
        writeFileSync(entry, 'console.log("fixture cli");\n');
      }

      const args =
        input !== "environment"
          ? `--prefix ${JSON.stringify(prefixInput)}${
              method === "git" ? ` --git-dir ${JSON.stringify(repoInput)}` : ""
            }`
          : "";
      const result = runShell(
        [
          "set -euo pipefail",
          `cd ${JSON.stringify(installRoot)}`,
          `source ${JSON.stringify(join(process.cwd(), SCRIPT_PATH))}`,
          "install_node() { :; }",
          "ensure_git() { :; }",
          "refresh_gateway_service_if_loaded() { :; }",
          ...(method === "git"
            ? [
                "preflight_fresh_git_disk_space() { :; }",
                "ensure_pnpm() { :; }",
                "ensure_pnpm_git_prepare_allowlist() { :; }",
                "cleanup_legacy_submodules() { :; }",
                "resolve_git_openclaw_ref() { printf 'main\\n'; }",
                "checkout_git_openclaw_ref() { :; }",
                "git_install_lockfile_flag() { printf '%s\\n' '--no-frozen-lockfile'; }",
                "run_pnpm() { :; }",
                "git() { return 0; }",
              ]
            : []),
          `main --${method} ${args}`,
          `cd ${JSON.stringify(otherRoot)}`,
          `${JSON.stringify(join(prefix, "bin", "openclaw"))} --version`,
        ].join("\n"),
        {
          HOME: home,
          OPENCLAW_HOME: home,
          OPENCLAW_GIT_DIR: undefined,
          OPENCLAW_PREFIX: input === "environment" ? prefixInput : undefined,
        },
      );

      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(readFileSync(legacy, "utf8")).toBe("keep this checkout");
      expect(result.stdout.trim().split("\n").at(-1)).toBe("fixture cli");
    },
  );

  it.each(["bundle", "remote"] as const)("pins a full commit from a %s", (source) => {
    const result = runShell(createInstallGitCommitFixtureScript(source), {
      OPENCLAW_INSTALLER_SCRIPT: SCRIPT_PATH,
    });

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("kind=immutable");
    expect(result.stdout).toContain("rejected=HEAD~1");
  });

  it("prefers a release tag over a same-named branch", () => {
    const result = runShell(createInstallGitTagPreferenceFixtureScript(SCRIPT_PATH));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("kind=immutable");
    expect(result.stdout).toContain("selected=");
  });

  it("falls back to a v-prefixed branch when no matching release tag exists", () => {
    const result = runShell(createInstallGitBranchFallbackFixtureScript(SCRIPT_PATH));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("kind=moving");
    expect(result.stdout).toContain("selected=");
  });

  it("updates a stale existing main checkout from the remote tracking ref", () => {
    const result = runShell(createInstallGitUpdateFixtureScript(SCRIPT_PATH));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("head=");
    expect(result.stdout).toContain("tracking=");
    expect(result.stdout).toContain("remote=");
  });

  it("restores an existing main checkout after a failed rebase", () => {
    const result = runShell(createInstallGitRebaseRecoveryFixtureScript(SCRIPT_PATH));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("recovery=head-restored status-clean rebase-state-cleared");
  });

  it("verifies unchanged state when a hook refuses rebase before it starts", () => {
    const result = runShell(createInstallGitHookRefusalFixtureScript(SCRIPT_PATH));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "hook-refusal=head-verified status-verified rebase-state-absent",
    );
  });

  it.each([
    ["corepack", "12.0.0", ""],
    ["corepack", "12.0.0", "install"],
    ["failing", "11.15.1", "build"],
  ])("keeps selected pnpm through nested builds (%s, %s, failure=%s)", (mode, version, failure) => {
    const tmp = tempDirs.make("openclaw-install-pnpm-boundary-");
    const bin = join(tmp, "bin"),
      repo = join(tmp, "repo"),
      outer = join(tmp, "outer"),
      temp = join(tmp, "temp");
    for (const dir of [bin, repo, outer, temp]) {
      mkdirSync(dir);
    }
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ packageManager: `pnpm@${version}` }),
    );
    writeFileSync(join(repo, "pnpm-lock.yaml"), "unchanged lock\n");
    writeFileSync(join(outer, "package.json"), '{"packageManager":"yarn@4.5.0"}');
    linkPnpmBootstrapShellTools(bin);
    symlinkSync(nodeExecutable, join(bin, "node"));
    const executable = (name: string, body: string) =>
      writeShell(join(bin, name), `set -eu\n${body}`);
    executable(
      "pnpm",
      `
      echo "$*" >> "$FIXTURE/ambient.log"
      echo corrupted > "$TARGET/pnpm-lock.yaml"
      if [[ "$1" == --version ]]; then echo "$VERSION"; fi
    `,
    );
    executable(
      "selected",
      `
      [[ "\${COREPACK_ENABLE_DOWNLOAD_PROMPT:-}" == 0 ]] || { echo "Corepack would await terminal input" >&2; exit 91; }
      [[ -z "\${CI:-}" && "$PWD" == "$TARGET" ]]
      [[ "$NPM_CONFIG_WORKSPACE_DIR" == "$TARGET" && "$npm_config_workspace_dir" == "$TARGET" ]]
      [[ "$PNPM_CONFIG_LOCKFILE_DIR" == "$TARGET" && "$pnpm_config_lockfile_dir" == "$TARGET" ]]
      case "$1" in
        --version) echo "$VERSION" ;;
        config) echo undefined ;;
        install) [[ "$2" == --frozen-lockfile ]]; echo install >> "$FIXTURE/steps"; [[ "$FAILURE" != install ]] || exit 42 ;;
        build) echo build >> "$FIXTURE/steps"; pnpm nested ;;
        nested) [[ "$FAILURE" != build ]] || exit 42; echo "nested:$VERSION" >> "$FIXTURE/steps" ;;
        *) exit 90 ;;
      esac
    `,
    );
    executable(
      "npm",
      `
      if [[ "$1" == --version ]]; then echo 12.0.0; exit; fi
      [[ "$1 $2 $3" == 'install -g --prefix' ]]
      [[ "$4" == "$FIXTURE/"* && "$4" != "$TARGET" ]]
      [[ "$5" == "pnpm@$VERSION" && "$6" == "--allow-scripts=pnpm@$VERSION" ]]
      mkdir -p "$4/bin"
      cp "$FIXTURE/bin/selected" "$4/bin/pnpm"
      echo "$4" > "$FIXTURE/npm-prefix"
    `,
    );
    executable(
      "corepack",
      `
      [[ "$1 $2" == 'enable --install-directory' && "$4" == pnpm ]]
      [[ "$3" == "$FIXTURE/"* ]]
      cp "$FIXTURE/bin/selected" "$3/pnpm"
      ${mode === "failing" ? 'echo "#!/bin/bash" > "$3/pnpm"; echo "exit 1" >> "$3/pnpm"' : ":"}
    `,
    );
    const result = runInstallCliShell(
      `
      unset CI
      PREFIX="$FIXTURE/prefix"
      node_bin() { printf '%s\\n' "$FIXTURE/bin/node"; }
      npm_bin() { printf '%s\\n' "$FIXTURE/bin/npm"; }
      cd "$FOREIGN"
      ensure_pnpm "$TARGET"
      run_pnpm -C "$TARGET" config get prefer-offline
      run_pnpm -C "$TARGET" install --frozen-lockfile
      run_pnpm -C "$TARGET" build
      [[ "$NPM_CONFIG_WORKSPACE_DIR" == "$FOREIGN" && "$npm_config_workspace_dir" == "$FOREIGN" ]]
      [[ "$PNPM_CONFIG_LOCKFILE_DIR" == "$FOREIGN" && "$pnpm_config_lockfile_dir" == "$FOREIGN" ]]
      [[ "$(command -v pnpm)" == "$FIXTURE/bin/pnpm" && "$COREPACK_ENABLE_DOWNLOAD_PROMPT" == 1 ]]
      echo completed
    `,
      {
        PATH: bin,
        COREPACK_ENABLE_DOWNLOAD_PROMPT: "1",
        TMPDIR: temp,
        HOME: tmp,
        FIXTURE: tmp,
        TARGET: repo,
        FOREIGN: outer,
        VERSION: version,
        FAILURE: failure,
        NPM_CONFIG_WORKSPACE_DIR: outer,
        npm_config_workspace_dir: outer,
        PNPM_CONFIG_LOCKFILE_DIR: outer,
        pnpm_config_lockfile_dir: outer,
      },
    );
    expect(result.status, result.stdout + result.stderr).toBe(failure ? 42 : 0);
    expect(readFileSync(join(repo, "pnpm-lock.yaml"), "utf8")).toBe("unchanged lock\n");
    expect(existsSync(join(tmp, "ambient.log"))).toBe(false);
    expect(result.stdout.includes("completed")).toBe(!failure);
    expect(readFileSync(join(tmp, "steps"), "utf8").trim().split("\n")).toEqual(
      failure === "install"
        ? ["install"]
        : failure === "build"
          ? ["install", "build"]
          : ["install", "build", `nested:${version}`],
    );
    expect(existsSync(join(tmp, "npm-prefix"))).toBe(mode !== "corepack");
    expect(readdirSync(temp)).toEqual([]);
  });

  it.each([false, true])("replaces an unusable musl runtime (apk required: %s)", (useApk) => {
    const root = tempDirs.make("openclaw-install-cli-alpine-");
    const bin = join(root, "bin");
    const oldBin = join(root, "old-bin");
    const prefix = join(root, "prefix");
    const managedBin = join(prefix, "tools", "node-v24.16.0", "bin");
    const apkLog = join(root, "apk.log");
    const state = join(root, "node-state");
    for (const path of [bin, oldBin, managedBin]) {
      mkdirSync(path, { recursive: true });
    }
    linkRequiredShellTools(bin);
    writeNodeFixture(join(managedBin, "node"), "v24.16.0", 1);
    writeNodeFixture(join(oldBin, "node"), "v18.20.0", 1);
    writeShell(join(oldBin, "npm"), "exit 0");
    writeShell(join(bin, "npm"), "exit 0");
    writeShell(
      join(bin, "apk"),
      `
      printf '%s\\n' "$*" >> "$APK_LOG"
      ${useApk ? 'printf new > "$NODE_STATE"' : "exit 99"}
    `,
    );
    if (useApk) {
      writeShell(
        join(bin, "node"),
        `
        if [[ "\${1:-}" == -v ]]; then
          if [[ -f "$NODE_STATE" ]]; then printf 'v24.16.0\\n'; else printf 'v18.20.0\\n'; fi
        elif [[ "\${1:-}" == -e ]]; then [[ -f "$NODE_STATE" ]]; exit $?; fi
        exit 0
      `,
      );
    } else {
      writeNodeFixture(join(bin, "node"), "v24.16.0");
    }
    const result = runInstallCliShell(
      `
      export PATH="$FIXTURE_PATH"
      is_musl_linux() { return 0; }
      is_root() { return ${useApk ? 0 : 1}; }
      PREFIX="$FIXTURE_PREFIX"
      APK_NODE_BIN_DIR="$FIXTURE_BIN"
      NODE_VERSION=24.16.0
      install_node linux x64
    `,
      {
        APK_LOG: apkLog,
        NODE_STATE: state,
        FIXTURE_PATH: `${managedBin}:${oldBin}:${bin}`,
        FIXTURE_PREFIX: prefix,
        FIXTURE_BIN: bin,
      },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout.includes("Installing Node via apk")).toBe(useApk);
    if (useApk) {
      expect(readFileSync(apkLog, "utf8")).toContain("add --no-cache nodejs npm");
    } else {
      expect(existsSync(apkLog)).toBe(false);
    }
    for (const tool of ["node", "npm"]) {
      expect(lstatSync(join(managedBin, tool)).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(managedBin, tool))).toBe(join(bin, tool));
    }
  });

  it("skips PATH runtimes whose npm cannot start and invokes npm with the selected Node", () => {
    const root = tempDirs.make("openclaw-install-cli-broken-npm-");
    const bad = join(root, "bad");
    const good = join(root, "good");
    const prefix = join(root, "prefix");
    mkdirSync(bad);
    mkdirSync(good);
    symlinkSync(nodeExecutable, join(bad, "node"));
    writeShell(join(bad, "npm"), 'printf "%s\\n" "$*" >> "$BAD_NPM_LOG"\nexit 42');
    writeShell(
      join(good, "node"),
      `printf '%s\\n' "$*" >> "$GOOD_NODE_LOG"\nexec ${JSON.stringify(nodeExecutable)} "$@"`,
    );
    writeFileSync(
      join(good, "npm"),
      '#!/usr/bin/env node\nrequire("node:fs").appendFileSync(process.env.GOOD_NPM_LOG, `${process.argv.slice(2).join(" ")}\\n`);\n',
      { mode: 0o755 },
    );
    const logs = {
      BAD_NPM_LOG: join(root, "bad.log"),
      GOOD_NODE_LOG: join(root, "node.log"),
      GOOD_NPM_LOG: join(root, "good.log"),
    };
    const result = runInstallCliShell(
      `
      export PATH="$FIXTURE_PATH"
      PREFIX="$FIXTURE_PREFIX"
      try_link_usable_node_runtime_from_path
    `,
      { ...logs, FIXTURE_PATH: `${bad}:${good}:${process.env.PATH ?? ""}`, FIXTURE_PREFIX: prefix },
    );
    expect(result.status).toBe(0);
    expect(readFileSync(logs.BAD_NPM_LOG, "utf8")).toBe("--version\n");
    expect(readFileSync(logs.GOOD_NPM_LOG, "utf8")).toBe("--version\n");
    expect(readFileSync(logs.GOOD_NODE_LOG, "utf8")).toContain("npm --version");
    const bin = join(prefix, "tools", "node-v24.21.0", "bin");
    expect(lstatSync(join(bin, "node")).isSymbolicLink()).toBe(true);
    for (const tool of ["node", "npm"]) {
      expect(readlinkSync(join(bin, tool))).toBe(join(good, tool));
    }
  });

  it.each([
    { route: "path", failure: "version" },
    { route: "path", failure: "npm" },
    { route: "apk", failure: "sqlite" },
  ])("preserves the active runtime when $route rejects $failure", ({ route, failure }) => {
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
    if (failure === "version") {
      writeFileSync(join(bin, "node"), "#!/bin/bash\nprintf 'v22.18.0\\n'\n", {
        mode: 0o755,
      });
    } else if (failure === "sqlite") {
      writeFileSync(
        join(bin, "node"),
        '#!/bin/bash\nif [[ "$1" == -e ]]; then exit 1; fi\nexec "$FIXTURE_NODE" "$@"\n',
        { mode: 0o755 },
      );
    } else {
      symlinkSync(nodeExecutable, join(bin, "node"));
    }
    writeFileSync(join(bin, "npm"), `#!/bin/bash\nexit ${failure === "npm" ? 42 : 0}\n`, {
      mode: 0o755,
    });
    const result = runInstallCliShell(
      `
      PREFIX="$FIXTURE_PREFIX"
      PATH="$FIXTURE_BIN"
      export PATH
      APK_NODE_BIN_DIR="$FIXTURE_BIN"
      is_root() { return 0; }
      apk() { printf 'apk called\\n'; }
      ${route === "path" ? "try_link_usable_node_runtime_from_path" : "install_alpine_node"}
      `,
      { FIXTURE_PREFIX: prefix, FIXTURE_BIN: bin, FIXTURE_NODE: nodeExecutable },
    );
    expect(result.status, result.stdout + result.stderr).toBe(1);
    if (route === "apk") {
      expect(result.stdout).toContain("apk called");
      expect(result.stdout).toContain("Alpine Node package must provide Node >=");
    }
    expect(readlinkSync(join(prefix, "tools", "node"))).toBe(oldRuntime);
    expect(readlinkSync(join(oldRuntime, "bin", "node"))).toBe(nodeExecutable);
    expect(existsSync(join(prefix, "tools", "node-v24.21.0"))).toBe(false);
  });

  it("excludes active runtime aliases reached through an empty PATH entry", () => {
    const root = tempDirs.make("openclaw-install-cli-runtime-alias-");
    const bin = join(root, "system-bin"),
      prefix = join(root, "prefix"),
      old = join(root, "old-runtime");
    const oldBin = join(old, "bin"),
      alias = join(root, "alias-bin");
    mkdirSync(bin);
    mkdirSync(oldBin, { recursive: true });
    linkRequiredShellTools(bin);
    for (const target of [bin, oldBin]) {
      symlinkSync(nodeExecutable, join(target, "node"));
      writeShell(join(target, "npm"), "exit 0");
    }
    for (const tool of ["npx", "corepack"]) {
      writeShell(join(oldBin, tool), "exit 0");
    }
    mkdirSync(join(prefix, "tools"), { recursive: true });
    symlinkSync(old, join(prefix, "tools", "node"));
    symlinkSync(join(prefix, "tools", "node", "bin"), alias);
    const result = runInstallCliShell(
      `
      PREFIX="$FIXTURE_PREFIX"
      cd "$FIXTURE_ALIAS"
      export PATH=":$FIXTURE_BIN"
      try_link_usable_node_runtime_from_path
    `,
      { FIXTURE_PREFIX: prefix, FIXTURE_ALIAS: alias, FIXTURE_BIN: bin },
    );
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

  it.each(["bin dir"])("publishes usable runtime links for relative PATH entry %j", (pathEntry) => {
    const root = tempDirs.make("openclaw-install-cli-relative-runtime-");
    const source = join(root, "source dir");
    const bin = join(source, pathEntry || ".");
    const optional = join(source, "tools dir");
    const fallback = join(root, "fallback");
    const elsewhere = join(root, "elsewhere");
    const prefix = join(root, "prefix");
    mkdirSync(bin, { recursive: true });
    mkdirSync(optional);
    mkdirSync(fallback);
    mkdirSync(elsewhere);
    linkRequiredShellTools(fallback);
    for (const [target, version] of [
      [bin, "11.19.1"],
      [fallback, "11.19.2"],
    ] as const) {
      symlinkSync(nodeExecutable, join(target, "node"));
      writeFileSync(
        join(target, "npm"),
        `#!/usr/bin/env node\nconsole.log(${JSON.stringify(version)});\n`,
        { mode: 0o755 },
      );
    }
    for (const tool of ["npx", "corepack"]) {
      writeFileSync(join(optional, tool), `#!/bin/bash\nprintf '${tool}-ok\\n'\n`, {
        mode: 0o755,
      });
    }
    const result = runInstallCliShell(
      `
        PREFIX="$FIXTURE_PREFIX"
        cd "$FIXTURE_SOURCE"
        PATH="$FIXTURE_PATH:tools dir:$FIXTURE_FALLBACK"
        export PATH
        try_link_usable_node_runtime_from_path
        cd "$FIXTURE_ELSEWHERE"
        PATH="$PREFIX/tools/node/bin:$FIXTURE_FALLBACK"
        "$PREFIX/tools/node/bin/node" -p '"node-ok"'
        "$PREFIX/tools/node/bin/npm" --version
        "$PREFIX/tools/node/bin/npx"
        "$PREFIX/tools/node/bin/corepack"
        `,
      {
        FIXTURE_PREFIX: prefix,
        FIXTURE_SOURCE: source,
        FIXTURE_PATH: pathEntry,
        FIXTURE_FALLBACK: fallback,
        FIXTURE_ELSEWHERE: elsewhere,
      },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("node-ok\n11.19.1\nnpx-ok\ncorepack-ok");
    for (const tool of ["node", "npm", "npx", "corepack"]) {
      expect(readlinkSync(join(prefix, "tools", "node", "bin", tool))).toMatch(/^\//);
    }
  });

  it.each(
    ["command", "runtime"].flatMap((route) =>
      ["empty", "trailing"].map((order) => ({ route, order })),
    ),
  )("preserves PATH lookup order for $route with $order entries", ({ route, order }) => {
    const root = tempDirs.make("openclaw-install-cli-path-order-");
    const current = join(root, "current");
    const other = join(root, "other");
    const prefix = join(root, "prefix");
    for (const bin of [current, other]) {
      mkdirSync(bin);
      linkRequiredShellTools(bin);
      if (bin === other && order === "trailing") {
        continue;
      }
      symlinkSync(nodeExecutable, join(bin, "node"));
      writeFileSync(
        join(bin, "npm"),
        `#!/bin/bash\nprintf '${bin === current ? "current" : "other"}-npm\\n'\n`,
        { mode: 0o755 },
      );
    }
    const search = order === "empty" ? "" : `${other}:`;
    const result = runInstallCliShell(
      `
      PREFIX="$FIXTURE_PREFIX"
      cd "$FIXTURE_CURRENT"
      PATH="$FIXTURE_SEARCH"
      export PATH
      ${route === "command" ? 'selected="$(command_path_without_node_prefix npm)"' : 'try_link_usable_node_runtime_from_path; selected="$(npm_bin)"'}
      "$selected" --version
      `,
      { FIXTURE_PREFIX: prefix, FIXTURE_CURRENT: current, FIXTURE_SEARCH: search },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("current-npm");
  });

  it("does not invent a cwd search after filtering an empty managed PATH entry", () => {
    const root = tempDirs.make("openclaw-install-cli-filtered-path-");
    const prefix = join(root, "prefix"),
      managed = join(prefix, "tools", "node-v24.21.0", "bin");
    mkdirSync(managed, { recursive: true });
    writeShell(join(managed, "npm"), "exit 0");
    const result = runInstallCliShell(
      `
      PREFIX="$FIXTURE_PREFIX"
      cd "$FIXTURE_MANAGED"
      export PATH=""
      command_path_without_node_prefix npm 1
    `,
      { FIXTURE_PREFIX: prefix, FIXTURE_MANAGED: managed },
    );
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toBe("");
  });

  it("preserves the active runtime until a downloaded replacement starts, then permits retry", () => {
    const root = tempDirs.make("openclaw-install-cli-node-retry-");
    const prefix = join(root, "prefix");
    const oldRuntime = join(prefix, "tools", "node-v22.23.2");
    const active = join(prefix, "tools", "node");
    const packageFile = join(oldRuntime, "lib", "node_modules", "openclaw", "package.json");
    mkdirSync(join(oldRuntime, "bin"), { recursive: true });
    mkdirSync(join(packageFile, ".."), { recursive: true });
    writeNodeFixture(join(oldRuntime, "bin", "node"), "v22.23.2");
    writeFileSync(packageFile, '{"name":"openclaw","version":"2026.9.2"}\n');
    symlinkSync(oldRuntime, active);
    const node = join(root, "new-node");
    writeShell(node, "exit 126");
    const install = () =>
      runInstallCliShell(
        `
      is_musl_linux() { return 1; }
      detect_downloader() { :; }
      require_bin() { :; }
      download_file() {
        case "$1" in
          */SHASUMS256.txt) printf 'fixture-sha  node-v24.16.0-linux-x64.tar.gz\\n' > "$2" ;;
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
        cp "$NEW_NODE" "$dest/bin/node"
        printf '#!/bin/bash\\nexit 0\\n' > "$dest/bin/npm"
        chmod +x "$dest/bin/npm"
      }
      PREFIX="$FIXTURE_PREFIX"
      NODE_VERSION=24.16.0
      install_node linux x64
    `,
        { NEW_NODE: node, FIXTURE_PREFIX: prefix },
      );
    const failed = install();
    expect(failed.status).toBe(1);
    expect(failed.stdout).toContain(
      "Installed Node 24.16.0 must provide Node >= 24.16.0 with WAL-reset-safe SQLite",
    );
    expect(failed.stdout).toContain("found Node unknown, SQLite unavailable");
    expect(readlinkSync(active)).toBe(oldRuntime);
    expect(spawnSync(join(active, "bin", "node"), ["-v"], { encoding: "utf8" }).stdout).toBe(
      "v22.23.2\n",
    );
    expect(readFileSync(packageFile, "utf8")).toBe('{"name":"openclaw","version":"2026.9.2"}\n');
    writeNodeFixture(node, "v24.16.0");
    const retried = install();
    expect(retried.status, retried.stdout + retried.stderr).toBe(0);
    expect(readlinkSync(active)).toBe(join(prefix, "tools", "node-v24.16.0"));
    expect(spawnSync(join(active, "bin", "node"), ["-v"], { encoding: "utf8" }).stdout).toBe(
      "v24.16.0\n",
    );
    expect(readFileSync(packageFile, "utf8")).toBe('{"name":"openclaw","version":"2026.9.2"}\n');
  });

  it("removes the workspace rewrite temp file when rewriting fails", () => {
    const tmp = tempDirs.make("openclaw-install-cli-workspace-cleanup-");
    const repo = join(tmp, "repo");
    const workspaceFile = join(repo, "pnpm-workspace.yaml");
    const rewriteTemp = join(tmp, "workspace-rewrite");
    const workspace = 'packages:\n  - "packages/*"\n\nallowBuilds:\n';
    mkdirSync(repo, { recursive: true });
    writeFileSync(workspaceFile, workspace);

    const result = runInstallCliShell(
      [
        `mktemp() { : > ${JSON.stringify(rewriteTemp)}; printf '%s\\n' ${JSON.stringify(rewriteTemp)}; }`,
        "awk() { return 43; }",
        `ensure_pnpm_git_prepare_allowlist ${JSON.stringify(repo)}`,
      ].join("\n"),
    );

    expect(result.status).toBe(43);
    expect(() => lstatSync(rewriteTemp)).toThrow();
    expect(readFileSync(workspaceFile, "utf8")).toBe(workspace);
  });

  it.each([
    { expected: "", version: "11.15.0" },
    { expected: "--allow-scripts=openclaw", version: "11.16.0" },
  ])("resolves npm lifecycle policy for npm $version", ({ expected, version }) => {
    const fixture = npmPolicyFixture();
    const result = fixture.run("openclaw@latest", version);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(expected);
    const tool = fixture.run("pnpm@12.0.0", version, "pnpm@12.0.0");
    expect(tool.status).toBe(0);
    expect(tool.stdout).toBe(expected ? "--allow-scripts=pnpm@12.0.0" : "");
  });

  it("rejects a malformed npm version before mutation", () => {
    const fixture = npmPolicyFixture();
    expect(fixture.run("openclaw@latest", "npm 12.0.0 warning").status).not.toBe(0);
    expect(existsSync(fixture.args)).toBe(false);
  });

  it.each([
    ["openclaw@npm:@scope/candidate.tgz@1.0.0", "--allow-scripts=@scope/candidate.tgz"],
    ["vendor/repo.tgz", "--allow-scripts=vendor/repo.tgz"],
    [
      "https://example.invalid/openclaw.tgz",
      "--allow-scripts=https://example.invalid/openclaw.tgz",
    ],
  ])("uses npm-resolved lifecycle identity for %s", (spec, expected) => {
    const result = npmPolicyFixture().run(spec, "12.0.0");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(expected);
  });

  it("uses the absolute npm tarball identity for file-relative input", () => {
    const fixture = npmPolicyFixture();
    const result = fixture.run("file:./candidate.tgz", "12.0.0");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      `--allow-scripts=file:${join(fixture.root, "candidate.tgz")}`,
    );
  });

  it.each([
    { version: "11.16.0", advisory: true },
    { version: "12.0.0", advisory: false },
  ])(
    "handles comma tarball identity under npm $version before mutation",
    ({ version, advisory }) => {
      const fixture = npmPolicyFixture("openclaw-install-cli-comma,");
      const result = fixture.run(join(fixture.root, "candidate.tgz"), version);
      expect(result.status).toBe(advisory ? 0 : 1);
      if (advisory) {
        expect(result.stdout).toBe("--allow-scripts=./candidate.tgz");
      } else {
        expect(result.stderr).toContain("without commas");
      }
      expect(existsSync(fixture.args)).toBe(false);
    },
  );

  defineInstallerNpmDirectoryIdentityContract(installerContract);

  it.each(["global", "builtin"])(
    "honors raw %s npmrc min-release-age before --before",
    (source) => {
      const root = tempDirs.make("openclaw-install-cli-npmrc-");
      const bin = join(root, "bin"),
        nodeDir = join(root, "node"),
        home = join(root, "home");
      const npmrc = join(root, source === "global" ? "etc/npmrc" : "npmrc");
      const npm = join(bin, "npm"),
        args = join(root, "args"),
        calls = join(root, "calls");
      for (const dir of [
        bin,
        home,
        join(root, "etc"),
        join(nodeDir, "bin"),
        join(nodeDir, "lib/node_modules/openclaw/dist"),
      ]) {
        mkdirSync(dir, { recursive: true });
      }
      symlinkSync(nodeExecutable, join(nodeDir, "bin", "node"));
      writeFileSync(join(nodeDir, "lib/node_modules/openclaw/dist/entry.js"), "");
      writeFileSync(npmrc, "min-release-age=7\n");
      writeNpmRawConfigFixture(npm, { prefixInstaller: true, globalConfig: true, logCalls: true });
      const result = runInstallCliShell(
        `
      npm_lifecycle_allow_arg() { :; }
      npm_bin() { printf '%s\\n' "$FIXTURE_NPM"; }
      node_dir() { printf '%s\\n' "$FIXTURE_NODE_DIR"; }
      emit_json() { :; }
      log() { :; }
      PREFIX="$FIXTURE_PREFIX"
      SET_NPM_PREFIX=0
      OPENCLAW_VERSION=1.2.3
      install_openclaw
    `,
        {
          HOME: home,
          PATH: `${bin}:${process.env.PATH}`,
          FIXTURE_NPM: npm,
          FIXTURE_NODE_DIR: nodeDir,
          FIXTURE_PREFIX: join(root, "prefix"),
          NPM_CONFIG_GLOBALCONFIG: undefined,
          NPM_CONFIG_PREFIX: undefined,
          npm_config_globalconfig: undefined,
          npm_config_prefix: undefined,
          NPM_FAKE_GLOBALCONFIG: source === "global" ? npmrc : join(root, "missing-npmrc"),
          NPM_FAKE_CALLS: calls,
          NPM_FAKE_INSTALL_ARGS: args,
        },
      );
      expect(result.status).toBe(0);
      expect(readFileSync(args, "utf8")).toContain("--min-release-age=0\n");
      expect(readFileSync(args, "utf8")).not.toContain("--before=");
      expect(readFileSync(calls, "utf8")).not.toContain("config get before");
    },
  );

  it.each(["linux"])("rejects OpenClaw GitHub source targets for npm installs on %s", (os) => {
    const result = runInstallCliShell(`
      set -euo pipefail
      os_detect() { printf '${os}\\n'; }
      OPENCLAW_VERSION=main
      install_openclaw
    `);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("npm installs do not support OpenClaw GitHub source targets");
    expect(result.stdout).toContain("--install-method git --version main");
  });

  it.each([
    { requested: "beta", outcome: "transient", produced: true, status: 0 },
    { requested: "latest", outcome: "persistent", produced: true, status: 1 },
    { requested: "latest", outcome: "success", produced: false, status: 1 },
  ])(
    "keeps the requested npm spec across $outcome installs (package: $produced)",
    ({ requested, outcome, produced, status }) => {
      const root = tempDirs.make("openclaw-install-npm-retry-");
      const prefix = join(root, "prefix"),
        nodeDir = join(root, "node"),
        calls = join(root, "calls"),
        npm = join(root, "npm");
      mkdirSync(join(nodeDir, "bin"), { recursive: true });
      symlinkSync(nodeExecutable, join(nodeDir, "bin", "node"));
      writeNpmInstallRetryFixture(npm);
      const result = runInstallCliShell(
        `
      npm_bin() { printf '%s\\n' "$FIXTURE_NPM"; }
      node_dir() { printf '%s\\n' "$FIXTURE_NODE_DIR"; }
      npm_config_has_raw_key() { return 1; }
      PREFIX="$FIXTURE_PREFIX"
      JSON=1
      OPENCLAW_VERSION=${requested}
      install_openclaw
    `,
        {
          FIXTURE_NPM: npm,
          FIXTURE_NODE_DIR: nodeDir,
          FIXTURE_PREFIX: prefix,
          NPM_FAKE_CALLS: calls,
          NPM_FAKE_ERROR: "EACCES permission denied",
          NPM_FAKE_OUTCOME: outcome,
          NPM_FAKE_PACKAGE_DIR: produced
            ? join(nodeDir, "lib", "node_modules", "openclaw")
            : undefined,
        },
      );
      expect(result.status).toBe(status);
      expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual([
        `openclaw@${requested}`,
        `openclaw@${requested}`,
      ]);
      expect(result.stdout + result.stderr).not.toContain("openclaw@next");
      if (status !== 0) {
        expect(result.stdout).not.toContain('"status":"ok"');
        expect(existsSync(join(prefix, "bin", "openclaw"))).toBe(false);
        if (produced) {
          expect(result.stderr).toContain("EACCES permission denied (attempt 2)");
        } else {
          expect(result.stdout).toContain("npm install did not produce a usable OpenClaw package");
        }
      }
    },
  );

  defineInstallerNpmFreshnessContract(installerContract);
});
