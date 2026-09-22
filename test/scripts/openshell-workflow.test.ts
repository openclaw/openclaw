import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const LIVE_E2E_WORKFLOW_PATH = ".github/workflows/openclaw-live-and-e2e-checks-reusable.yml";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function readNulSeparatedArgs(filePath: string): string[] {
  return readFileSync(filePath, "utf8").split("\0").filter(Boolean);
}

function workflowSteps() {
  return parse(readFileSync(LIVE_E2E_WORKFLOW_PATH, "utf8")).jobs.validate_special_e2e
    .steps as Array<{
    name?: string;
    run?: string;
    env?: Record<string, string>;
  }>;
}

describe.skipIf(process.platform !== "linux")("OpenShell hosted bootstrap", () => {
  it("builds the private QA runtime required by special E2E", () => {
    expect(
      workflowSteps().find((step) => step.name === "Build dist for special E2E"),
    ).toMatchObject({
      run: "pnpm build",
      env: { OPENCLAW_BUILD_PRIVATE_QA: "1" },
    });
  });

  it.each([
    {
      name: "success",
      curlExit: 0,
      checksumExit: 0,
      installExit: 0,
      calls: "download\nverify\ninstall\nversion\n",
    },
    {
      name: "partial download",
      curlExit: 28,
      checksumExit: 0,
      installExit: 0,
      calls: "download\n",
    },
    {
      name: "checksum failure",
      curlExit: 0,
      checksumExit: 1,
      installExit: 0,
      calls: "download\nverify\n",
    },
    {
      name: "install failure",
      curlExit: 0,
      checksumExit: 0,
      installExit: 42,
      calls: "download\nverify\ninstall\n",
    },
  ])("verifies the OpenShell package before installation and cleans it on $name", (scenario) => {
    const installStep = expectDefined(
      workflowSteps().find((step) => step.name === "Install OpenShell CLI"),
      "OpenShell install step",
    );
    const run = expectDefined(installStep.run, "OpenShell install command");
    const root = tempDirs.make("openclaw-openshell-package-");
    const result = spawnSync(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        `
curl() {
  printf '%s\\0' "$@" > "$RUNNER_TEMP/curl-args"
  local output=""
  while (( $# )); do
    if [[ "$1" == -o ]]; then shift; output="$1"; fi
    shift
  done
  printf '%s' "$output" > "$RUNNER_TEMP/package-path"
  printf 'fixture package' > "$output"
  printf 'download\\n' >> "$RUNNER_TEMP/calls"
  return "$CURL_EXIT"
}
sha256sum() {
  printf '%s\\0' "$@" > "$RUNNER_TEMP/checksum-args"
  cat > "$RUNNER_TEMP/checksum-input"
  printf 'verify\\n' >> "$RUNNER_TEMP/calls"
  return "$CHECKSUM_EXIT"
}
sudo() {
  printf '%s\\0' "$@" > "$RUNNER_TEMP/install-args"
  local package
  for package in "$@"; do :; done
  cat "$package" > "$RUNNER_TEMP/installed-bytes"
  printf 'install\\n' >> "$RUNNER_TEMP/calls"
  return "$INSTALL_EXIT"
}
openshell() {
  [[ "$*" == --version ]] || return 99
  printf 'version\\n' >> "$RUNNER_TEMP/calls"
}
${run}`,
      ],
      {
        encoding: "utf8",
        timeout: 5_000,
        env: {
          PATH: process.env.PATH,
          RUNNER_TEMP: root,
          CURL_EXIT: String(scenario.curlExit),
          CHECKSUM_EXIT: String(scenario.checksumExit),
          INSTALL_EXIT: String(scenario.installExit),
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(
      scenario.curlExit || scenario.checksumExit || scenario.installExit,
    );
    expect(readFileSync(join(root, "calls"), "utf8")).toBe(scenario.calls);
    const packagePath = readFileSync(join(root, "package-path"), "utf8");
    expect(readNulSeparatedArgs(join(root, "curl-args"))).toEqual([
      "-LsSf",
      "--connect-timeout",
      "10",
      "--max-time",
      "120",
      "-o",
      packagePath,
      "https://github.com/NVIDIA/OpenShell/releases/download/v0.0.109/openshell_0.0.109-1_amd64.deb",
    ]);
    if (scenario.curlExit === 0) {
      expect(readNulSeparatedArgs(join(root, "checksum-args"))).toEqual(["--check", "-"]);
      expect(readFileSync(join(root, "checksum-input"), "utf8")).toBe(
        `0364a21f279023a241d967309ebb0177dadb66bd792eeb3daf542283158ca40f  ${packagePath}\n`,
      );
    }
    if (scenario.curlExit === 0 && scenario.checksumExit === 0) {
      expect(readNulSeparatedArgs(join(root, "install-args"))).toEqual([
        "env",
        "DEBIAN_FRONTEND=noninteractive",
        "apt-get",
        "install",
        "-y",
        packagePath,
      ]);
      expect(readFileSync(join(root, "installed-bytes"), "utf8")).toBe("fixture package");
    }
    expect(existsSync(packagePath)).toBe(false);
  });
});
