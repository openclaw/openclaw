import { spawn, spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path, { join } from "node:path";
import { runInNewContext } from "node:vm";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, describe, expect, it, type TestContext } from "vitest";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../helpers/fixture-receipts.js";
import { withinTest } from "../helpers/promise.js";
import { createTempDirTracker, useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { isProcessAlive } from "./live-process-fixture.test-support.js";

const SCRIPT_PATH = "scripts/test-install-sh-docker.sh";
const INSTALL_E2E_DOCKER_PATH = "scripts/test-install-sh-e2e-docker.sh";
const INSTALL_E2E_RUNNER_PATH = "scripts/docker/install-sh-e2e/run.sh";
const DOCKER_SETUP_PATH = "scripts/docker/setup.sh";
const PODMAN_SETUP_PATH = "scripts/podman/setup.sh";
const PODMAN_QUADLET_TEMPLATE_PATH = "scripts/podman/openclaw.container.in";
const PODMAN_RUN_PATH = "scripts/run-openclaw-podman.sh";
const SMOKE_RUNNER_PATH = "scripts/docker/install-sh-smoke/run.sh";
const NONROOT_DOCKERFILE_PATH = "scripts/docker/install-sh-nonroot/Dockerfile";
const NONROOT_RUNNER_PATH = "scripts/docker/install-sh-nonroot/run.sh";
const BUN_GLOBAL_SMOKE_PATH = "scripts/e2e/bun-global-install-smoke.sh";
const BUN_GLOBAL_ASSERTIONS_PATH = "scripts/e2e/lib/bun-global-install/assertions.mjs";
const DOCKER_E2E_PACKAGE_HELPER_PATH = "scripts/lib/docker-e2e-package.sh";
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

function runBash(source: string, env?: NodeJS.ProcessEnv) {
  return runCommand("bash", ["--noprofile", "--norc", "-c", source], env ? { env } : {});
}

function runCommand(
  command: string,
  args: string[],
  options: Omit<SpawnSyncOptionsWithStringEncoding, "encoding"> = {},
) {
  return spawnSync(command, args, { encoding: "utf8", ...options });
}

function childFixture(onTestFinished: TestContext["onTestFinished"]) {
  let cleanup = async () => {};
  const dirs = useAutoCleanupTempDirTracker((removeDirs) => {
    onTestFinished(async () => {
      await cleanup();
      removeDirs();
    });
  });
  return {
    make: (prefix: string, root?: string) => dirs.make(prefix, root),
    own(child: ReturnType<typeof spawn>, pidFiles: string[], group = false) {
      const output = { stdout: "", stderr: "" };
      for (const key of ["stdout", "stderr"] as const) {
        child[key]?.setEncoding("utf8").on("data", (chunk: string) => {
          output[key] = (output[key] + chunk).slice(-16_384);
        });
      }
      const closed = new Promise<{ status: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          child.once("error", reject);
          child.once("close", (status, signal) => resolve({ status, signal }));
        },
      );
      let joined: Promise<void> | undefined;
      cleanup = () =>
        (joined ??= (async () => {
          if (child.pid && child.exitCode === null && child.signalCode === null) {
            if (group) {
              process.kill(-child.pid, "SIGKILL");
            } else {
              child.kill("SIGTERM");
            }
          }
          await closed;
          for (const file of pidFiles.filter(existsSync)) {
            const pid = Number(readFileSync(file, "utf8"));
            if (pid && isProcessAlive(pid)) {
              process.kill(pid, "SIGKILL");
            }
          }
        })());
      return { closed, output, cleanup };
    },
  };
}

function fixturePaths(prefix: string) {
  const root = tempDirs.make(`openclaw-${prefix}-`);
  const bin = join(root, "bin");
  mkdirSync(bin);
  return { root, bin };
}

function writeExecutable(file: string, source: string) {
  writeFileSync(file, source, { mode: 0o755 });
}

function writeCommands(bin: string, commands: Record<string, string>) {
  for (const [name, source] of Object.entries(commands)) {
    writeExecutable(join(bin, name), source);
  }
}

function writeFiles(root: string, files: Record<string, string>) {
  for (const [name, source] of Object.entries(files)) {
    const file = join(root, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, source);
  }
}

function expectIncludes(text: string, ...fragments: string[]) {
  for (const fragment of fragments) {
    expect(text).toContain(fragment);
  }
}

class ScriptExit extends Error {
  constructor(readonly status: number) {
    super(`script exited ${String(status)}`);
  }
}

function extractScript(file: string, pattern: RegExp): string {
  const match = readFileSync(file, "utf8").match(pattern);
  return expectDefined(match?.[1], `script fragment in ${file}: ${pattern}`);
}

function extractBetween(file: string, startMarker: string, endMarker: string): string {
  const script = readFileSync(file, "utf8");
  const start = script.indexOf(startMarker);
  const end = script.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end <= start) {
    throw new Error(`script fragment not found in ${file}`);
  }
  return script.slice(start, end);
}

function scanInstallE2eTranscript(text: string, limits: Record<string, string> = {}) {
  const root = tempDirs.make("openclaw-install-e2e-transcript-");
  const file = join(root, "session.jsonl");
  writeFileSync(file, text);
  const script = readFileSync(INSTALL_E2E_RUNNER_PATH, "utf8");
  const marker = `node - <<'NODE' "$jsonl" "$@" || scan_status="$?"\n`;
  const start = script.indexOf(marker);
  const source = script.slice(start + marker.length, script.indexOf("\nNODE", start));
  const errors: string[] = [];
  try {
    runInNewContext(source, {
      Buffer,
      require: createRequire(import.meta.url),
      console: { error: (message: string) => errors.push(message) },
      process: {
        argv: ["node", "-", file, "exec|bash"],
        env: limits,
        exit: (code: number) => {
          throw new ScriptExit(code);
        },
      },
    });
    return { code: 0, errors };
  } catch (error) {
    if (error instanceof ScriptExit) {
      return { code: error.status, errors };
    }
    throw error;
  }
}

function runDockerTimezoneValidator(timezone: string) {
  const { root, bin } = fixturePaths("docker-timezone");
  writeExecutable(
    join(bin, "docker"),
    `#!/bin/bash
set -euo pipefail
while [[ "$#" -gt 0 && "$1" != "-e" ]]; do shift; done
exec "$HOST_NODE" "$@"
`,
  );

  return runBash(
    `${extractScript(
      DOCKER_SETUP_PATH,
      /(is_valid_timezone_in_image\(\) \{[\s\S]*?\n\})\n\nvalidate_mount_path_value/u,
    )}\nIMAGE_NAME=openclaw:test\nis_valid_timezone_in_image "$TIMEZONE"`,
    {
      HOME: root,
      HOST_NODE: testNodeExecPath,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      TIMEZONE: timezone,
    },
  );
}

