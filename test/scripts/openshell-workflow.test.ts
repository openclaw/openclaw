import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const LIVE_E2E_WORKFLOW_PATH = ".github/workflows/openclaw-live-and-e2e-checks-reusable.yml";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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
    ["success", 0, 0, 0, "download\nverify\ninstall\nversion\n"],
    ["partial download", 28, 0, 0, "download\n"],
    ["checksum failure", 0, 1, 0, "download\nverify\n"],
    ["install failure", 0, 0, 42, "download\nverify\ninstall\n"],
  ] as const)(
    "verifies the OpenShell package before installation and cleans it on %s",
    (_name, curlExit, checksumExit, installExit, calls) => {
      const installStep = expectDefined(
        workflowSteps().find((step) => step.name === "Install OpenShell CLI"),
        "OpenShell install step",
      );
      const run = expectDefined(installStep.run, "OpenShell install command");
      const root = tempDirs.make("openclaw-openshell-package-");
      const read = (file: string) => readFileSync(join(root, file), "utf8");
      const args = (command: string) => read(`${command}-args`).split("\0").filter(Boolean);
      const fixture = `
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
${run}`;
      const result = spawnSync("bash", ["--noprofile", "--norc", "-c", fixture], {
        encoding: "utf8",
        timeout: 5_000,
        env: {
          PATH: process.env.PATH,
          RUNNER_TEMP: root,
          CURL_EXIT: String(curlExit),
          CHECKSUM_EXIT: String(checksumExit),
          INSTALL_EXIT: String(installExit),
        },
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(curlExit || checksumExit || installExit);
      expect(read("calls")).toBe(calls);
      const packagePath = read("package-path");
      expect(args("curl")).toEqual([
        ..."-LsSf --connect-timeout 10 --max-time 120 -o".split(" "),
        packagePath,
        "https://github.com/NVIDIA/OpenShell/releases/download/v0.1.3/openshell_0.1.3-1_amd64.deb",
      ]);
      if (curlExit === 0) {
        expect(args("checksum")).toEqual(["--check", "-"]);
        expect(read("checksum-input")).toBe(
          `64000b75aaf7d23763ad43aef6d9d6386325cba7bb636a64539a13ce98f88108  ${packagePath}\n`,
        );
      }
      if (curlExit === 0 && checksumExit === 0) {
        expect(args("install")).toEqual([
          ..."env DEBIAN_FRONTEND=noninteractive apt-get install -y".split(" "),
          packagePath,
        ]);
        expect(read("installed-bytes")).toBe("fixture package");
      }
      expect(existsSync(packagePath)).toBe(false);
    },
  );
});
