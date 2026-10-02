import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { runInNewContext } from "node:vm";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../helpers/fixture-receipts.js";
import { withinTest } from "../helpers/promise.js";
import { createTempDirTracker, useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT_PATH = "scripts/test-install-sh-docker.sh";
const INSTALL_E2E_DOCKER_PATH = "scripts/test-install-sh-e2e-docker.sh";
const INSTALL_E2E_RUNNER_PATH = "scripts/docker/install-sh-e2e/run.sh";
const DOCKER_SETUP_PATH = "scripts/docker/setup.sh";
const HOST_TIMEOUT_PATH = "scripts/lib/host-timeout.sh";
const PODMAN_SETUP_PATH = "scripts/podman/setup.sh";
const PODMAN_QUADLET_TEMPLATE_PATH = "scripts/podman/openclaw.container.in";
const PODMAN_RUN_PATH = "scripts/run-openclaw-podman.sh";
const SMOKE_RUNNER_PATH = "scripts/docker/install-sh-smoke/run.sh";
const NONROOT_DOCKERFILE_PATH = "scripts/docker/install-sh-nonroot/Dockerfile";
const NONROOT_RUNNER_PATH = "scripts/docker/install-sh-nonroot/run.sh";
const BUN_GLOBAL_SMOKE_PATH = "scripts/e2e/bun-global-install-smoke.sh";
const BUN_GLOBAL_ASSERTIONS_PATH = "scripts/e2e/lib/bun-global-install/assertions.mjs";
const DOCKER_E2E_PACKAGE_HELPER_PATH = "scripts/lib/docker-e2e-package.sh";
const INSTALL_SMOKE_WORKFLOW_PATH = ".github/workflows/install-smoke-reusable.yml";
const LIVE_E2E_WORKFLOW_PATH = ".github/workflows/openclaw-live-and-e2e-checks-reusable.yml";
const tempDirs = createTempDirTracker();
let fixtureReceipts: FixtureReceiptChannel;
beforeAll(async () => {
  fixtureReceipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await fixtureReceipts.close();
});
const testNodeExecPath = resolveTestNodeExecPath();

afterEach(() => {
  tempDirs.cleanup();
});

class ScriptExit extends Error {
  constructor(readonly status: number) {
    super(`script exited ${String(status)}`);
  }
}

function extractNonrootNodePreflight(): string {
  const script = readFileSync(NONROOT_RUNNER_PATH, "utf8");
  const match = script.match(/node -e '\n([\s\S]*?)\n'\ncommand -v npm/u);
  if (!match) {
    throw new Error("non-root smoke Node preflight was not found");
  }
  return expectDefined(match[1], "non-root smoke Node preflight capture");
}

function extractInstallE2eInstallerFunction(): string {
  const script = readFileSync(INSTALL_E2E_RUNNER_PATH, "utf8");
  const startMarker = "run_official_installer() (\n";
  const endMarker = "\n\nverify_installed_version()";
  const start = script.indexOf(startMarker);
  const end = script.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end <= start) {
    throw new Error("install E2E installer function was not found");
  }
  return script.slice(start, end);
}

function extractNonrootInstallerStep(): string {
  const script = readFileSync(NONROOT_RUNNER_PATH, "utf8");
  const startMarker = 'echo "==> Run installer (non-root user)"';
  const endMarker = "\n\n# Ensure PATH";
  const start = script.indexOf(startMarker);
  const end = script.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end <= start) {
    throw new Error("non-root installer step was not found");
  }
  return script.slice(start, end);
}

function extractDockerTimezoneValidator(): string {
  const script = readFileSync(DOCKER_SETUP_PATH, "utf8");
  const match = script.match(
    /(is_valid_timezone_in_image\(\) \{[\s\S]*?\n\})\n\nvalidate_mount_path_value/u,
  );
  if (!match) {
    throw new Error("Docker timezone validator was not found");
  }
  return expectDefined(match[1], "Docker timezone validator capture");
}

function runDockerTimezoneValidator(timezone: string) {
  const root = tempDirs.make("openclaw-docker-timezone-");
  const binDir = join(root, "bin");
  const dockerPath = join(binDir, "docker");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    dockerPath,
    [
      "#!/bin/bash",
      "set -euo pipefail",
      'while [[ "$#" -gt 0 && "$1" != "-e" ]]; do shift; done',
      'exec "$HOST_NODE" "$@"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  return spawnSync(
    "bash",
    [
      "--noprofile",
      "--norc",
      "-c",
      `${extractDockerTimezoneValidator()}\nIMAGE_NAME=openclaw:test\nis_valid_timezone_in_image "$TIMEZONE"`,
    ],
    {
      encoding: "utf8",
      env: {
        HOME: root,
        HOST_NODE: testNodeExecPath,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        TIMEZONE: timezone,
      },
    },
  );
}

function runInstallE2eInstallerFixture(params: {
  curlExitCode?: number;
  installTag: string;
  installerBody: string;
}) {
  const root = tempDirs.make("openclaw-install-e2e-download-");
  const binDir = join(root, "bin");
  const curlPath = join(binDir, "curl");
  const curlArgsPath = join(root, "curl-args.txt");
  const installerSourcePath = join(root, "installer-source.sh");
  const markerPath = join(root, "installer-marker.txt");
  const outputPathCapture = join(root, "curl-output-path.txt");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(installerSourcePath, params.installerBody);
  writeFileSync(
    curlPath,
    [
      "#!/bin/sh",
      "set -eu",
      'printf \'%s\\n\' "$*" >"$CURL_ARGS_PATH"',
      'output=""',
      'while [ "$#" -gt 0 ]; do',
      '  if [ "$1" = "-o" ]; then',
      "    shift",
      '    output="$1"',
      "  fi",
      "  shift",
      "done",
      'cp "$FAKE_INSTALLER_SOURCE" "$output"',
      'printf "%s" "$output" >"$OUTPUT_PATH_CAPTURE"',
      'exit "$FAKE_CURL_EXIT"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CURL_ARGS_PATH: curlArgsPath,
    FAKE_CURL_EXIT: String(params.curlExitCode ?? 0),
    FAKE_INSTALLER_SOURCE: installerSourcePath,
    INSTALL_MARKER: markerPath,
    OUTPUT_PATH_CAPTURE: outputPathCapture,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
  };
  delete env.OPENCLAW_BETA;
  delete env.OPENCLAW_VERSION;

  const result = spawnSync(
    "/bin/bash",
    [
      "-c",
      [
        "set -u",
        extractInstallE2eInstallerFunction(),
        'INSTALL_URL="https://installer.example.test/install.sh"',
        `INSTALL_TAG=${JSON.stringify(params.installTag)}`,
        "run_official_installer",
      ].join("\n"),
    ],
    {
      encoding: "utf8",
      env,
    },
  );

  return { curlArgsPath, markerPath, outputPathCapture, result };
}

function runNonrootInstallerFixture(curlExitCode: number) {
  const root = tempDirs.make("openclaw-install-nonroot-download-");
  const binDir = join(root, "bin");
  const curlArgsPath = join(root, "curl-args.txt");
  const markerPath = join(root, "installer-marker.txt");
  const outputPathCapture = join(root, "curl-output-path.txt");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(binDir, "curl"),
    [
      "#!/bin/sh",
      "set -eu",
      `printf '%s\\0' "$@" >"$CURL_ARGS_PATH"`,
      'output=""',
      'while [ "$#" -gt 0 ]; do',
      '  if [ "$1" = "-o" ]; then',
      "    shift",
      '    output="$1"',
      "  fi",
      "  shift",
      "done",
      `printf '%s\\n' 'touch "$INSTALL_MARKER"' >"$output"`,
      'chmod +x "$output"',
      'printf "%s" "$output" >"$OUTPUT_PATH_CAPTURE"',
      'exit "$FAKE_CURL_EXIT"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const result = spawnSync(
    "/bin/bash",
    [
      "--noprofile",
      "--norc",
      "-c",
      [
        "set -euo pipefail",
        'INSTALL_URL="https://installer.example.test/install.sh"',
        extractNonrootInstallerStep(),
      ].join("\n"),
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CURL_ARGS_PATH: curlArgsPath,
        FAKE_CURL_EXIT: String(curlExitCode),
        INSTALL_MARKER: markerPath,
        OUTPUT_PATH_CAPTURE: outputPathCapture,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
    },
  );

  return { curlArgsPath, markerPath, outputPathCapture, result };
}

function runNonrootNodePreflight(
  version: string,
  options: { sqlite?: boolean; sqliteVersion?: string } = {},
) {
  const stderr: string[] = [];
  try {
    runInNewContext(extractNonrootNodePreflight(), {
      process: {
        versions: { node: version },
        stderr: {
          write(message: string) {
            stderr.push(message);
          },
        },
        exit(status: number) {
          throw new ScriptExit(status);
        },
      },
      require(specifier: string) {
        if (specifier === "node:sqlite" && options.sqlite === false) {
          throw new Error("missing node:sqlite");
        }
        return {
          DatabaseSync: class {
            prepare() {
              return {
                get: () => ({ version: options.sqliteVersion ?? "3.51.3" }),
              };
            }

            close() {}
          },
        };
      },
    });
    return { status: 0, stderr: stderr.join("") };
  } catch (error) {
    if (error instanceof ScriptExit) {
      return { status: error.status, stderr: stderr.join("") };
    }
    throw error;
  }
}

function runDefaultSmokePlatform(env: Record<string, string>, hostArch: string): string {
  const script = readFileSync(SCRIPT_PATH, "utf8");
  const match = script.match(/^SMOKE_PLATFORM=.*$/mu);
  if (!match) {
    throw new Error("install smoke platform assignment was not found");
  }
  const result = spawnSync(
    "bash",
    [
      "--noprofile",
      "--norc",
      "-c",
      `source scripts/lib/docker-build.sh\nuname() { if [[ "\${1:-}" == "-m" ]]; then printf "%s" "$FAKE_UNAME_ARCH"; else command uname "$@"; fi; }\n${match[0]}\nprintf '%s' "$SMOKE_PLATFORM"`,
    ],
    {
      encoding: "utf8",
      env: {
        HOME: "/tmp",
        PATH: process.env.PATH ?? "",
        FAKE_UNAME_ARCH: hostArch,
        ...env,
      },
    },
  );
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return result.stdout;
}

function extractInstallE2eAgentJsonParser(): string {
  const script = readFileSync(INSTALL_E2E_RUNNER_PATH, "utf8");
  const match = script.match(
    /node - <<'NODE' "\$out_json"\n([\s\S]*?)\nNODE\n\}\n\nRUN_AGENT_TURN_BG_PID/u,
  );
  if (!match) {
    throw new Error("install E2E agent JSON parser was not found");
  }
  return expectDefined(match[1], "install E2E agent JSON parser capture");
}