function runFailedInstallerDownload(nonroot: boolean) {
  const { root, bin } = fixturePaths("installer-download");
  const curlArgsPath = join(root, "curl-args.txt");
  const installerSourcePath = join(root, "installer-source.sh");
  const markerPath = join(root, "installer-marker.txt");
  const outputPathCapture = join(root, "curl-output-path.txt");
  writeFileSync(installerSourcePath, 'touch "$INSTALL_MARKER"\n');
  writeExecutable(
    join(bin, "curl"),
    `#!/bin/sh
set -eu
${nonroot ? `printf '%s\\0' "$@"` : `printf '%s\\n' "$*"`} >"$CURL_ARGS_PATH"
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then
    shift
    output="$1"
  fi
  shift
done
cp "$FAKE_INSTALLER_SOURCE" "$output"
${nonroot ? 'chmod +x "$output"' : ""}
printf "%s" "$output" >"$OUTPUT_PATH_CAPTURE"
exit "$FAKE_CURL_EXIT"
`,
  );

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CURL_ARGS_PATH: curlArgsPath,
    FAKE_CURL_EXIT: "28",
    FAKE_INSTALLER_SOURCE: installerSourcePath,
    INSTALL_MARKER: markerPath,
    OUTPUT_PATH_CAPTURE: outputPathCapture,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
  };
  if (!nonroot) {
    delete env.OPENCLAW_BETA;
    delete env.OPENCLAW_VERSION;
  }

  const result = runCommand(
    "/bin/bash",
    [
      ...(nonroot ? ["--noprofile", "--norc"] : []),
      "-c",
      nonroot
        ? `set -euo pipefail\nINSTALL_URL="https://installer.example.test/install.sh"\n${extractBetween(
            NONROOT_RUNNER_PATH,
            'echo "==> Run installer (non-root user)"',
            "\n\n# Ensure PATH",
          )}`
        : `set -u\n${extractBetween(
            INSTALL_E2E_RUNNER_PATH,
            "run_official_installer() (\n",
            "\n\nverify_installed_version()",
          )}\nINSTALL_URL="https://installer.example.test/install.sh"\nINSTALL_TAG="latest"\nrun_official_installer`,
    ],
    { env },
  );

  return { curlArgsPath, markerPath, outputPathCapture, result };
}

function runNonrootNodePreflight(
  version: string,
  options: { sqlite?: boolean; sqliteVersion?: string } = {},
) {
  const stderr: string[] = [];
  try {
    runInNewContext(
      extractScript(NONROOT_RUNNER_PATH, /node -e '\n([\s\S]*?)\n'\ncommand -v npm/u),
      {
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
      },
    );
    return { status: 0, stderr: stderr.join("") };
  } catch (error) {
    if (error instanceof ScriptExit) {
      return { status: error.status, stderr: stderr.join("") };
    }
    throw error;
  }
}

function normalizeInstallE2eAgentOutput(output: string) {
  const root = tempDirs.make("openclaw-install-e2e-agent-output-");
  const outputPath = join(root, "agent.json");
  writeFileSync(outputPath, output, "utf8");
  const result = runCommand(testNodeExecPath, ["-", outputPath], {
    input: extractScript(
      INSTALL_E2E_RUNNER_PATH,
      /node - <<'NODE' "\$out_json"\n([\s\S]*?)\nNODE\n\}\n\nRUN_AGENT_TURN_BG_PID/u,
    ),
  });
  return { output: readFileSync(outputPath, "utf8"), status: result.status, stderr: result.stderr };
}

const UPDATE_URL = "http://candidate.invalid/openclaw.tgz";

function runUpdateJson(
  payload: {
    status: string;
    reason?: string;
    before: { version: string; buildId?: string };
    after: { version: string; buildId?: string };
    steps: Record<string, unknown>[];
  },
  env: NodeJS.ProcessEnv = {},
) {
  return runCommand(testNodeExecPath, ["-"], {
    input: extractScript(
      SMOKE_RUNNER_PATH,
      /UPDATE_JSON="\$UPDATE_JSON" \\\n[\s\S]*?node - <<'NODE'\n([\s\S]*?)\nNODE\n\n {2}echo "==> Verify updated version"/u,
    ),
    env: {
      ...process.env,
      UPDATE_JSON: JSON.stringify(payload),
      UPDATE_EXPECT_VERSION: payload.after.version,
      UPDATE_BASELINE_VERSION: payload.before.version,
      UPDATE_TAG_URL: UPDATE_URL,
      ...env,
    },
  });
}

function validateInstallSmokeUpdateJson(doctorStep?: Record<string, unknown>) {
  return runUpdateJson({
    status: "ok",
    before: { version: "2026.7.0" },
    after: { version: "2026.7.1" },
    steps: [
      {
        name: "global update",
        exitCode: 0,
        command: `npm install ${UPDATE_URL}`,
      },
      ...(doctorStep ? [doctorStep] : []),
    ],
  });
}

function readNulSeparatedArgs(filePath: string): string[] {
  return readFileSync(filePath, "utf8").split("\0").filter(Boolean);
}

