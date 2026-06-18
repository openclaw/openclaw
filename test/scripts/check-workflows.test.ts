// Check Workflows tests cover check workflows script behavior.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = path.resolve("scripts/check-workflows.mjs");

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
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "check-workflows-"));
    try {
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
        "github.com/rhysd/actionlint/cmd/actionlint@v1.7.11",
      );
      const preCommitArgs = readFileSync(preCommitMarkerPath, "utf8");
      expect(preCommitArgs).toContain("run --config .pre-commit-config.yaml zizmor --files");
      expect(preCommitArgs).toContain(".github/workflows/ci.yml");
      expect(preCommitArgs).toContain(".github/workflows/windows-testbox-probe.yml");
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("bootstraps pinned pre-commit in a temporary Python venv when needed", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "check-workflows-"));
    try {
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
      expect(pythonArgs).toContain(
        "-m pip install --disable-pip-version-check pre-commit==4.2.0",
      );
      expect(pythonArgs).toContain(
        "-m pre_commit run --config .pre-commit-config.yaml actionlint --files",
      );
      expect(pythonArgs).toContain(
        "-m pre_commit run --config .pre-commit-config.yaml zizmor --files",
      );
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("keeps Windows WSL2 probe output normalized through the shared wrapper", () => {
    const workflow = readFileSync(".github/workflows/windows-testbox-probe.yml", "utf8");

    expect(workflow).toContain(
      '$import = Invoke-WslText -Arguments @("--import", "UbuntuProbe", $wslRoot, $rootfs, "--version", "2")',
    );
    expect(workflow).toContain('Write-Host "wsl_import_exit=$($import.Code)"');
    expect(workflow).toContain(
      '$exec = Invoke-WslText -Arguments @("-d", $distro, "--exec", "bash", "-lc"',
    );
    expect(workflow).toContain('Write-Host "wsl_exec_exit=$($exec.Code)"');
    expect(workflow).not.toContain("wsl.exe --import UbuntuProbe");
  });

  it("keeps the Windows probe CI shard opt-in and dependency-backed", () => {
    const workflow = readFileSync(".github/workflows/windows-testbox-probe.yml", "utf8");

    expect(workflow).toContain("run_windows_ci:");
    expect(workflow).toContain('description: "Run the focused Windows-native CI test shard after probing"');
    expect(workflow).toContain("default: false");
    expect(workflow).toContain("if: ${{ inputs.run_windows_ci }}");
    expect(workflow).toContain("source .github/actions/setup-pnpm-store-cache/ensure-node.sh");
    expect(workflow).toContain("uses: ./.github/actions/setup-pnpm-store-cache");
    expect(workflow).toContain("pnpm install --frozen-lockfile --prefer-offline");
    expect(workflow).toContain("pnpm test:windows:ci");
    expect(workflow).toContain("if: ${{ always() && !cancelled() }}");
    expect(workflow).toContain("if: ${{ always() && !cancelled() && inputs.require_wsl2 }}");
  });
});