function normalizeInstallE2eAgentOutput(output: string) {
  const root = mkdtempSync(join(tmpdir(), "openclaw-install-e2e-agent-output-"));
  const outputPath = join(root, "agent.json");
  writeFileSync(outputPath, output, "utf8");
  try {
    const result = spawnSync(testNodeExecPath, ["-", outputPath], {
      encoding: "utf8",
      input: extractInstallE2eAgentJsonParser(),
    });
    return {
      output: readFileSync(outputPath, "utf8"),
      status: result.status,
      stderr: result.stderr,
    };
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function extractInstallSmokeUpdateJsonParser(): string {
  const script = readFileSync(SMOKE_RUNNER_PATH, "utf8");
  const match = script.match(
    /UPDATE_JSON="\$UPDATE_JSON" \\\n[\s\S]*?node - <<'NODE'\n([\s\S]*?)\nNODE\n\n {2}echo "==> Verify updated version"/u,
  );
  if (!match) {
    throw new Error("install smoke update JSON parser was not found");
  }
  return expectDefined(match[1], "install smoke update JSON parser capture");
}

function validateInstallSmokeUpdateJson(doctorStep?: Record<string, unknown>) {
  const updateUrl = "http://candidate.invalid/openclaw.tgz";
  const payload = {
    status: "ok",
    before: { version: "2026.7.0" },
    after: { version: "2026.7.1" },
    steps: [
      {
        name: "global update",
        exitCode: 0,
        command: `npm install ${updateUrl}`,
      },
      ...(doctorStep ? [doctorStep] : []),
    ],
  };
  return spawnSync(testNodeExecPath, ["-"], {
    encoding: "utf8",
    input: extractInstallSmokeUpdateJsonParser(),
    env: {
      ...process.env,
      UPDATE_JSON: JSON.stringify(payload),
      UPDATE_EXPECT_VERSION: payload.after.version,
      UPDATE_BASELINE_VERSION: payload.before.version,
      UPDATE_TAG_URL: updateUrl,
    },
  });
}

function extractInstallSmokeInstallerPipeline(): string {
  const script = readFileSync(SMOKE_RUNNER_PATH, "utf8");
  const match = script.match(/(run_installer_pipeline\(\) \{[\s\S]*?\n\})\n\nrun_install_smoke/u);
  if (!match) {
    throw new Error("install smoke installer pipeline helper was not found");
  }
  return expectDefined(match[1], "install smoke installer pipeline helper capture");
}

function readNulSeparatedArgs(filePath: string): string[] {
  return readFileSync(filePath, "utf8").split("\0").filter(Boolean);
}

function runInstallSmokeInstallerPipelineFixture(params: {
  curlExitCode?: number;
  installerArgs: string[];
}) {
  const root = tempDirs.make("openclaw-install-smoke-pipeline-");
  const binDir = join(root, "bin");
  const curlArgsPath = join(root, "curl-args.txt");
  const installerArgsPath = join(root, "installer-args.txt");
  const installerMarkerPath = join(root, "installer-ran");
  const installerSourcePath = join(root, "installer.sh");
  const timeoutArgsPath = join(root, "timeout-args.txt");
  const installUrl = "https://installer.example.test/install.sh?channel=beta&trace=1";
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(binDir, "timeout"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `printf '%s\\0' "$@" >"$TIMEOUT_ARGS_PATH"`,
      "shift 2",
      'exec "$@"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  writeFileSync(
    join(binDir, "curl"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `printf '%s\\0' "$@" >"$CURL_ARGS_PATH"`,
      'cat "$FAKE_INSTALLER_SOURCE"',
      'exit "$FAKE_CURL_EXIT"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  writeFileSync(
    installerSourcePath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `printf '%s\\0' "$@" >"$INSTALLER_ARGS_PATH"`,
      'touch "$INSTALLER_MARKER_PATH"',
      "",
    ].join("\n"),
  );

  const result = spawnSync(
    "/bin/bash",
    [
      "--noprofile",
      "--norc",
      "-c",
      `set -euo pipefail
${extractInstallSmokeInstallerPipeline()}
run_installer_pipeline "$INSTALL_URL" "$@"`,
      "_",
      ...params.installerArgs,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CURL_ARGS_PATH: curlArgsPath,
        FAKE_CURL_EXIT: String(params.curlExitCode ?? 0),
        FAKE_INSTALLER_SOURCE: installerSourcePath,
        INSTALLER_ARGS_PATH: installerArgsPath,
        INSTALLER_MARKER_PATH: installerMarkerPath,
        INSTALL_COMMAND_TIMEOUT: "17",
        INSTALL_URL: installUrl,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        TIMEOUT_ARGS_PATH: timeoutArgsPath,
      },
    },
  );

  return {
    curlArgsPath,
    installUrl,
    installerArgsPath,
    installerMarkerPath,
    result,
    timeoutArgsPath,
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function extractReadPackTarballFilename(): string {
  const script = readFileSync(SCRIPT_PATH, "utf8");
  const match = script.match(/(read_pack_tarball_filename\(\) \{[\s\S]*?\n\})\n\nSMOKE_IMAGE/u);
  if (!match) {
    throw new Error("read_pack_tarball_filename helper was not found");
  }
  return expectDefined(match[1], "pack tarball filename helper capture");
}

function extractInstallSmokePackHelper(name: string, nextName: string): string {
  const script = readFileSync(SCRIPT_PATH, "utf8");
  const start = script.indexOf(`${name}() {`);
  const end = script.indexOf(`\n\n${nextName}() {`, start);
  if (start < 0 || end <= start) {
    throw new Error(`${name} helper was not found`);
  }
  return script.slice(start, end);
}

function runInstallSmokePackHelpers(packJson: unknown, budgetBytes?: number) {
  const root = tempDirs.make("openclaw-install-pack-helper-");
  const packJsonPath = join(root, "pack.json");
  writeFileSync(packJsonPath, JSON.stringify(packJson), "utf8");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PACK_JSON_PATH: packJsonPath,
    HARNESS_ROOT: process.cwd(),
    GITHUB_ACTIONS: "false",
  };
  delete env.OPENCLAW_INSTALL_SMOKE_PACK_UNPACKED_BUDGET_BYTES;
  if (budgetBytes !== undefined) {
    env.OPENCLAW_INSTALL_SMOKE_PACK_UNPACKED_BUDGET_BYTES = String(budgetBytes);
  }
  const result = spawnSync(
    "bash",
    [
      "--noprofile",
      "--norc",
      "-c",
      `set -euo pipefail
${extractInstallSmokePackHelper("normalize_npm_pack_json_file", "run_install_smoke_container")}
${extractInstallSmokePackHelper("assert_pack_unpacked_size_budget", "print_pack_delta_audit")}
normalize_npm_pack_json_file "$PACK_JSON_PATH"
assert_pack_unpacked_size_budget "fixture" "$PACK_JSON_PATH"`,
    ],
    {
      encoding: "utf8",
      env,
    },
  );
  return {
    normalized: JSON.parse(readFileSync(packJsonPath, "utf8")),
    result,
  };
}

function runReadPackTarballFilename(filename: string) {
  return spawnSync(
    "bash",
    [
      "--noprofile",
      "--norc",
      "-c",
      `${extractReadPackTarballFilename()}
pack_json_file="$(mktemp)"
trap 'rm -f "$pack_json_file"' EXIT
printf '%s' "$PACK_JSON" >"$pack_json_file"
read_pack_tarball_filename "$pack_json_file"`,
    ],
    {
      encoding: "utf8",
      env: {
        HOME: "/tmp",
        PACK_JSON: JSON.stringify([{ filename }]),
        PATH: process.env.PATH ?? "",
      },
    },
  );
}

function extractEnsureLocalUpdateDistImportClosure(): string {
  const script = readFileSync(SCRIPT_PATH, "utf8");
  const match = script.match(
    /(ensure_local_update_dist_import_closure\(\) \{[\s\S]*?\n\})\n\nread_candidate_version/u,
  );
  if (!match) {
    throw new Error("ensure_local_update_dist_import_closure helper was not found");
  }
  return expectDefined(match[1], "local update import closure helper capture");
}

type RestorePathEscape = "packages" | "ai";

function runRestoreLocalDistFixture(
  options: { failAiSwap?: boolean; symlinkEscape?: RestorePathEscape } = {},
) {
  const fixtureRoot = tempDirs.make("openclaw-install-restore-root-");
  const imageRoot = tempDirs.make("openclaw-install-restore-image-");
  let externalSentinel = "";
  for (const [relativePath, contents] of [
    ["dist/root.txt", "old-root"],
    ["packages/ai/dist/ai.txt", "old-ai"],
    ["packages/ai/package.json", "{}"],
  ] as const) {
    const target = join(fixtureRoot, relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  for (const [relativePath, contents] of [
    ["app/dist/root.txt", "new-root"],
    ["app/node_modules/@openclaw/ai/dist/ai.txt", "new-ai"],
  ] as const) {
    const target = join(imageRoot, relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }

  if (options.symlinkEscape) {
    const escapeRoot = tempDirs.make("openclaw-install-restore-escape-");
    const externalAiRoot =
      options.symlinkEscape === "packages" ? join(escapeRoot, "packages", "ai") : escapeRoot;
    externalSentinel = join(externalAiRoot, "dist", "ai.txt");
    mkdirSync(path.dirname(externalSentinel), { recursive: true });
    writeFileSync(join(externalAiRoot, "package.json"), "{}");
    writeFileSync(externalSentinel, "external-ai");
    if (options.symlinkEscape === "packages") {
      rmSync(join(fixtureRoot, "packages"), { force: true, recursive: true });
      symlinkSync(join(escapeRoot, "packages"), join(fixtureRoot, "packages"), "dir");
    } else {
      rmSync(join(fixtureRoot, "packages", "ai"), { force: true, recursive: true });
      symlinkSync(externalAiRoot, join(fixtureRoot, "packages", "ai"), "dir");
    }
  }

  return spawnSync(
    "bash",
    [
      "--noprofile",
      "--norc",
      "-c",
      `set -euo pipefail
REPO_ROOT="$FIXTURE_REPO"
ROOT_DIR="$FIXTURE_ROOT"
IMAGE_ROOT="$FIXTURE_IMAGE"
docker_e2e_docker_cmd() {
  printf 'docker-call=%s\\n' "$1" >&2
  case "$1" in
    create)
      printf "fixture"
      ;;
    cp)
      local source="\${2#fixture:}"
      cp -R "$IMAGE_ROOT$source" "$3"
      ;;
    rm)
      ;;
    *)
      return 2
      ;;
  esac
}
docker_e2e_docker_run_cmd() {
  docker_e2e_docker_cmd "$@"
}
mv() {
  if [[ "$FAIL_AI_SWAP" == "1" && "$1" == */ai-dist && "$2" == */packages/ai/dist ]]; then
    return 1
  fi
  command mv "$@"
}
source "$REPO_ROOT/${DOCKER_E2E_PACKAGE_HELPER_PATH}"
status=0
docker_e2e_restore_package_dist_from_image fixture-image || status=$?
printf 'status=%s\\n' "$status"
printf 'root=%s\\n' "$(cat "$ROOT_DIR/dist/root.txt")"
printf 'ai=%s\\n' "$(cat "$ROOT_DIR/packages/ai/dist/ai.txt")"
if [[ -n "$EXTERNAL_SENTINEL" ]]; then
  printf 'external=%s\\n' "$(cat "$EXTERNAL_SENTINEL")"
fi
`,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        FAIL_AI_SWAP: options.failAiSwap ? "1" : "0",
        EXTERNAL_SENTINEL: externalSentinel,
        FIXTURE_IMAGE: imageRoot,
        FIXTURE_REPO: process.cwd(),
        FIXTURE_ROOT: fixtureRoot,
      },
    },
  );
}

describe("test-install-sh-docker", () => {
  it("defaults ARM hosts to native arm64 while keeping x64 CI on amd64", () => {
    expect(runDefaultSmokePlatform({ CI: "true" }, "aarch64")).toBe("linux/arm64");
    expect(runDefaultSmokePlatform({ GITHUB_ACTIONS: "true" }, "x86_64")).toBe("linux/amd64");
    expect(runDefaultSmokePlatform({}, "arm64")).toBe("linux/arm64");
    expect(
      runDefaultSmokePlatform({ OPENCLAW_INSTALL_SMOKE_PLATFORM: "linux/s390x" }, "x86_64"),
    ).toBe("linux/s390x");
  });

  it.runIf(process.platform !== "win32")(
    "serves distinct candidate and baseline bytes when npm packs the same version",
    () => {
      const root = tempDirs.make("openclaw-install-same-version-");
      const bin = join(root, "bin");
      const ready = join(root, "server-ready");
      const receipts = join(root, "served.jsonl");
      mkdirSync(bin);
      symlinkSync(testNodeExecPath, join(bin, "node"));
      expect(spawnSync("mkfifo", [ready]).status).toBe(0);
      const writeCommand = (name: string, source: string) =>
        writeFileSync(join(bin, name), source, { mode: 0o755 });
      writeCommand(
        "npm",
        `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const pack = args.indexOf("pack");
if (pack >= 0) {
  const dir = args[args.indexOf("--pack-destination") + 1];
  const filename = "openclaw-2026.9.6.tgz";
  const bytes = args[pack + 1].startsWith("openclaw@") ? "published baseline" : "candidate build";
  fs.writeFileSync(path.join(dir, filename), bytes);
  console.log(JSON.stringify([{ name: "openclaw", version: "2026.9.6", filename, size: bytes.length, unpackedSize: bytes.length }]));
} else if (args.includes("view")) {
  console.log("2026.9.6");
} else {
  throw new Error("Unexpected npm invocation: " + args.join(" "));
}
`,
      );
      writeCommand(
        "python3",
        `#!/usr/bin/env node
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
http.createServer((request, response) => {
  const file = path.join(process.cwd(), new URL(request.url, "http://localhost").pathname.slice(1));
  fs.createReadStream(file).on("error", () => {
    response.statusCode = 404;
    response.end("missing package");
  }).pipe(response);
}).listen(Number(process.argv[4]), "127.0.0.1", () => {
  fs.writeFileSync(process.env.SERVER_READY, "ready\\n");
});
`,
      );
      // Join actual listener readiness instead of spending the runner's startup sleep.
      writeCommand(
        "sleep",
        '#!/bin/bash\nIFS= read -r ready < "$SERVER_READY"\n[[ "$ready" == ready ]]\n',
      );
      writeCommand(
        "docker",
        `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] !== "run") throw new Error("Unexpected Docker invocation");
const env = new Map();
for (let index = 0; index < args.length; index++) {
  if (args[index] === "-e") {
    const entry = args[++index];
    const equals = entry.indexOf("=");
    env.set(entry.slice(0, equals), entry.slice(equals + 1));
  }
}
(async () => {
  for (const [key, kind] of [
    ["OPENCLAW_INSTALL_FRESH_TAG_URL", "fresh"],
    ["OPENCLAW_INSTALL_UPDATE_BASELINE_TAG_URL", "baseline"],
    ["OPENCLAW_INSTALL_UPDATE_TAG_URL", "update"],
  ]) {
    const url = env.get(key);
    if (!url) continue;
    const response = await fetch(url);
    if (!response.ok) throw new Error("Package HTTP status " + response.status);
    const bytes = await response.text();
    fs.appendFileSync(process.env.SERVED_RECEIPTS, JSON.stringify({ kind, url, bytes }) + "\\n");
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
`,
      );

      const result = spawnSync("bash", [SCRIPT_PATH], {
        encoding: "utf8",
        timeout: 30_000,
        env: {
          HOME: root,
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
          TMPDIR: root,
          SERVER_READY: ready,
          SERVED_RECEIPTS: receipts,
          npm_config_userconfig: "/dev/null",
          npm_config_globalconfig: "/dev/null",
          OPENCLAW_DOCKER_E2E_DISABLE_RESOURCE_LIMITS: "1",
          OPENCLAW_INSTALL_SMOKE_GROUP: "update",
          OPENCLAW_INSTALL_SMOKE_SKIP_IMAGE_BUILD: "1",
          OPENCLAW_INSTALL_SMOKE_SKIP_NPM_GLOBAL: "1",
          OPENCLAW_INSTALL_SMOKE_SKIP_FRESHNESS: "1",
          OPENCLAW_INSTALL_SMOKE_UPDATE_BASELINE: "2026.9.6",
          OPENCLAW_INSTALL_SMOKE_UPDATE_PACKAGE_SPEC: "candidate-fixture",
          OPENCLAW_INSTALL_SMOKE_UPDATE_HOST: "127.0.0.1",
        },
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const served = readFileSync(receipts, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { kind: string; url: string; bytes: string });
      expect(served.map(({ kind, bytes }) => ({ kind, bytes }))).toEqual([
        { kind: "fresh", bytes: "candidate build" },
        { kind: "baseline", bytes: "published baseline" },
        { kind: "update", bytes: "candidate build" },
      ]);
      expect(served[0]?.url).toBe(served[2]?.url);
      expect(served[1]?.url).not.toBe(served[2]?.url);
    },
  );

  it("downloads the non-root NodeSource installer completely before execution", () => {
    const dockerfile = readFileSync(NONROOT_DOCKERFILE_PATH, "utf8");
    expect(dockerfile).toContain('installer="$(mktemp)"');
    expect(dockerfile).toContain(
      'curl -fsSL --connect-timeout 10 --max-time 120 -o "$installer" https://deb.nodesource.com/setup_24.x',
    );
    expect(dockerfile).toContain('bash "$installer"');
    expect(dockerfile).toContain('rm -f "$installer"');
    expect(dockerfile).not.toMatch(/curl[^\n]+\|\s*bash/u);
  });
  it("keeps release-harness npm lookups outside caller freshness policy", () => {
    const root = tempDirs.make("openclaw-install-npm-policy-");
    const binDir = join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, "npm"),
      `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({ args: process.argv.slice(2), policy: Object.fromEntries(Object.entries(process.env).filter(([key]) => ["npm_config_before", "npm_config_min_release_age", "npm_config_min-release-age"].includes(key.toLowerCase()))) }));\n`,
      { mode: 0o755 },
    );

    const runNpmFixture = (source: string, cwd: string, env: NodeJS.ProcessEnv) =>
      spawnSync(
        "bash",
        [
          "-c",
          source,
          "bash",
          join(process.cwd(), "scripts/docker/install-sh-common/version-parse.sh"),
        ],
        { cwd, encoding: "utf8", env },
      );

    const noPolicyResult = spawnSync(
      "bash",
      [
        "-c",
        "set -euo pipefail; source scripts/docker/install-sh-common/version-parse.sh; run_npm_without_freshness_policy bash -c 'printf ok'",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) =>
              ![
                "npm_config_before",
                "npm_config_globalconfig",
                "npm_config_min_release_age",
                "npm_config_min-release-age",
                "npm_config_userconfig",
              ].includes(key.toLowerCase()),
          ),
        ),
      },
    );
    expect(noPolicyResult.status, noPolicyResult.stderr).toBe(0);
    expect(noPolicyResult.stdout).toBe("ok");

    const noHomeResult = spawnSync(
      "bash",
      [
        "-c",
        "unset HOME; source scripts/docker/install-sh-common/version-parse.sh; resolve_npm_config_path_value '~/.npmrc'",
      ],
      { cwd: process.cwd(), encoding: "utf8", env: process.env },
    );
    expect(noHomeResult.status, noHomeResult.stderr).toBe(0);
    const nativeHomeResult = spawnSync(
      process.execPath,
      ["-e", "delete process.env.HOME; process.stdout.write(require('node:os').homedir())"],
      { encoding: "utf8", env: process.env },
    );
    expect(nativeHomeResult.status, nativeHomeResult.stderr).toBe(0);
    expect(noHomeResult.stdout).toBe(join(nativeHomeResult.stdout, ".npmrc"));

    const result = spawnSync(
      "bash",
      [
        "-c",
        "source scripts/docker/install-sh-common/version-parse.sh; quiet_npm view openclaw@2026.8.32 version",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          NPM_CONFIG_BEFORE: "2026-09-17T23:07:28.000Z",
          NPM_CONFIG_GLOBALCONFIG: join(root, "missing-global.npmrc"),
          NPM_CONFIG_before: "2026-09-17T23:07:28.000Z",
          "NPM_CONFIG_MIN-RELEASE-AGE": "10080",
          NPM_CONFIG_MIN_RELEASE_AGE: "10080",
          Npm_Config_Min_Release_Age: "10080",
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          npm_config_before: "2026-09-17T23:07:28.000Z",
          npm_config_min_release_age: "10080",
          "npm_config_min-release-age": "10080",
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    const invocation = JSON.parse(result.stdout) as {
      args: string[];
      policy: Record<string, string>;
    };
    expect(invocation.args.slice(0, 3)).toEqual([
      expect.stringMatching(/^--prefix=\/.+/u),
      expect.stringMatching(/^--userconfig=\/dev\/fd\/\d+$/u),
      expect.stringMatching(/^--globalconfig=\/dev\/fd\/\d+$/u),
    ]);
    expect(invocation).toEqual({
      args: [
        ...invocation.args.slice(0, 3),
        "--loglevel=error",
        "--logs-max=0",
        "--no-update-notifier",
        "--no-fund",
        "--no-audit",
        "--no-progress",
        "view",
        "openclaw@2026.8.32",
        "version",
      ],
      policy: {},
    });

    const projectDir = join(root, "project");
    const workspaceDir = join(projectDir, "packages", "fixture");
    const nestedProjectDir = join(workspaceDir, "nested");
    mkdirSync(nestedProjectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "package.json"),
      '{"name":"npm-policy-root","workspaces":["!packages/private","./packages/*/"]}\n',
    );
    writeFileSync(join(workspaceDir, "package.json"), '{"name":"npm-policy-fixture"}\n');
    const globalConfigPath = join(root, "global.npmrc");
    const projectGlobalConfigPath = join(root, "project-global.npmrc");
    const selectedUserConfigPath = join(root, "project-user.npmrc");
    writeFileSync(globalConfigPath, "min-release-age=7\nfetch-retries=23\n");
    writeFileSync(projectGlobalConfigPath, "min-release-age=7\nfetch-retries=17\n");
    writeFileSync(
      join(root, ".npmrc"),
      [
        "before=2026-09-17T23:07:28.000Z",
        "globalconfig=${HOME}/global.npmrc",
        "registry=https://user-registry.example.test/",
        "ca[]=user-ca",
      ].join("\n"),
    );
    writeFileSync(
      selectedUserConfigPath,
      "globalconfig=${HOME}/global.npmrc\nregistry=https://selected-user-registry.example.test/\n",
    );
    writeFileSync(
      join(projectDir, ".npmrc"),
      "before=2026-09-17T23:07:28.000Z\nuserconfig=${HOME}/project-user.npmrc # selected user config\nglobalconfig=${HOME}/project-global.npmrc # selected global config\nregistry=https://project-registry.example.test/\nca[]=project-ca\ncafile=./certs/ca.pem\n",
    );
    writeFileSync(join(nestedProjectDir, ".npmrc"), "registry=https://nested.example.test/\n");
    writeFileSync(join(workspaceDir, ".npmrc"), "registry=https://workspace.example.test/\n");
    const projectResult = runNpmFixture(
      'source "$1"; quiet_npm config get before; quiet_npm config get registry; quiet_npm config get fetch-retries; quiet_npm config get ca --json; quiet_npm config get cafile',
      nestedProjectDir,
      { ...process.env, HOME: root },
    );
    expect(projectResult.status, projectResult.stderr).toBe(0);
    expect(projectResult.stdout.trim().split("\n")).toEqual([
      "null",
      "https://project-registry.example.test/",
      "17",
      "project-ca",
      join(nestedProjectDir, "certs", "ca.pem"),
    ]);

    const globalResult = runNpmFixture(
      'source "$1"; quiet_npm config get registry --location global',
      nestedProjectDir,
      { ...process.env, HOME: root },
    );
    expect(globalResult.status, globalResult.stderr).toBe(0);
    expect(globalResult.stdout.trim()).toBe("https://user-registry.example.test/");

    const excludedWorkspaceDir = join(projectDir, "packages", "private");
    const excludedNestedDir = join(excludedWorkspaceDir, "nested");
    mkdirSync(excludedNestedDir, { recursive: true });
    writeFileSync(join(excludedWorkspaceDir, "package.json"), '{"name":"npm-policy-private"}\n');
    writeFileSync(
      join(excludedWorkspaceDir, ".npmrc"),
      "registry=https://private-registry.example.test/\n",
    );
    const excludedResult = runNpmFixture(
      'source "$1"; quiet_npm config get registry',
      excludedNestedDir,
      { ...process.env, HOME: root },
    );
    expect(excludedResult.status, excludedResult.stderr).toBe(0);
    expect(excludedResult.stdout.trim()).toBe("https://private-registry.example.test/");

    const lowercaseUserConfigPath = join(root, "lowercase#user.npmrc");
    writeFileSync(lowercaseUserConfigPath, "fetch-timeout=1234\n");
    const configPathNeutralEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !["npm_config_globalconfig", "npm_config_userconfig"].includes(key.toLowerCase()),
      ),
    );
    for (const configEnv of [
      {
        NPM_CONFIG_GLOBALCONFIG: join(root, "missing-global.npmrc"),
        NPM_CONFIG_USERCONFIG: join(root, "missing-user.npmrc"),
        npm_config_globalconfig: "~/project-global.npmrc",
        npm_config_userconfig: "${HOME}/lowercase#user.npmrc",
      },
      {
        Npm_Config_Globalconfig: "~/project-global.npmrc",
        Npm_Config_Userconfig: "${HOME}/lowercase#user.npmrc",
      },
    ]) {
      const configEnvResult = runNpmFixture(
        'source "$1"; quiet_npm config get fetch-timeout; quiet_npm config get fetch-retries; quiet_npm config get globalconfig',
        nestedProjectDir,
        { ...configPathNeutralEnv, HOME: root, ...configEnv },
      );
      expect(configEnvResult.status, configEnvResult.stderr).toBe(0);
      expect(configEnvResult.stdout.trim().split("\n")).toEqual([
        "1234",
        "17",
        expect.stringMatching(/^\/dev\/fd\/\d+$/u),
      ]);
    }
  });

  it("restores root and AI build trees from one image", () => {
    const result = runRestoreLocalDistFixture();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("status=0");
    expect(result.stdout).toContain("root=new-root");
    expect(result.stdout).toContain("ai=new-ai");
  });

  it("rolls both build trees back when the AI swap fails", () => {
    const result = runRestoreLocalDistFixture({ failAiSwap: true });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("status=1");
    expect(result.stdout).toContain("root=old-root");
    expect(result.stdout).toContain("ai=old-ai");
  });

  it.each(["packages", "ai"] as const)(
    "rejects a symlinked %s path before restoring artifacts",
    (symlinkEscape) => {
      const result = runRestoreLocalDistFixture({ symlinkEscape });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("status=1");
      expect(result.stdout).toContain("root=old-root");
      expect(result.stdout).toContain("ai=external-ai");
      expect(result.stdout).toContain("external=external-ai");
      expect(result.stderr).not.toContain("docker-call=");
      expect(result.stderr).toContain("refusing package artifact restore through a symlinked");
    },
  );

  it("fails closed when exact image artifacts fail import closure", () => {
    const result = spawnSync(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        `set -euo pipefail
HARNESS_ROOT=/trusted
ROOT_DIR=/candidate
UPDATE_SKIP_LOCAL_BUILD=1
node() {
  return 1
}
pnpm() {
  printf 'pnpm-called\\n'
}
${extractEnsureLocalUpdateDistImportClosure()}
status=0
ensure_local_update_dist_import_closure || status=$?
printf 'status=%s\\n' "$status"
`,
      ],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("status=1");
    expect(result.stdout).not.toContain("pnpm-called");
    expect(result.stderr).toContain("exact-image mode forbids a local rebuild");
  });

  it("bounds installer smoke container runs", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain(
      'INSTALL_SMOKE_DOCKER_RUN_TIMEOUT="${OPENCLAW_INSTALL_SMOKE_DOCKER_RUN_TIMEOUT:-2700s}"',
    );
    expect(script).toContain("run_install_smoke_container()");
    expect(script).toContain(
      'DOCKER_COMMAND_TIMEOUT="$INSTALL_SMOKE_DOCKER_RUN_TIMEOUT" docker_e2e_docker_run_cmd run "$@"',
    );
    expect(script.match(/run_install_smoke_container --rm -t/g)?.length).toBe(6);
    expect(script).not.toContain("docker run --rm -t \\");
  });

  it("rejects non-root smoke Node runtimes without node:sqlite", () => {
    const result = runNonrootNodePreflight("24.16.0", { sqlite: false });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unsupported node 24.16.0: missing node:sqlite");
  });

  it("rejects non-root smoke Node runtimes with vulnerable system SQLite", () => {
    const result = runNonrootNodePreflight("24.17.0", { sqliteVersion: "3.51.2" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unsupported node 24.17.0: unsafe SQLite 3.51.2");
  });

  it("accepts non-root smoke Node runtimes that match the installer runtime floor", () => {
    expect(runNonrootNodePreflight("22.23.2").status).toBe(1);
    expect(runNonrootNodePreflight("24.16.0").status).toBe(0);
    expect(runNonrootNodePreflight("25.9.0").status).toBe(1);
    expect(runNonrootNodePreflight("26.0.0").status).toBe(1);
    expect(runNonrootNodePreflight("26.1.0").status).toBe(0);
  });

  it("runs the root Dockerfile build with the CI heap limit", () => {
    const dockerfile = readFileSync("Dockerfile", "utf8");

    expect(dockerfile).toContain(
      'ARG OPENCLAW_DOCKER_BUILD_NODE_OPTIONS="--max-old-space-size=8192"',
    );
    expect(dockerfile).toContain('ARG OPENCLAW_DOCKER_BUILD_TSDOWN_MAX_OLD_SPACE_MB=""');
    expect(dockerfile).toContain("ARG OPENCLAW_DOCKER_BUILD_SKIP_DTS=1");
    expect(dockerfile).toContain(
      'OPENCLAW_RUN_NODE_SKIP_DTS_BUILD="$OPENCLAW_DOCKER_BUILD_SKIP_DTS" OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB="$OPENCLAW_DOCKER_BUILD_TSDOWN_MAX_OLD_SPACE_MB" NODE_OPTIONS="$OPENCLAW_DOCKER_BUILD_NODE_OPTIONS" pnpm_config_verify_deps_before_run=false pnpm build:docker',
    );
  });

  it("copies the launcher version contract into root Docker build and runtime stages", () => {
    const dockerfile = readFileSync("Dockerfile", "utf8");

    expect(dockerfile).toContain("COPY node-version.mjs ./");
    expect(dockerfile).toContain(
      "COPY --from=runtime-assets --chown=node:node /app/node-version.mjs .",
    );
  });

  it("exports the Playwright browser cache installed by the root Dockerfile", () => {
    const dockerfile = readFileSync("Dockerfile", "utf8");

    expect(dockerfile).toContain("ENV PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright");
    expect(dockerfile).toContain('mkdir -p "$PLAYWRIGHT_BROWSERS_PATH"');
    expect(dockerfile).toContain(
      "node /app/node_modules/playwright-core/cli.js install --with-deps chromium",
    );
  });

  it("passes the baked browser build arg through Docker setup", () => {
    const script = readFileSync(DOCKER_SETUP_PATH, "utf8");

    expect(script).toContain('export OPENCLAW_INSTALL_BROWSER="${OPENCLAW_INSTALL_BROWSER:-}"');
    expect(script).toContain("OPENCLAW_INSTALL_BROWSER \\");
    expect(script).toContain('--build-arg "OPENCLAW_INSTALL_BROWSER=${OPENCLAW_INSTALL_BROWSER}"');
  });

  it("bounds Docker setup image pulls", () => {
    const script = readFileSync(DOCKER_SETUP_PATH, "utf8");
    const timeoutHelper = readFileSync(HOST_TIMEOUT_PATH, "utf8");

    expect(script).toContain('source "$ROOT_DIR/scripts/lib/host-timeout.sh"');
    expect(script).toContain('DOCKER_PULL_TIMEOUT="${OPENCLAW_DOCKER_SETUP_PULL_TIMEOUT:-600s}"');
    expect(script).toContain("run_docker_pull()");
    expect(script).toContain(
      'openclaw_host_timeout_cmd "$DOCKER_PULL_TIMEOUT" docker pull "$image"',
    );
    expect(timeoutHelper).toContain("elif command -v gtimeout >/dev/null 2>&1; then");
    expect(timeoutHelper).toContain('"$timeout_bin" --kill-after=30s "$timeout_value" "$@"');
    expect(script).toContain('run_docker_pull "$IMAGE_NAME"');
    expect(script).not.toContain('docker pull "$IMAGE_NAME"');
  });

  it("validates Docker timezones against the selected image runtime", () => {
    for (const timezone of ["Asia/Shanghai", "UTC", "US/Pacific"]) {
      const result = runDockerTimezoneValidator(timezone);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    }

    for (const timezone of ["zone.tab", "iso3166.tab", "Factory", "localtime"]) {
      const result = runDockerTimezoneValidator(timezone);
      expect(result.status).toBe(1);
    }

    const script = readFileSync(DOCKER_SETUP_PATH, "utf8");
    expect(script).not.toContain("/usr/share/zoneinfo");
    expect(script).toContain(
      'fail "OPENCLAW_TZ must be supported by $IMAGE_NAME (e.g. Asia/Shanghai)."',
    );
  });

  it("bounds Podman setup image pulls", () => {
    const script = readFileSync(PODMAN_SETUP_PATH, "utf8");

    expect(script).toContain('source "$REPO_PATH/scripts/lib/host-timeout.sh"');
    expect(script).toContain('PODMAN_PULL_TIMEOUT="${OPENCLAW_PODMAN_SETUP_PULL_TIMEOUT:-600s}"');
    expect(script).toContain("run_podman_pull()");
    expect(script).toContain(
      'openclaw_host_timeout_cmd "$PODMAN_PULL_TIMEOUT" podman pull "$image"',
    );
    expect(script).toContain('run_podman_pull "$OPENCLAW_IMAGE"');
    expect(script).not.toContain('podman pull "$OPENCLAW_IMAGE"');
  });

  it("bounds Podman setup image builds", () => {
    const script = readFileSync(PODMAN_SETUP_PATH, "utf8");

    expect(script).toContain(
      'PODMAN_BUILD_TIMEOUT="${OPENCLAW_PODMAN_SETUP_BUILD_TIMEOUT:-1800s}"',
    );
    expect(script).toContain("run_podman_build()");
    expect(script).toContain('openclaw_host_timeout_cmd "$PODMAN_BUILD_TIMEOUT" podman build "$@"');
    expect(script).toContain('run_podman_build -t "$OPENCLAW_IMAGE"');
    expect(script).not.toContain('podman build -t "$OPENCLAW_IMAGE"');
  });

  it("bounds detached Podman launches without timing out onboarding", () => {
    const script = readFileSync(PODMAN_RUN_PATH, "utf8");

    expect(script).toContain('PODMAN_RUN_TIMEOUT="${OPENCLAW_PODMAN_RUN_TIMEOUT:-600s}"');
    expect(script).toContain("OPENCLAW_PODMAN_RUN_TIMEOUT|OPENCLAW_PODMAN_GATEWAY_HOST_PORT");
    expect(script).toContain('source "$SCRIPT_DIR/lib/host-timeout.sh"');
    expect(script).toContain(
      'openclaw_prepare_gateway_image podman "$OPENCLAW_IMAGE" "$PODMAN_PULL"',
    );
    expect(script).toContain("run_podman_detached()");
    expect(script).toContain('openclaw_host_timeout_cmd "$PODMAN_RUN_TIMEOUT" podman run "$@"');
    expect(script).toContain('podman run --pull="$PODMAN_PULL" --rm -it \\');
    expect(script).toContain("run_podman_detached --pull=never -d --replace \\");
    expect(script).not.toContain("podman run --pull=never -d --replace \\");
  });

  it("binds the Podman Quadlet Gateway port to loopback", () => {
    const template = readFileSync(PODMAN_QUADLET_TEMPLATE_PATH, "utf8");
    expect(template).toContain("PublishPort=127.0.0.1:18789:18789");
    expect(template).not.toContain("/home/admin");
  });
  it("allows repository branch history and release tags for secret-backed Docker release checks", () => {
    const workflow = readFileSync(LIVE_E2E_WORKFLOW_PATH, "utf8");

    expect(workflow).toContain('git rev-parse --verify "${INPUT_REF}^{commit}"');
    expect(workflow).toContain(
      'git merge-base --is-ancestor "$selected_sha" refs/remotes/origin/main',
    );
    expect(workflow).toContain("repository-branch-history");
    expect(workflow).toContain("git tag --points-at \"$selected_sha\" | grep -Eq '^v'");
    expect(workflow).toContain(
      "git for-each-ref --format='%(refname:short)' --contains \"$selected_sha\" refs/remotes/origin",
    );
    expect(workflow).toContain("reachable from an OpenClaw branch or release tag");
  });

  it("normalizes npm 12 pack output and enforces the budget without tsx", () => {
    const withinBudget = runInstallSmokePackHelpers({
      openclaw: {
        filename: "openclaw-2026.8.1.tgz",
        unpackedSize: 100,
        version: "2026.8.1",
      },
    });
    expect(withinBudget.result.status).toBe(0);
    expect(withinBudget.result.stderr).toBe("");
    expect(withinBudget.normalized).toEqual([
      {
        filename: "openclaw-2026.8.1.tgz",
        unpackedSize: 100,
        version: "2026.8.1",
      },
    ]);

    const oversized = runInstallSmokePackHelpers(
      [{ name: "ignored" }, { filename: "candidate.tgz", unpackedSize: 101 }],
      100,
    );
    expect(oversized.result.status).not.toBe(0);
    expect(oversized.result.stderr).toContain(
      "candidate.tgz unpackedSize 101 bytes (0.0 MiB) exceeds budget 100 bytes",
    );
  });

  it("rejects path-like npm pack tarball filenames in update smoke metadata", () => {
    expect(runReadPackTarballFilename("openclaw-2026.6.17.tgz")).toMatchObject({
      status: 0,
      stdout: "openclaw-2026.6.17.tgz",
    });

    const unsafeFilenames = [
      "../openclaw.tgz",
      "nested/openclaw.tgz",
      "nested\\openclaw.tgz",
      "/tmp/openclaw.tgz",
      "C:\\temp\\openclaw.tgz",
      "openclaw.tar.gz",
    ];

    for (const filename of unsafeFilenames) {
      const result = runReadPackTarballFilename(filename);

      expect(result.status, filename).not.toBe(0);
      expect(result.stderr, filename).toContain("npm pack reported unsafe tarball filename");
    }
  });

  it("uses the package artifact helper for local update tarballs", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain('node "$HARNESS_ROOT/scripts/package-openclaw-for-docker.mjs"');
    expect(script).toContain("--allow-unreleased-changelog");
    expect(script).toContain("OPENCLAW_INSTALL_SMOKE_ALLOW_UNRELEASED_CHANGELOG");
    expect(script).toContain(
      'if [[ "${OPENCLAW_INSTALL_SMOKE_ALLOW_UNRELEASED_CHANGELOG:-true}" == "true" ]]',
    );
    expect(script).toContain("package_args+=(--allow-unreleased-changelog)");
    expect(script).toContain('--source-dir "$ROOT_DIR"');
    expect(script).toContain('--pack-json "$pack_json_file"');
    expect(script).toContain("--skip-build");
    expect(script).not.toContain("node --import tsx scripts/write-package-dist-inventory.ts");
    expect(script).not.toContain("quiet_npm pack --ignore-scripts --json");
    expect(script).toContain('node "$HARNESS_ROOT/scripts/check-openclaw-package-tarball.mjs"');
    expect(script).toContain("--require-bundled-workspace-deps");
  });

  it("keeps frozen payload mode free of candidate build and normalization work", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");
    const prepareStart = script.indexOf("prepare_update_tarball() {");
    const frozenStart = script.indexOf('if [[ -n "$FROZEN_PAYLOAD_DIR" ]]; then', prepareStart);
    const packageSpecBranch = script.indexOf('elif [[ -n "$UPDATE_PACKAGE_SPEC" ]]', frozenStart);
    const frozenBranch = script.slice(frozenStart, packageSpecBranch);

    expect(prepareStart).toBeGreaterThan(0);
    expect(frozenStart).toBeGreaterThan(0);
    expect(packageSpecBranch).toBeGreaterThan(frozenStart);
    expect(frozenBranch).toContain('cp "$FROZEN_PAYLOAD_DIR/candidate.tgz"');
    expect(frozenBranch).toContain('cp "$FROZEN_PAYLOAD_DIR/candidate-pack.json"');
    expect(frozenBranch).not.toContain("pnpm build");
    expect(frozenBranch).not.toContain("package-openclaw-for-docker");
    expect(frozenBranch).not.toContain("normalize_npm_pack_json_file");
    expect(script).not.toContain("node --import tsx");
    expect(script).toContain('if [[ -z "$FROZEN_PAYLOAD_DIR" ]]; then');
    expect(script).toContain(
      'require_regular_payload_file "$FROZEN_PAYLOAD_DIR/install.sh" "installer"',
    );
    expect(script).toContain(
      'require_regular_payload_file "$FROZEN_PAYLOAD_DIR/install-cli.sh" "CLI installer"',
    );
  });

  it("runs candidate tarballs through the installer script instead of direct npm", () => {
    const wrapper = readFileSync(SCRIPT_PATH, "utf8");
    const runner = readFileSync(SMOKE_RUNNER_PATH, "utf8");

    expect(wrapper).toContain('-v "$INSTALL_SCRIPT_PATH:/tmp/openclaw-install.sh:ro"');
    expect(wrapper).toContain(
      'FROZEN_PAYLOAD_DIR="${OPENCLAW_INSTALL_SMOKE_FROZEN_PAYLOAD_DIR:-}"',
    );
    expect(wrapper).toContain('FROZEN_NODE_VERSION="${OPENCLAW_INSTALL_SMOKE_NODE_VERSION:-}"');
    expect(wrapper).toContain('-e "OPENCLAW_NODE_VERSION=$FROZEN_NODE_VERSION"');
    expect(runner).toContain("Run official installer one-liner for latest release tarball");
    expect(runner).toContain("run_installer_pipeline");
    expect(runner).toContain('--version "$FRESH_TAG_URL"');
    expect(runner).not.toContain('npm_install_global "install latest release tarball"');
  });

  it("bounds both non-root installer pipelines and propagates curl failures", () => {
    const wrapper = readFileSync(SCRIPT_PATH, "utf8");
    const nonrootRunner = readFileSync(NONROOT_RUNNER_PATH, "utf8");

    expect(wrapper).toContain('-e OPENCLAW_INSTALL_CLI_URL="$CLI_INSTALL_URL"');
    expect(wrapper).toContain(
      `'set -o pipefail; curl -fsSL --connect-timeout 30 --max-time 300 -- "$OPENCLAW_INSTALL_CLI_URL" | bash -s -- --set-npm-prefix --no-onboard'`,
    );
    expect(nonrootRunner).toContain(
      'curl -fsSL --connect-timeout 30 --max-time 300 -o "$installer" -- "$INSTALL_URL"',
    );
    expect(nonrootRunner.indexOf('-o "$installer"')).toBeLessThan(
      nonrootRunner.indexOf('bash "$installer"'),
    );
  });

  it("does not execute or retain a non-root installer after curl fails", () => {
    const fixture = runNonrootInstallerFixture(28);
    const outputPath = readFileSync(fixture.outputPathCapture, "utf8");

    expect(fixture.result.status).toBe(28);
    expect(readNulSeparatedArgs(fixture.curlArgsPath)).toEqual([
      "-fsSL",
      "--connect-timeout",
      "30",
      "--max-time",
      "300",
      "-o",
      outputPath,
      "--",
      "https://installer.example.test/install.sh",
    ]);
    expect(existsSync(fixture.markerPath)).toBe(false);
    expect(existsSync(outputPath)).toBe(false);
  });

  it("executes and cleans the non-root installer after curl succeeds", () => {
    const fixture = runNonrootInstallerFixture(0);

    expect(fixture.result.status, fixture.result.stderr).toBe(0);
    expect(existsSync(fixture.markerPath)).toBe(true);
    expect(existsSync(readFileSync(fixture.outputPathCapture, "utf8"))).toBe(false);
  });
});