function runInstallSmokeInstallerPipelineFixture(params: {
  curlExitCode?: number;
  installerArgs: string[];
}) {
  const { root, bin } = fixturePaths("install-smoke-pipeline");
  const curlArgsPath = join(root, "curl-args.txt");
  const installerArgsPath = join(root, "installer-args.txt");
  const installerMarkerPath = join(root, "installer-ran");
  const installerSourcePath = join(root, "installer.sh");
  const timeoutArgsPath = join(root, "timeout-args.txt");
  const installUrl = "https://installer.example.test/install.sh?channel=beta&trace=1";
  writeCommands(bin, {
    timeout: `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\0' "$1" "$2" >"$TIMEOUT_ARGS_PATH"
shift 2
exec "$@"
`,
    curl: `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\0' "$@" >"$CURL_ARGS_PATH"
cat "$FAKE_INSTALLER_SOURCE"
exit "$FAKE_CURL_EXIT"
`,
  });
  writeFileSync(
    installerSourcePath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\0' "$@" >"$INSTALLER_ARGS_PATH"
touch "$INSTALLER_MARKER_PATH"
`,
  );

  const result = runCommand(
    "/bin/bash",
    [
      "--noprofile",
      "--norc",
      "-c",
      `set -euo pipefail
${extractScript(
  SMOKE_RUNNER_PATH,
  /(run_installer_pipeline\(\) \{[\s\S]*?\n\})\n\nrun_install_smoke/u,
)}
run_installer_pipeline "$INSTALL_URL" "$@"`,
      "_",
      ...params.installerArgs,
    ],
    {
      env: {
        ...process.env,
        CURL_ARGS_PATH: curlArgsPath,
        FAKE_CURL_EXIT: String(params.curlExitCode ?? 0),
        FAKE_INSTALLER_SOURCE: installerSourcePath,
        INSTALLER_ARGS_PATH: installerArgsPath,
        INSTALLER_MARKER_PATH: installerMarkerPath,
        INSTALL_COMMAND_TIMEOUT: "17",
        INSTALL_URL: installUrl,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
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

function extractInstallSmokePackHelper(name: string, nextName: string) {
  return extractBetween(SCRIPT_PATH, `${name}() {`, `\n\n${nextName}() {`);
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
  const result = runBash(
    `set -euo pipefail
${extractInstallSmokePackHelper("normalize_npm_pack_json_file", "run_install_smoke_container")}
${extractInstallSmokePackHelper("assert_pack_unpacked_size_budget", "print_pack_delta_audit")}
normalize_npm_pack_json_file "$PACK_JSON_PATH"
assert_pack_unpacked_size_budget "fixture" "$PACK_JSON_PATH"`,
    env,
  );
  return {
    normalized: JSON.parse(readFileSync(packJsonPath, "utf8")),
    result,
  };
}

function runReadPackTarballFilename(filename: string) {
  return runBash(
    `${extractScript(
      SCRIPT_PATH,
      /(read_pack_tarball_filename\(\) \{[\s\S]*?\n\})\n\nSMOKE_IMAGE/u,
    )}
pack_json_file="$(mktemp)"
trap 'rm -f "$pack_json_file"' EXIT
printf '%s' "$PACK_JSON" >"$pack_json_file"
read_pack_tarball_filename "$pack_json_file"`,
    {
      HOME: "/tmp",
      PACK_JSON: JSON.stringify([{ filename }]),
      PATH: process.env.PATH ?? "",
    },
  );
}

type RestorePathEscape = "packages" | "ai";

function runRestoreLocalDistFixture(
  options: { failAiSwap?: boolean; symlinkEscape?: RestorePathEscape } = {},
) {
  const fixtureRoot = tempDirs.make("openclaw-install-restore-root-");
  const imageRoot = tempDirs.make("openclaw-install-restore-image-");
  let externalSentinel = "";
  writeFiles(fixtureRoot, {
    "dist/root.txt": "old-root",
    "packages/ai/dist/ai.txt": "old-ai",
    "packages/ai/package.json": "{}",
  });
  writeFiles(imageRoot, {
    "app/dist/root.txt": "new-root",
    "app/node_modules/@openclaw/ai/dist/ai.txt": "new-ai",
  });

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

  return runBash(
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
    {
      ...process.env,
      FAIL_AI_SWAP: options.failAiSwap ? "1" : "0",
      EXTERNAL_SENTINEL: externalSentinel,
      FIXTURE_IMAGE: imageRoot,
      FIXTURE_REPO: process.cwd(),
      FIXTURE_ROOT: fixtureRoot,
    },
  );
}

describe("test-install-sh-docker", () => {
  it.runIf(process.platform !== "win32")(
    "serves distinct candidate and baseline bytes when npm packs the same version",
    () => {
      const { root, bin } = fixturePaths("install-same-version");
      const ready = join(root, "server-ready");
      const receipts = join(root, "served.jsonl");
      const containerReceipts = join(root, "containers.jsonl");
      const timeoutReceipts = join(root, "timeouts.txt");
      symlinkSync(testNodeExecPath, join(bin, "node"));
      expect(spawnSync("mkfifo", [ready]).status).toBe(0);
      writeCommands(bin, {
        timeout: '#!/bin/bash\nprintf "%s\\n" "$*" >> "$TIMEOUT_RECEIPTS"\nshift 2\nexec "$@"\n',
        npm: `#!/usr/bin/env node
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
        python3: `#!/usr/bin/env node
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
        // Join actual listener readiness instead of spending the runner's startup sleep.
        sleep: '#!/bin/bash\nIFS= read -r ready < "$SERVER_READY"\n[[ "$ready" == ready ]]\n',
        docker: `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] !== "run") throw new Error("Unexpected Docker invocation");
const env = new Map();
for (let index = 0; index < args.length; index++) {
  if (args[index] === "-e") {
    const entry = args[++index];
    const equals = entry.indexOf("=");
    env.set(equals < 0 ? entry : entry.slice(0, equals), equals < 0 ? process.env[entry] : entry.slice(equals + 1));
  }
}
fs.appendFileSync(process.env.CONTAINER_RECEIPTS, JSON.stringify({ args, env: Object.fromEntries(env) }) + "\\n");
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
      });

      const result = runCommand("bash", [SCRIPT_PATH], {
        timeout: 30_000,
        env: {
          HOME: root,
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
          TMPDIR: root,
          SERVER_READY: ready,
          SERVED_RECEIPTS: receipts,
          CONTAINER_RECEIPTS: containerReceipts,
          TIMEOUT_RECEIPTS: timeoutReceipts,
          OPENCLAW_INSTALL_SMOKE_DOCKER_RUN_TIMEOUT: "17s",
          OPENCLAW_INSTALL_ALLOW_LEGACY_SAME_VERSION_APPLY: "1",
          OPENCLAW_INSTALL_SMOKE_COMMAND_TIMEOUT: "19",
          OPENCLAW_INSTALL_SMOKE_HEARTBEAT_INTERVAL: "0",
          OPENCLAW_INSTALL_SMOKE_PREVIOUS: "2026.8.2",
          OPENCLAW_INSTALL_SMOKE_SKIP_PREVIOUS: "1",
          npm_config_userconfig: "/dev/null",
          npm_config_globalconfig: "/dev/null",
          OPENCLAW_DOCKER_E2E_DISABLE_RESOURCE_LIMITS: "1",
          OPENCLAW_INSTALL_SMOKE_GROUP: "all",
          OPENCLAW_INSTALL_SMOKE_SKIP_IMAGE_BUILD: "1",
          OPENCLAW_INSTALL_NONROOT_SKIP_IMAGE_BUILD: "1",
          OPENCLAW_INSTALL_SMOKE_SKIP_NPM_GLOBAL: "0",
          OPENCLAW_INSTALL_SMOKE_SKIP_FRESHNESS: "0",
          OPENCLAW_INSTALL_SMOKE_UPDATE_BASELINE: "2026.9.6",
          OPENCLAW_INSTALL_SMOKE_UPDATE_PACKAGE_SPEC: "candidate-fixture",
          OPENCLAW_INSTALL_SMOKE_UPDATE_HOST: "127.0.0.1",
        },
      });
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      const served = readFileSync(receipts, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { kind: string; url: string; bytes: string });
      expect(served.map(({ kind, bytes }) => ({ kind, bytes }))).toEqual([
        { kind: "fresh", bytes: "candidate build" },
        { kind: "baseline", bytes: "published baseline" },
        { kind: "update", bytes: "candidate build" },
        { kind: "baseline", bytes: "published baseline" },
        { kind: "update", bytes: "candidate build" },
      ]);
      expect(served[0]?.url).toBe(served[2]?.url);
      expect(served[1]?.url).not.toBe(served[2]?.url);
      const containers = readFileSync(containerReceipts, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { args: string[]; env: Record<string, string> });
      expect(containers).toHaveLength(6);
      expect(
        containers.slice(0, 4).map((entry) => entry.env.OPENCLAW_INSTALL_SMOKE_MODE ?? "fresh"),
      ).toEqual(["fresh", "update", "npm-global", "freshness"]);
      for (const container of containers.slice(0, 4)) {
        expect(container.env).toMatchObject({
          OPENCLAW_INSTALL_ALLOW_LEGACY_SAME_VERSION_APPLY: "1",
          OPENCLAW_INSTALL_SMOKE_COMMAND_TIMEOUT: "19",
          OPENCLAW_INSTALL_SMOKE_HEARTBEAT_INTERVAL: "0",
          OPENCLAW_INSTALL_SMOKE_PREVIOUS: "2026.8.2",
          OPENCLAW_INSTALL_SMOKE_SKIP_PREVIOUS: "1",
        });
      }
      const timeouts = readFileSync(timeoutReceipts, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line.includes("docker run "));
      expect(timeouts).toHaveLength(6);
      expect(timeouts.every((line) => line.startsWith("--kill-after=30s 17s "))).toBe(true);
    },
  );

  it.each([0, 28])("executes NodeSource only after a complete download (curl=%s)", (curlExit) => {
    const { root, bin } = fixturePaths("nodesource-download");
    const marker = join(root, "executed");
    const downloaded = join(root, "downloaded");
    const layer = readFileSync(NONROOT_DOCKERFILE_PATH, "utf8")
      .replace(/\\\n/gu, " ")
      .split(/^RUN /mu)
      .find((command) => command.includes("https://deb.nodesource.com/setup_24.x"))!
      .split("\n")[0]!
      .replace(/--mount=\S+\s*/gu, "");
    writeCommands(bin, {
      curl: '#!/bin/sh\nwhile [ "$1" != -o ]; do shift; done\nshift\nprintf %s "$1" > "$DOWNLOADED"\nprintf \'touch "$MARKER"\\n\' > "$1"\nexit "$CURL_EXIT"\n',
      "apt-get": '#!/bin/sh\nprintf installed > "$APT_MARKER"\n',
    });
    const result = runBash(layer, {
      ...process.env,
      PATH: bin + path.delimiter + process.env.PATH,
      TMPDIR: root,
      MARKER: marker,
      DOWNLOADED: downloaded,
      CURL_EXIT: String(curlExit),
      APT_MARKER: join(root, "apt"),
    });
    expect(result.status, result.stderr).toBe(curlExit);
    expect(existsSync(marker)).toBe(curlExit === 0);
    expect(existsSync(join(root, "apt"))).toBe(curlExit === 0);
    if (curlExit === 0) {
      expect(existsSync(readFileSync(downloaded, "utf8"))).toBe(false);
    }
  });

  it("keeps release-harness npm lookups outside caller freshness policy", () => {
    const { root, bin } = fixturePaths("install-npm-policy");
    writeExecutable(
      join(bin, "npm"),
      `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({ args: process.argv.slice(2), policy: Object.fromEntries(Object.entries(process.env).filter(([key]) => ["npm_config_before", "npm_config_min_release_age", "npm_config_min-release-age"].includes(key.toLowerCase()))) }));\n`,
    );

    const runNpmFixture = (
      source: string,
      env: NodeJS.ProcessEnv = process.env,
      cwd = process.cwd(),
    ) =>
      runCommand(
        "bash",
        [
          "-c",
          source,
          "bash",
          join(process.cwd(), "scripts/docker/install-sh-common/version-parse.sh"),
        ],
        { cwd, env },
      );

    const noPolicyResult = runNpmFixture(
      "set -euo pipefail; source scripts/docker/install-sh-common/version-parse.sh; run_npm_without_freshness_policy bash -c 'printf ok'",
      Object.fromEntries(
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
    );
    expect(noPolicyResult, noPolicyResult.stderr).toMatchObject({ status: 0, stdout: "ok" });

    const noHomeResult = runNpmFixture(
      "unset HOME; source scripts/docker/install-sh-common/version-parse.sh; resolve_npm_config_path_value '~/.npmrc'",
    );
    expect(noHomeResult.status, noHomeResult.stderr).toBe(0);
    const nativeHomeResult = runCommand(
      process.execPath,
      ["-e", "delete process.env.HOME; process.stdout.write(require('node:os').homedir())"],
      { env: process.env },
    );
    expect(nativeHomeResult.status, nativeHomeResult.stderr).toBe(0);
    expect(noHomeResult.stdout).toBe(join(nativeHomeResult.stdout, ".npmrc"));

    const result = runNpmFixture(
      "source scripts/docker/install-sh-common/version-parse.sh; quiet_npm view openclaw@2026.8.32 version",
      {
        ...process.env,
        NPM_CONFIG_BEFORE: "2026-09-17T23:07:28.000Z",
        NPM_CONFIG_GLOBALCONFIG: join(root, "missing-global.npmrc"),
        NPM_CONFIG_before: "2026-09-17T23:07:28.000Z",
        "NPM_CONFIG_MIN-RELEASE-AGE": "10080",
        NPM_CONFIG_MIN_RELEASE_AGE: "10080",
        Npm_Config_Min_Release_Age: "10080",
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        npm_config_before: "2026-09-17T23:07:28.000Z",
        npm_config_min_release_age: "10080",
        "npm_config_min-release-age": "10080",
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
    const expectConfig = (
      command: string,
      expected: unknown[],
      cwd = nestedProjectDir,
      env: NodeJS.ProcessEnv = { ...process.env, HOME: root },
    ) => {
      const configResult = runNpmFixture(`source "$1"; ${command}`, env, cwd);
      expect(configResult.status, configResult.stderr).toBe(0);
      expect(configResult.stdout.trim().split("\n")).toEqual(expected);
    };
    writeFiles(root, {
      "project/package.json":
        '{"name":"npm-policy-root","workspaces":["!packages/private","./packages/*/"]}\n',
      "project/packages/fixture/package.json": '{"name":"npm-policy-fixture"}\n',
      "global.npmrc": "min-release-age=7\nfetch-retries=23\n",
      "project-global.npmrc": "min-release-age=7\nfetch-retries=17\n",
      ".npmrc": `before=2026-09-17T23:07:28.000Z
globalconfig=\${HOME}/global.npmrc
registry=https://user-registry.example.test/
ca[]=user-ca`,
      "project-user.npmrc":
        "globalconfig=${HOME}/global.npmrc\nregistry=https://selected-user-registry.example.test/\n",
      "project/.npmrc":
        "before=2026-09-17T23:07:28.000Z\nuserconfig=${HOME}/project-user.npmrc # selected user config\nglobalconfig=${HOME}/project-global.npmrc # selected global config\nregistry=https://project-registry.example.test/\nca[]=project-ca\ncafile=./certs/ca.pem\n",
      "project/packages/fixture/nested/.npmrc": "registry=https://nested.example.test/\n",
      "project/packages/fixture/.npmrc": "registry=https://workspace.example.test/\n",
    });
    expectConfig(
      "quiet_npm config get before; quiet_npm config get registry; quiet_npm config get fetch-retries; quiet_npm config get ca --json; quiet_npm config get cafile",
      [
        "null",
        "https://project-registry.example.test/",
        "17",
        "project-ca",
        join(nestedProjectDir, "certs", "ca.pem"),
      ],
    );
    expectConfig("quiet_npm config get registry --location global", [
      "https://user-registry.example.test/",
    ]);

    const excludedWorkspaceDir = join(projectDir, "packages", "private");
    const excludedNestedDir = join(excludedWorkspaceDir, "nested");
    writeFiles(excludedWorkspaceDir, {
      "package.json": '{"name":"npm-policy-private"}\n',
      ".npmrc": "registry=https://private-registry.example.test/\n",
    });
    mkdirSync(excludedNestedDir);
    expectConfig(
      "quiet_npm config get registry",
      ["https://private-registry.example.test/"],
      excludedNestedDir,
    );

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
      expectConfig(
        "quiet_npm config get fetch-timeout; quiet_npm config get fetch-retries; quiet_npm config get globalconfig",
        ["1234", "17", expect.stringMatching(/^\/dev\/fd\/\d+$/u)],
        nestedProjectDir,
        { ...configPathNeutralEnv, HOME: root, ...configEnv },
      );
    }
  });

  it.each([
    { failAiSwap: false, status: 0, tree: "new" },
    { failAiSwap: true, status: 1, tree: "old" },
  ])(
    "restores both image build trees atomically (failAiSwap=$failAiSwap)",
    ({ failAiSwap, status, tree }) => {
      const result = runRestoreLocalDistFixture({ failAiSwap });
      expect(result.status, result.stderr).toBe(0);
      expectIncludes(result.stdout, `status=${status}`, `root=${tree}-root`, `ai=${tree}-ai`);
    },
  );

  it.each(["packages", "ai"] as const)(
    "rejects a symlinked %s path before restoring artifacts",
    (symlinkEscape) => {
      const result = runRestoreLocalDistFixture({ symlinkEscape });

      expect(result.status, result.stderr).toBe(0);
      expectIncludes(
        result.stdout,
        "status=1",
        "root=old-root",
        "ai=external-ai",
        "external=external-ai",
      );
      expect(result.stderr).not.toContain("docker-call=");
      expect(result.stderr).toContain("refusing package artifact restore through a symlinked");
    },
  );

  it("fails closed when exact image artifacts fail import closure", () => {
    const result = runBash(`set -euo pipefail
HARNESS_ROOT=/trusted
ROOT_DIR=/candidate
UPDATE_SKIP_LOCAL_BUILD=1
node() {
  return 1
}
pnpm() {
  printf 'pnpm-called\\n'
}
${extractScript(
  SCRIPT_PATH,
  /(ensure_local_update_dist_import_closure\(\) \{[\s\S]*?\n\})\n\nread_candidate_version/u,
)}
status=0
ensure_local_update_dist_import_closure || status=$?
printf 'status=%s\\n' "$status"
`);

    expect(result, result.stderr).toMatchObject({
      status: 0,
      stdout: expect.stringContaining("status=1"),
    });
    expect(result.stdout).not.toContain("pnpm-called");
    expect(result.stderr).toContain("exact-image mode forbids a local rebuild");
  });

  it.each([
    {
      version: "24.22.1",
      options: { sqlite: false },
      error: "unsupported node 24.22.1: missing node:sqlite",
    },
    {
      version: "24.17.0",
      options: { sqliteVersion: "3.51.2" },
      error: "unsupported node 24.17.0: unsafe SQLite 3.51.2",
    },
  ])("validates non-root Node $version with $options", ({ version, options, error }) => {
    const result = runNonrootNodePreflight(version, options);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(error);
  });

  it("accepts non-root smoke Node runtimes that match the installer runtime floor", () => {
    expect(runNonrootNodePreflight("22.23.2").status).toBe(1);
    expect(runNonrootNodePreflight("24.22.1").status).toBe(0);
    expect(runNonrootNodePreflight("26.0.0").status).toBe(1);
    expect(runNonrootNodePreflight("26.12.1").status).toBe(0);
  });

  it("installs Playwright into the runtime browser cache", () => {
    expect(readFileSync("Dockerfile", "utf8")).toMatch(
      /ENV PLAYWRIGHT_BROWSERS_PATH=\/home\/node\/\.cache\/ms-playwright[\s\S]*?mkdir -p "\$PLAYWRIGHT_BROWSERS_PATH"[\s\S]*?playwright-core\/cli\.js install --with-deps "\$@" chromium/u,
    );
    expectIncludes(
      readFileSync("Dockerfile", "utf8"),
      "1) set -- ;;",
      "chromium) set -- --no-shell",
      "headless-shell) set -- --only-shell",
    );
  });

  it.each([
    [DOCKER_SETUP_PATH, "run_docker_pull"],
    [PODMAN_SETUP_PATH, "run_podman_pull"],
    [PODMAN_SETUP_PATH, "run_podman_build"],
    [PODMAN_RUN_PATH, "run_podman_detached"],
  ])("ships %s %s wired to the host timeout owner (static packaging contract)", (file, helper) => {
    // This guards packaged adapter ownership; it does not measure timeout enforcement.
    const body = extractScript(file, new RegExp("(" + helper + "\\(\\) \\{[\\s\\S]*?\\n\\})", "u"));
    expect(body).toMatch(/openclaw_host_timeout_cmd "\$[A-Z_]+" (?:docker|podman) /u);
  });

  it("validates Docker timezones against the selected image runtime", () => {
    for (const timezone of ["Asia/Shanghai", "UTC"]) {
      const result = runDockerTimezoneValidator(timezone);
      expect(result).toMatchObject({ stderr: "", status: 0 });
    }

    expect(runDockerTimezoneValidator("zone.tab").status).toBe(1);
  });

  it("binds the Podman Quadlet Gateway port to loopback", () => {
    const template = readFileSync(PODMAN_QUADLET_TEMPLATE_PATH, "utf8");
    expect(template).toContain("PublishPort=127.0.0.1:18789:18789");
  });
  it("restricts secret-backed Docker checks to repository history or release tags", () => {
    const workflow = readFileSync(LIVE_E2E_WORKFLOW_PATH, "utf8");
    expect(workflow).toMatch(/git rev-parse --verify "\$\{INPUT_REF\}\^\{commit\}"/u);
    expect(workflow).toContain(
      'git merge-base --is-ancestor "$selected_sha" refs/remotes/origin/main',
    );
    expect(workflow).toMatch(/git tag --points-at "\$selected_sha" \| grep -Eq '\^v'/u);
    expect(workflow).toMatch(
      /git for-each-ref[^\n]+--contains "\$selected_sha" refs\/remotes\/origin/u,
    );
  });

  it("normalizes npm 12 pack output and enforces the budget without tsx", () => {
    const pack = { filename: "openclaw-2026.8.1.tgz", unpackedSize: 100, version: "2026.8.1" };
    const withinBudget = runInstallSmokePackHelpers({ openclaw: pack });
    expect(withinBudget.result).toMatchObject({ status: 0, stderr: "" });
    expect(withinBudget.normalized).toEqual([pack]);

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

    const unsafeFilenames = ["../openclaw.tgz", "nested\\openclaw.tgz", "openclaw.tar.gz"];

    for (const filename of unsafeFilenames) {
      const result = runReadPackTarballFilename(filename);

      expect(result.status, filename).not.toBe(0);
      expect(result.stderr, filename).toContain("npm pack reported unsafe tarball filename");
    }
  });

  it("packages and validates local updates through the trusted harness", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");
    expect(script).toContain('node "$HARNESS_ROOT/scripts/package-openclaw-for-docker.mjs"');
    expect(script).toMatch(
      /node "\$HARNESS_ROOT\/scripts\/check-openclaw-package-tarball\.mjs"[\s\S]*?--require-bundled-workspace-deps/u,
    );
  });

  it("ships a frozen-payload branch without local-build dependencies (static packaging contract)", () => {
    // Dependency/branch wiring only, not proof of execution or filesystem mutation.
    const branch = extractScript(
      SCRIPT_PATH,
      /prepare_update_tarball\(\) \{[\s\S]*?if \[\[ -n "\$FROZEN_PAYLOAD_DIR" \]\]; then([\s\S]*?)elif/u,
    );
    expect(branch).toMatch(
      /cp "\$FROZEN_PAYLOAD_DIR\/candidate\.tgz"[\s\S]*?cp "\$FROZEN_PAYLOAD_DIR\/candidate-pack\.json"/u,
    );
    expect(branch).not.toMatch(
      /pnpm build|package-openclaw-for-docker|normalize_npm_pack_json_file/u,
    );
    expect(readFileSync(SCRIPT_PATH, "utf8")).toMatch(
      /require_regular_payload_file "\$FROZEN_PAYLOAD_DIR\/install(?:-cli)?\.sh"/u,
    );
  });

  it("does not execute or retain a non-root installer after curl fails", () => {
    const fixture = runFailedInstallerDownload(true);
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
});

describe("install-sh E2E runner", () => {
  it("scans bounded completed transcripts and excludes oversized or partial records", () => {
    const tool = JSON.stringify({ type: "tool_use", name: "exec", input: {} });
    expect(scanInstallE2eTranscript(`unparseable\n${tool}\n`).code).toBe(0);
    expect(scanInstallE2eTranscript(tool).code).toBe(0);
    expect(
      scanInstallE2eTranscript(tool, { OPENCLAW_INSTALL_E2E_SESSION_SCAN_BYTES: "20" }),
    ).toMatchObject({
      code: 1,
      errors: expect.arrayContaining(["Transcript scan stopped after 20 bytes"]),
    });
    expect(
      scanInstallE2eTranscript(`${tool}\n`, { OPENCLAW_INSTALL_E2E_SESSION_LINE_BYTES: "20" }),
    ).toMatchObject({
      code: 1,
      errors: expect.arrayContaining(["Skipped 1 oversized transcript line(s)"]),
    });
  });

  it("does not execute a partial installer after a bounded download fails", () => {
    const fixture = runFailedInstallerDownload(false);

    expect(fixture.result.status).toBe(28);
    expect(readFileSync(fixture.curlArgsPath, "utf8")).toContain(
      "-fsSL --connect-timeout 10 --max-time 120 https://installer.example.test/install.sh -o",
    );
    expect(existsSync(fixture.markerPath)).toBe(false);
    expect(existsSync(readFileSync(fixture.outputPathCapture, "utf8"))).toBe(false);
  });

  it.each([
    [INSTALL_E2E_DOCKER_PATH, "OPENCLAW_INSTALL_E2E_AGENT_TURN_TIMEOUT_SECONDS", "300s"],
    [INSTALL_E2E_DOCKER_PATH, "OPENCLAW_INSTALL_E2E_AGENT_TURNS_PARALLEL", "2"],
    [INSTALL_E2E_DOCKER_PATH, "OPENCLAW_INSTALL_E2E_SESSION_SCAN_DEPTH", "0"],
    [INSTALL_E2E_RUNNER_PATH, "OPENCLAW_INSTALL_E2E_AGENT_TURN_TIMEOUT_SECONDS", "300s"],
    [INSTALL_E2E_RUNNER_PATH, "OPENCLAW_INSTALL_E2E_AGENT_TURNS_PARALLEL", "2"],
    [SMOKE_RUNNER_PATH, "OPENCLAW_INSTALL_SMOKE_COMMAND_TIMEOUT", "900s"],
    [SMOKE_RUNNER_PATH, "OPENCLAW_INSTALL_SMOKE_HEARTBEAT_INTERVAL", "60s"],
    [BUN_GLOBAL_SMOKE_PATH, "OPENCLAW_BUN_GLOBAL_SMOKE_TIMEOUT_MS", "180000ms"],
  ] as const)("%s rejects invalid %s before setup", (script, envName, value) => {
    const result = runCommand("bash", [script], {
      env: {
        ...process.env,
        [envName]: value,
      },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`invalid ${envName}: ${value}`);
    if (script === INSTALL_E2E_DOCKER_PATH) {
      expect(result.stdout).not.toContain("==> Build image:");
    } else {
      const setupDiagnostic = {
        [INSTALL_E2E_RUNNER_PATH]: "OPENCLAW_E2E_MODELS=both requires",
        [SMOKE_RUNNER_PATH]: "unsupported OPENCLAW_INSTALL_SMOKE_MODE",
        [BUN_GLOBAL_SMOKE_PATH]: "Bun is required",
      }[script];
      expect(result.stderr).not.toContain(setupDiagnostic);
    }
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

    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(result.output)).toEqual(payload);
  });
});

describe("install-sh smoke runner", () => {
  it.runIf(process.platform !== "win32").for([23])(
    "reaps the heartbeat timer and preserves command exit %i",
    async (exitCode, { signal, onTestFinished }) => {
      const fixtureDirs = childFixture(onTestFinished);
      const root = fixtureDirs.make("openclaw-smoke-heartbeat-");
      const bin = join(root, "bin");
      const pidFile = join(root, "timer.pid");
      const readyPipe = join(root, "timer-ready");
      mkdirSync(bin);
      writeExecutable(
        join(bin, "sleep"),
        '#!/bin/bash\nexec >/dev/null 2>&1\nprintf "%s" "$$" >"$SLEEP_PID_FILE"\nprintf "%s\\n" "$$" >&3\nexec /bin/sleep "$@"\n',
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
      const { closed, output, cleanup } = fixtureDirs.own(child, [pidFile], true);
      try {
        const result = { ...(await withinTest(closed, signal)), ...output };
        const timerPid = Number(readFileSync(pidFile, "utf8"));
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
    { scenario: "linked service definition", exitCode: 0, updateCount: 2 },
    { scenario: "service manager", exitCode: 1, updateCount: 0 },
    { scenario: "inspection failure", exitCode: 1, updateCount: 0 },
  ])(
    "uses the baseline manual path only after offline proof and checks candidate defaults: $scenario",
    ({ scenario, exitCode, updateCount }) => {
      const { root, bin } = fixturePaths("update-smoke");
      const globalRoot = join(root, "node_modules");
      const versionFile = join(root, "version");
      const callsFile = join(root, "updates.jsonl");
      const preload = join(root, "native-inspection.cjs");
      const systemd = join(root, "systemd");
      mkdirSync(systemd);
      if (scenario === "linked service definition") {
        const outside = join(root, "outside-systemd");
        mkdirSync(outside);
        writeFileSync(join(outside, "openclaw-gateway.service"), "outside service");
        symlinkSync(outside, join(systemd, "linked"), "dir");
        symlinkSync(systemd, join(systemd, "loop"), "dir");
      }
      if (scenario === "service definition") {
        writeFileSync(join(systemd, "openclaw-gateway.service"), "fixture service");
      }
      mkdirSync(join(globalRoot, "openclaw"), { recursive: true });
      writeFileSync(join(globalRoot, "openclaw", "package.json"), '{"version":"2026.8.2"}');
      writeFileSync(versionFile, "2026.8.2");
      writeFileSync(callsFile, "");
      symlinkSync(testNodeExecPath, join(bin, "node"));
      writeCommands(bin, {
        npm: '#!/bin/bash\nif [[ " $* " == *" root -g "* ]]; then printf "%s\\n" "$FAKE_GLOBAL_ROOT"; fi\n',
        timeout: '#!/bin/bash\nshift 2\nexec "$@"\n',
        openclaw: `#!${testNodeExecPath}
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
      });
      // Simulate native /proc and service files; execute the complete shell runner and CLI boundary.
      writeFileSync(
        preload,
        `const fs = require("node:fs");
const realRead = fs.readFileSync;
const realList = fs.readdirSync;
const realOpen = fs.opendirSync;
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
  return realList(file, ...args);
};
fs.opendirSync = (file, ...args) => {
  if (String(file).endsWith("/systemd")) {
    if (process.env.FAKE_SCENARIO === "inspection failure") throw Object.assign(new Error("inspection denied"), { code: "EACCES" });
    return realOpen(process.env.FAKE_SYSTEMD_DIR, ...args);
  }
  return realOpen(file, ...args);
};
fs.readFileSync = (file, ...args) => {
  if (file === "/proc/1/cmdline") return "bash\\0/usr/local/bin/openclaw-install-smoke\\0";
  if (file === "/proc/42/cmdline") return "openclaw-gateway\\0";
  return realRead(file, ...args);
};
`,
      );
      const result = runCommand("bash", [SMOKE_RUNNER_PATH], {
        env: {
          HOME: root,
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
          NODE_OPTIONS: `--require=${preload}`,
          FAKE_SCENARIO: scenario,
          FAKE_SYSTEMD_DIR: systemd,
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
      if (scenario === "service definition") {
        expect(result.stderr).toContain("service definition exists");
      }
      if (scenario === "inspection failure") {
        expect(result.stderr).toContain("inspection denied");
      }
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

  it.each([0, 28])("preserves timed installer arguments and curl exit %s", (curlExitCode) => {
    const installerArgs = [
      "--install-method",
      "npm",
      "--version",
      "https://packages.example.test/openclaw.tgz?x=1&y=2",
      "--no-prompt",
    ];
    const fixture = runInstallSmokeInstallerPipelineFixture({ installerArgs, curlExitCode });

    expect(fixture.result.status, fixture.result.stderr).toBe(curlExitCode);
    expect(readNulSeparatedArgs(fixture.timeoutArgsPath)).toEqual(["--kill-after=30s", "17s"]);
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

  it.each([
    ["unrelated skip", { reason: "dirty" }, "already-current", 1],
    ["changed build", { after: { version: "2026.9.3", buildId: "other" } }, "already-current", 1],
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
    [
      "failed recovery cleanup",
      {
        steps: [
          {
            name: "package-install",
            exitCode: 0,
            command: "npm install http://candidate.invalid/openclaw.tgz",
          },
          { name: "recovery-artifact-cleanup", exitCode: 1 },
        ],
      },
      "already-current",
      1,
    ],
    ["skipped first upgrade", {}, "applied", 1],
  ])("validates explicit installer outcome: %s", (_label, overrides, outcome, expectedExit) => {
    const payload = {
      status: "skipped",
      reason: "already-current",
      before: { version: "2026.9.3", buildId: "candidate-build" },
      after: { version: "2026.9.3", buildId: "candidate-build" },
      steps: [{ name: "package-install", exitCode: 0, command: `npm install ${UPDATE_URL}` }],
      ...overrides,
    };
    const result = runUpdateJson(payload, { UPDATE_EXPECT_OUTCOME: outcome });
    expect(result.status, result.stderr).toBe(expectedExit);
  });

  it("accepts one automatic recovery cleanup after an already-current update", () => {
    const payload = {
      status: "skipped",
      reason: "already-current",
      before: { version: "2026.9.3", buildId: "candidate-build" },
      after: { version: "2026.9.3", buildId: "candidate-build" },
      steps: [
        { name: "package-install", exitCode: 0, command: `npm install ${UPDATE_URL}` },
        { name: "recovery-artifact-cleanup", exitCode: 0 },
      ],
    };

    expect(runUpdateJson(payload, { UPDATE_EXPECT_OUTCOME: "already-current" }).status).toBe(0);
  });

  it("accepts legacy same-version apply only with the frozen-target compatibility flag", () => {
    const payload = {
      status: "ok",
      before: { version: "2026.7.33" },
      after: { version: "2026.7.33" },
      steps: [
        { name: "global update", exitCode: 0, command: `npm install ${UPDATE_URL}` },
        { name: "global install swap", exitCode: 0 },
        { name: "openclaw doctor", exitCode: 0 },
      ],
    };
    const run = (allowLegacy: boolean) =>
      runUpdateJson(payload, {
        UPDATE_EXPECT_OUTCOME: "already-current",
        ...(allowLegacy ? { OPENCLAW_INSTALL_ALLOW_LEGACY_SAME_VERSION_APPLY: "1" } : {}),
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
      undefined,
    ],
    ["missing", undefined, "missing openclaw doctor step"],
    ["untyped advisory", { name: "openclaw doctor", exitCode: 86 }, "openclaw doctor step failed"],
  ])("validates a %s package post-install doctor result", (_label, doctorStep, error) => {
    const result = validateInstallSmokeUpdateJson(doctorStep);
    if (error) {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(error);
    } else {
      expect(result.status, result.stderr).toBe(0);
    }
  });
});

describe("bun global install smoke", () => {
  const runTimeout = (
    timeout: string,
    grace: string,
    command: string[],
    options: { preload?: string; timeout?: number } = {},
  ) =>
    runCommand(
      testNodeExecPath,
      [
        ...(options.preload ? ["--import", options.preload] : []),
        BUN_GLOBAL_ASSERTIONS_PATH,
        "run-with-timeout",
        timeout,
        ...command,
      ],
      {
        env: { ...process.env, OPENCLAW_BUN_GLOBAL_SMOKE_TIMEOUT_KILL_GRACE_MS: grace },
        timeout: options.timeout,
      },
    );
  const bunCase = (
    name: string,
    overrides: { bunRuntime?: string; statusExit?: number; aiVersion?: string } = {},
  ) => ({ name, bunRuntime: "supported", statusExit: 0, aiVersion: "2026.6.17", ...overrides });
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
    return runTimeout("60000", "100", ["fixture"], { preload: preloadPath });
  };

  it.runIf(process.platform !== "win32").each([
    { first: "timer", failure: undefined, error: undefined },
    { first: "drain", failure: undefined, error: undefined },
    { first: "drain", failure: "permission", error: "kill EPERM" },
    {
      first: "timer",
      failure: "uncleared",
      error: "command process group remained active after SIGKILL",
    },
  ] as const)(
    "force-kills Bun descendants once (first=$first, failure=$failure)",
    ({ first, failure, error }) => {
      const result = runForceKillOrderingFixture(first, failure);
      expect(result.status, result.stderr).toBe(error ? 1 : 143);
      if (error) {
        expect(result.stderr).toContain(error);
      }
      expect(result.stdout).toContain("force-kill-attempts=1");
    },
  );

  it("requires Bun to trust and execute OpenClaw lifecycle scripts", () => {
    const tempDir = tempDirs.make("openclaw-bun-trusted-lifecycle-");
    const packageRoot = join(tempDir, "node_modules", "openclaw");
    const globalManifestPath = join(tempDir, "package.json");
    const untrustedOutputPath = join(tempDir, "untrusted.txt");
    mkdirSync(join(packageRoot, "dist"), { recursive: true });
    writeFileSync(globalManifestPath, JSON.stringify({ trustedDependencies: ["openclaw"] }));
    writeFileSync(untrustedOutputPath, "./node_modules/koffi [install]\n");

    const assertTrusted = () =>
      runCommand(testNodeExecPath, [
        BUN_GLOBAL_ASSERTIONS_PATH,
        "assert-openclaw-trusted",
        packageRoot,
        globalManifestPath,
        untrustedOutputPath,
      ]);
    const trusted = assertTrusted();
    expect(trusted.status, trusted.stderr).toBe(0);

    writeFileSync(untrustedOutputPath, "./node_modules/openclaw [preinstall, postinstall]\n");
    const blocked = assertTrusted();
    expect(blocked.status).not.toBe(0);
    expect(blocked.stderr).toContain("OpenClaw lifecycle scripts remain blocked by Bun");

    writeFileSync(untrustedOutputPath, "");
    writeFileSync(join(packageRoot, ".openclaw-lifecycle-pending"), "pending\n");
    const skipped = assertTrusted();
    expect(skipped.status).not.toBe(0);
    expect(skipped.stderr).toContain("OpenClaw package lifecycle did not complete");
  });

  it.runIf(process.platform !== "win32").each([
    bunCase("uses bundled AI bytes when a prebuilt tarball is provided"),
    bunCase("rejects a mismatched bundled AI candidate before installation", {
      aiVersion: "2026.6.18",
    }),
    bunCase("preserves redirected Bun command diagnostics and exit status", { statusExit: 23 }),
    bunCase("uses Node for a Bun-installed package that explicitly rejects the Bun runtime", {
      bunRuntime: "unsupported",
    }),
    bunCase("does not hide an unexpected direct Bun runtime failure", {
      bunRuntime: "unexpected-failure",
    }),
  ])("$name", ({ bunRuntime, statusExit, aiVersion }) => {
    const tempDir = tempDirs.make("openclaw-bun-prebuilt-");
    const packageDir = join(tempDir, "fixture", "package");
    const packageTgz = join(tempDir, "openclaw-prebuilt.tgz");
    const bunPath = join(tempDir, "bun");
    const statePath = join(tempDir, "state-path");
    const aiTarballPath = join(tempDir, "ai-tarball-path");
    writeFiles(packageDir, {
      "package.json": JSON.stringify({
        name: "openclaw",
        version: "2026.6.17",
        dependencies: { "@openclaw/ai": "2026.6.17" },
        bundleDependencies: ["@openclaw/ai"],
      }),
      "node_modules/@openclaw/ai/package.json": JSON.stringify({
        name: "@openclaw/ai",
        version: aiVersion,
      }),
    });
    const packed = runCommand("tar", [
      "-czf",
      packageTgz,
      "-C",
      join(tempDir, "fixture"),
      "package",
    ]);
    expect(packed.status, packed.stderr).toBe(0);
    writeFileSync(
      bunPath,
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--version" ]; then
  echo "1.4.4"
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
override="$(node -e 'const p=require(process.argv[1]);process.stdout.write(p.overrides["@openclaw/ai"])' "$BUN_INSTALL/install/global/package.json")"
case "\${override#file:}" in
  *.tgz) ;;
  *) exit 1 ;;
esac
test -f "\${override#file:}"
package_root="$BUN_INSTALL/install/global/node_modules/openclaw"
mkdir -p "$BUN_INSTALL/bin" "$package_root/dist/plugin-sdk"
printf '%s\\n' "$OPENCLAW_STATE_DIR" >"$FAKE_STATE_PATH"
printf '%s\\n' "\${override#file:}" >"$FAKE_AI_TARBALL_PATH"
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
      if (_req.url === "/readyz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ready: true }));
        return;
      }
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

    const result = runCommand("bash", [BUN_GLOBAL_SMOKE_PATH], {
      env: {
        ...process.env,
        BUN_BIN: bunPath,
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
      expect(result).toMatchObject({
        status: 1,
        stderr: expect.stringContaining(
          "candidate version mismatch: openclaw=2026.6.17, dependency=2026.6.17, @openclaw/ai=2026.6.18",
        ),
      });
      expect(existsSync(statePath)).toBe(false);
      return;
    }

    const expectedExit = bunRuntime === "unexpected-failure" ? 42 : statusExit;
    expect(result.status, result.stderr).toBe(expectedExit);
    expect(existsSync(path.dirname(readFileSync(statePath, "utf8").trim()))).toBe(false);
    expect(existsSync(path.dirname(readFileSync(aiTarballPath, "utf8").trim()))).toBe(false);
    if (bunRuntime !== "unexpected-failure") {
      expect(result.stdout).toContain("bun-global-install-smoke: image providers OK (3 providers)");
    }
    if (bunRuntime === "unexpected-failure") {
      expect(result.stderr).toContain("synthetic direct Bun runtime failure");
      expect(result.stdout).not.toContain("Gateway runtime OK");
    } else if (statusExit === 0) {
      expect(result.stdout).toContain(
        `bun-global-install-smoke: Bun 1.4.4 install with ${bunRuntime === "supported" ? "Bun" : "Node"} CLI, local agent, and Gateway runtime OK`,
      );
    } else {
      expectIncludes(
        result.stderr,
        "bun global install smoke failed with exit code 23",
        "synthetic Bun status failure",
      );
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
      const childScript = `const fs = require('node:fs');
process.on('SIGTERM', () => {
  setTimeout(() => {
    fs.writeFileSync(process.argv[2], 'drained');
    process.exit(0);
  }, 50);
});
fs.writeFileSync(process.argv[1], 'ready');
setInterval(() => {}, 1000);`;

      const result = runTimeout(
        "500",
        "1000",
        ["/usr/bin/time", testNodeExecPath, "-e", childScript, readyPath, drainedPath],
        { timeout: 5_000 },
      );

      expect(result).toMatchObject({
        status: 1,
        stderr: expect.stringContaining("command timed out after 500ms: /usr/bin/time"),
      });
      expect(readFileSync(readyPath, "utf8")).toBe("ready");
      expect(readFileSync(drainedPath, "utf8")).toBe("drained");
    },
  );

  it.runIf(process.platform !== "win32")(
    "cleans Bun global smoke descendants on parent signal",
    async ({ signal, onTestFinished }) => {
      const fixtureDirs = childFixture(onTestFinished);
      const tempDir = fixtureDirs.make("openclaw-bun-global-parent-signal-");
      const readyPath = path.join(tempDir, "ready");
      const descendantPidPath = path.join(tempDir, "descendant.pid");
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
      const { closed: runnerExit, output, cleanup } = fixtureDirs.own(runner, [descendantPidPath]);
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
        const descendantPid = Number(readFileSync(descendantPidPath, "utf8"));
        expect(descendantPid).toBeGreaterThan(0);
        expect(isProcessAlive(descendantPid)).toBe(true);

        const signalSent = runner.kill("SIGTERM");
        const result = await withinTest(runnerExit, signal);

        expect(signalSent, output.stderr).toBe(true);
        expect(result, output.stderr).toEqual({ status: 143, signal: null });
        // Status 143 is emitted only after the assertion runner observes its group gone.
        expect(isProcessAlive(descendantPid)).toBe(false);
      } finally {
        await cleanup();
      }
    },
  );

  it("kills Bun global install smoke commands that ignore TERM after timeout", () => {
    const result = runTimeout(
      "50",
      "50",
      [testNodeExecPath, "-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
      { timeout: 5000 },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`command timed out after 50ms: ${testNodeExecPath}`);
  });
});
