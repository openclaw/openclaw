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
import { writeNpmLifecycleFixture } from "./install-npm-fixtures.js";
import { findDarwinReexecBash } from "./install-reexec-fixtures.js";
import {
  defineInstallerNpmConfigContract,
  defineInstallerNpmArchiveIdentityContract,
  defineInstallerNpmDirectoryIdentityContract,
  defineInstallerNpmRetryContract,
  defineInstallerNpmFreshnessContract,
  defineInstallerPnpmContract,
  defineInstallerShellIsolationContract,
} from "./install-test-contract.js";

const SCRIPT_PATH = "scripts/install-cli.sh";
const nodeExecutable = requireNodeTool("node");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function runInstallCliShell(script: string, env: NodeJS.ProcessEnv = {}) {
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

function linkRequiredShellTools(bin: string) {
  for (const tool of ["ln", "mkdir"]) {
    symlinkSync(`/bin/${tool}`, join(bin, tool));
  }
}

function writeNodeFixture(filePath: string, version: string, sqliteExit = 0) {
  writeFileSync(
    filePath,
    `#!/bin/bash
if [[ "\${1:-}" == "-v" ]]; then
  printf '%s\\n' '${version}'
elif [[ "\${1:-}" == "-e" ]]; then
  exit ${sqliteExit}
fi
exit 0
`,
  );
}

describe("install-cli.sh", () => {
  const script = readFileSync(SCRIPT_PATH, "utf8");
  const installerContract = {
    scriptPath: SCRIPT_PATH,
    runShell: runInstallCliShell,
    nodeExecutable,
    prefix: true,
    createTempDir: (prefix: string) => tempDirs.make(prefix),
  };

  defineInstallerShellIsolationContract(installerContract);

  it("installs only Node into the requested prefix without entering package or service setup", () => {
    const result = runInstallCliShell(`
      source ${SCRIPT_PATH}
      is_musl_linux() { return 1; }
      os_detect() { echo linux; }
      arch_detect() { echo x64; }
      install_node() { printf 'node:%s:%s:%s\\n' "$1" "$2" "$PREFIX"; }
      preflight_fresh_git_disk_space() { exit 91; }
      install_openclaw_from_git() { exit 92; }
      install_openclaw() { exit 93; }
      refresh_gateway_service_if_loaded() { exit 94; }
      main --node-only --prefix '/tmp/private node' --git --onboard
    `);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("node:linux:x64:/tmp/private node");
  });

  it.each([false, true])(
    "keeps browser runtime-only installation free of service and onboarding effects (runtimeOnly=%s)",
    (runtimeOnly) => {
      const root = tempDirs.make("openclaw-browser-runtime-install-");
      const prefix = join(root, "private-runtime");
      const commandLog = join(root, "commands.log");
      mkdirSync(join(prefix, "bin"), { recursive: true });
      writeFileSync(
        join(prefix, "bin", "openclaw"),
        [
          "#!/bin/bash",
          'printf "%s\\n" "$*" >> "$COMMAND_LOG"',
          'if [[ "$1" == --version ]]; then printf "OpenClaw 2026.9.4\\n"; fi',
        ].join("\n"),
        { mode: 0o755 },
      );
      const result = runInstallCliShell(
        [
          "set -euo pipefail",
          `source ${JSON.stringify(SCRIPT_PATH)}`,
          "install_node() { :; }; install_openclaw() { :; }",
          'ensure_git() { printf "git\\n" >> "$COMMAND_LOG"; }',
          'refresh_gateway_service_if_loaded() { printf "service-refresh\\n" >> "$COMMAND_LOG"; }',
          `main --json --npm --onboard ${runtimeOnly ? "--runtime-only" : ""} --prefix ${JSON.stringify(prefix)}`,
        ].join("\n"),
        { COMMAND_LOG: commandLog },
      );
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(readFileSync(commandLog, "utf8").trim().split("\n")).toEqual(
        runtimeOnly ? ["--version"] : ["git", "--version", "service-refresh", "onboard"],
      );
      expect(result.stdout).toContain('"event":"done"');
    },
  );

  it("refuses musl Node-only recovery before an installer can invoke system package changes", () => {
    const result = runInstallCliShell(`
      source ${SCRIPT_PATH}
      is_musl_linux() { return 0; }
      install_node() { echo unexpected-node-install; }
      main --node-only
    `);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain("unavailable on musl Linux");
    expect(result.stdout).not.toContain("unexpected-node-install");
  });

  it.each(
    ["directory", "missing", "file"].flatMap((tempBase) =>
      [false, true].map((downloadFails) => ({ tempBase, downloadFails })),
    ),
  )(
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
          source ${SCRIPT_PATH}
          is_musl_linux() { return 1; }
          detect_downloader() { :; }
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
          main --json --node-only --node-version 24.19.0 --prefix "$FIXTURE_PREFIX"
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
        source ${SCRIPT_PATH}
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
        "set -euo pipefail",
        `cd ${JSON.stringify(process.cwd())}`,
        `source ${JSON.stringify(SCRIPT_PATH)}`,
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

  it("allows a fresh Git install with enough free space", () => {
    const tmp = tempDirs.make("openclaw-install-cli-disk-ok-");
    const repo = join(tmp, "new", "openclaw");

    const result = runInstallCliShell(
      [
        "set -euo pipefail",
        `cd ${JSON.stringify(process.cwd())}`,
        `source ${JSON.stringify(SCRIPT_PATH)}`,
        "JSON=1",
        "available_disk_kib() { printf '7340032\\n'; }",
        `preflight_fresh_git_disk_space ${JSON.stringify(repo)}`,
        "printf 'continued\\n'",
      ].join("\n"),
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('{"event":"step","name":"disk-space","status":"start"}');
    expect(result.stdout).toContain('{"event":"step","name":"disk-space","status":"ok"}');
    expect(result.stdout).toContain("continued");
  });

  it("does not apply the fresh-install disk threshold to an existing checkout", () => {
    const tmp = tempDirs.make("openclaw-install-cli-disk-existing-");
    const repo = join(tmp, "openclaw");
    mkdirSync(join(repo, ".git"), { recursive: true });

    const result = runInstallCliShell(
      [
        "set -euo pipefail",
        `cd ${JSON.stringify(process.cwd())}`,
        `source ${JSON.stringify(SCRIPT_PATH)}`,
        "JSON=1",
        "available_disk_kib() { printf 'disk check should not run\\n' >&2; return 99; }",
        `preflight_fresh_git_disk_space ${JSON.stringify(repo)}`,
      ].join("\n"),
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("emits ordered stages for an existing Git checkout build", () => {
    const tmp = tempDirs.make("openclaw-install-cli-events-");
    const repo = join(tmp, "openclaw");
    mkdirSync(join(repo, ".git"), { recursive: true });

    const result = runInstallCliShell(
      [
        "set -euo pipefail",
        `cd ${JSON.stringify(process.cwd())}`,
        `source ${JSON.stringify(SCRIPT_PATH)}`,
        "JSON=1",
        `PREFIX=${JSON.stringify(join(tmp, "prefix"))}`,
        "ensure_git() { :; }",
        "ensure_pnpm() { :; }",
        "ensure_pnpm_git_prepare_allowlist() { :; }",
        "cleanup_legacy_submodules() { :; }",
        "resolve_git_openclaw_ref() { printf 'main\\n'; }",
        "checkout_git_openclaw_ref() { :; }",
        "run_pnpm() { :; }",
        "git() {",
        '  if [[ "$1" == --git-dir=* ]]; then return 0; fi',
        '  if [[ "$1" == "-C" && "$3" == "status" ]]; then return 0; fi',
        "  return 0",
        "}",
        `install_openclaw_from_git ${JSON.stringify(repo)}`,
      ].join("\n"),
    );

    expect(result.status).toBe(0);
    const stages = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: string; name?: string; status?: string })
      .filter((event) => event.event === "step")
      .map((event) => `${event.name}:${event.status}`);
    expect(stages).toEqual([
      "openclaw:start",
      "git-tools:start",
      "git-tools:ok",
      "git-update:start",
      "git-update:ok",
      "dependencies:start",
      "dependencies:ok",
      "control-ui:start",
      "control-ui:ok",
      "cli-build:start",
      "cli-build:ok",
      "openclaw:ok",
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
        "set -euo pipefail",
        `cd ${JSON.stringify(process.cwd())}`,
        `source ${JSON.stringify(SCRIPT_PATH)}`,
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

    const failure = runInstallCliShell(
      [
        "set -euo pipefail",
        `cd ${JSON.stringify(process.cwd())}`,
        `source ${JSON.stringify(SCRIPT_PATH)}`,
        "JSON=1",
        'fail "$EVENT_VALUE"',
      ].join("\n"),
      { EVENT_VALUE: dynamicValue },
    );

    expect(failure.status).toBe(1);
    expect(failure.stdout.trimEnd().split("\n")).toHaveLength(1);
    expect(JSON.parse(failure.stdout)).toEqual({ event: "error", message: dynamicValue });
  });

  it("rejects a git checkout without a commit before updating it", () => {
    const result = runInstallCliShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
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

  it("keeps a pre-existing empty Git install destination retryable after clone failure", () => {
    const root = tempDirs.make("openclaw-install-cli-empty-retry-");
    const repo = join(root, "openclaw");
    mkdirSync(repo);
    const runAttempt = (cloneMode: "failure" | "success") =>
      runInstallCliShell(
        `
        set -euo pipefail
        source "${SCRIPT_PATH}"
        ensure_git() { :; }
        ensure_pnpm() { :; }
          resolve_git_openclaw_ref() { printf 'main\\n'; }
        checkout_git_openclaw_ref() { :; }
        cleanup_legacy_submodules() { :; }
        ensure_pnpm_git_prepare_allowlist() { :; }
        git_install_lockfile_flag() { printf '%s\\n' '--frozen-lockfile'; }
        run_pnpm() { :; }
        git() {
          if [[ "$1" == "clone" ]]; then
            target="\${*: -1}"
            mkdir -p "$target/.git"
            if [[ "$CLONE_MODE" == "failure" ]]; then
              return 42
            fi
            printf 'complete\\n' > "$target/checkout.marker"
          fi
          return 0
        }
        install_openclaw_from_git "$REPO"
      `,
        { CLONE_MODE: cloneMode, REPO: repo },
      );

    const failed = runAttempt("failure");
    expect(failed.status, failed.stderr || failed.stdout).toBe(42);
    expect(existsSync(repo)).toBe(true);
    expect(readdirSync(repo)).toEqual([]);

    const succeeded = runAttempt("success");
    expect(succeeded.status, succeeded.stderr || succeeded.stdout).toBe(0);
    expect(readFileSync(join(repo, "checkout.marker"), "utf8")).toBe("complete\n");
  });

  it("publishes fresh Git clones only after success and cleans failed staging directories", () => {
    const root = tempDirs.make("openclaw-install-cli-transactional-clone-");
    const result = runInstallCliShell(
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
      source "${SCRIPT_PATH}"
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

  it.each([17, 43])(
    "uses the configured %s-second budget for curl connection and transfer stalls",
    (budget) => {
      const result = runInstallCliShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
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
      source "${SCRIPT_PATH}"
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

  it("does not clean an unrelated legacy checkout during the default npm install", () => {
    const main = script.slice(script.indexOf("\nmain() {"));
    expect(main).not.toContain("cleanup_legacy_submodules");
    expect(script).toContain('cleanup_legacy_submodules "$repo_dir"');
  });

  it("matches the canonical release-label contract for installed Node runtimes", () => {
    expect(script).toContain("SELECT sqlite_version() AS version");
    const result = runInstallCliShell(
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

  it("reuses the minimum supported runtime unless a newer version was explicitly requested", () => {
    const result = runInstallCliShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
      NODE_VERSION=26.1.0
      NODE_VERSION_REQUESTED=0
      printf 'default=%s\n' "$(required_node_version)"
      NODE_VERSION_REQUESTED=1
      printf 'requested=%s\n' "$(required_node_version)"
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("default=24.16.0");
    expect(result.stdout).toContain("requested=26.1.0");
  });

  it("rejects Linux ARMv7 before installing an explicitly requested Node", () => {
    const result = runInstallCliShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
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
      source "${SCRIPT_PATH}"
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
      source "${SCRIPT_PATH}"
      parse_args --prefix --no-onboard
    `);

    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain("Missing value for --prefix");
    expect(result.stdout + result.stderr).not.toContain("unbound variable");
  });

  it("matches the Gateway future-config compatibility rule", () => {
    const result = runInstallCliShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
      node_bin() { command -v node; }
      set +e
      for pair in \
        2026.7.1-2:2026.7.2 \
        2026.7.2-beta.6:2026.7.2-beta.7 \
        2026.7.2:2026.7.2-beta.7 \
        2026.7.2-beta.7:2026.7.2 \
        2026.7.2-1:2026.7.2-2 \
        2026.7.3-beta.1:2026.7.2; do
        candidate="\${pair%%:*}"
        writer="\${pair#*:}"
        openclaw_version_is_compatible_with "$candidate" "$writer"
        printf '%s=%s\\n' "$pair" "$?"
      done
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("2026.7.1-2:2026.7.2=1");
    expect(result.stdout).toContain("2026.7.2-beta.6:2026.7.2-beta.7=1");
    expect(result.stdout).toContain("2026.7.2:2026.7.2-beta.7=0");
    expect(result.stdout).toContain("2026.7.2-beta.7:2026.7.2=0");
    expect(result.stdout).toContain("2026.7.2-1:2026.7.2-2=0");
    expect(result.stdout).toContain("2026.7.3-beta.1:2026.7.2=0");
  });

  it.each([
    {
      candidate: "2026.7.1-2",
      message: "OpenClaw 2026.7.1-2 is older than config writer 2026.7.2",
    },
    {
      candidate: "invalid-version",
      message:
        "Cannot compare resolved OpenClaw version 'invalid-version' with config writer '2026.7.2'.",
    },
  ])("rejects $candidate before replacing an existing managed CLI", ({ candidate, message }) => {
    const tmp = tempDirs.make("openclaw-install-cli-compatible-");
    const prefix = join(tmp, "prefix");
    const bin = join(prefix, "bin");
    const openclaw = join(bin, "openclaw");
    mkdirSync(bin, { recursive: true });
    writeFileSync(openclaw, "existing-managed-cli\n");

    const result = runInstallCliShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
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
      install_openclaw
    `);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(message);
    expect(result.stderr).not.toContain("unexpected mutation");
    expect(readFileSync(openclaw, "utf8")).toBe("existing-managed-cli\n");
  });

  it("checks a git checkout version before dependency install or wrapper replacement", () => {
    const checkoutIndex = script.indexOf('checkout_git_openclaw_ref "$repo_dir" "$git_ref"');
    const compatibilityIndex = script.indexOf(
      'require_openclaw_version_compatible "$resolved_version"',
    );
    const dependencyInstallIndex = script.indexOf(
      'CI="${CI:-true}" run_pnpm -C "$repo_dir" install ${pnpm_prefer_offline_args[@]+"${pnpm_prefer_offline_args[@]}"} "$install_lockfile_flag"',
    );
    const wrapperIndex = script.indexOf(
      'publish_executable_wrapper "${PREFIX}/bin/openclaw"',
      compatibilityIndex,
    );

    expect(checkoutIndex).toBeGreaterThan(-1);
    expect(compatibilityIndex).toBeGreaterThan(checkoutIndex);
    expect(dependencyInstallIndex).toBeGreaterThan(compatibilityIndex);
    expect(wrapperIndex).toBeGreaterThan(compatibilityIndex);
  });

  it.each(["none", "unsupported", "missing"])(
    "reports a successful runtime replacement (%s) without restarting again",
    (replaced) => {
      const tmp = tempDirs.make("openclaw-install-cli-gateway-refresh-");
      const prefix = join(tmp, "prefix");
      const bin = join(prefix, "bin");
      const commandLog = join(tmp, "commands.log");
      const openclaw = join(bin, "openclaw");
      mkdirSync(bin, { recursive: true });
      writeFileSync(
        openclaw,
        [
          "#!/bin/bash",
          'printf "%s\\n" "$*" >> "$COMMAND_LOG"',
          'if [[ "$*" == "gateway install --force" ]]; then',
          '  printf "%s\\n" "incidental-output-canary"',
          '  if [[ "$REPLACED" == unsupported ]]; then printf "%s\\n" "Replacing unsupported Gateway service Node 22.23.1 (/old/node) with /new/node; refreshing the install."; fi',
          '  if [[ "$REPLACED" == missing ]]; then printf "%s\\n" "Replacing missing Gateway service Node (/old/node) with /new/node; refreshing the install."; fi',
          "fi",
        ].join("\n"),
      );
      chmodSync(openclaw, 0o755);

      const result = runInstallCliShell(
        [
          "set -euo pipefail",
          `cd ${JSON.stringify(process.cwd())}`,
          `source ${JSON.stringify(SCRIPT_PATH)}`,
          `PREFIX=${JSON.stringify(prefix)}`,
          "is_gateway_daemon_loaded() { return 0; }",
          "refresh_gateway_service_if_loaded",
        ].join("\n"),
        { COMMAND_LOG: commandLog, REPLACED: replaced },
      );

      expect(result.status).toBe(0);
      expect(result.stderr.includes("Gateway service Node runtime replaced.")).toBe(
        replaced !== "none",
      );
      expect(result.stdout + result.stderr).not.toContain("incidental-output-canary");
      expect(result.stdout + result.stderr).not.toContain("/old/node");
      expect(result.stdout + result.stderr).not.toContain("/new/node");
      expect(readFileSync(commandLog, "utf8").trim().split("\n")).toEqual([
        "gateway install --force",
        "gateway status --probe --json",
      ]);
    },
  );

  it.each([
    { error: "SERVICE_DEFINITION_SEALED: protected", args: "", stream: "stderr" },
    { error: "SERVICE_DEFINITION_SEALED: protected", args: "--json", stream: "stdout" },
    { error: "SERVICE_DEFINITION_UNKNOWN: inaccessible", args: "--json", stream: "stderr" },
    { error: "service manager unavailable", args: "--json", stream: "stderr" },
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
        "set -euo pipefail",
        `source ${JSON.stringify(SCRIPT_PATH)}`,
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

    const denied = error.startsWith("SERVICE_DEFINITION_");
    expect(readFileSync(commandLog, "utf8").split("\n")).not.toContain("gateway restart");
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("+ main");
    expect(result.stdout + result.stderr).not.toContain(secretCanary);
    expect(result.stdout + result.stderr).not.toContain("Gateway service Node runtime replaced");
    if (denied) {
      expect(result.stderr).toContain("gateway service definition left unchanged");
      expect(result.stderr).toContain(
        error.includes("SEALED")
          ? "privileged deployment owner"
          : "inspect service-definition access",
      );
      if (args) {
        expect(result.stdout).toContain('"event":"done"');
        expect(result.stdout).toContain('"reason":"definition-mutation-denied"');
      } else {
        expect(result.stdout).toContain("OpenClaw installed (OpenClaw 2026.8.25).");
      }
    } else {
      expect(result.stdout).toContain('"reason":"install-failed"');
      expect(result.stdout).toContain('"event":"done"');
    }
  });

  it.each([
    { args: "--json", mode: "JSON" },
    { args: "", mode: "human" },
  ])(
    "rejects a package without a runnable CLI in $mode mode before service refresh",
    ({ args }) => {
      const tmp = tempDirs.make("openclaw-install-cli-invalid-package-");
      const prefix = join(tmp, "prefix");
      const refreshLog = join(tmp, "gateway-refresh.log");

      const result = runInstallCliShell(
        [
          "set -euo pipefail",
          `cd ${JSON.stringify(process.cwd())}`,
          `source ${JSON.stringify(SCRIPT_PATH)}`,
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

  it.each([
    { args: "--json", mode: "JSON" },
    { args: "", mode: "human" },
  ])(
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
          "set -euo pipefail",
          `cd ${JSON.stringify(process.cwd())}`,
          `source ${JSON.stringify(SCRIPT_PATH)}`,
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

  it("keeps HOME for default prefix while OPENCLAW_HOME controls git checkout paths", () => {
    const tmp = tempDirs.make("openclaw-install-cli-home-");
    const osHome = join(tmp, "os-home");
    const openclawHome = join(tmp, "openclaw-home");
    mkdirSync(osHome, { recursive: true });
    mkdirSync(openclawHome, { recursive: true });

    const result = runInstallCliShell(
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

    expect(result.status).toBe(0);
    const output = result.stdout;
    expect(output).toContain(`prefix=${join(osHome, ".openclaw")}`);
    expect(output).toContain(`git=${join(openclawHome, "openclaw")}`);
  });

  it.each([
    { input: "arguments", method: "npm" },
    { input: "environment", method: "npm" },
    { input: "literal tilde", method: "npm" },
    { input: "arguments", method: "git" },
    { input: "environment", method: "git" },
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
      const result = runInstallCliShell(
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
          OPENCLAW_GIT_DIR: input === "environment" && method === "git" ? repoInput : undefined,
          OPENCLAW_PREFIX: input === "environment" ? prefixInput : undefined,
        },
      );

      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stdout.trim().split("\n").at(-1)).toBe("fixture cli");
    },
  );

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

  it.each(["bundle", "remote"] as const)("pins a full commit from a %s", (source) => {
    const result = runInstallCliShell(createInstallGitCommitFixtureScript(source), {
      OPENCLAW_INSTALLER_SCRIPT: SCRIPT_PATH,
    });

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("kind=immutable");
    expect(result.stdout).toContain("rejected=HEAD~1");
  });

  it("prefers a release tag over a same-named branch", () => {
    const result = runInstallCliShell(createInstallGitTagPreferenceFixtureScript(SCRIPT_PATH));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("kind=immutable");
    expect(result.stdout).toContain("selected=");
  });

  it("falls back to a v-prefixed branch when no matching release tag exists", () => {
    const result = runInstallCliShell(createInstallGitBranchFallbackFixtureScript(SCRIPT_PATH));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("kind=moving");
    expect(result.stdout).toContain("selected=");
  });

  it("updates a stale existing main checkout from the remote tracking ref", () => {
    const result = runInstallCliShell(createInstallGitUpdateFixtureScript(SCRIPT_PATH));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("head=");
    expect(result.stdout).toContain("tracking=");
    expect(result.stdout).toContain("remote=");
  });

  it("restores an existing main checkout after a failed rebase", () => {
    const result = runInstallCliShell(createInstallGitRebaseRecoveryFixtureScript(SCRIPT_PATH));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("recovery=head-restored status-clean rebase-state-cleared");
  });

  it("verifies unchanged state when a hook refuses rebase before it starts", () => {
    const result = runInstallCliShell(createInstallGitHookRefusalFixtureScript(SCRIPT_PATH));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "hook-refusal=head-verified status-verified rebase-state-absent",
    );
  });

  it("uses non-frozen lockfile installs only for moving git refs", () => {
    const result = runInstallCliShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
      printf 'moving=%s\\n' "$(git_install_lockfile_flag moving)"
      printf 'immutable=%s\\n' "$(git_install_lockfile_flag immutable)"
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("moving=--no-frozen-lockfile");
    expect(result.stdout).toContain("immutable=--frozen-lockfile");
    expect(script).toContain(
      'CI="${CI:-true}" run_pnpm -C "$repo_dir" install ${pnpm_prefer_offline_args[@]+"${pnpm_prefer_offline_args[@]}"} "$install_lockfile_flag"',
    );
  });

  defineInstallerPnpmContract(installerContract);

  it("links an existing usable Alpine/musl Node runtime without sudo", () => {
    const tmp = tempDirs.make("openclaw-install-cli-alpine-");
    const bin = join(tmp, "bin");
    const prefix = join(tmp, "prefix");
    const apkLog = join(tmp, "apk.log");
    const fakeApk = join(bin, "apk");
    const fakeNode = join(bin, "node");
    const fakeNpm = join(bin, "npm");

    mkdirSync(bin, { recursive: true });
    linkRequiredShellTools(bin);
    writeFileSync(
      fakeApk,
      ["#!/bin/bash", 'printf "%s\\n" "$*" >> "$APK_LOG"', "exit 99", ""].join("\n"),
    );
    writeNodeFixture(fakeNode, "v24.16.0");
    writeFileSync(fakeNpm, ["#!/bin/bash", "exit 0", ""].join("\n"));
    chmodSync(fakeApk, 0o755);
    chmodSync(fakeNode, 0o755);
    chmodSync(fakeNpm, 0o755);

    const result = runInstallCliShell(
      [
        "set -euo pipefail",
        `cd ${JSON.stringify(process.cwd())}`,
        `source ${JSON.stringify(SCRIPT_PATH)}`,
        `export PATH=${JSON.stringify(bin)}`,
        "is_musl_linux() { return 0; }",
        "is_root() { return 1; }",
        `PREFIX=${JSON.stringify(prefix)}`,
        `APK_NODE_BIN_DIR=${JSON.stringify(bin)}`,
        "install_node linux x64",
      ].join("\n"),
      {
        APK_LOG: apkLog,
        PATH: bin,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("Installing Node via apk");
    expect(() => readFileSync(apkLog, "utf8")).toThrow();
    const nodeLink = join(prefix, "tools", "node-v24.21.0", "bin", "node");
    const npmLink = join(prefix, "tools", "node-v24.21.0", "bin", "npm");
    expect(lstatSync(nodeLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(nodeLink)).toBe(fakeNode);
    expect(readlinkSync(npmLink)).toBe(fakeNpm);
    expect(script).toContain("apk add --no-cache git");
  });

  it("replaces a stale Alpine/musl prefix Node before the generic skip", () => {
    const tmp = tempDirs.make("openclaw-install-cli-alpine-stale-");
    const bin = join(tmp, "bin");
    const oldBin = join(tmp, "old-bin");
    const prefix = join(tmp, "prefix");
    const nodePrefixBin = join(prefix, "tools", "node-v24.16.0", "bin");
    const apkLog = join(tmp, "apk.log");
    const fakeApk = join(bin, "apk");
    const fakeNode = join(bin, "node");
    const fakeNpm = join(bin, "npm");
    const oldNode = join(oldBin, "node");
    const oldNpm = join(oldBin, "npm");
    const staleNode = join(nodePrefixBin, "node");

    mkdirSync(bin, { recursive: true });
    linkRequiredShellTools(bin);
    mkdirSync(oldBin, { recursive: true });
    mkdirSync(nodePrefixBin, { recursive: true });
    writeFileSync(
      fakeApk,
      ["#!/bin/bash", 'printf "%s\\n" "$*" >> "$APK_LOG"', "exit 99", ""].join("\n"),
    );
    writeNodeFixture(staleNode, "v24.16.0", 1);
    writeNodeFixture(fakeNode, "v24.16.0");
    writeNodeFixture(oldNode, "v18.20.0", 1);
    writeFileSync(oldNpm, ["#!/bin/bash", "exit 0", ""].join("\n"));
    writeFileSync(fakeNpm, ["#!/bin/bash", "exit 0", ""].join("\n"));
    chmodSync(fakeApk, 0o755);
    chmodSync(staleNode, 0o755);
    chmodSync(oldNode, 0o755);
    chmodSync(oldNpm, 0o755);
    chmodSync(fakeNode, 0o755);
    chmodSync(fakeNpm, 0o755);

    const result = runInstallCliShell(
      [
        "set -euo pipefail",
        `cd ${JSON.stringify(process.cwd())}`,
        `source ${JSON.stringify(SCRIPT_PATH)}`,
        `export PATH=${JSON.stringify(`${nodePrefixBin}:${oldBin}:${bin}`)}`,
        "is_musl_linux() { return 0; }",
        "is_root() { return 1; }",
        `PREFIX=${JSON.stringify(prefix)}`,
        "NODE_VERSION=24.16.0",
        "install_node linux x64",
      ].join("\n"),
      {
        APK_LOG: apkLog,
        PATH: `${nodePrefixBin}:${oldBin}:${bin}`,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("Installing Node via apk");
    expect(() => readFileSync(apkLog, "utf8")).toThrow();
    const nodeLink = join(prefix, "tools", "node-v24.16.0", "bin", "node");
    const npmLink = join(prefix, "tools", "node-v24.16.0", "bin", "npm");
    expect(lstatSync(nodeLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(nodeLink)).toBe(fakeNode);
    expect(readlinkSync(npmLink)).toBe(fakeNpm);
  });

  it("uses apk-managed Node and Git on Alpine/musl when the existing Node is unusable", () => {
    const tmp = tempDirs.make("openclaw-install-cli-alpine-apk-");
    const bin = join(tmp, "bin");
    const prefix = join(tmp, "prefix");
    const apkLog = join(tmp, "apk.log");
    const nodeState = join(tmp, "node-state");
    const fakeApk = join(bin, "apk");
    const fakeNode = join(bin, "node");
    const fakeNpm = join(bin, "npm");

    mkdirSync(bin, { recursive: true });
    linkRequiredShellTools(bin);
    writeFileSync(
      fakeApk,
      [
        "#!/bin/bash",
        'printf "%s\\n" "$*" >> "$APK_LOG"',
        'printf "new\\n" > "$NODE_STATE"',
        "exit 0",
        "",
      ].join("\n"),
    );
    writeFileSync(
      fakeNode,
      [
        "#!/bin/bash",
        'if [[ "${1:-}" == "-v" ]]; then',
        '  if [[ -f "$NODE_STATE" ]]; then',
        "    printf 'v24.16.0\\n'",
        "  else",
        "    printf 'v18.20.0\\n'",
        "  fi",
        "  exit 0",
        "fi",
        'if [[ "${1:-}" == "-e" ]]; then',
        '  [[ -f "$NODE_STATE" ]]',
        "  exit $?",
        "fi",
        "exit 0",
        "",
      ].join("\n"),
    );
    writeFileSync(fakeNpm, ["#!/bin/bash", "exit 0", ""].join("\n"));
    chmodSync(fakeApk, 0o755);
    chmodSync(fakeNode, 0o755);
    chmodSync(fakeNpm, 0o755);

    const result = runInstallCliShell(
      [
        "set -euo pipefail",
        `cd ${JSON.stringify(process.cwd())}`,
        `source ${JSON.stringify(SCRIPT_PATH)}`,
        `export PATH=${JSON.stringify(bin)}`,
        "is_musl_linux() { return 0; }",
        "is_root() { return 0; }",
        `PREFIX=${JSON.stringify(prefix)}`,
        `APK_NODE_BIN_DIR=${JSON.stringify(bin)}`,
        "NODE_VERSION=24.16.0",
        "install_node linux x64",
      ].join("\n"),
      {
        APK_LOG: apkLog,
        NODE_STATE: nodeState,
        PATH: bin,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Installing Node via apk");
    expect(readFileSync(apkLog, "utf8")).toContain("add --no-cache nodejs npm");
    const nodeLink = join(prefix, "tools", "node-v24.16.0", "bin", "node");
    const npmLink = join(prefix, "tools", "node-v24.16.0", "bin", "npm");
    expect(lstatSync(nodeLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(nodeLink)).toBe(fakeNode);
    expect(readlinkSync(npmLink)).toBe(fakeNpm);
    expect(script).toContain("apk add --no-cache git");
  });

  it("skips PATH Node runtimes whose npm command cannot start", () => {
    const tmp = tempDirs.make("openclaw-install-cli-broken-npm-");
    const badBin = join(tmp, "bad-bin");
    const goodBin = join(tmp, "good-bin");
    const prefix = join(tmp, "prefix");
    const badNpmLog = join(tmp, "bad-npm.log");
    const goodNpmLog = join(tmp, "good-npm.log");
    const goodNodeLog = join(tmp, "good-node.log");
    const badNode = join(badBin, "node");
    const badNpm = join(badBin, "npm");
    const goodNode = join(goodBin, "node");
    const goodNpm = join(goodBin, "npm");

    mkdirSync(badBin, { recursive: true });
    mkdirSync(goodBin, { recursive: true });
    symlinkSync(nodeExecutable, badNode);
    writeFileSync(
      goodNode,
      [
        "#!/bin/bash",
        'printf "%s\\n" "$*" >> "$GOOD_NODE_LOG"',
        `exec ${JSON.stringify(nodeExecutable)} "$@"`,
        "",
      ].join("\n"),
    );
    writeFileSync(
      badNpm,
      ["#!/bin/bash", 'printf "%s\\n" "$*" >> "$BAD_NPM_LOG"', "exit 42", ""].join("\n"),
    );
    writeFileSync(
      goodNpm,
      [
        "#!/usr/bin/env node",
        'require("node:fs").appendFileSync(',
        "  process.env.GOOD_NPM_LOG,",
        '  `${process.argv.slice(2).join(" ")}\\n`,',
        ");",
        "",
      ].join("\n"),
    );
    chmodSync(badNpm, 0o755);
    chmodSync(goodNode, 0o755);
    chmodSync(goodNpm, 0o755);

    const result = runInstallCliShell(
      [
        "set -euo pipefail",
        `cd ${JSON.stringify(process.cwd())}`,
        `source ${JSON.stringify(SCRIPT_PATH)}`,
        `export PATH=${JSON.stringify(`${badBin}:${goodBin}:${process.env.PATH ?? ""}`)}`,
        `PREFIX=${JSON.stringify(prefix)}`,
        "try_link_usable_node_runtime_from_path",
      ].join("\n"),
      {
        BAD_NPM_LOG: badNpmLog,
        GOOD_NPM_LOG: goodNpmLog,
        GOOD_NODE_LOG: goodNodeLog,
      },
    );

    expect(result.status).toBe(0);
    const nodeLink = join(prefix, "tools", "node-v24.21.0", "bin", "node");
    const npmLink = join(prefix, "tools", "node-v24.21.0", "bin", "npm");
    expect(readFileSync(badNpmLog, "utf8")).toBe("--version\n");
    expect(readFileSync(goodNpmLog, "utf8")).toBe("--version\n");
    expect(readFileSync(goodNodeLog, "utf8")).toContain("npm --version");
    expect(lstatSync(nodeLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(nodeLink)).toBe(goodNode);
    expect(readlinkSync(npmLink)).toBe(goodNpm);
  });

  it.each(
    ["path", "apk"].flatMap((route) =>
      ["version", "npm", "sqlite"].map((failure) => ({ route, failure })),
    ),
  )("preserves the active runtime when $route rejects $failure", ({ route, failure }) => {
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
      source ${SCRIPT_PATH}
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

  it.each(["alias path", "empty entry"])(
    "excludes active runtime aliases from %s when selecting Node and optional tools",
    (entry) => {
      const root = tempDirs.make("openclaw-install-cli-runtime-alias-");
      const bin = join(root, "system-bin");
      const prefix = join(root, "prefix");
      const oldRuntime = join(root, "old-runtime");
      const oldBin = join(oldRuntime, "bin");
      const aliasBin = join(root, "alias-bin");
      mkdirSync(bin);
      linkRequiredShellTools(bin);
      mkdirSync(oldBin, { recursive: true });
      for (const target of [bin, oldBin]) {
        symlinkSync(nodeExecutable, join(target, "node"));
        writeFileSync(join(target, "npm"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
      }
      for (const tool of ["npx", "corepack"]) {
        writeFileSync(join(oldBin, tool), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
      }
      mkdirSync(join(prefix, "tools"), { recursive: true });
      symlinkSync(oldRuntime, join(prefix, "tools", "node"));
      symlinkSync(join(prefix, "tools", "node", "bin"), aliasBin);
      const result = runInstallCliShell(
        `
      source ${SCRIPT_PATH}
      PREFIX="$FIXTURE_PREFIX"
      ${entry === "empty entry" ? 'cd "$FIXTURE_ALIAS"' : ""}
      PATH="${entry === "empty entry" ? "" : "$FIXTURE_ALIAS"}:$FIXTURE_BIN"
      export PATH
      try_link_usable_node_runtime_from_path
      `,
        { FIXTURE_PREFIX: prefix, FIXTURE_ALIAS: aliasBin, FIXTURE_BIN: bin },
      );
      expect(result.status, result.stdout + result.stderr).toBe(0);
      const active = join(prefix, "tools", "node", "bin");
      expect(readlinkSync(join(active, "node"))).toBe(join(bin, "node"));
      expect(readlinkSync(join(active, "npm"))).toBe(join(bin, "npm"));
      for (const tool of ["npx", "corepack"]) {
        expect(readdirSync(active)).not.toContain(tool);
        expect(readFileSync(join(oldBin, tool), "utf8")).toBe("#!/bin/bash\nexit 0\n");
      }
    },
  );

  it.each([".", "", "bin dir"])(
    "publishes usable runtime links for relative PATH entry %j",
    (pathEntry) => {
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
        source ${SCRIPT_PATH}
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
    },
  );

  it.each(
    ["command", "runtime"].flatMap((route) =>
      ["empty", "trailing", "leading", "absolute first"].map((order) => ({ route, order })),
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
    const search = order === "empty" ? "" : order === "leading" ? `:${other}` : `${other}:`;
    const result = runInstallCliShell(
      `
      source ${SCRIPT_PATH}
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
    expect(result.stdout.trim()).toBe(order === "absolute first" ? "other-npm" : "current-npm");
  });

  it.each(["excluded path", "empty managed cwd"])(
    "does not invent a cwd search after filtering %s",
    (entry) => {
      const root = tempDirs.make("openclaw-install-cli-filtered-path-");
      const prefix = join(root, "prefix");
      const managed = join(prefix, "tools", "node-v24.21.0", "bin");
      const current = entry === "empty managed cwd" ? managed : join(root, "current");
      mkdirSync(managed, { recursive: true });
      mkdirSync(current, { recursive: true });
      writeFileSync(join(current, "npm"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
      const result = runInstallCliShell(
        `
        source ${SCRIPT_PATH}
        PREFIX="$FIXTURE_PREFIX"
        cd "$FIXTURE_CURRENT"
        PATH="$FIXTURE_SEARCH"
        command_path_without_node_prefix npm ${entry === "empty managed cwd" ? "1" : "0"}
        `,
        {
          FIXTURE_PREFIX: prefix,
          FIXTURE_CURRENT: current,
          FIXTURE_SEARCH: entry === "empty managed cwd" ? "" : managed,
        },
      );
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stdout).toBe("");
    },
  );

  it("rejects Alpine/musl Node packages below the requested runtime floor", () => {
    const tmp = tempDirs.make("openclaw-install-cli-alpine-old-node-");
    const bin = join(tmp, "bin");
    const prefix = join(tmp, "prefix");
    const apkLog = join(tmp, "apk.log");
    const fakeApk = join(bin, "apk");
    const fakeNode = join(bin, "node");
    const fakeNpm = join(bin, "npm");

    mkdirSync(bin, { recursive: true });
    linkRequiredShellTools(bin);
    writeFileSync(
      fakeApk,
      ["#!/bin/bash", 'printf "%s\\n" "$*" >> "$APK_LOG"', "exit 0", ""].join("\n"),
    );
    writeNodeFixture(fakeNode, "v22.18.0");
    writeFileSync(fakeNpm, ["#!/bin/bash", "exit 0", ""].join("\n"));
    chmodSync(fakeApk, 0o755);
    chmodSync(fakeNode, 0o755);
    chmodSync(fakeNpm, 0o755);

    const result = runInstallCliShell(
      [
        "set -euo pipefail",
        `cd ${JSON.stringify(process.cwd())}`,
        `source ${JSON.stringify(SCRIPT_PATH)}`,
        `export PATH=${JSON.stringify(bin)}`,
        "is_musl_linux() { return 0; }",
        "is_root() { return 0; }",
        `PREFIX=${JSON.stringify(prefix)}`,
        `APK_NODE_BIN_DIR=${JSON.stringify(bin)}`,
        "NODE_VERSION=24.16.0",
        "install_node linux x64",
      ].join("\n"),
      {
        APK_LOG: apkLog,
        PATH: bin,
      },
    );

    expect(result.status).toBe(1);
    expect(readFileSync(apkLog, "utf8")).toContain("add --no-cache nodejs npm");
    expect(result.stdout).toContain(
      "Alpine Node package must provide Node >= 24.16.0 with WAL-reset-safe SQLite 3.51.3+, 3.50.7+ within 3.50.x, or 3.44.6+ within 3.44.x",
    );
    expect(result.stdout).toContain("found Node v22.18.0, SQLite unavailable");
  });

  it("replaces cached generic Node runtimes below the runtime floor", () => {
    const tmp = tempDirs.make("openclaw-install-cli-generic-stale-node-");
    const prefix = join(tmp, "prefix");
    const nodePrefixBin = join(prefix, "tools", "node-v24.16.0", "bin");
    const staleNode = join(nodePrefixBin, "node");
    const staleNpm = join(nodePrefixBin, "npm");
    const newNode = join(tmp, "new-node");
    const newNpm = join(tmp, "new-npm");

    mkdirSync(nodePrefixBin, { recursive: true });
    writeNodeFixture(staleNode, "v22.18.0");
    writeFileSync(staleNpm, ["#!/bin/bash", "exit 0", ""].join("\n"));
    writeNodeFixture(newNode, "v24.16.0");
    writeFileSync(newNpm, ["#!/bin/bash", "exit 0", ""].join("\n"));
    chmodSync(staleNode, 0o755);
    chmodSync(staleNpm, 0o755);
    chmodSync(newNode, 0o755);
    chmodSync(newNpm, 0o755);

    const result = runInstallCliShell(
      [
        "set -euo pipefail",
        `cd ${JSON.stringify(process.cwd())}`,
        `source ${JSON.stringify(SCRIPT_PATH)}`,
        "is_musl_linux() { return 1; }",
        "detect_downloader() { :; }",
        "require_bin() { :; }",
        "download_file() {",
        '  case "$1" in',
        "    */SHASUMS256.txt) printf 'fixture-sha  node-v24.16.0-linux-x64.tar.gz\\n' > \"$2\" ;;",
        "    *) printf 'node tarball fixture\\n' > \"$2\" ;;",
        "  esac",
        "}",
        "sha256_file() { printf 'fixture-sha\\n'; }",
        "tar() {",
        "  local dest=''",
        "  while [[ $# -gt 0 ]]; do",
        '    if [[ "$1" == \'-C\' ]]; then dest="$2"; shift 2; else shift; fi',
        "  done",
        '  mkdir -p "$dest/bin"',
        '  cp "$NEW_NODE" "$dest/bin/node"',
        '  cp "$NEW_NPM" "$dest/bin/npm"',
        "}",
        `PREFIX=${JSON.stringify(prefix)}`,
        "NODE_VERSION=24.16.0",
        "install_node linux x64",
      ].join("\n"),
      {
        NEW_NODE: newNode,
        NEW_NPM: newNpm,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Installing Node 24.16.0 (user-space)");
    expect(result.stdout).not.toContain('"status":"skip"');
    expect(readFileSync(staleNode, "utf8")).toContain("v24.16.0");
  });

  it.each([
    { existing: false, starts: true },
    { existing: false, starts: false },
    { existing: true, starts: true },
    { existing: true, starts: false },
  ])(
    "keeps the active runtime until a downloaded replacement is usable ($existing, $starts)",
    ({ existing, starts }) => {
      const tmp = tempDirs.make("openclaw-install-cli-generic-old-node-");
      const prefix = join(tmp, "prefix");
      const newNode = join(tmp, "new-node");
      const newNpm = join(tmp, "new-npm");
      const activeNode = join(prefix, "tools", "node");
      const oldNodeDir = join(prefix, "tools", "node-v22.23.2");
      const oldPackage = join(oldNodeDir, "lib", "node_modules", "openclaw", "package.json");
      if (existing) {
        mkdirSync(join(oldNodeDir, "bin"), { recursive: true });
        writeFileSync(join(oldNodeDir, "bin", "node"), "#!/bin/bash\nprintf 'v22.23.2\\n'\n");
        chmodSync(join(oldNodeDir, "bin", "node"), 0o755);
        mkdirSync(join(oldPackage, ".."), { recursive: true });
        writeFileSync(oldPackage, '{"name":"openclaw","version":"2026.9.2"}\n');
        symlinkSync(oldNodeDir, activeNode);
      }

      writeFileSync(
        newNode,
        [
          "#!/bin/bash",
          ...(starts ? [] : ["exit 126"]),
          'if [[ "${1:-}" == "-v" ]]; then',
          "  printf 'v22.22.2\\n'",
          "  exit 0",
          "fi",
          'if [[ "${1:-}" == "-e" ]]; then',
          "  exit 0",
          "fi",
          "exit 0",
          "",
        ].join("\n"),
      );
      writeFileSync(newNpm, ["#!/bin/bash", "exit 0", ""].join("\n"));
      chmodSync(newNode, 0o755);
      chmodSync(newNpm, 0o755);

      const install = () =>
        runInstallCliShell(
          [
            "set -euo pipefail",
            `cd ${JSON.stringify(process.cwd())}`,
            `source ${JSON.stringify(SCRIPT_PATH)}`,
            "is_musl_linux() { return 1; }",
            "detect_downloader() { :; }",
            "require_bin() { :; }",
            "download_file() {",
            '  case "$1" in',
            "    */SHASUMS256.txt) printf 'fixture-sha  node-v24.16.0-linux-x64.tar.gz\\n' > \"$2\" ;;",
            "    *) printf 'node tarball fixture\\n' > \"$2\" ;;",
            "  esac",
            "}",
            "sha256_file() { printf 'fixture-sha\\n'; }",
            "tar() {",
            "  local dest=''",
            "  while [[ $# -gt 0 ]]; do",
            '    if [[ "$1" == \'-C\' ]]; then dest="$2"; shift 2; else shift; fi',
            "  done",
            '  mkdir -p "$dest/bin"',
            '  cp "$NEW_NODE" "$dest/bin/node"',
            '  cp "$NEW_NPM" "$dest/bin/npm"',
            "}",
            `PREFIX=${JSON.stringify(prefix)}`,
            "NODE_VERSION=24.16.0",
            "install_node linux x64",
          ].join("\n"),
          {
            NEW_NODE: newNode,
            NEW_NPM: newNpm,
          },
        );
      const result = install();
      expect(result.status).toBe(1);
      expect(result.stdout).toContain(
        "Installed Node 24.16.0 must provide Node >= 24.16.0 with WAL-reset-safe SQLite",
      );
      expect(result.stdout).toContain(
        starts
          ? "found Node v22.22.2, SQLite unavailable"
          : "found Node unknown, SQLite unavailable",
      );
      if (existing) {
        expect(readlinkSync(activeNode)).toBe(oldNodeDir);
        expect(
          spawnSync(join(activeNode, "bin", "node"), ["-v"], { encoding: "utf8" }).stdout,
        ).toBe("v22.23.2\n");
        expect(readFileSync(oldPackage, "utf8")).toBe('{"name":"openclaw","version":"2026.9.2"}\n');
      } else {
        expect(existsSync(activeNode)).toBe(false);
      }

      writeFileSync(
        newNode,
        "#!/bin/bash\nif [[ \"${1:-}\" == '-v' ]]; then printf 'v24.16.0\\n'; fi\nexit 0\n",
      );
      const retry = install();
      expect(retry.status, retry.stdout + retry.stderr).toBe(0);
      expect(readlinkSync(activeNode)).toBe(join(prefix, "tools", "node-v24.16.0"));
      expect(spawnSync(join(activeNode, "bin", "node"), ["-v"], { encoding: "utf8" }).stdout).toBe(
        "v24.16.0\n",
      );
      if (existing) {
        expect(readFileSync(oldPackage, "utf8")).toBe('{"name":"openclaw","version":"2026.9.2"}\n');
      }
    },
  );

  it("removes the Node staging directory when download fails", () => {
    const tmp = tempDirs.make("openclaw-install-cli-node-cleanup-");
    const prefix = join(tmp, "prefix");
    const stagingDir = join(tmp, "node-staging");

    const result = runInstallCliShell(
      [
        "set -euo pipefail",
        `cd ${JSON.stringify(process.cwd())}`,
        `source ${JSON.stringify(SCRIPT_PATH)}`,
        "is_musl_linux() { return 1; }",
        "linked_node_is_usable() { return 1; }",
        "detect_downloader() { :; }",
        "require_bin() { :; }",
        `mktemp() { mkdir -p ${JSON.stringify(stagingDir)}; printf '%s\\n' ${JSON.stringify(stagingDir)}; }`,
        "download_file() { return 42; }",
        `PREFIX=${JSON.stringify(prefix)}`,
        "NODE_VERSION=24.16.0",
        "install_node linux x64",
      ].join("\n"),
    );

    expect(result.status).toBe(42);
    expect(() => lstatSync(stagingDir)).toThrow();
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
        "set -euo pipefail",
        `cd ${JSON.stringify(process.cwd())}`,
        `source ${JSON.stringify(SCRIPT_PATH)}`,
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
    { expected: "--allow-scripts=openclaw", version: "12.0.0" },
  ])("resolves canonical npm lifecycle policy for npm $version", ({ expected, version }) => {
    const tmp = tempDirs.make("openclaw-install-cli-lifecycle-");
    const npm = join(tmp, "npm");
    writeNpmLifecycleFixture(npm);
    const result = runInstallCliShell(
      [
        `source ${JSON.stringify(SCRIPT_PATH)}`,
        `node_bin() { printf '%s\n' ${JSON.stringify(nodeExecutable)}; }`,
        `result="$(npm_lifecycle_allow_arg ${JSON.stringify(npm)} openclaw@latest)"`,
        `printf '%s' "$result"`,
      ].join("\n"),
      { NPM_FAKE_VERSION: version },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(expected);
    const tool = runInstallCliShell(
      [
        `source ${JSON.stringify(SCRIPT_PATH)}`,
        `node_bin() { printf '%s\\n' ${JSON.stringify(nodeExecutable)}; }`,
        `npm_lifecycle_allow_arg ${JSON.stringify(npm)} pnpm@12.0.0 "$PWD" pnpm@12.0.0`,
      ].join("\n"),
      { NPM_FAKE_VERSION: version },
    );
    expect(tool.status).toBe(0);
    expect(tool.stdout).toBe(expected ? "--allow-scripts=pnpm@12.0.0" : "");
  });

  it.each(["invalid", "npm 12.0.0 warning"])(
    "rejects npm version %s before mutation",
    (version) => {
      const tmp = tempDirs.make("openclaw-install-cli-lifecycle-invalid-");
      const npm = join(tmp, "npm");
      const args = join(tmp, "args");
      writeNpmLifecycleFixture(npm);
      const result = runInstallCliShell(
        [
          `source ${JSON.stringify(SCRIPT_PATH)}`,
          `node_bin() { printf '%s\n' ${JSON.stringify(nodeExecutable)}; }`,
          `npm_lifecycle_allow_arg ${JSON.stringify(npm)} openclaw@latest`,
        ].join("\n"),
        { NPM_FAKE_ARGS: args, NPM_FAKE_VERSION: version },
      );
      expect(result.status).not.toBe(0);
      expect(existsSync(args)).toBe(false);
    },
  );

  it.each([
    ["openclaw@npm:@scope/candidate@1.0.0", "--allow-scripts=@scope/candidate"],
    ["openclaw@npm:@scope/candidate.tgz@1.0.0", "--allow-scripts=@scope/candidate.tgz"],
    ["file:/tmp/openclaw.tgz", "--allow-scripts=file:/tmp/openclaw.tgz"],
    ["vendor/repo.tgz", "--allow-scripts=vendor/repo.tgz"],
    ["vendor/repo#release.tgz", "--allow-scripts=vendor/repo#release.tgz"],
    [
      "https://example.invalid/openclaw.tgz",
      "--allow-scripts=https://example.invalid/openclaw.tgz",
    ],
  ])("uses npm-resolved lifecycle identity for %s", (spec, expected) => {
    const tmp = tempDirs.make("openclaw-install-cli-identity-");
    const npm = join(tmp, "npm");
    writeNpmLifecycleFixture(npm);
    const result = runInstallCliShell(
      [
        `source ${JSON.stringify(SCRIPT_PATH)}`,
        `node_bin() { printf '%s\n' ${JSON.stringify(nodeExecutable)}; }`,
        `npm_lifecycle_allow_arg ${JSON.stringify(npm)} ${JSON.stringify(spec)}`,
      ].join("\n"),
      { NPM_FAKE_VERSION: "12.0.0" },
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(expected);
  });

  defineInstallerNpmArchiveIdentityContract(installerContract);

  it.each([
    { version: "11.16.0", advisory: true },
    { version: "12.0.0", advisory: false },
  ])(
    "handles comma tarball identity under npm $version before mutation",
    ({ version, advisory }) => {
      const tmp = tempDirs.make("openclaw-install-cli-archive-comma,");
      const npm = join(tmp, "npm");
      const args = join(tmp, "args");
      writeNpmLifecycleFixture(npm);
      const result = runInstallCliShell(
        [
          `source ${JSON.stringify(SCRIPT_PATH)}`,
          `node_bin() { printf '%s\\n' ${JSON.stringify(nodeExecutable)}; }`,
          `cd ${JSON.stringify(tmp)}`,
          `npm_lifecycle_allow_arg ${JSON.stringify(npm)} ${JSON.stringify(join(tmp, "candidate.tgz"))} "$PWD"`,
        ].join("\n"),
        { NPM_FAKE_VERSION: version, NPM_FAKE_ARGS: args },
      );
      expect(result.status).toBe(advisory ? 0 : 1);
      if (advisory) {
        expect(result.stdout).toBe("--allow-scripts=./candidate.tgz");
      } else {
        expect(result.stderr).toContain("without commas");
      }
      expect(existsSync(args)).toBe(false);
    },
  );

  defineInstallerNpmDirectoryIdentityContract(installerContract);

  defineInstallerNpmConfigContract(installerContract);

  it.each(["linux", "darwin"])(
    "rejects OpenClaw GitHub source targets for npm installs on %s",
    (os) => {
      const result = runInstallCliShell(`
      set -euo pipefail
      source "${SCRIPT_PATH}"
      os_detect() { printf '${os}\\n'; }
      OPENCLAW_VERSION=main
      install_openclaw
    `);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("npm installs do not support OpenClaw GitHub source targets");
      expect(result.stdout).toContain("--install-method git --version main");
    },
  );

  defineInstallerNpmRetryContract(installerContract);

  defineInstallerNpmFreshnessContract(installerContract);
});