describe("install-sh E2E runner", () => {
  it("does not execute a partial installer after a bounded download fails", () => {
    const fixture = runInstallE2eInstallerFixture({
      curlExitCode: 28,
      installerBody: 'touch "$INSTALL_MARKER"\n',
      installTag: "latest",
    });

    expect(fixture.result.status).toBe(28);
    expect(readFileSync(fixture.curlArgsPath, "utf8")).toContain(
      "-fsSL --connect-timeout 10 --max-time 120 https://installer.example.test/install.sh -o",
    );
    expect(existsSync(fixture.markerPath)).toBe(false);
    expect(existsSync(readFileSync(fixture.outputPathCapture, "utf8"))).toBe(false);
  });

  it.each([
    ["turn timeout", "OPENCLAW_INSTALL_E2E_AGENT_TURN_TIMEOUT_SECONDS", "300s"],
    ["parallel toggle", "OPENCLAW_INSTALL_E2E_AGENT_TURNS_PARALLEL", "2"],
    ["session scan depth", "OPENCLAW_INSTALL_E2E_SESSION_SCAN_DEPTH", "0"],
  ])("rejects invalid install E2E Docker %s before image build", (_label, envName, value) => {
    const result = spawnSync("bash", [INSTALL_E2E_DOCKER_PATH], {
      encoding: "utf8",
      env: {
        ...process.env,
        [envName]: value,
      },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`invalid ${envName}: ${value}`);
    expect(result.stdout).not.toContain("==> Build image:");
  });

  it("validates agent timing and toggle knobs before running provider setup", () => {
    const script = readFileSync(INSTALL_E2E_RUNNER_PATH, "utf8");

    expect(script).toContain(
      'AGENT_TURN_TIMEOUT_SECONDS="$(read_positive_int_env OPENCLAW_INSTALL_E2E_AGENT_TURN_TIMEOUT_SECONDS 300)"',
    );
    expect(script).toContain(
      'AGENT_TURNS_PARALLEL="$(read_boolean_env OPENCLAW_INSTALL_E2E_AGENT_TURNS_PARALLEL 1)"',
    );
    expect(script).toContain(
      'AGENT_TOOL_SMOKE="$(read_boolean_env OPENCLAW_INSTALL_E2E_AGENT_TOOL_SMOKE 1)"',
    );
    expect(script).toContain(
      'OPENAI_PROVIDER_TIMEOUT_SECONDS="$(read_positive_int_env OPENCLAW_INSTALL_E2E_OPENAI_PROVIDER_TIMEOUT_SECONDS "$AGENT_TURN_TIMEOUT_SECONDS")"',
    );
    expect(script).toContain('timeout --kill-after=15s "${AGENT_TURN_TIMEOUT_SECONDS}s"');
    expect(script).toContain('\\"timeoutSeconds\\":${OPENAI_PROVIDER_TIMEOUT_SECONDS}');
    expect(script).toContain('openclaw --profile "$profile" agent \\');
    expect(script).not.toContain("\n    --local \\\n");
  });

  it("normalizes agent JSON when structured lifecycle diagnostics follow the result", () => {
    const payload = {
      result: {
        payloads: [{ text: "LEFT=RED RIGHT=GREEN" }],
      },
      replayInvalid: true,
    };
    const result = normalizeInstallE2eAgentOutput(
      `${JSON.stringify(payload, null, 2)}\n[agent] ${JSON.stringify({ stopReason: "stop" })}\n`,
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.output)).toEqual(payload);
  });

  it.each([
    ["turn timeout", "OPENCLAW_INSTALL_E2E_AGENT_TURN_TIMEOUT_SECONDS", "300s"],
    ["parallel toggle", "OPENCLAW_INSTALL_E2E_AGENT_TURNS_PARALLEL", "2"],
  ])("rejects invalid install E2E %s before credential preflight", (_label, envName, value) => {
    const result = spawnSync("bash", [INSTALL_E2E_RUNNER_PATH], {
      encoding: "utf8",
      env: {
        ...process.env,
        [envName]: value,
      },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`invalid ${envName}: ${value}`);
    expect(result.stderr).not.toContain("OPENCLAW_E2E_MODELS=both requires");
  });
});

describe("install-sh smoke runner", () => {
  it.runIf(process.platform !== "win32").for([23])(
    "reaps the heartbeat timer and preserves command exit %i",
    async (exitCode, { signal, onTestFinished }) => {
      let cleanup = async () => {};
      // Vitest can start afterEach while an aborted body is still joining its child.
      const fixtureDirs = useAutoCleanupTempDirTracker((removeDirs) => {
        onTestFinished(async () => {
          await cleanup();
          removeDirs();
        });
      });
      const root = fixtureDirs.make("openclaw-smoke-heartbeat-");
      const bin = join(root, "bin");
      const pidFile = join(root, "timer.pid");
      const readyPipe = join(root, "timer-ready");
      mkdirSync(bin);
      writeFileSync(
        join(bin, "sleep"),
        '#!/bin/bash\nexec >/dev/null 2>&1\nprintf "%s" "$$" >"$SLEEP_PID_FILE"\nprintf "%s\\n" "$$" >&3\nexec /bin/sleep "$@"\n',
        { mode: 0o755 },
      );
      const runner = readFileSync(SMOKE_RUNNER_PATH, "utf8");
      const heartbeat = runner.slice(
        runner.indexOf("run_with_heartbeat() {"),
        runner.indexOf("\nis_self_swapped_package_process_exit()"),
      );
      const command = `
const fs = require("node:fs");
const ready = Buffer.alloc(64);
let length = 0;
while (!ready.subarray(0, length).includes(10)) {
  const count = fs.readSync(3, ready, length, ready.length - length, null);
  if (count === 0) throw new Error("heartbeat timer readiness pipe closed");
  length += count;
}
if (!/^\\d+\\n$/.test(ready.subarray(0, length).toString())) {
  throw new Error("invalid heartbeat timer readiness");
}
process.exit(${exitCode});
`;
      let timerPid = 0;
      const child = spawn(
        "bash",
        [
          "-c",
          `set -euo pipefail
HEARTBEAT_INTERVAL=60
mkfifo "$TIMER_READY_PIPE"
exec 3<>"$TIMER_READY_PIPE"
${heartbeat}
command_result=0
run_with_heartbeat fixture "$HOST_NODE" -e "$COMMAND_SOURCE" || command_result=$?
printf 'command-status=%s\\n' "$command_result"
`,
        ],
        {
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            HOME: root,
            PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
            SLEEP_PID_FILE: pidFile,
            TIMER_READY_PIPE: readyPipe,
            HOST_NODE: testNodeExecPath,
            COMMAND_SOURCE: command,
          },
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });
      const closed = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      let cleanupPromise: Promise<void> | undefined;
      cleanup = () =>
        (cleanupPromise ??= (async () => {
          if (child.pid && child.exitCode === null && child.signalCode === null) {
            // The shell and its heartbeat children share this test-owned process group.
            process.kill(-child.pid, "SIGKILL");
          }
          await closed;
          if (!timerPid && existsSync(pidFile)) {
            timerPid = Number(readFileSync(pidFile, "utf8"));
          }
          if (timerPid && isProcessAlive(timerPid)) {
            process.kill(timerPid, "SIGKILL");
          }
        })());
      try {
        const status = await withinTest(closed, signal);
        const result = { status, stdout, stderr };
        timerPid = Number(readFileSync(pidFile, "utf8"));
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.trim()).toBe(`command-status=${exitCode}`);
        expect(timerPid).toBeGreaterThan(0);
        expect(isProcessAlive(timerPid)).toBe(false);
      } finally {
        await cleanup();
      }
    },
  );

  it.runIf(process.platform !== "win32").each([
    { scenario: "idle", exitCode: 0, updateCount: 2 },
    { scenario: "candidate refusal", exitCode: 21, updateCount: 2 },
    { scenario: "live process", exitCode: 1, updateCount: 0 },
    { scenario: "service definition", exitCode: 1, updateCount: 0 },
    { scenario: "service manager", exitCode: 1, updateCount: 0 },
    { scenario: "inspection failure", exitCode: 1, updateCount: 0 },
  ])(
    "uses the baseline manual path only after offline proof and checks candidate defaults: $scenario",
    ({ scenario, exitCode, updateCount }) => {
      const root = tempDirs.make("openclaw-update-smoke-");
      const bin = join(root, "bin");
      const globalRoot = join(root, "node_modules");
      const versionFile = join(root, "version");
      const callsFile = join(root, "updates.jsonl");
      const preload = join(root, "native-inspection.cjs");
      mkdirSync(bin);
      mkdirSync(join(globalRoot, "openclaw"), { recursive: true });
      writeFileSync(join(globalRoot, "openclaw", "package.json"), '{"version":"2026.8.2"}');
      writeFileSync(versionFile, "2026.8.2");
      writeFileSync(callsFile, "");
      symlinkSync(testNodeExecPath, join(bin, "node"));
      writeFileSync(
        join(bin, "npm"),
        '#!/bin/bash\nif [[ " $* " == *" root -g "* ]]; then printf "%s\\n" "$FAKE_GLOBAL_ROOT"; fi\n',
        { mode: 0o755 },
      );
      writeFileSync(join(bin, "timeout"), '#!/bin/bash\nshift 2\nexec "$@"\n', { mode: 0o755 });
      writeFileSync(
        join(bin, "openclaw"),
        `#!${testNodeExecPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("OpenClaw " + fs.readFileSync(process.env.FAKE_VERSION_FILE, "utf8"));
} else if (args[0] === "update") {
  const before = fs.readFileSync(process.env.FAKE_VERSION_FILE, "utf8");
  fs.appendFileSync(process.env.FAKE_CALLS_FILE, JSON.stringify(args) + "\\n");
  if (before === "2026.8.2" && !args.includes("--no-restart")) process.exit(20);
  if (before === "2026.9.1" && (args.includes("--no-restart") || process.env.FAKE_SCENARIO === "candidate refusal")) process.exit(21);
  fs.writeFileSync(process.env.FAKE_VERSION_FILE, "2026.9.1");
  console.log(JSON.stringify({
    status: before === "2026.9.1" ? "skipped" : "ok",
    ...(before === "2026.9.1" ? { reason: "already-current" } : {}),
    before: { version: before, buildId: "candidate-build" }, after: { version: "2026.9.1", buildId: "candidate-build" },
    steps: [
      { name: before === "2026.9.1" ? "package-install" : "global update", exitCode: 0, command: "npm install " + args[args.indexOf("--tag") + 1] },
      ...(before === "2026.9.1" ? [] : [{ name: "openclaw doctor", exitCode: 0 }]),
    ],
  }));
}
`,
        { mode: 0o755 },
      );
      // Simulate native /proc and service files; execute the complete shell runner and CLI boundary.
      writeFileSync(
        preload,
        `const fs = require("node:fs");
const realRead = fs.readFileSync;
const realList = fs.readdirSync;
const realStat = fs.lstatSync;
const absent = () => { throw Object.assign(new Error("absent"), { code: "ENOENT" }); };
Object.defineProperty(process, "platform", { value: "linux" });
Object.defineProperty(process, "ppid", { value: 1 });
fs.lstatSync = (file, ...args) => {
  if (String(file).startsWith("/run/")) {
    if (process.env.FAKE_SCENARIO === "service manager") return {};
    return absent();
  }
  return realStat(file, ...args);
};
fs.readdirSync = (file, ...args) => {
  if (file === "/proc") return ["1", String(process.pid), ...(process.env.FAKE_SCENARIO === "live process" ? ["42"] : [])];
  if (String(file).endsWith("/systemd")) {
    if (process.env.FAKE_SCENARIO === "inspection failure") throw Object.assign(new Error("inspection denied"), { code: "EACCES" });
    return process.env.FAKE_SCENARIO === "service definition" ? [{ name: "openclaw-gateway.service", parentPath: file }] : [];
  }
  return realList(file, ...args);
};
fs.readFileSync = (file, ...args) => {
  if (file === "/proc/1/cmdline") return "bash\\0/usr/local/bin/openclaw-install-smoke\\0";
  if (file === "/proc/42/cmdline") return "openclaw-gateway\\0";
  return realRead(file, ...args);
};
`,
      );
      const result = spawnSync("bash", [SMOKE_RUNNER_PATH], {
        encoding: "utf8",
        env: {
          HOME: root,
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
          NODE_OPTIONS: `--require=${preload}`,
          FAKE_SCENARIO: scenario,
          FAKE_GLOBAL_ROOT: globalRoot,
          FAKE_VERSION_FILE: versionFile,
          FAKE_CALLS_FILE: callsFile,
          OPENCLAW_INSTALL_SMOKE_MODE: "update",
          OPENCLAW_INSTALL_UPDATE_BASELINE: "2026.8.2",
          OPENCLAW_INSTALL_UPDATE_BASELINE_TAG_URL: "http://baseline.invalid/openclaw.tgz",
          OPENCLAW_INSTALL_UPDATE_EXPECT_VERSION: "2026.9.1",
          OPENCLAW_INSTALL_UPDATE_TAG_URL: "http://candidate.invalid/openclaw.tgz",
          OPENCLAW_INSTALL_SMOKE_HEARTBEAT_INTERVAL: "0",
        },
      });
      const calls = readFileSync(callsFile, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]);
      expect(result.status, result.stderr).toBe(exitCode);
      expect(calls).toHaveLength(updateCount);
      if (updateCount > 0) {
        expect(calls[0]).toContain("--no-restart");
        expect(calls[1]).not.toContain("--no-restart");
      }
      if (exitCode === 0) {
        expect(result.stdout).toContain("Verified idle container");
        expect(result.stdout.trim().endsWith("OK")).toBe(true);
      } else {
        expect(result.stdout.trim().endsWith("OK")).toBe(false);
      }
    },
  );

  it("passes the URL and installer arguments through the timed pipeline unchanged", () => {
    const installerArgs = [
      "--install-method",
      "npm",
      "--version",
      "https://packages.example.test/openclaw.tgz?x=1&y=2",
      "--no-prompt",
    ];
    const fixture = runInstallSmokeInstallerPipelineFixture({ installerArgs });

    expect(fixture.result.status, fixture.result.stderr).toBe(0);
    expect(readNulSeparatedArgs(fixture.timeoutArgsPath)).toEqual([
      "--kill-after=30s",
      "17s",
      "bash",
      "-o",
      "pipefail",
      "-c",
      'curl -fsSL --connect-timeout 30 --max-time 300 -- "$1" | bash -s -- "${@:2}"',
      "_",
      fixture.installUrl,
      ...installerArgs,
    ]);
    expect(readNulSeparatedArgs(fixture.curlArgsPath)).toEqual([
      "-fsSL",
      "--connect-timeout",
      "30",
      "--max-time",
      "300",
      "--",
      fixture.installUrl,
    ]);
    expect(readNulSeparatedArgs(fixture.installerArgsPath)).toEqual(installerArgs);
    expect(existsSync(fixture.installerMarkerPath)).toBe(true);
  });

  it("propagates curl exit 28 even when the piped installer exits successfully", () => {
    const fixture = runInstallSmokeInstallerPipelineFixture({
      curlExitCode: 28,
      installerArgs: ["--no-prompt"],
    });

    expect(fixture.result.status, fixture.result.stderr).toBe(28);
    expect(existsSync(fixture.installerMarkerPath)).toBe(true);
    expect(readNulSeparatedArgs(fixture.timeoutArgsPath).slice(0, 6)).toEqual([
      "--kill-after=30s",
      "17s",
      "bash",
      "-o",
      "pipefail",
      "-c",
    ]);
  });

  it.each([
    [
      "released-driver same-build no-op",
      {
        steps: [
          {
            name: "global update",
            exitCode: 0,
            command: "npm install http://candidate.invalid/openclaw.tgz",
          },
        ],
      },
      "already-current",
      0,
    ],
    ["unrelated skip", { reason: "dirty" }, "already-current", 1],
    ["changed build", { after: { version: "2026.9.3", buildId: "other" } }, "already-current", 1],
    ["missing build identity", { before: { version: "2026.9.3" } }, "already-current", 1],
    [
      "unexpected activation",
      {
        steps: [
          {
            name: "package-install",
            exitCode: 0,
            command: "npm install http://candidate.invalid/openclaw.tgz",
          },
          { name: "global install swap", exitCode: 0 },
        ],
      },
      "already-current",
      1,
    ],
    ["skipped first upgrade", {}, "applied", 1],
  ])("validates explicit installer outcome: %s", (_label, overrides, outcome, expectedExit) => {
    const url = "http://candidate.invalid/openclaw.tgz";
    const payload = {
      status: "skipped",
      reason: "already-current",
      before: { version: "2026.9.3", buildId: "candidate-build" },
      after: { version: "2026.9.3", buildId: "candidate-build" },
      steps: [{ name: "package-install", exitCode: 0, command: `npm install ${url}` }],
      ...overrides,
    };
    const result = spawnSync(testNodeExecPath, ["-"], {
      encoding: "utf8",
      input: extractInstallSmokeUpdateJsonParser(),
      env: {
        ...process.env,
        UPDATE_JSON: JSON.stringify(payload),
        UPDATE_EXPECT_VERSION: "2026.9.3",
        UPDATE_BASELINE_VERSION: "2026.9.3",
        UPDATE_TAG_URL: url,
        UPDATE_EXPECT_OUTCOME: outcome,
      },
    });
    expect(result.status, result.stderr).toBe(expectedExit);
  });

  it("accepts legacy same-version apply only with the frozen-target compatibility flag", () => {
    const url = "http://candidate.invalid/openclaw.tgz";
    const payload = {
      status: "ok",
      before: { version: "2026.7.33" },
      after: { version: "2026.7.33" },
      steps: [
        { name: "global update", exitCode: 0, command: `npm install ${url}` },
        { name: "global install swap", exitCode: 0 },
        { name: "openclaw doctor", exitCode: 0 },
      ],
    };
    const run = (allowLegacy: boolean) =>
      spawnSync(testNodeExecPath, ["-"], {
        encoding: "utf8",
        input: extractInstallSmokeUpdateJsonParser(),
        env: {
          ...process.env,
          UPDATE_JSON: JSON.stringify(payload),
          UPDATE_EXPECT_VERSION: "2026.7.33",
          UPDATE_BASELINE_VERSION: "2026.7.33",
          UPDATE_TAG_URL: url,
          UPDATE_EXPECT_OUTCOME: "already-current",
          ...(allowLegacy ? { OPENCLAW_INSTALL_ALLOW_LEGACY_SAME_VERSION_APPLY: "1" } : {}),
        },
      });

    expect(run(false).status).toBe(1);
    expect(run(true).status).toBe(0);
  });

  it.each([
    [
      "recoverable advisory",
      {
        name: "openclaw doctor",
        exitCode: 86,
        advisory: { kind: "package-post-install-doctor", message: "repair deferred" },
      },
    ],
  ])("accepts a %s package post-install doctor result", (_label, doctorStep) => {
    const result = validateInstallSmokeUpdateJson(doctorStep);

    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    ["missing", undefined, "missing openclaw doctor step"],
    ["untyped advisory", { name: "openclaw doctor", exitCode: 86 }, "openclaw doctor step failed"],
    [
      "wrong advisory exit",
      {
        name: "openclaw doctor",
        exitCode: 1,
        advisory: { kind: "package-post-install-doctor" },
      },
      "openclaw doctor step failed",
    ],
  ])("rejects a %s package post-install doctor result", (_label, doctorStep, error) => {
    const result = validateInstallSmokeUpdateJson(doctorStep);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(error);
  });

  it.each([
    ["command timeout", "OPENCLAW_INSTALL_SMOKE_COMMAND_TIMEOUT", "900s"],
    ["heartbeat interval", "OPENCLAW_INSTALL_SMOKE_HEARTBEAT_INTERVAL", "60s"],
  ])("rejects invalid install smoke %s before running npm", (_label, envName, value) => {
    const result = spawnSync("bash", [SMOKE_RUNNER_PATH], {
      encoding: "utf8",
      env: {
        ...process.env,
        [envName]: value,
      },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`invalid ${envName}: ${value}`);
    expect(result.stderr).not.toContain("unsupported OPENCLAW_INSTALL_SMOKE_MODE");
  });

  it("covers plain npm global installs and npm-driven updates", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");
    const runner = readFileSync(SMOKE_RUNNER_PATH, "utf8");

    expect(script).toContain('SKIP_NPM_GLOBAL="${OPENCLAW_INSTALL_SMOKE_SKIP_NPM_GLOBAL:-0}"');
    expect(script).toContain('NPM_CACHE_DIR="${OPENCLAW_INSTALL_SMOKE_NPM_CACHE_DIR:-}"');
    expect(script).toContain("-e npm_config_cache=/npm-cache");
    expect(script).toContain('${NPM_CACHE_DOCKER_ARGS[@]+"${NPM_CACHE_DOCKER_ARGS[@]}"}');
    expect(script).toContain("remove_owned_npm_cache");
    expect(script).toContain('sudo -n rm -rf "$NPM_CACHE_DIR"');
    expect(script).not.toMatch(
      /Run installer non-root test:[\s\S]*"\$\{NPM_CACHE_DOCKER_ARGS\[@\]\}"/,
    );
    expect(script).not.toMatch(
      /Run CLI installer non-root test[\s\S]*"\$\{NPM_CACHE_DOCKER_ARGS\[@\]\}"/,
    );
    expect(script).toContain("==> Run direct npm global smoke");
    expect(script).toContain("OPENCLAW_INSTALL_SMOKE_MODE=npm-global");
    expect(runner).toContain("run_npm_global_smoke");
    expect(runner).toContain("==> Direct npm global install candidate");
    expect(runner).toContain("==> Direct npm global update candidate");
  });

  it("forwards smoke-runner control knobs into Docker containers", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain("SMOKE_RUNNER_ENV_ARGS=()");
    for (const envName of [
      "OPENCLAW_INSTALL_ALLOW_LEGACY_SAME_VERSION_APPLY",
      "OPENCLAW_INSTALL_SMOKE_COMMAND_TIMEOUT",
      "OPENCLAW_INSTALL_SMOKE_HEARTBEAT_INTERVAL",
      "OPENCLAW_INSTALL_SMOKE_PREVIOUS",
      "OPENCLAW_INSTALL_SMOKE_SKIP_PREVIOUS",
    ]) {
      expect(script).toContain(envName);
    }
    expect(script).toMatch(
      /Run installer smoke test[\s\S]*\$\{SMOKE_RUNNER_ENV_ARGS\[@\]\+"\$\{SMOKE_RUNNER_ENV_ARGS\[@\]\}"\}/u,
    );
    expect(script).toMatch(
      /Run update smoke[\s\S]*\$\{SMOKE_RUNNER_ENV_ARGS\[@\]\+"\$\{SMOKE_RUNNER_ENV_ARGS\[@\]\}"\}/u,
    );
    expect(script).toMatch(
      /Run direct npm global smoke[\s\S]*\$\{SMOKE_RUNNER_ENV_ARGS\[@\]\+"\$\{SMOKE_RUNNER_ENV_ARGS\[@\]\}"\}/u,
    );
    expect(script).toMatch(
      /Run installer npm freshness smoke[\s\S]*\$\{SMOKE_RUNNER_ENV_ARGS\[@\]\+"\$\{SMOKE_RUNNER_ENV_ARGS\[@\]\}"\}/u,
    );
  });
});

