// Check Workflows tests cover check workflows script behavior.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

const scriptPath = path.resolve("scripts/check-workflows.mjs");
const tempDirs: string[] = [];

function writeTimeoutHook(tempDir: string): string {
  const hookPath = path.join(tempDir, "shorten-command-timeout.mjs");
  writeFileSync(
    hookPath,
    [
      "const nativeSetTimeout = globalThis.setTimeout;",
      "globalThis.setTimeout = (callback, delay, ...args) =>",
      "  nativeSetTimeout(callback, delay === 300_000 ? 500 : delay === 900_000 ? 2_000 : delay, ...args);",
      "",
    ].join("\n"),
  );
  return hookPath;
}

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

describe("check-workflows", () => {
  it("prints an actionable diagnostic when actionlint and go are unavailable", () => {
    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: "",
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing workflow linter");
    expect(result.stderr).toContain("install actionlint, Go");
  });

  it("uses the pinned go fallback and audits all workflows with zizmor", () => {
    const tempDir = makeTempDir(tempDirs, "check-workflows-");
    const binDir = path.join(tempDir, "bin");
    const markerPath = path.join(tempDir, "go-run.txt");
    const preCommitMarkerPath = path.join(tempDir, "pre-commit.txt");
    mkdirSync(binDir);
    writeFileSync(
      path.join(binDir, "go"),
      [
        "#!/bin/sh",
        'if [ "$1" = "version" ]; then exit 0; fi',
        'if [ "$1" = "run" ]; then printf "%s\\n" "$*" > "$GO_FALLBACK_MARKER"; exit 0; fi',
        "exit 1",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    writeFileSync(
      path.join(binDir, "pre-commit"),
      [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then exit 0; fi',
        'printf "%s\\n" "$*" >> "$PRE_COMMIT_MARKER"',
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    for (const command of ["python3", "node"]) {
      writeFileSync(path.join(binDir, command), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    }

    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        GO_FALLBACK_MARKER: markerPath,
        PRE_COMMIT_MARKER: preCommitMarkerPath,
        PATH: binDir,
      },
    });

    expect(result.status).toBe(0);
    expect(readFileSync(markerPath, "utf8")).toContain(
      "github.com/rhysd/actionlint/cmd/actionlint@v1.7.12",
    );
    const preCommitArgs = readFileSync(preCommitMarkerPath, "utf8");
    expect(preCommitArgs).toContain("run --config .pre-commit-config.yaml zizmor --files");
    expect(preCommitArgs).toContain(".github/workflows/ci.yml");
    expect(preCommitArgs).toContain(".github/workflows/windows-testbox-probe.yml");
  });

  it("lets a slow healthy Go bootstrap exceed the linter budget", () => {
    const tempDir = makeTempDir(tempDirs, "check-workflows-");
    const binDir = path.join(tempDir, "bin");
    const timeoutHookPath = writeTimeoutHook(tempDir);
    mkdirSync(binDir);
    writeFileSync(
      path.join(binDir, "go"),
      [
        "#!/bin/sh",
        'if [ "$1" = "version" ]; then exit 0; fi',
        'if [ "$1" = "run" ]; then sleep 1.2; exit 0; fi',
        "exit 1",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    for (const command of ["pre-commit", "python3", "node"]) {
      writeFileSync(path.join(binDir, command), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    }

    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_OPTIONS: `--import=${pathToFileURL(timeoutHookPath).href}`,
        PATH: binDir,
      },
      timeout: 10_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
  });

  it("applies the bootstrap budget to a non-cooperative Go fallback", () => {
    const tempDir = makeTempDir(tempDirs, "check-workflows-");
    const binDir = path.join(tempDir, "bin");
    const timeoutHookPath = writeTimeoutHook(tempDir);
    mkdirSync(binDir);
    writeFileSync(
      path.join(binDir, "go"),
      [
        `#!${process.execPath}`,
        'if (process.argv[2] === "version") process.exit(0);',
        'process.on("SIGTERM", () => {});',
        "setInterval(() => {}, 10_000);",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_OPTIONS: `--import=${pathToFileURL(timeoutHookPath).href}`,
        PATH: binDir,
      },
      timeout: 10_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "[check-workflows] timed out after 900000ms: go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12",
    );
  });

  it("preserves the venv bootstrap timeout diagnostic", () => {
    const tempDir = makeTempDir(tempDirs, "check-workflows-");
    const binDir = path.join(tempDir, "bin");
    const timeoutHookPath = writeTimeoutHook(tempDir);
    mkdirSync(binDir);
    writeFileSync(
      path.join(binDir, "python3"),
      [
        `#!${process.execPath}`,
        'if (process.argv[2] === "--version") process.exit(0);',
        'if (process.argv[2] === "-m" && process.argv[3] === "pre_commit") process.exit(1);',
        'process.on("SIGTERM", () => {});',
        "setInterval(() => {}, 10_000);",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_OPTIONS: `--import=${pathToFileURL(timeoutHookPath).href}`,
        PATH: binDir,
      },
      timeout: 10_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("[check-workflows] timed out after 900000ms: python3 -m venv");
    expect(result.stderr).not.toContain("missing pre-commit runtime");
  });

  it("fails with an actionable timeout when a workflow command ignores SIGTERM", () => {
    const tempDir = makeTempDir(tempDirs, "check-workflows-");
    const binDir = path.join(tempDir, "bin");
    const timeoutHookPath = writeTimeoutHook(tempDir);
    mkdirSync(binDir);
    writeFileSync(
      path.join(binDir, "actionlint"),
      [
        `#!${process.execPath}`,
        'if (process.argv[2] === "--version") process.exit(0);',
        'process.on("SIGTERM", () => {});',
        "setInterval(() => {}, 10_000);",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_OPTIONS: `--import=${pathToFileURL(timeoutHookPath).href}`,
        PATH: binDir,
      },
      timeout: 5_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("[check-workflows] timed out after 300000ms: actionlint");
    expect(result.stderr).toContain(".github/workflows/ci.yml");
  });

  it.skipIf(process.platform === "win32")(
    "cleans up a surviving descendant when the POSIX leader exits first",
    async () => {
      const tempDir = makeTempDir(tempDirs, "check-workflows-");
      const binDir = path.join(tempDir, "bin");
      const timeoutHookPath = writeTimeoutHook(tempDir);
      const survivorMarker = path.join(tempDir, "survivor.pid");
      mkdirSync(binDir);
      writeFileSync(
        path.join(binDir, "actionlint"),
        [
          `#!${process.execPath}`,
          `import { spawn } from "node:child_process";`,
          `if (process.argv[2] === "--version") process.exit(0);`,
          `spawn(process.execPath, ["-e", "require('node:fs').writeFileSync(process.env.CHECK_WORKFLOWS_SURVIVOR_MARKER, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 10_000);"], {`,
          `  env: { ...process.env, CHECK_WORKFLOWS_SURVIVOR_MARKER: process.env.CHECK_WORKFLOWS_SURVIVOR_MARKER },`,
          `  stdio: "ignore",`,
          `});`,
          `process.on("SIGTERM", () => process.exit(0));`,
          `setInterval(() => {}, 10_000);`,
          "",
        ].join("\n"),
        { mode: 0o755 },
      );

      const result = spawnSync(process.execPath, [scriptPath], {
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_OPTIONS: `--import=${pathToFileURL(timeoutHookPath).href}`,
          CHECK_WORKFLOWS_SURVIVOR_MARKER: survivorMarker,
          PATH: binDir,
        },
        timeout: 10_000,
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("[check-workflows] timed out after 300000ms: actionlint");
      expect(existsSync(survivorMarker)).toBe(true);
      const survivorPid = Number(readFileSync(survivorMarker, "utf8"));
      expect(Number.isInteger(survivorPid) && survivorPid > 0).toBe(true);

      // The checker must not settle on the leader's exit while its survivor is
      // still running: escalation (SIGKILL after the grace period) must finish
      // the group before the timed-out run resolves.
      const deadline = Date.now() + 5_000;
      let survivorGone = false;
      while (Date.now() < deadline && !survivorGone) {
        try {
          process.kill(survivorPid, 0);
        } catch {
          survivorGone = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(survivorGone).toBe(true);
    },
  );

  it("surfaces a timed-out discovery probe instead of silently falling back", () => {
    const tempDir = makeTempDir(tempDirs, "check-workflows-");
    const binDir = path.join(tempDir, "bin");
    const timeoutHookPath = writeTimeoutHook(tempDir);
    mkdirSync(binDir);
    writeFileSync(
      path.join(binDir, "actionlint"),
      [
        `#!${process.execPath}`,
        'process.on("SIGTERM", () => {});',
        "setInterval(() => {}, 10_000);",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_OPTIONS: `--import=${pathToFileURL(timeoutHookPath).href}`,
        PATH: binDir,
      },
      timeout: 10_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "[check-workflows] timed out after 300000ms: actionlint --version",
    );
    expect(result.stderr).not.toContain("missing workflow linter");
  });

  it("bootstraps pinned pre-commit in a temporary Python venv when needed", () => {
    const tempDir = makeTempDir(tempDirs, "check-workflows-");
    const binDir = path.join(tempDir, "bin");
    const markerPath = path.join(tempDir, "python.txt");
    mkdirSync(binDir);
    writeFileSync(path.join(binDir, "node"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(
      path.join(binDir, "python3"),
      [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then exit 0; fi',
        'if [ "$1" = "-m" ] && [ "$2" = "pre_commit" ] && [ "$3" = "--version" ]; then exit 1; fi',
        'if [ "$1" = "-m" ] && [ "$2" = "pip" ]; then',
        '  printf "%s\\n" "$*" >> "$PRE_COMMIT_BOOTSTRAP_MARKER"',
        "  exit 0",
        "fi",
        'if [ "$1" = "-m" ] && [ "$2" = "pre_commit" ]; then',
        '  printf "%s\\n" "$*" >> "$PRE_COMMIT_BOOTSTRAP_MARKER"',
        "  exit 0",
        "fi",
        'if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then',
        '  /bin/mkdir -p "$3/bin"',
        '  /bin/cp "$0" "$3/bin/python"',
        '  /bin/chmod +x "$3/bin/python"',
        "  exit 0",
        "fi",
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: binDir,
        PRE_COMMIT_BOOTSTRAP_MARKER: markerPath,
      },
    });

    expect(result.status).toBe(0);
    const pythonArgs = readFileSync(markerPath, "utf8");
    expect(pythonArgs).toContain("-m pip install --disable-pip-version-check pre-commit==4.2.0");
    expect(pythonArgs).toContain(
      "-m pre_commit run --config .pre-commit-config.yaml actionlint --files",
    );
    expect(pythonArgs).toContain(
      "-m pre_commit run --config .pre-commit-config.yaml zizmor --files",
    );
  });

  it("prints the missing runtime diagnostic when Python venv support is unavailable", () => {
    const tempDir = makeTempDir(tempDirs, "check-workflows-");
    const binDir = path.join(tempDir, "bin");
    mkdirSync(binDir);
    writeFileSync(path.join(binDir, "node"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(
      path.join(binDir, "python3"),
      [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then exit 0; fi',
        'if [ "$1" = "-m" ] && [ "$2" = "pre_commit" ] && [ "$3" = "--version" ]; then exit 1; fi',
        'if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then',
        '  printf "%s\\n" "python venv unavailable" >&2',
        "  exit 1",
        "fi",
        "exit 1",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: binDir,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("python venv unavailable");
    expect(result.stderr).toContain("missing pre-commit runtime for actionlint");
    expect(result.stderr).toContain("Python venv support for pre-commit 4.2.0");
  });

  it("cleans the temporary Python venv before exiting on hook failure", () => {
    const tempDir = makeTempDir(tempDirs, "check-workflows-");
    const binDir = path.join(tempDir, "bin");
    const markerPath = path.join(tempDir, "venv-path.txt");
    mkdirSync(binDir);
    writeFileSync(path.join(binDir, "node"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(
      path.join(binDir, "python3"),
      [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then exit 0; fi',
        'if [ "$1" = "-m" ] && [ "$2" = "pre_commit" ] && [ "$3" = "--version" ]; then exit 1; fi',
        'if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then',
        '  /bin/mkdir -p "$3/bin"',
        '  /bin/cp "$0" "$3/bin/python"',
        '  /bin/chmod +x "$3/bin/python"',
        '  printf "%s\\n" "$3" > "$PRE_COMMIT_VENV_MARKER"',
        "  exit 0",
        "fi",
        'if [ "$1" = "-m" ] && [ "$2" = "pip" ]; then exit 0; fi',
        'if [ "$1" = "-m" ] && [ "$2" = "pre_commit" ]; then',
        '  printf "%s\\n" "hook failed" >&2',
        "  exit 13",
        "fi",
        "exit 1",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: binDir,
        PRE_COMMIT_VENV_MARKER: markerPath,
      },
    });

    expect(result.status).toBe(13);
    expect(result.stderr).toContain("hook failed");
    expect(existsSync(readFileSync(markerPath, "utf8").trim())).toBe(false);
  });

  it("keeps Windows WSL2 probe output normalized through the shared wrapper", () => {
    const workflow = readFileSync(".github/workflows/windows-testbox-probe.yml", "utf8");

    expect(workflow).toContain(
      '$import = Invoke-WslText -Arguments @("--import", "UbuntuProbe", $wslRoot, $rootfs, "--version", "2")',
    );
    expect(workflow).toContain("function Resolve-UbuntuWslRootfsUrl");
    expect(workflow).toContain('"x64" { $wslArch = "amd64" }');
    expect(workflow).toContain('"arm64" { $wslArch = "arm64" }');
    expect(workflow).toContain("ubuntu-noble-wsl-$wslArch-wsl.rootfs.tar.gz");
    expect(workflow).toContain("ubuntu_wsl_rootfs_arch=$wslArch");
    expect(workflow).toContain("-ConnectionTimeoutSeconds 15");
    expect(workflow).toContain("-OperationTimeoutSeconds 120");
    expect(workflow).toContain('Write-Host "wsl_import_exit=$($import.Code)"');
    expect(workflow).toContain("wsl2_restart_required=true");
    expect(workflow).toContain("import_ubuntu_wsl2=skipped_restart_required");
    expect(workflow).toContain("wsl_exec_skipped=restart_required");
    expect(workflow).toContain(
      '"wsl2_restart_required=$($restartRequired.ToString().ToLowerInvariant())"',
    );
    expect(workflow).toContain(
      '$exec = Invoke-WslText -Arguments @("-d", $distro, "--exec", "bash", "-lc"',
    );
    expect(workflow).toContain('Write-Host "wsl_exec_exit=$($exec.Code)"');
    expect(workflow).not.toContain("wsl.exe --import UbuntuProbe");
    expect(workflow).not.toContain("Microsoft-Hyper-V-All");
  });

  it("keeps the Windows probe CI shard opt-in and dependency-backed", () => {
    const workflow = readFileSync(".github/workflows/windows-testbox-probe.yml", "utf8");

    expect(workflow).toContain("run_windows_ci:");
    expect(workflow).toContain(
      'description: "Run the focused Windows CI shard and native Scheduled Task proof"',
    );
    expect(workflow).toContain("default: false");
    expect(workflow).toContain("if: ${{ inputs.run_windows_ci }}");
    expect(workflow).toContain("source .github/actions/setup-pnpm-store-cache/ensure-node.sh");
    expect(workflow).toContain("uses: ./.github/actions/setup-pnpm-store-cache");
    expect(workflow).toContain("pnpm install --frozen-lockfile --prefer-offline");
    expect(workflow).toContain("pnpm test:windows:ci");
    expect(workflow).toContain("pnpm test:windows:schtasks:integration");
    expect(workflow).toContain('CI_WINDOWS_SCHTASKS_HEAD="$(git rev-parse HEAD)"');
    expect(workflow).toContain('if [[ "$CI_WINDOWS_SCHTASKS_HEAD" != "$EXPECTED_HEAD" ]]; then');
    expect(workflow).toContain('$activePidPath = Join-Path $env:TEST_ROOT "active-pid.txt"');
    expect(workflow).toContain('$process.CommandLine -like "*$probePath*"');
    expect(workflow).toContain('$process.CommandLine -like "*$eventsPath*"');
    expect(workflow).toContain("schtasks.exe /Delete /F /TN $taskName");
    expect(workflow).toContain('$service = New-Object -ComObject "Schedule.Service"');
    expect(workflow).toContain("failure-diagnostics.json");
    expect(workflow).toContain("cleanup-summary.txt");
    expect(workflow).not.toContain("task-before-cleanup.xml");
    expect(workflow).not.toContain("Copy-Item -LiteralPath $stateDir");
    expect(workflow).toContain("          exit 0");
    expect(workflow).toContain(".artifacts/windows-schtasks/");
    expect(workflow).toContain("if: ${{ always() && !cancelled() }}");
    expect(workflow).toContain("if: ${{ always() && !cancelled() && inputs.require_wsl2 }}");
  });
});