describe("bun global install smoke", () => {
  const runForceKillOrderingFixture = (
    first: "timer" | "drain",
    failure?: "permission" | "uncleared",
  ) => {
    const tempDir = tempDirs.make("openclaw-bun-global-force-kill-");
    const preloadPath = path.join(tempDir, "lifecycle.mjs");
    // Drive both native-observed callback orders at the real CLI boundary.
    // Only the child and clock are simulated; the helper owns all cleanup logic.
    writeFileSync(
      preloadPath,
      `import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
let now = 0;
let alive = true;
let forceKills = 0;
const timers = [];
process.on("exit", () => console.log("force-kill-attempts=" + forceKills));
process.kill = (pid, signal) => {
  if (pid !== -1234) throw new Error("unexpected fixture signal target");
  if (signal === "SIGKILL") {
    forceKills++;
    if (${JSON.stringify(failure)} === "permission" ||
        (forceKills > 1 && ${JSON.stringify(failure)} !== "uncleared")) {
      throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    }
  }
  if (signal === 0 && !alive) {
    throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
  }
  return true;
};
childProcess.spawn = () => {
  const stream = () => Object.assign(new EventEmitter(), { setEncoding() {} });
  const child = Object.assign(new EventEmitter(), {
    pid: 1234, stdout: stream(), stderr: stream(),
  });
  Date.now = () => now;
  globalThis.setTimeout = (callback, delay) => {
    const timer = { callback, delay, cleared: false, unref() {} };
    timers.push(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => { if (timer) timer.cleared = true; };
  const fire = async (delay, at) => {
    now = at;
    const timer = timers.find((entry) => !entry.cleared && entry.delay === delay);
    if (!timer) throw new Error("missing fixture timer: " + delay);
    timer.cleared = true;
    timer.callback();
    await Promise.resolve();
    await Promise.resolve();
  };
  process.nextTick(async () => {
    process.emit("SIGTERM");
    child.emit("close", 0, null);
    await Promise.resolve();
    if (${JSON.stringify(first)} === "timer") {
      await fire(100, 100);
      await fire(25, 100);
    } else {
      await fire(25, 100);
      if (${JSON.stringify(failure)} === "permission") return;
      await fire(100, 100);
    }
    alive = ${JSON.stringify(failure)} === "uncleared";
    await fire(25, 200);
  });
  return child;
};
syncBuiltinESMExports();
`,
    );
    return spawnSync(
      testNodeExecPath,
      ["--import", preloadPath, BUN_GLOBAL_ASSERTIONS_PATH, "run-with-timeout", "60000", "fixture"],
      {
        encoding: "utf8",
        env: { ...process.env, OPENCLAW_BUN_GLOBAL_SMOKE_TIMEOUT_KILL_GRACE_MS: "100" },
      },
    );
  };

  it.runIf(process.platform !== "win32").each(["timer", "drain"] as const)(
    "force-kills Bun descendants once when the %s callback runs first",
    (first) => {
      const result = runForceKillOrderingFixture(first);
      expect(result.status, result.stderr).toBe(143);
      expect(result.stdout).toContain("force-kill-attempts=1");
    },
  );

  it.runIf(process.platform !== "win32")("propagates Bun force-kill permission failures", () => {
    const result = runForceKillOrderingFixture("drain", "permission");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("kill EPERM");
    expect(result.stdout).toContain("force-kill-attempts=1");
  });

  it.runIf(process.platform !== "win32")(
    "fails when a Bun process group remains after force-kill cleanup",
    () => {
      const result = runForceKillOrderingFixture("timer", "uncleared");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("command process group remained active after SIGKILL");
      expect(result.stdout).toContain("force-kill-attempts=1");
    },
  );

  it("packs the current tree and capability-binds the installed package runtime", () => {
    const script = readFileSync(BUN_GLOBAL_SMOKE_PATH, "utf8");
    const assertions = readFileSync(BUN_GLOBAL_ASSERTIONS_PATH, "utf8");

    expect(script).toContain("node scripts/package-openclaw-for-docker.mjs");
    expect(script).toContain("--allow-unreleased-changelog");
    expect(script).toContain("OPENCLAW_BUN_GLOBAL_SMOKE_ALLOW_UNRELEASED_CHANGELOG");
    expect(script).toContain(
      'if [[ "${OPENCLAW_BUN_GLOBAL_SMOKE_ALLOW_UNRELEASED_CHANGELOG:-true}" == "true" ]]',
    );
    expect(script).toContain("package_args+=(--allow-unreleased-changelog)");
    expect(script).toContain("--skip-build");
    expect(script).toContain("--output-name openclaw-current.tgz");
    expect(script).not.toContain("npm pack --ignore-scripts --json --pack-destination");
    expect(script).toContain('"$bun_path" install -g --trust "$PACKAGE_TGZ" --no-progress');
    expect(script).toContain('"$openclaw_bin" --help');
    expect(script).toContain('grep -Fq "Bun runtime is unsupported" "$DIRECT_BUN_LOG"');
    expect(script).toContain('grep -Fq "node:sqlite" "$DIRECT_BUN_LOG"');
    expect(script).toContain('runtime_command=("$openclaw_bin")');
    expect(script).toContain('return "$direct_bun_status"');
    expect(script).toContain("OPENCLAW_BUN_GLOBAL_SMOKE_PROOF_PATH");
    expect(script).toContain("infer image providers --json");
    expect(script).toContain("assert-image-providers");
    expect(script).toContain("assert-openclaw-trusted");
    expect(script).toContain("agent --local");
    expect(script).toContain("gateway health");
    expect(script).toContain("openclaw_e2e_wait_gateway_ready");
    expect(assertions).toContain("image providers output is missing bundled provider");
    expect(script).toContain("OPENCLAW_BUN_GLOBAL_SMOKE_DIST_IMAGE");
    expect(script).toContain('source "$ROOT_DIR/scripts/lib/docker-e2e-package.sh"');
    expect(script).toContain("docker_e2e_restore_package_dist_from_image");
    expect(script).toContain(
      'COMMAND_TIMEOUT_MS="$(docker_e2e_read_positive_int_env OPENCLAW_BUN_GLOBAL_SMOKE_TIMEOUT_MS 180000)"',
    );
    expect(script).toContain(
      'DOCKER_COMMAND_TIMEOUT="${DOCKER_COMMAND_TIMEOUT:-${OPENCLAW_BUN_GLOBAL_SMOKE_DOCKER_COMMAND_TIMEOUT:-600s}}"',
    );
  });

  it("rejects invalid Bun global install command timeouts before Bun setup", () => {
    const result = spawnSync("bash", [BUN_GLOBAL_SMOKE_PATH], {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_BUN_GLOBAL_SMOKE_TIMEOUT_MS: "180000ms",
      },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("invalid OPENCLAW_BUN_GLOBAL_SMOKE_TIMEOUT_MS: 180000ms");
    expect(result.stderr).not.toContain("Bun is required");
  });

  it("requires Bun to trust and execute OpenClaw lifecycle scripts", () => {
    const tempDir = tempDirs.make("openclaw-bun-trusted-lifecycle-");
    const packageRoot = join(tempDir, "node_modules", "openclaw");
    const globalManifestPath = join(tempDir, "package.json");
    const untrustedOutputPath = join(tempDir, "untrusted.txt");
    mkdirSync(join(packageRoot, "dist"), { recursive: true });
    writeFileSync(globalManifestPath, JSON.stringify({ trustedDependencies: ["openclaw"] }));
    writeFileSync(untrustedOutputPath, "./node_modules/koffi [install]\n");

    const trusted = spawnSync(
      testNodeExecPath,
      [
        BUN_GLOBAL_ASSERTIONS_PATH,
        "assert-openclaw-trusted",
        packageRoot,
        globalManifestPath,
        untrustedOutputPath,
      ],
      { encoding: "utf8" },
    );
    expect(trusted.status, trusted.stderr).toBe(0);

    writeFileSync(untrustedOutputPath, "./node_modules/openclaw [preinstall, postinstall]\n");
    const blocked = spawnSync(
      testNodeExecPath,
      [
        BUN_GLOBAL_ASSERTIONS_PATH,
        "assert-openclaw-trusted",
        packageRoot,
        globalManifestPath,
        untrustedOutputPath,
      ],
      { encoding: "utf8" },
    );
    expect(blocked.status).not.toBe(0);
    expect(blocked.stderr).toContain("OpenClaw lifecycle scripts remain blocked by Bun");

    writeFileSync(untrustedOutputPath, "");
    writeFileSync(join(packageRoot, ".openclaw-lifecycle-pending"), "pending\n");
    const skipped = spawnSync(
      testNodeExecPath,
      [
        BUN_GLOBAL_ASSERTIONS_PATH,
        "assert-openclaw-trusted",
        packageRoot,
        globalManifestPath,
        untrustedOutputPath,
      ],
      { encoding: "utf8" },
    );
    expect(skipped.status).not.toBe(0);
    expect(skipped.stderr).toContain("OpenClaw package lifecycle did not complete");
  });

  it.runIf(process.platform !== "win32").each([
    {
      name: "uses bundled AI bytes when a prebuilt tarball is provided",
      bundledAi: true,
      bunRuntime: "supported",
      statusExit: 0,
    },
    {
      name: "rejects a mismatched bundled AI candidate before installation",
      bundledAi: true,
      bunRuntime: "supported",
      statusExit: 0,
      aiVersion: "2026.6.18",
    },
    {
      name: "installs an older tarball with no bundled AI dependency unchanged",
      bundledAi: false,
      bunRuntime: "supported",
      statusExit: 0,
    },
    {
      name: "preserves redirected Bun command diagnostics and exit status",
      bundledAi: true,
      bunRuntime: "supported",
      statusExit: 23,
    },
    {
      name: "uses Node for a Bun-installed package that explicitly rejects the Bun runtime",
      bundledAi: true,
      bunRuntime: "unsupported",
      statusExit: 0,
    },
    {
      name: "does not hide an unexpected direct Bun runtime failure",
      bundledAi: true,
      bunRuntime: "unexpected-failure",
      statusExit: 0,
    },
  ])("$name", ({ bundledAi, bunRuntime, statusExit, aiVersion = "2026.6.17" }) => {
    const tempDir = tempDirs.make("openclaw-bun-prebuilt-");
    const packageDir = join(tempDir, "fixture", "package");
    const aiDir = join(packageDir, "node_modules", "@openclaw", "ai");
    const packageTgz = join(tempDir, "openclaw-prebuilt.tgz");
    const bunPath = join(tempDir, "bun");
    const statePath = join(tempDir, "state-path");
    const aiTarballPath = join(tempDir, "ai-tarball-path");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      join(packageDir, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version: "2026.6.17",
        ...(bundledAi
          ? {
              dependencies: { "@openclaw/ai": "2026.6.17" },
              bundleDependencies: ["@openclaw/ai"],
            }
          : {}),
      }),
    );
    if (bundledAi) {
      mkdirSync(aiDir, { recursive: true });
      writeFileSync(
        join(aiDir, "package.json"),
        JSON.stringify({ name: "@openclaw/ai", version: aiVersion }),
      );
    }
    const packed = spawnSync(
      "tar",
      ["-czf", packageTgz, "-C", join(tempDir, "fixture"), "package"],
      {
        encoding: "utf8",
      },
    );
    expect(packed.status, packed.stderr).toBe(0);
    writeFileSync(
      bunPath,
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--version" ]; then
  echo "1.4.0"
  exit 0
fi
if [ "\${1:-}" = "pm" ] && [ "\${2:-}" = "-g" ] && [ "\${3:-}" = "untrusted" ]; then
  echo './node_modules/koffi [install]'
  exit 0
fi
if [ "\${1:-}" = "run" ] && [ "\${2:-}" = "--bun" ]; then
  echo "OpenClaw 2026.6.17"
  exit 0
fi
if [[ "\${1:-}" == */verify-fs-safe-native.mjs ]]; then
  test "\${2:-}" = "--package-root"
  test -d "\${3:-}"
  test "\${4:-}" = "--mode"
  test "\${5:-}" = "require"
  exit 0
fi
if [[ "\${1:-}" == */openclaw.mjs ]]; then
  if [ "$FAKE_BUN_RUNTIME" = "unsupported" ]; then
    echo 'openclaw: the Bun runtime is unsupported because OpenClaw requires node:sqlite.' >&2
    exit 1
  fi
  if [ "$FAKE_BUN_RUNTIME" = "unexpected-failure" ]; then
    echo 'synthetic direct Bun runtime failure' >&2
    exit 42
  fi
  shift
  exec node "$BUN_INSTALL/install/global/node_modules/openclaw/openclaw.mjs" "$@"
fi
test "\${1:-}" = "install"
case " $* " in
  *' --trust '*) ;;
  *) echo 'missing --trust' >&2; exit 1 ;;
esac
mkdir -p "$BUN_INSTALL/install/global"
if [ ! -f "$BUN_INSTALL/install/global/package.json" ]; then
  echo '{}' >"$BUN_INSTALL/install/global/package.json"
fi
if [ "$EXPECT_AI_OVERRIDE" = "1" ]; then
override="$(node -e 'const p=require(process.argv[1]);process.stdout.write(p.overrides["@openclaw/ai"])' "$BUN_INSTALL/install/global/package.json")"
case "\${override#file:}" in
  *.tgz) ;;
  *) exit 1 ;;
esac
test -f "\${override#file:}"
fi
package_root="$BUN_INSTALL/install/global/node_modules/openclaw"
mkdir -p "$BUN_INSTALL/bin" "$package_root/dist/plugin-sdk"
printf '%s\\n' "$OPENCLAW_STATE_DIR" >"$FAKE_STATE_PATH"
if [ "$EXPECT_AI_OVERRIDE" = "1" ]; then
  printf '%s\\n' "\${override#file:}" >"$FAKE_AI_TARBALL_PATH"
else
  node -e 'const p=require(process.argv[1]);process.exit(p.overrides ? 1 : 0)' "$BUN_INSTALL/install/global/package.json"
fi
# Synthetic package redactor isolates stderr routing; canonical redaction has separate proof.
cat >"$package_root/dist/plugin-sdk/logging-core.js" <<'REDACTOR'
exports.redactSensitiveText = (text) => text;
REDACTOR
cat >"$package_root/openclaw.mjs" <<'OPENCLAW'
#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("OpenClaw 2026.6.17");
} else if (args[0] === "--help") {
  console.log("Usage: openclaw");
} else if (args[0] === "infer") {
  console.log(JSON.stringify([{ id: "google" }, { id: "openai" }, { id: "xai" }]));
} else if (args[0] === "status" && process.env.FAKE_STATUS_EXIT !== "0") {
  console.error("synthetic Bun status failure");
  process.exit(Number(process.env.FAKE_STATUS_EXIT));
} else if (args[0] === "status" || (args[0] === "plugins" && args[1] === "list")) {
  console.log("{}");
} else if (args[0] === "agent") {
  fs.appendFileSync(process.env.MOCK_REQUEST_LOG, '{"path":"/v1/responses"}\\n');
  console.log(JSON.stringify({ payloads: [{ text: process.env.SUCCESS_MARKER }] }));
} else if (args[0] === "gateway" && args[1] === "health") {
  console.log('{"ok":true}');
} else if (args[0] === "gateway" && args[1] === "call" && args[2] === "status") {
  console.log(JSON.stringify({ eventLoop: {
    cpuCoreRatio: 0.1, utilization: 0.2, delayP99Ms: 20, delayMaxMs: 21, intervalMs: 1000,
  } }));
} else if (args[0] === "gateway") {
  const port = Number(args[args.indexOf("--port") + 1]);
  http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    })
    .listen(port, "127.0.0.1", () => console.log("[gateway] ready at http://127.0.0.1:" + port));
} else {
  process.exit(1);
}
OPENCLAW
chmod +x "$package_root/openclaw.mjs"
ln -s "$package_root/openclaw.mjs" "$BUN_INSTALL/bin/openclaw"
node -e 'const fs=require("node:fs");const p=process.argv[1];const value=JSON.parse(fs.readFileSync(p,"utf8"));value.trustedDependencies=["openclaw"];fs.writeFileSync(p,JSON.stringify(value))' "$BUN_INSTALL/install/global/package.json"
`,
    );
    chmodSync(bunPath, 0o755);

    const result = spawnSync("bash", [BUN_GLOBAL_SMOKE_PATH], {
      encoding: "utf8",
      env: {
        ...process.env,
        BUN_BIN: bunPath,
        EXPECT_AI_OVERRIDE: bundledAi ? "1" : "0",
        FAKE_BUN_RUNTIME: bunRuntime,
        FAKE_STATUS_EXIT: String(statusExit),
        FAKE_STATE_PATH: statePath,
        FAKE_AI_TARBALL_PATH: aiTarballPath,
        OPENCLAW_BUN_GLOBAL_SMOKE_HOST_BUILD: "0",
        OPENCLAW_BUN_GLOBAL_SMOKE_PACKAGE_TGZ: packageTgz,
        OPENCLAW_BUN_GLOBAL_SMOKE_TIMEOUT_MS: "10000",
      },
    });

    if (aiVersion !== "2026.6.17") {
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "candidate version mismatch: openclaw=2026.6.17, dependency=2026.6.17, @openclaw/ai=2026.6.18",
      );
      expect(existsSync(statePath)).toBe(false);
      return;
    }

    const expectedExit = bunRuntime === "unexpected-failure" ? 42 : statusExit;
    expect(result.status, result.stderr).toBe(expectedExit);
    expect(existsSync(path.dirname(readFileSync(statePath, "utf8").trim()))).toBe(false);
    if (bundledAi) {
      expect(existsSync(path.dirname(readFileSync(aiTarballPath, "utf8").trim()))).toBe(false);
    }
    if (bunRuntime !== "unexpected-failure") {
      expect(result.stdout).toContain("bun-global-install-smoke: image providers OK (3 providers)");
    }
    if (bunRuntime === "unexpected-failure") {
      expect(result.stderr).toContain("synthetic direct Bun runtime failure");
      expect(result.stdout).not.toContain("Gateway runtime OK");
    } else if (statusExit === 0) {
      expect(result.stdout).toContain(
        `bun-global-install-smoke: Bun 1.4.0 install with ${bunRuntime === "supported" ? "Bun" : "Node"} CLI, local agent, and Gateway runtime OK`,
      );
    } else {
      expect(result.stderr).toContain("bun global install smoke failed with exit code 23");
      expect(result.stderr).toContain("synthetic Bun status failure");
      expect(result.stderr).not.toContain("failure log omitted");
      expect(result.stdout).not.toContain("Gateway runtime OK");
    }
  });

  it.runIf(process.platform !== "win32" && existsSync("/usr/bin/time"))(
    "preserves Bun global timeout kill grace after the leader exits",
    () => {
      const tempDir = tempDirs.make("openclaw-bun-global-timeout-grace-");
      const readyPath = path.join(tempDir, "ready");
      const drainedPath = path.join(tempDir, "drained");
      const childScript = [
        "const fs = require('node:fs');",
        "process.on('SIGTERM', () => {",
        "  setTimeout(() => {",
        "    fs.writeFileSync(process.argv[2], 'drained');",
        "    process.exit(0);",
        "  }, 50);",
        "});",
        "fs.writeFileSync(process.argv[1], 'ready');",
        "setInterval(() => {}, 1000);",
      ].join("\n");

      const result = spawnSync(
        testNodeExecPath,
        [
          BUN_GLOBAL_ASSERTIONS_PATH,
          "run-with-timeout",
          "500",
          "/usr/bin/time",
          testNodeExecPath,
          "-e",
          childScript,
          readyPath,
          drainedPath,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            OPENCLAW_BUN_GLOBAL_SMOKE_TIMEOUT_KILL_GRACE_MS: "1000",
          },
          timeout: 5_000,
        },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("command timed out after 500ms: /usr/bin/time");
      expect(readFileSync(readyPath, "utf8")).toBe("ready");
      expect(readFileSync(drainedPath, "utf8")).toBe("drained");
    },
  );

  it.runIf(process.platform !== "win32")(
    "cleans Bun global smoke descendants on parent signal",
    async ({ signal, onTestFinished }) => {
      let cleanup = async () => {};
      // Vitest can start afterEach while an aborted body is still joining its child.
      const fixtureDirs = useAutoCleanupTempDirTracker((removeDirs) => {
        onTestFinished(async () => {
          await cleanup();
          removeDirs();
        });
      });
      const tempDir = fixtureDirs.make("openclaw-bun-global-parent-signal-");
      const readyPath = path.join(tempDir, "ready");
      const descendantPidPath = path.join(tempDir, "descendant.pid");
      let descendantPid = 0;
      const descendantScript = [
        "import fs from 'node:fs';",
        fixtureReceiptClientSource(fixtureReceipts.endpoint),
        "process.on('SIGTERM', () => {});",
        `fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(process.pid));`,
        `sendReceipt(${JSON.stringify(descendantPidPath)}, "ready");`,
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const parentScript = [
        "import childProcess from 'node:child_process';",
        "import fs from 'node:fs';",
        fixtureReceiptClientSource(fixtureReceipts.endpoint),
        `childProcess.spawn(process.execPath, ["--input-type=module", "--eval", ${JSON.stringify(descendantScript)}], { stdio: "ignore" });`,
        "process.on('SIGTERM', () => process.exit(0));",
        `fs.writeFileSync(${JSON.stringify(readyPath)}, "ready");`,
        `sendReceipt(${JSON.stringify(readyPath)}, "ready");`,
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const runner = spawn(
        testNodeExecPath,
        [
          BUN_GLOBAL_ASSERTIONS_PATH,
          "run-with-timeout",
          "60000",
          testNodeExecPath,
          "--input-type=module",
          "--eval",
          parentScript,
        ],
        {
          env: {
            ...process.env,
            OPENCLAW_BUN_GLOBAL_SMOKE_TIMEOUT_KILL_GRACE_MS: "100",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let runnerStderr = "";
      runner.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        runnerStderr = `${runnerStderr}${chunk}`.slice(-16_384);
      });
      const runnerExit = new Promise<{ status: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => {
          runner.once("close", (status, exitSignal) => resolve({ status, signal: exitSignal }));
        },
      );

      let cleanupPromise: Promise<void> | undefined;
      cleanup = () =>
        (cleanupPromise ??= (async () => {
          if (runner.pid && isProcessAlive(runner.pid)) {
            // Let the runner own its tree even when readiness is aborted.
            runner.kill("SIGTERM");
          }
          await runnerExit;
          if (!descendantPid && existsSync(descendantPidPath)) {
            descendantPid = Number(readFileSync(descendantPidPath, "utf8"));
          }
          if (descendantPid && isProcessAlive(descendantPid)) {
            process.kill(descendantPid, "SIGKILL");
          }
        })());
      try {
        const ready = Promise.all([
          fixtureReceipts.waitFor(readyPath, "ready"),
          fixtureReceipts.waitFor(descendantPidPath, "ready"),
        ]);
        // Both fixtures commit their records before sending; exit may beat socket delivery.
        const settled = runnerExit.then(() => {
          if (
            !existsSync(readyPath) ||
            !existsSync(descendantPidPath) ||
            !/^\d+$/.test(readFileSync(descendantPidPath, "utf8"))
          ) {
            throw new Error("timed out waiting for Bun global smoke descendant readiness");
          }
        });
        await withinTest(Promise.race([ready, settled]), signal);
        descendantPid = Number(readFileSync(descendantPidPath, "utf8"));
        expect(descendantPid).toBeGreaterThan(0);
        expect(isProcessAlive(descendantPid)).toBe(true);

        const signalSent = runner.kill("SIGTERM");
        const result = await withinTest(runnerExit, signal);

        expect(signalSent, runnerStderr).toBe(true);
        expect(result, runnerStderr).toEqual({ status: 143, signal: null });
        // Status 143 is emitted only after the assertion runner observes its group gone.
        expect(isProcessAlive(descendantPid)).toBe(false);
      } finally {
        await cleanup();
      }
    },
  );

  it.each([23])("relays package container warnings without changing exit %i", (exitCode) => {
    const workflow = parse(readFileSync(INSTALL_SMOKE_WORKFLOW_PATH, "utf8"));
    const packageStep = workflow.jobs.installer_smoke_candidate_payload.steps.find(
      (entry: { name?: string }) => entry.name === "Package candidate only inside pinned harness",
    );
    const root = tempDirs.make("openclaw-package-container-summary-");
    const summary = join(root, "summary.md");
    writeFileSync(summary, "existing summary\n");
    const result = spawnSync(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        `${String.raw`
timeout() { shift 2; "$@"; }
docker() {
  local receipt="" forward_actions=0 forward_summary=0 arg
  for arg in "$@"; do
    case "$arg" in
      GITHUB_ACTIONS) forward_actions=1 ;;
      GITHUB_STEP_SUMMARY=/tmp/openclaw-limit-summary.md) forward_summary=1 ;;
      *:/tmp/openclaw-limit-summary.md) receipt="$(printf '%s' "$arg" | sed 's|:/tmp/openclaw-limit-summary.md$||')" ;;
    esac
  done
  [[ "$forward_actions" == 1 && "$forward_summary" == 1 && "$GITHUB_ACTIONS" == true ]] || return 98
  [[ -n "$receipt" && "$receipt" != "$GITHUB_STEP_SUMMARY" ]] || return 99
  printf '<p>Warning: package size</p>\n' > "$receipt"
  printf '::warning file=package.json,title=Package size::over budget\n'
  return "$FIXTURE_EXIT"
}
`}
${packageStep.run}`,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          FIXTURE_EXIT: String(exitCode),
          GITHUB_ACTIONS: "true",
          GITHUB_STEP_SUMMARY: summary,
          RUNNER_TEMP: root,
        },
      },
    );
    expect(result.status).toBe(exitCode);
    expect(result.stdout).toContain("::warning file=package.json,");
    expect(readFileSync(summary, "utf8")).toBe("existing summary\n<p>Warning: package size</p>\n");
  });

  it("kills Bun global install smoke commands that ignore TERM after timeout", () => {
    const result = spawnSync(
      testNodeExecPath,
      [
        BUN_GLOBAL_ASSERTIONS_PATH,
        "run-with-timeout",
        "50",
        testNodeExecPath,
        "-e",
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_BUN_GLOBAL_SMOKE_TIMEOUT_KILL_GRACE_MS: "50",
        },
        timeout: 5000,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`command timed out after 50ms: ${testNodeExecPath}`);
  });
});
