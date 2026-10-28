import {
  type ChildProcess,
  execFileSync,
  spawn,
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
} from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mainLanes } from "../../scripts/lib/docker-e2e-scenarios.mts";
import { readSystemdServiceExecStart } from "../../src/daemon/systemd-service-files.js";
import { buildSystemdUnit } from "../../src/daemon/systemd-unit.js";
import { listDirectoryTreeStrictSync } from "../../src/infra/directory-walk.js";
import { isPidAlive } from "../../src/shared/pid-alive.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../helpers/fixture-receipts.js";
import { waitForFixtureFile } from "../helpers/process-wait.js";
import { awaitGateBeforeSettlement, withinTest } from "../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  copySurvivorCaptureClosure,
  UPGRADE_SURVIVOR_DIAGNOSTICS_PATH,
} from "../helpers/upgrade-survivor-diagnostics.js";
import {
  readUpgradeSurvivorPaths,
  UPGRADE_SURVIVOR_PATHS_HELPER,
} from "./upgrade-survivor-paths.test-support.js";
import {
  readJson as readDiagnosticJson,
  successSummary,
  writeJson as writeDiagnosticJson,
} from "./upgrade-survivor-shard.test-support.js";

const pendingChildCompletions = new Set<Promise<unknown>>();
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    // Vitest starts afterEach without joining a timed-out body's async finally.
    // Keep stop-policy scripts and child state until their native owners settle.
    await Promise.allSettled(pendingChildCompletions);
    cleanup();
  }),
);
const testNodeExecPath = resolveTestNodeExecPath();
let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts?.close();
});

function ownChildCompletion<T>(completion: Promise<T>): Promise<T> {
  const owned = completion.finally(() => {
    pendingChildCompletions.delete(owned);
  });
  pendingChildCompletions.add(owned);
  return owned;
}

function writeFixtureReceiptReporter(workDir: string): string {
  const reporter = join(workDir, "fixture-receipt.mjs");
  writeFileSync(
    reporter,
    `${fixtureReceiptClientSource(receipts.endpoint)}
import fs from "node:fs";
const [source, line] = process.argv.slice(2);
fs.appendFileSync(source, line + "\\n");
sendReceipt(source, line);
fixtureReceiptSocket.ref();
fixtureReceiptSocket.end();
`,
  );
  return reporter;
}

function fixtureEventBeforeSettlement(
  source: string,
  text: string,
  operation: PromiseLike<unknown>,
  message: string,
): Promise<void> {
  const recorded = () => existsSync(source) && readFileSync(source, "utf8").includes(text);
  const settled = Promise.resolve(operation).then(
    () => {
      if (!recorded()) {
        throw new Error(message);
      }
    },
    (error: unknown) => {
      if (!recorded()) {
        throw error;
      }
    },
  );
  return Promise.race([receipts.waitFor(source, text), settled]);
}

const PACKAGE_BUILDER_NODE_SCRIPT = `node() {
  local script="$1"
  shift
  if [[ "$script" != "$DOCKER_E2E_PACKAGE_LIB_DIR/../package-openclaw-for-docker.mjs" ]]; then
    command node "$script" "$@"
    return
  fi

  local output_dir=""
  local output_name=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --output-dir)
        output_dir="$2"
        shift 2
        ;;
      --output-name)
        output_name="$2"
        shift 2
        ;;
      *)
        shift
        ;;
    esac
  done

  mkdir -p "$output_dir"
  printf fixture >"$output_dir/$output_name"
  printf "%s\\n" "$output_dir/$output_name"
}
export -f node`;

const PACKAGE_BUILD_CONTEXT_PROBE_SCRIPT = `docker_build_run() {
  local build_context=""
  local arg
  for arg in "$@"; do
    case "$arg" in
      openclaw_package=*)
        build_context="\${arg#openclaw_package=}"
        ;;
    esac
  done

  test -n "$build_context"
  test -f "$build_context/openclaw-current.tgz"
  printf "%s\\n" "$build_context" >"$TMPDIR/build-context-seen"
}`;

const PASSTHROUGH_TIMEOUT_SCRIPT = `#!/usr/bin/env bash
case "$1" in
  --kill-after=1s)
    exit 0
    ;;
  --kill-after=30s)
    shift 2
    ;;
  *)
    shift
    ;;
esac
"$@"`;

const PASSTHROUGH_TIMEOUT_SETUP = `mkdir -p "$TMPDIR/bin"
cat >"$TMPDIR/bin/timeout" <<'SH'
${PASSTHROUGH_TIMEOUT_SCRIPT}
SH
chmod +x "$TMPDIR/bin/timeout"
export PATH="$TMPDIR/bin:$PATH"`;

const DOCKER_CIDFILE_PROBE = `local cidfile=""
  local previous="" arg
  for arg in "$@"; do
    [[ "$previous" != "--cidfile" ]] || cidfile="$arg"
    previous="$arg"
  done
  test -n "$cidfile"`;

const HELPER_PATH = "scripts/lib/docker-build.sh";
const DOCKER_E2E_PACKAGE_HELPER_PATH = "scripts/lib/docker-e2e-package.sh";
const DOCKER_E2E_IMAGE_HELPER_PATH = "scripts/lib/docker-e2e-image.sh";
const OPENCLAW_E2E_INSTANCE_HELPER_PATH = "scripts/lib/openclaw-e2e-instance.sh";
const DOCKER_PACKAGE_INSTALL_E2E_PATH = "scripts/e2e/docker-package-install.sh";
// Preserve the published 2026.8.1 query; the systemd fixture tests use the current reader.
const SURVIVOR_SERVICE_SHOW_ARGS = [
  "--user",
  "show",
  "openclaw-gateway.service",
  "--property",
  "Id,ActiveState,SubState,Result,NRestarts,StartLimitBurst,MainPID,ExecMainStatus,ExecMainCode,KillMode,TasksCurrent,MemoryCurrent",
];
const CLEANUP_DOCKER_SMOKE_PATH = "scripts/test-cleanup-docker.sh";
const OPENWEBUI_DOCKER_E2E_PATH = "scripts/e2e/openwebui-docker.sh";
const PLUGIN_BINDING_COMMAND_ESCAPE_DOCKER_E2E_PATH =
  "scripts/e2e/plugin-binding-command-escape-docker.sh";
const PLUGIN_BINDING_COMMAND_ESCAPE_DOCKERFILE_PATH =
  "scripts/e2e/plugin-binding-command-escape.Dockerfile";
const MULTI_NODE_UPDATE_DOCKER_E2E_PATH = "scripts/e2e/multi-node-update-docker.sh";
const CLEANUP_SMOKE_DOCKERFILE_PATH = "scripts/docker/cleanup-smoke/Dockerfile";
const CLEANUP_SMOKE_RUN_PATH = "scripts/docker/cleanup-smoke/run.sh";
const PLUGIN_LIFECYCLE_MATRIX_DOCKER_E2E_PATH = "scripts/e2e/plugin-lifecycle-matrix-docker.sh";
const DOCTOR_SWITCH_SCENARIO_PATH = "scripts/e2e/lib/doctor-install-switch/scenario.sh";
const DOCTOR_SWITCH_BUSCTL_SHIM_PATH = "scripts/e2e/lib/doctor-install-switch/shims/busctl";
const DOCTOR_SWITCH_SYSTEMD_EXEC_START_PATH =
  "scripts/e2e/lib/doctor-install-switch/shims/systemd-exec-start.mjs";
const UPGRADE_SURVIVOR_DOCKER_E2E_PATH = "scripts/e2e/upgrade-survivor-docker.sh";
const UPGRADE_SURVIVOR_DIAGNOSTICS_PUBLISH_PATH = "scripts/upgrade-survivor-diagnostics.mjs";
const PREPUBLISH_PLUGIN_REGISTRY_HELPER_PATH = "scripts/e2e/lib/prepublish-plugin-registry.sh";
const RELEASE_TYPED_ONBOARDING_DOCKER_E2E_PATH = "scripts/e2e/release-typed-onboarding-docker.sh";
const UPGRADE_SURVIVOR_RUN_SCRIPT = "scripts/e2e/lib/upgrade-survivor/run.sh";
const UPGRADE_SURVIVOR_UPDATE_RESTART_AUTH_PATH =
  "scripts/e2e/lib/upgrade-survivor/update-restart-auth.sh";
const UPGRADE_SURVIVOR_CONFIG_PARKING_PATH = "scripts/e2e/lib/upgrade-survivor/config-parking.mjs";
const GATEWAY_NETWORK_DOCKER_E2E_PATH = "scripts/e2e/gateway-network-docker.sh";
const BROWSER_CDP_SNAPSHOT_DOCKER_E2E_PATH = "scripts/e2e/browser-cdp-snapshot-docker.sh";
const SANDBOX_BROWSER_SIDECAR_DOCKER_E2E_PATH = "scripts/e2e/sandbox-browser-sidecar-docker.sh";
const SANDBOX_BROWSER_SIDECAR_SCENARIO_PATH =
  "scripts/e2e/lib/sandbox-browser-sidecar/scenario.mjs";

const CURRENT_INSTALL_PROBE_SETUP = `source "$ROOT_DIR/${OPENCLAW_E2E_INSTANCE_HELPER_PATH}"
source "$ROOT_DIR/${UPGRADE_SURVIVOR_UPDATE_RESTART_AUTH_PATH}"
install_update_restart_systemctl_shim() { :; }
openclaw_e2e_maybe_timeout() {
  shift
  "$@"
}`;

function extractUpgradeSurvivorPayload(script: string) {
  const marker = " bash -lc ";
  const start = script.indexOf(marker);
  const quoted = script.slice(start + marker.length).trimEnd();
  const end = quoted.search(/\n'(?:\n|$)/u);
  if (start < 0 || !quoted.startsWith("'") || end < 0) {
    throw new Error("upgrade survivor bash -lc payload not found");
  }
  return quoted.slice(1, end + 1).replaceAll(`'"'"'`, "'");
}

type ContainerCleanupEvent = { command: string; args: string[]; content?: string };

function containerCleanupFixture(scenario: string) {
  const root = realpathSync(tempDirs.make("openclaw-container-cleanup-"));
  // Extensionless command shims must not inherit an enclosing ESM package.
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "commonjs" }));
  const temp = join(root, "temp with spaces");
  const bin = join(root, "bin");
  const log = join(temp, "runner log");
  const eventsPath = join(root, "events.jsonl");
  const pidPath = join(root, "docker.pid");
  const readyPath = join(root, "docker.ready");
  const reporter = writeFixtureReceiptReporter(root);
  const stdinPath = join(root, "stdin");
  mkdirSync(temp);
  writeFileSync(join(root, "retained-evidence"), "keep evidence");
  writeFileSync(join(temp, "unrelated-sentinel"), "keep sentinel");
  writeFileSync(join(root, "profile"), "export OPENAI_API_KEY=synthetic-fixture-key\n");
  const record = `const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const record = (command, args, extra = {}) => fs.appendFileSync(
  process.env.FIXTURE_EVENTS, JSON.stringify({ command, args, ...extra }) + "\\n",
);
`;
  writeExecutables(bin, {
    timeout: PASSTHROUGH_TIMEOUT_SCRIPT,
    node: `#!/bin/bash
case "$1" in
  */openclaw-test-state.mts | */openclaw-test-state.mjs) printf 'export OPENCLAW_TEST_FAST=1\\n' ;;
  *) exec ${shellQuote(process.execPath)} "$@" ;;
esac
`,
    mktemp: `#!${process.execPath}
${record}
if (args[0] === "-t") {
  fs.writeFileSync(process.env.FIXTURE_RUN_LOG, "");
  record("mktemp", [process.env.FIXTURE_RUN_LOG]);
  console.log(process.env.FIXTURE_RUN_LOG);
} else {
  const result = spawnSync("/usr/bin/mktemp", args, { encoding: "utf8" });
  if (result.status !== 0) process.exit(result.status ?? 1);
  record("mktemp", [result.stdout.trim()]);
  process.stdout.write(result.stdout);
}
`,
    rm: `#!${process.execPath}
${record}
const log = process.env.FIXTURE_RUN_LOG;
record("rm", args, args.includes(log) ? { content: fs.readFileSync(log, "utf8") } : {});
if (args.some(arg => !arg.startsWith("-") && !arg.startsWith(process.env.HOME + "/"))) {
  throw new Error("unexpected removal outside fixture");
}
const result = spawnSync("/bin/rm", args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`,
    docker: `#!${process.execPath}
${record}
record("docker", args);
const scenario = process.env.FIXTURE_SCENARIO;
if (args[0] === "image" || args[0] === "rm") process.exit(0);
if (args[0] === "inspect") {
  console.log("ExitCode=23\\nOOMKilled=false\\nError=fixture");
  process.exit(0);
}
if (args[0] !== "run") throw new Error("unexpected Docker command");
const cid = args.indexOf("--cidfile");
if (cid !== -1) fs.writeFileSync(args[cid + 1], "fixture-container\\n");
if (args.includes("-i")) fs.writeFileSync(process.env.FIXTURE_STDIN, fs.readFileSync(0));
console.log("fixture container output");
if (scenario === "signal") {
  fs.writeFileSync(process.env.FIXTURE_PID, String(process.pid));
  process.on("SIGTERM", () => process.exit(143));
  require("node:child_process").spawn(process.execPath, [${JSON.stringify(reporter)}, ${JSON.stringify(readyPath)}, "ready"], { stdio: "ignore" });
  setInterval(() => {}, 1000);
} else {
  console.log("Tests 4 passed");
  process.exit(0);
}
`,
  });
  const env = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: root,
    TMPDIR: temp,
    OPENCLAW_STATE_DIR: join(root, "state"),
    OPENCLAW_CONFIG_PATH: join(root, "absent-config"),
    OPENCLAW_MCP_CODE_MODE_LIVE_PROFILE_FILE: join(root, "profile"),
    OPENCLAW_SKIP_DOCKER_BUILD: "1",
    OPENCLAW_DOCKER_E2E_REQUIRE_LOCAL_IMAGE: "1",
    OPENCLAW_DOCKER_E2E_AVAILABLE_CPUS: "2",
    OPENCLAW_DOCKER_E2E_CONTAINER_TERM_GRACE_SECONDS: "1",
    FIXTURE_EVENTS: eventsPath,
    FIXTURE_RUN_LOG: log,
    FIXTURE_SCENARIO: scenario,
    FIXTURE_PID: pidPath,
    FIXTURE_STDIN: stdinPath,
  };
  const events = (): ContainerCleanupEvent[] =>
    readFileSync(eventsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  return { root, temp, log, env, events, pidPath, readyPath };
}

function expectContainerCleanup(
  fixture: ReturnType<typeof containerCleanupFixture>,
  prefix: string,
) {
  const events = fixture.events();
  const namedRemovals = events.filter(
    (event) =>
      event.command === "docker" && event.args[0] === "rm" && event.args[2]?.startsWith(prefix),
  );
  expect(namedRemovals).toHaveLength(1);
  const namedRemoval = namedRemovals[0];
  const logRemoval = events.find(
    (event) => event.command === "rm" && event.args.includes(fixture.log),
  );
  if (!namedRemoval || !logRemoval) {
    throw new Error("missing owned container or log cleanup");
  }
  expect(namedRemoval.args).toEqual([
    "rm",
    "-f",
    expect.stringMatching(new RegExp(`^${prefix}\\d+$`)),
  ]);
  expect(logRemoval.args).toEqual(["-f", fixture.log]);
  expect(events.indexOf(namedRemoval)).toBeLessThan(events.indexOf(logRemoval));
  expect(existsSync(fixture.log)).toBe(false);
  expect(readFileSync(join(fixture.root, "retained-evidence"), "utf8")).toBe("keep evidence");
  expect(readFileSync(join(fixture.temp, "unrelated-sentinel"), "utf8")).toBe("keep sentinel");
  expect(
    readdirSync(fixture.temp).filter((name) => name.startsWith("openclaw-docker-e2e-container.")),
  ).toEqual([]);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function runSurvivorDiagnostics(
  mode: "capture" | "publish",
  artifacts: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
) {
  return spawnSync(
    testNodeExecPath,
    [
      ...(mode === "publish" ? ["--import", "./scripts/tsx.mjs"] : []),
      mode === "publish"
        ? UPGRADE_SURVIVOR_DIAGNOSTICS_PUBLISH_PATH
        : UPGRADE_SURVIVOR_DIAGNOSTICS_PATH,
      mode,
      artifacts,
      ...args,
    ],
    { encoding: "utf8", env: { ...process.env, ...env } },
  );
}

function publishSurvivorDiagnostics(workDir: string, artifacts: string, env?: NodeJS.ProcessEnv) {
  const uploaded = join(workDir, "public");
  const published = runSurvivorDiagnostics("publish", artifacts, [uploaded], env);
  expect(published.status, published.stderr).toBe(0);
  const text = readFileSync(join(uploaded, "failure.json"), "utf8");
  return { uploaded, text, report: JSON.parse(text) };
}

function captureSurvivorDiagnostics(artifacts: string, env: NodeJS.ProcessEnv) {
  const captured = runSurvivorDiagnostics("capture", artifacts, ["update-candidate", "1"], env);
  expect(captured.status, captured.stderr).toBe(0);
}

function survivorPostCoreFixture() {
  const workDir = realpathSync(tempDirs.make("openclaw-survivor-post-core-"));
  const artifacts = join(workDir, "artifacts");
  const resultDir = join(workDir, "openclaw-update-post-core-fixture");
  mkdirSync(artifacts);
  mkdirSync(resultDir);
  const resultPath = join(resultDir, "plugins.json");
  return {
    workDir,
    artifacts,
    resultDir,
    resultPath,
    preloadOptions: `--no-warnings --import=${pathToFileURL(join(process.cwd(), UPGRADE_SURVIVOR_DIAGNOSTICS_PATH)).href}`,
    env: {
      ...process.env,
      HOME: workDir,
      TMPDIR: workDir,
      OPENCLAW_STATE_DIR: workDir,
      OPENCLAW_CONFIG_PATH: join(workDir, "absent"),
      OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: artifacts,
      OPENCLAW_UPDATE_POST_CORE: "1",
      OPENCLAW_UPDATE_POST_CORE_RESULT_PATH: resultPath,
      NODE_OPTIONS: "--no-warnings",
    },
  };
}

function postCoreResult(status: string) {
  return {
    status,
    changed: false,
    sync: { changed: false, switchedToBundled: [], switchedToNpm: [], warnings: [], errors: [] },
    npm: { changed: false, outcomes: [] },
    integrityDrifts: [],
  };
}

function renderRepoShell(
  parts: TemplateStringsArray,
  values: readonly unknown[],
  workDir?: string,
): string {
  const body = parts.reduce(
    (result, part, index) => result + part + (index < values.length ? String(values[index]) : ""),
    "",
  );
  const scriptBody = body.startsWith("\n") ? body.slice(1) : body;
  const tempSetup = workDir ? `TMPDIR=${shellQuote(workDir)}\nexport ROOT_DIR TMPDIR\n` : "";
  return `
set -euo pipefail
ROOT_DIR=${shellQuote(process.cwd())}
${tempSetup}${scriptBody}`;
}

function repoRootShell(parts: TemplateStringsArray, ...values: unknown[]): string {
  return renderRepoShell(parts, values);
}

function repoShell(workDir: string) {
  return (parts: TemplateStringsArray, ...values: unknown[]): string =>
    renderRepoShell(parts, values, workDir);
}

function prepareDockerSnippet(
  script: string,
  options: SpawnSyncOptionsWithStringEncoding,
  args: string[],
) {
  return [
    "/bin/bash",
    ["--noprofile", "--norc", "-c", script, ...args],
    {
      ...options,
      // Snippets own their shell setup; inherited hooks must not run before or after them.
      env: { ...(options.env ?? process.env), BASH_ENV: "", ENV: "" },
    },
  ] as const;
}

function execDockerSnippet(
  script: string,
  options: SpawnSyncOptionsWithStringEncoding = { encoding: "utf8" },
  args: string[] = [],
) {
  return execFileSync(...prepareDockerSnippet(script, options, args));
}

function spawnDockerSnippet(
  script: string,
  options: SpawnSyncOptionsWithStringEncoding = { encoding: "utf8" },
  args: string[] = [],
) {
  return spawnSync(...prepareDockerSnippet(script, options, args));
}

async function runDockerSnippet(script: string, signal: AbortSignal): Promise<void> {
  const child = spawn("/bin/bash", ["--noprofile", "--norc", "-c", script], {
    detached: true,
    env: { ...process.env, BASH_ENV: "", ENV: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
  let closed = false;
  const completion = ownChildCompletion(
    new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        closed = true;
        resolve(code);
      });
    }),
  );
  try {
    expect(await withinTest(completion, signal), output).toBe(0);
  } finally {
    if (!closed && child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
      await completion;
    }
  }
}

function writeExecutables(directory: string, files: Record<string, string>): void {
  mkdirSync(directory, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(directory, name), contents, { mode: 0o755 });
  }
}

function doctorSwitchFixture(prefix: string, name?: string, selector = name) {
  const home = tempDirs.make(prefix);
  // Native manager children do not inherit OpenClaw selectors.
  const serviceName = name ?? `${basename(home)}.service`;
  const binDir = join(home, "bin");
  const unitPath = join(home, ".config/systemd/user", serviceName);
  writeExecutables(binDir, {
    busctl: readFileSync(DOCTOR_SWITCH_BUSCTL_SHIM_PATH, "utf8").replace(
      "process.env.OPENCLAW_SYSTEMD_UNIT",
      JSON.stringify(serviceName),
    ),
    "systemd-exec-start.mjs": readFileSync(DOCTOR_SWITCH_SYSTEMD_EXEC_START_PATH, "utf8"),
  });
  const env = {
    HOME: home,
    PATH: `${binDir}:${process.env.PATH}`,
    OPENCLAW_SYSTEMD_UNIT: selector ?? serviceName,
    XDG_RUNTIME_DIR: join(home, "runtime"),
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(home, "runtime", "bus")}`,
  };
  return {
    unitPath,
    invoke: (args: string[]) => spawnSync(join(binDir, "busctl"), args, { env, encoding: "utf8" }),
    // Native busctl has a 5s production budget; cold Node shims need more under load.
    inspect: (requireLoaded = false) =>
      readSystemdServiceExecStart(env, {
        requireEffective: true,
        requireLoaded,
        timeoutMs: 30_000,
      }),
    runtime: async () => {
      const { readLoadedSystemdServiceRuntime } =
        await import("../../src/daemon/systemd-loaded-runtime.js");
      return readLoadedSystemdServiceRuntime(env, 30_000);
    },
  };
}

function extractUpgradeSurvivorSupervisor(script: string): string {
  const match = script.match(
    /cat >"\$supervisor_script" <<'SUPERVISOR'\n(?<source>[\s\S]*?)\nSUPERVISOR/u,
  );
  const source = match?.groups?.source;
  if (!source) {
    throw new Error("upgrade survivor supervisor source not found");
  }
  return source;
}

// These process tests isolate supervision from unit parsing (covered by the
// systemd fixture suite), while exercising its real stop-policy subprocess call.
function startUpgradeSurvivorSupervisor(
  workDir: string,
  command: string,
  env: NodeJS.ProcessEnv,
  { stopTimeoutMs = 330_000, fastRestart = false, restartWindowMs = 60_000 } = {},
) {
  const supervisorPath = join(workDir, "supervisor.mjs");
  const policyPath = join(workDir, "stop-policy.mjs");
  writeFileSync(
    policyPath,
    `
if (process.argv.length !== 3 || process.argv[2] !== "stop-context") throw new Error("Unexpected supervisor policy request");
process.stdout.write(${JSON.stringify(JSON.stringify({ stopTimeoutMs, killMode: "control-group", controlGroup: "" }))});
`,
  );
  let source = extractUpgradeSurvivorSupervisor(
    readFileSync(UPGRADE_SURVIVOR_UPDATE_RESTART_AUTH_PATH, "utf8"),
  );
  if (fastRestart) {
    source = source
      .replace("const restartDelayMs = 5_000;", "const restartDelayMs = 5;")
      .replace("const restartWindowMs = 60_000;", `const restartWindowMs = ${restartWindowMs};`);
  }
  writeFileSync(supervisorPath, source);
  return spawn(process.execPath, [supervisorPath], {
    env: {
      ...process.env,
      OPENCLAW_SYSTEMCTL_SHIM_MANAGER_ENV: "{}",
      OPENCLAW_SYSTEMCTL_SHIM_MANAGER_SCRIPT: policyPath,
      OPENCLAW_SYSTEMCTL_SHIM_EXEC_START: command,
      ...env,
    },
    stdio: "ignore",
  });
}

async function expectSupervisorExit(supervisor: ChildProcess, signal: AbortSignal) {
  const exited = waitForProcessExit(supervisor);
  try {
    expect(await withinTest(exited, signal)).toBe(0);
  } finally {
    if (supervisor.exitCode === null && supervisor.signalCode === null) {
      supervisor.kill("SIGTERM");
    }
    await exited;
  }
}

function installUpgradeSurvivorSystemctlShim(
  prefix: string,
  env: NodeJS.ProcessEnv,
  scriptPath = UPGRADE_SURVIVOR_UPDATE_RESTART_AUTH_PATH,
): string {
  const installed = spawnDockerSnippet(
    'set -euo pipefail; source "$1"; install_update_restart_systemctl_shim',
    { env: { PATH: process.env.PATH, ...env, npm_config_prefix: prefix }, encoding: "utf8" },
    ["fixture", scriptPath],
  );
  expect(installed.status, installed.stderr).toBe(0);
  return join(prefix, "bin", "systemctl");
}

function waitForProcessExit(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(child.exitCode);
  }
  return ownChildCompletion(
    new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    }),
  );
}

// The watchdog's escalation callback exits before reaping its foreign child.
// Keep this exact-PID observation tied to the test lifetime, without another deadline.
async function waitForForeignProcessExit(pid: number, signal: AbortSignal): Promise<void> {
  try {
    while (isPidAlive(pid)) {
      await delay(10, undefined, { signal });
    }
  } catch (cause) {
    throw new Error(`process stayed alive: ${pid}`, { cause });
  }
}

async function stopUpgradeSurvivorSupervisor(supervisor: ChildProcess, pidPath: string) {
  try {
    if (supervisor.exitCode === null && supervisor.signalCode === null) {
      supervisor.kill("SIGTERM");
      await waitForProcessExit(supervisor).catch(() => undefined);
    }
  } finally {
    // Read the owned fixture's publication during cleanup even if readiness failed
    // before the test learned the descendant PID.
    if (existsSync(pidPath)) {
      const pid = Number(readFileSync(pidPath, "utf8").trim());
      if (Number.isSafeInteger(pid) && pid > 1 && isPidAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }
  }
}

function writeTermIgnoringDescendant(workDir: string): string {
  const descendantPath = join(workDir, "descendant.mjs");
  writeFileSync(
    descendantPath,
    `import fs from "node:fs";
process.on("SIGTERM", () => {});
// Readers use file existence as readiness; publish the complete PID atomically.
const pendingPid = process.env.DESCENDANT_PID_FILE + ".pending";
fs.writeFileSync(pendingPid, String(process.pid));
fs.renameSync(pendingPid, process.env.DESCENDANT_PID_FILE);
process.send?.({ kind: "ready", pid: process.pid });
setInterval(() => {}, 1_000);
`,
  );
  return descendantPath;
}

function survivorProcessGroupFixture(source: string, fastRestart = false) {
  const root = tempDirs.make("openclaw-supervisor-group-");
  const pidPath = join(root, "descendant.pid");
  const gatewayPath = join(root, "gateway.mjs");
  const statePath = join(root, "state");
  const startsPath = join(root, "starts");
  const replacementPath = join(root, "replacement");
  writeFileSync(
    gatewayPath,
    `import fs from "node:fs";
import { spawn } from "node:child_process";
${source}`,
  );
  const supervisor = startUpgradeSurvivorSupervisor(
    root,
    `${shellQuote(process.execPath)} ${shellQuote(gatewayPath)}`,
    {
      DESCENDANT_PID_FILE: pidPath,
      DESCENDANT_SCRIPT: writeTermIgnoringDescendant(root),
      OPENCLAW_SYSTEMCTL_SHIM_DAEMON_LOG: join(root, "daemon.log"),
      STATE_FILE: statePath,
      STARTS_FILE: startsPath,
      REPLACEMENT_FILE: replacementPath,
    },
    { stopTimeoutMs: 200, fastRestart },
  );
  return {
    supervisor,
    statePath,
    exited: waitForProcessExit(supervisor),
    pid: () => Number.parseInt(readFileSync(pidPath, "utf8"), 10),
    starts: () => readFileSync(startsPath, "utf8"),
    replacement: () => readFileSync(replacementPath, "utf8"),
    stop: () => stopUpgradeSurvivorSupervisor(supervisor, pidPath),
  };
}

async function expectSystemctlSettlement(signal: AbortSignal, zombie: boolean): Promise<void> {
  const workDir = tempDirs.make("openclaw-systemctl-shim-");
  const binDir = join(workDir, "bin");
  const pidPath = join(workDir, "gateway.pid");
  const childPidPath = join(workDir, "child.pid");
  const child = spawn(process.execPath, [writeTermIgnoringDescendant(workDir)], {
    env: { ...process.env, DESCENDANT_PID_FILE: childPidPath },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const exited = waitForProcessExit(child);
  const ready = new Promise<void>((resolve) => {
    child.once("message", () => resolve());
  });
  try {
    await withinTest(
      awaitGateBeforeSettlement(ready, exited, `file was not written: ${childPidPath}`),
      signal,
    );
    const pid = Number.parseInt(readFileSync(childPidPath, "utf8"), 10);
    writeFileSync(pidPath, `${pid}\n`);
    const daemonLog = join(workDir, "gateway.log");
    const fixtureEnv = {
      HOME: workDir,
      OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_LOG: join(workDir, "systemctl.log"),
      OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE: pidPath,
      OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_DAEMON_LOG: daemonLog,
    };
    const unitDir = join(workDir, ".config/systemd/user");
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(
      join(unitDir, "openclaw-gateway.service"),
      buildSystemdUnit({
        programArguments: [process.execPath, "gateway"],
      }),
    );
    const shimPath = installUpgradeSurvivorSystemctlShim(workDir, fixtureEnv);
    writeExecutables(binDir, {
      cat: `#!/usr/bin/env bash
case "\${1:-}" in
  /proc/*/stat)
    printf 'proc-stat-read\\n' >>"$OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_LOG"
    [ "$FAKE_PROC_STAT_MODE" != "unreadable" ] || exit 1
    printf '%s\\n' "$FAKE_PROC_STAT"
    ;;
  *) exec /bin/cat "$@" ;;
esac
`,
      sleep: `#!/usr/bin/env bash
printf 'wait\\n' >>"$OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_LOG"
exit 97
`,
    });
    const run = (procStat?: string, settled = false) => {
      // The synthetic /proc observation and manager custody describe the same
      // state: a zombie has retired; unreadable/malformed state stays owned.
      writeFileSync(
        `${daemonLog}.runtime.json`,
        JSON.stringify({
          pid: 0,
          supervisorPid: settled ? 0 : pid,
          groupPid: 0,
        }),
      );
      writeFileSync(fixtureEnv.OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_LOG, "");
      return spawnSync("bash", [shimPath, "--user", "stop", "openclaw-gateway.service"], {
        encoding: "utf8",
        env: {
          ...process.env,
          FAKE_PROC_STAT: procStat ?? "",
          FAKE_PROC_STAT_MODE: procStat === undefined ? "unreadable" : "readable",
          ...fixtureEnv,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
      }).status;
    };
    const procTail = Array.from({ length: 49 }, (_, field) => field + 1).join(" ");
    const stats = zombie
      ? [`${pid} (gateway (old) worker) Z ${procTail}`]
      : [undefined, `${pid} (gateway) Z`];
    for (const procStat of stats) {
      // Missing stat data must wait rather than being mistaken for exit.
      expect(run(procStat, zombie), procStat ?? "unreadable").toBe(zombie ? 0 : 97);
      expect(
        readFileSync(fixtureEnv.OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_LOG, "utf8")
          .trim()
          .split("\n"),
      ).toEqual([
        "--user stop openclaw-gateway.service",
        "proc-stat-read",
        zombie ? "proc-stat-read" : "wait",
      ]);
      expect(isPidAlive(pid)).toBe(true);
      if (!zombie) {
        expect(readFileSync(pidPath, "utf8")).toBe(`${pid}\n`);
      }
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await waitForProcessExit(child).catch(() => undefined);
  }
}

function cleanupSmokeLogTailHelpers(): string {
  const script = readFileSync(CLEANUP_SMOKE_RUN_PATH, "utf8");
  const match = script.match(
    /(read_positive_int_env\(\) \{[\s\S]*?\n\}\n\nprint_log_tail\(\) \{[\s\S]*?\n\})\n\nread_positive_int_env/u,
  );
  if (!match) {
    throw new Error("cleanup smoke log helpers were not found");
  }
  const helpers = match[1];
  if (helpers === undefined) {
    throw new Error("cleanup smoke log helper capture was not found");
  }
  return helpers;
}

function runCleanupDefaultPlatform(env: Record<string, string>, hostArch: string): string {
  const script = readFileSync(CLEANUP_DOCKER_SMOKE_PATH, "utf8");
  const match = script.match(/^PLATFORM=.*$/mu);
  if (!match) {
    throw new Error("cleanup smoke platform assignment was not found");
  }
  return execDockerSnippet(
    `source ${shellQuote(HELPER_PATH)}\nuname() { if [[ "\${1:-}" == "-m" ]]; then printf "%s" "$FAKE_UNAME_ARCH"; else command uname "$@"; fi; }\n${match[0]}\nprintf '%s' "$PLATFORM"`,
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
}

function expectInvalidDockerEnv(
  scriptPath: string,
  envName: string,
  value: string,
  env: Record<string, string> = {},
): string {
  const result = spawnSync("bash", [scriptPath], {
    encoding: "utf8",
    env: { ...process.env, ...env, [envName]: value },
  });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain(`invalid ${envName}: ${value}`);
  return result.stderr;
}

describe("docker build helper", () => {
  it.each(["0", "1"])("isolates helper snippets from shell hooks at SHLVL=%s", (shellLevel) => {
    const home = tempDirs.make("openclaw-docker-shell-hooks-");
    const marker = join(home, "hook-ran");
    const hook = `printf 'unrequested hook\\n' >>${shellQuote(marker)}\nfalse\n`;
    const hookNames = [
      ".bash_profile",
      ".bash_login",
      ".profile",
      ".bashrc",
      ".bash_logout",
      "bash-env",
      "env",
    ];
    for (const name of hookNames) {
      writeFileSync(join(home, name), hook);
    }
    const options = {
      encoding: "utf8" as const,
      env: {
        ...process.env,
        HOME: home,
        SHLVL: shellLevel,
        BASH_ENV: join(home, "bash-env"),
        ENV: join(home, "env"),
      },
    };
    const script = repoShell(home)`
source "$ROOT_DIR/scripts/lib/docker-e2e-logs.sh"
printf '%s\\n' "$HOME"
trap : INT
trap '' TERM
trap - HUP
original_traps="$(trap -p INT TERM HUP)"
run_logged_print_heartbeat isolated-shell 30 printf 'fixture output\\n'
test "$(trap -p INT TERM HUP)" = "$original_traps"
exit 0
`;
    const expected = `${home}\nfixture output\n`;

    expect(execDockerSnippet(script, options)).toBe(expected);
    const result = spawnDockerSnippet(script, options);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(expected);
    expect(result.stderr).toBe("");
    expect(existsSync(marker)).toBe(false);
    for (const name of hookNames) {
      expect(readFileSync(join(home, name), "utf8")).toBe(hook);
    }
  });

  it.each([
    {
      failure: "registry auth 5xx",
      log: [
        "#3 ERROR: failed to authorize: failed to fetch oauth token: unexpected status from POST request to https://auth.docker.io/token: 504 Gateway Timeout: error code: 504",
        "ERROR: failed to solve: failed to resolve source metadata for docker.io/docker/dockerfile:1.7",
      ].join("\n"),
      transient: true,
      exhausted: false,
    },
    {
      failure: "compiler OOM",
      log: "c++: fatal error: Killed signal terminated program cc1plus\n",
      transient: false,
      exhausted: true,
    },
    {
      failure: "Corepack timeout with Dockerfile OOM comments",
      log: [
        '# Docker builds on small VMs may otherwise fail with "Killed" (exit 137).',
        "ConnectTimeoutError: Connect Timeout Error (attempted addresses: 192.0.2.1:443)",
      ].join("\n"),
      transient: true,
      exhausted: false,
    },
  ])("classifies $failure build failures", ({ log, transient, exhausted }) => {
    const logPath = join(tempDirs.make("openclaw-docker-build-failure-"), "docker-build.log");
    writeFileSync(logPath, log);
    const script = repoRootShell`
LOG_PATH=${shellQuote(logPath)}
source "$ROOT_DIR/scripts/lib/docker-build.sh"
${transient ? "" : "! "}docker_build_transient_failure "$LOG_PATH" || exit 3
${exhausted ? "" : "! "}docker_build_resource_exhausted_failure "$LOG_PATH" || exit 3
`;

    execDockerSnippet(script);
  });

  it("runs the sandbox browser sidecar proof from the package-installed image", () => {
    const scenario = readFileSync(SANDBOX_BROWSER_SIDECAR_SCENARIO_PATH, "utf8");
    expect(scenario).not.toMatch(/(?:from\s+|import\s*\(\s*)["'][.]{1,2}\/.*src\//u);
  });

  it("cleans all sidecar modes without touching another run on the same Gateway workspace", () => {
    const workDir = realpathSync(tempDirs.make("openclaw-sidecar-cleanup-"));
    const binDir = join(workDir, "bin");
    const scenarioRoot = join(workDir, "scenario");
    const buildRoot = join(workDir, "build");
    const containersPath = join(workDir, "containers.json");
    const sessionKey = "agent:main:sandbox-browser-sidecar";
    const workspaceHash = createHash("sha256")
      .update("/home/appuser/.openclaw-e2e/workspace")
      .digest("hex")
      .slice(0, 32);
    const unrelated = [
      { name: "other-run", scopeKey: `${sessionKey}:other-run:rw:workspace:${workspaceHash}` },
      { name: "other-workspace", scopeKey: `${sessionKey}:other-run:rw:workspace:other` },
    ];
    const seedContainers = `
const sessionKey = ${JSON.stringify(sessionKey)} + ":" + process.argv[1];
const containers = ["none", "ro", "rw"].flatMap((access) =>
  ["sandbox", "browser"].map((kind) => ({
    name: "short-" + access + "-" + kind,
    scopeKey: sessionKey + ":" + access + ":workspace:" + ${JSON.stringify(workspaceHash)},
  })),
);
require("node:fs").writeFileSync(${JSON.stringify(containersPath)}, JSON.stringify([
  ...containers,
  ...${JSON.stringify(unrelated)},
]));
`;
    writeExecutables(binDir, {
      date: "#!/bin/sh\nprintf '1700000000\\n'\n",
      mktemp: `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const template = args.at(-1);
const target = template.includes("sandbox-browser-sidecar-build.")
  ? ${JSON.stringify(buildRoot)}
  : template.includes("sandbox-browser-sidecar.") ? ${JSON.stringify(scenarioRoot)} : undefined;
if (target) {
  fs.mkdirSync(target, { recursive: true });
  console.log(target);
} else {
  process.stdout.write(require("node:child_process").execFileSync("/usr/bin/mktemp", args));
}
`,
      docker: `#!/usr/bin/env node
const fs = require("node:fs");
const file = ${JSON.stringify(containersPath)};
const containers = JSON.parse(fs.readFileSync(file, "utf8"));
const args = process.argv.slice(2);
if (args[0] === "ps") {
  const filterIndex = args.indexOf("--filter");
  const filter = filterIndex < 0 ? undefined : args[filterIndex + 1];
  for (const container of containers) {
    if (!filter || filter === "label=openclaw.sessionKey=" + container.scopeKey) console.log(container.name);
  }
} else if (args[0] === "rm") {
  fs.writeFileSync(file, JSON.stringify(containers.filter((container) => !args.slice(1).includes(container.name))));
}
`,
    });

    // exec preserves the shell PID used by RUN_ID; the fixed date supplies its
    // other component without deriving expected labels from the cleanup filter.
    const result = spawnDockerSnippet(
      'node -e "$1" "$$-1700000000"\nexec /bin/bash "$2"',
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          OPENCLAW_DOCKER_SOCKET: join(workDir, "missing.sock"),
        },
      },
      ["sidecar-cleanup", seedContainers, SANDBOX_BROWSER_SIDECAR_DOCKER_E2E_PATH],
    );

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("Docker socket not found:");
    expect(JSON.parse(readFileSync(containersPath, "utf8"))).toEqual(unrelated);
    expect(existsSync(scenarioRoot)).toBe(false);
    expect(existsSync(buildRoot)).toBe(false);
  });

  it.each([
    ["64kb", "cleanup output\n", 2],
    ["0008", "old-cleanup-output-recent\n", 0],
  ] as const)("validates cleanup-smoke log byte limit %s", (limit, log, status) => {
    const workDir = tempDirs.make("openclaw-cleanup-smoke-log-tail-");
    const logPath = join(workDir, "cleanup.log");
    writeFileSync(logPath, log);
    const script = `
set -euo pipefail
LOG_PATH=${shellQuote(logPath)}
export OPENCLAW_CLEANUP_SMOKE_LOG_PRINT_BYTES=${limit}

${cleanupSmokeLogTailHelpers()}

print_log_tail "$LOG_PATH"
`;

    const result = spawnDockerSnippet(script);

    expect(result.status).toBe(status);
    if (status === 2) {
      expect(result.stderr).toContain("invalid OPENCLAW_CLEANUP_SMOKE_LOG_PRINT_BYTES: 64kb");
      expect(result.stdout).toBe("");
    } else {
      expect(result.stdout).toContain("truncated: showing last 8");
      expect(result.stdout).toContain("-recent\n");
      expect(result.stdout).not.toContain("old-cleanup-output");
      expect(result.stderr).toBe("");
    }
  });

  it("runs cleanup smoke on the native ARM platform instead of pulling an amd64 tag", () => {
    expect(runCleanupDefaultPlatform({ CI: "true" }, "aarch64")).toBe("linux/arm64");
    expect(runCleanupDefaultPlatform({ GITHUB_ACTIONS: "true" }, "x86_64")).toBe("linux/amd64");
    expect(runCleanupDefaultPlatform({}, "arm64")).toBe("linux/arm64");
    expect(
      runCleanupDefaultPlatform({ OPENCLAW_CLEANUP_SMOKE_PLATFORM: "linux/s390x" }, "x86_64"),
    ).toBe("linux/s390x");
  });

  it("pins the default external OpenWebUI image by digest", () => {
    expect(readFileSync(OPENWEBUI_DOCKER_E2E_PATH, "utf8")).toMatch(
      /OPENWEBUI_IMAGE="\$\{OPENWEBUI_IMAGE:-[^}]+@sha256:[a-f0-9]{64}\}"/u,
    );
  });

  it("resolves source and compiled candidate test-state entrypoints", () => {
    const resolveEntrypoint = (rootDir: string) =>
      spawnDockerSnippet(
        `source "${DOCKER_E2E_IMAGE_HELPER_PATH}"; docker_e2e_test_state_entrypoint`,
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: { ...process.env, ROOT_DIR: rootDir },
        },
      );

    const sourceResult = resolveEntrypoint(process.cwd());
    expect(sourceResult.status, sourceResult.stderr).toBe(0);
    expect(sourceResult.stdout.trim()).toBe(
      join(process.cwd(), "scripts/lib/openclaw-test-state.mts"),
    );

    const compiledRoot = tempDirs.make("openclaw-compiled-test-state-");
    const missingResult = resolveEntrypoint(compiledRoot);
    expect(missingResult.status).toBe(1);
    expect(missingResult.stderr).toContain("OpenClaw test-state entrypoint not found");

    const compiledDir = join(compiledRoot, "scripts/lib");
    mkdirSync(compiledDir, { recursive: true });
    const compiledEntrypoint = join(compiledDir, "openclaw-test-state.mjs");
    writeFileSync(compiledEntrypoint, "", "utf8");
    const compiledResult = resolveEntrypoint(compiledRoot);
    expect(compiledResult.status, compiledResult.stderr).toBe(0);
    expect(compiledResult.stdout.trim()).toBe(compiledEntrypoint);
  });

  it("runs current TypeScript and frozen JavaScript Docker harness entrypoints", () => {
    const fixtureRoot = tempDirs.make("openclaw-docker-script-entrypoint-");
    const scriptStem = join(fixtureRoot, "fixture");
    const runFixture = (value: string) =>
      spawnDockerSnippet(
        `source "${OPENCLAW_E2E_INSTANCE_HELPER_PATH}"; openclaw_e2e_run_script_entrypoint "$1" "$2"`,
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${join(process.cwd(), "node_modules/.bin")}:${process.env.PATH ?? ""}`,
          },
        },
        ["openclaw-docker-script-entrypoint", scriptStem, value],
      );

    writeFileSync(
      `${scriptStem}.mts`,
      'enum Choice { Current = "current" }\nconst value: Choice = process.argv[2] as Choice; process.stdout.write(`mts:${value}`);\n',
      "utf8",
    );
    const sourceResult = runFixture("current");
    expect(sourceResult.status, sourceResult.stderr).toBe(0);
    expect(sourceResult.stdout).toBe("mts:current");

    rmSync(`${scriptStem}.mts`);
    writeFileSync(
      `${scriptStem}.mjs`,
      'process.stdout.write(`mjs:${process.argv[2] ?? ""}`);\n',
      "utf8",
    );
    const compiledResult = runFixture("frozen");
    expect(compiledResult.status, compiledResult.stderr).toBe(0);
    expect(compiledResult.stdout).toBe("mjs:frozen");

    rmSync(`${scriptStem}.mjs`);
    const missingResult = runFixture("missing");
    expect(missingResult.status).toBe(1);
    expect(missingResult.stderr).toContain("script entrypoint not found");
  });

  it("rejects malformed Docker E2E resource limits before a suite starts", () => {
    const runProbe = (value: string) => {
      const script = [
        "source scripts/lib/docker-e2e-image.sh",
        "docker_e2e_read_nonnegative_decimal_env OPENCLAW_SAMPLE_RESOURCE_LIMIT 2048",
      ].join("\n");
      return spawnDockerSnippet(script, {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_SAMPLE_RESOURCE_LIMIT: value,
        },
      });
    };

    const invalid = runProbe("12mb");
    const overlarge = runProbe("9999999999");
    const overprecise = runProbe("12.1234567");
    const decimal = runProbe("12.5");
    expect(invalid.status).toBe(2);
    expect(invalid.stderr).toContain("invalid OPENCLAW_SAMPLE_RESOURCE_LIMIT: 12mb");
    expect(overlarge.status).toBe(2);
    expect(overlarge.stderr).toContain("invalid OPENCLAW_SAMPLE_RESOURCE_LIMIT: 9999999999");
    expect(overprecise.status).toBe(2);
    expect(overprecise.stderr).toContain("invalid OPENCLAW_SAMPLE_RESOURCE_LIMIT: 12.1234567");
    expect(decimal.status).toBe(0);
    expect(decimal.stdout.trimEnd()).toBe("12.5");
  });

  it("wraps centralized Docker builds with the timeout helper", () => {
    const workDir = tempDirs.make("openclaw-docker-build-timeout-");
    writeExecutables(join(workDir, "bin"), {
      timeout: `#!/bin/bash
set -euo pipefail
if [[ "$1" = "--kill-after=1s" ]]; then
  exit 0
fi
printf '%s %s|%s\\n' "$1" "$2" "\${*:3}" >>"$TMPDIR/timeout-seen"
shift 2
"$@"
`,
      docker: `#!/bin/sh
printf "%s\\n" "$*" >>"$TMPDIR/docker-seen"
`,
    });

    const script = repoShell(workDir)`
export PATH="$TMPDIR/bin:$PATH"
export OPENCLAW_DOCKER_BUILD_TIMEOUT=17s

source "$ROOT_DIR/scripts/lib/docker-build.sh"

trap : INT
trap '' TERM
trap - HUP
original_traps="$(trap -p INT TERM HUP)"
docker_build_run e2e-build -t demo-image .
test "$(trap -p INT TERM HUP)" = "$original_traps"

grep -q '^--kill-after=30s 17s|env DOCKER_BUILDKIT=1 docker build --progress=plain --build-arg GITHUB_ACTIONS -t demo-image .$' "$TMPDIR/timeout-seen"
grep -q '^build --progress=plain --build-arg GITHUB_ACTIONS -t demo-image .$' "$TMPDIR/docker-seen"
`;

    execDockerSnippet(script);
  });

  it("stops the tracked build command without retrying when interrupted", async ({ signal }) => {
    const workDir = tempDirs.make("openclaw-docker-build-signal-");
    writeExecutables(join(workDir, "bin"), {
      docker: `#!/bin/bash
set -euo pipefail
count=0
if [ -f "$TMPDIR/docker-count" ]; then
  count="$(<"$TMPDIR/docker-count")"
fi
count="$((count + 1))"
printf '%s\\n' "$count" >"$TMPDIR/docker-count"
printf '%s\\n' "$$" >"$TMPDIR/docker.pid"
printf 'rpc error: code = Unavailable\\n'
trap 'printf "term\\n" >"$TMPDIR/docker.term"; exit 0' TERM
mkfifo "$TMPDIR/docker.block"
printf 'ready\\n' >"$TMPDIR/docker.ready"
while true; do
  read -r -t 1 _ <> "$TMPDIR/docker.block" || true
done
`,
    });

    writeExecutables(workDir, {
      "runner.sh": `#!/bin/bash
set -euo pipefail
ROOT_DIR=${shellQuote(process.cwd())}
TMPDIR=${shellQuote(workDir)}
export ROOT_DIR TMPDIR
export PATH="$TMPDIR/bin:$PATH"
export OPENCLAW_DOCKER_BUILD_RETRIES=3
source "$ROOT_DIR/scripts/lib/docker-build.sh"
docker_build_run e2e-build -t demo-image .
`,
    });

    const runInterruptedBuild = async (childSignal: NodeJS.Signals, expectedCode: number) => {
      for (const name of [
        "docker.pid",
        "docker.term",
        "docker.ready",
        "docker.block",
        "docker-count",
      ]) {
        rmSync(join(workDir, name), { force: true });
      }
      const runner = spawn(join(workDir, "runner.sh"), {
        env: { ...process.env, TMPDIR: workDir },
        stdio: "ignore",
      });
      const exited = waitForProcessExit(runner);
      const closed = ownChildCompletion(
        new Promise<number | null>((resolve, reject) => {
          runner.once("error", reject);
          runner.once("close", resolve);
        }),
      );
      try {
        const pidPath = join(workDir, "docker.pid");
        const readyPath = join(workDir, "docker.ready");
        await withinTest(waitForFixtureFile(readyPath, exited), signal);
        expect(existsSync(readyPath)).toBe(true);
        const buildPid = Number.parseInt(readFileSync(pidPath, "utf8"), 10);

        runner.kill(childSignal);
        expect(await withinTest(closed, signal)).toBe(expectedCode);
        expect(runner.signalCode).toBeNull();
        // The timeout wrapper can exit before the Docker fixture finishes its trap.
        await waitForForeignProcessExit(buildPid, signal);
        expect(existsSync(join(workDir, "docker.term"))).toBe(true);
        expect(readFileSync(join(workDir, "docker-count"), "utf8").trim()).toBe("1");
        expect(isPidAlive(buildPid)).toBe(false);
      } finally {
        if (runner.exitCode === null && runner.signalCode === null) {
          runner.kill("SIGTERM");
        }
        await closed;
      }
    };

    await runInterruptedBuild("SIGTERM", 143);
    await runInterruptedBuild("SIGINT", 130);
  });

  it.each([
    ["HEARTBEAT_SECONDS", "heartbeat_seconds"],
    ["RETRIES", "retry_count"],
  ])("normalizes zero-padded Docker build %s", (envSuffix, helperSuffix) => {
    const script = repoRootShell`
export ROOT_DIR
export OPENCLAW_DOCKER_BUILD_${envSuffix}=08

source "$ROOT_DIR/scripts/lib/docker-build.sh"

[[ "$(docker_build_${helperSuffix})" = "8" ]]
`;

    execDockerSnippet(script);
  });

  it.each([
    [
      "retry count",
      "OPENCLAW_DOCKER_BUILD_RETRIES",
      "2x",
      "invalid OPENCLAW_DOCKER_BUILD_RETRIES: 2x",
    ],
    [
      "heartbeat interval",
      "OPENCLAW_DOCKER_BUILD_HEARTBEAT_SECONDS",
      "soon",
      "invalid OPENCLAW_DOCKER_BUILD_HEARTBEAT_SECONDS: soon",
    ],
  ])(
    "rejects invalid centralized Docker build %s before invoking docker",
    (_label, envName, value, expectedError) => {
      const workDir = tempDirs.make("openclaw-docker-build-config-");
      const markerPath = join(workDir, "docker-invoked");

      writeExecutables(join(workDir, "bin"), {
        docker: `#!/bin/bash
printf invoked >${shellQuote(markerPath)}
exit 0
`,
      });

      const script = repoRootShell`
TMPDIR=${shellQuote(workDir)}
export ROOT_DIR TMPDIR
export PATH="$TMPDIR/bin:$PATH"

source "$ROOT_DIR/scripts/lib/docker-build.sh"

docker_build_run e2e-build -t demo-image .
`;

      const result = spawnDockerSnippet(script, {
        encoding: "utf8",
        env: {
          ...process.env,
          [envName]: value,
        },
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(expectedError);
      expect(existsSync(markerPath)).toBe(false);
    },
  );

  it.each([
    { mode: "build", timeout: "19s", envName: "OPENCLAW_DOCKER_BUILD_TIMEOUT", status: 1 },
    { mode: "command", timeout: "7s", envName: "DOCKER_COMMAND_TIMEOUT", status: 127 },
  ])(
    "fails Docker $mode fast when timeout is unavailable",
    ({ mode, timeout, envName, status }) => {
      const workDir = tempDirs.make("openclaw-docker-timeout-required-");
      mkdirSync(join(workDir, "bin"));
      const script = repoShell(workDir)`
export PATH="$TMPDIR/bin"
export ${envName}=${timeout}
${
  mode === "build"
    ? `
dirname() { /usr/bin/dirname "$@"; }
grep() { /usr/bin/grep "$@"; }
cat() { /bin/cat "$@"; }
rm() { /bin/rm "$@"; }
mktemp() { /usr/bin/mktemp "$@"; }
export -f dirname grep cat rm mktemp
`
    : ""
}

docker() {
  printf "%s\\n" "$*" >"$TMPDIR/docker-seen"
}
export -f docker

source "$ROOT_DIR/scripts/lib/${mode === "build" ? "docker-build.sh" : "docker-e2e-container.sh"}"

set +e
${mode === "build" ? "docker_build_run e2e-build -t demo-image ." : "docker_e2e_docker_cmd ps"} >"$TMPDIR/stdout" 2>"$TMPDIR/stderr"
status="$?"
set -e

diagnostic="$(<"$TMPDIR/${mode === "build" ? "stdout" : "stderr"}")"
[[ "$status" = "${status}" ]]
[[ "$diagnostic" = *"timeout command not found; cannot bound Docker command after ${timeout}"* ]]
[[ ! -e "$TMPDIR/docker-seen" ]]
`;

      execDockerSnippet(script);
    },
  );

  it.for([
    {
      title: "keeps reused Docker image probes behind the timeout-aware helper",
      tempPrefix: "openclaw-docker-image-reuse-timeout-",
      scriptSource: (workDir: string) => repoShell(workDir)`
export DOCKER_COMMAND_TIMEOUT=3s
export OPENCLAW_SKIP_DOCKER_BUILD=1

mkdir -p "$TMPDIR/bin"
cat >"$TMPDIR/bin/timeout" <<'SH'
#!/usr/bin/env bash
case "$1" in
  --kill-after=1s)
    exit 0
    ;;
  --kill-after=30s)
    printf "%s %s|%s\\n" "$1" "$2" "$3 $4 $5" >>"$TMPDIR/timeout-seen"
    shift 2
    ;;
  *)
    printf "%s|%s\\n" "$1" "$2 $3 $4" >>"$TMPDIR/timeout-seen"
    shift
    ;;
esac
"$@"
SH
chmod +x "$TMPDIR/bin/timeout"
export PATH="$TMPDIR/bin:$PATH"

docker() {
  printf "%s\\n" "$*" >>"$TMPDIR/docker-seen"
  case "$1 $2" in
    "image inspect")
      return 1
      ;;
    "pull openclaw-reuse-image")
      return 0
      ;;
    *)
      return 9
      ;;
  esac
}
export -f docker

source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"

docker_e2e_build_or_reuse \\
  openclaw-reuse-image \\
  reuse-timeout-proof \\
  "$ROOT_DIR/scripts/e2e/Dockerfile" \\
  "$ROOT_DIR" \\
  functional

test "$(grep -c '^--kill-after=30s 3s|' "$TMPDIR/timeout-seen")" = "2"
grep -q '^image inspect openclaw-reuse-image$' "$TMPDIR/docker-seen"
grep -q '^pull openclaw-reuse-image$' "$TMPDIR/docker-seen"
`,
    },
    {
      title: "explains how to opt out when Docker rejects default resource limits",
      tempPrefix: "openclaw-docker-resource-diagnostic-",
      scriptSource: (workDir: string) => repoShell(workDir)`
export OPENCLAW_DOCKER_E2E_AVAILABLE_CPUS=8
unset OPENCLAW_DOCKER_E2E_DISABLE_RESOURCE_LIMITS
unset OPENCLAW_DOCKER_E2E_MEMORY OPENCLAW_DOCKER_E2E_CPUS OPENCLAW_DOCKER_E2E_PIDS_LIMIT

docker() {
  printf "%s\\n" "$*" >>"$TMPDIR/docker-seen"
  echo "docker: Error response from daemon: NanoCPUs can not be set, as the cgroup is not mounted" >&2
  return 125
}

mktemp() {
  local dir=""
  dir="$(/usr/bin/mktemp "$@")" || return
  printf "%s\\n" "$*" >"$TMPDIR/mktemp-seen"
  printf "%s\\n" "$dir" >"$TMPDIR/diagnostic-dir"
  printf "%s\\n" "$dir"
}

tail() {
  [[ "$#" = "3" && "$1" = "-c" && "$2" = "65536" && -p "$3" ]] || return 1
  printf "%s %s\\n" "$1" "$2" >"$TMPDIR/tail-seen"
  /usr/bin/tail "$@"
}

source "$ROOT_DIR/scripts/lib/docker-e2e-container.sh"
docker_e2e_timeout_cmd() {
  shift
  "$@"
}

set +e
printf "before Docker\\n" >"$TMPDIR/stderr"
docker_e2e_docker_cmd run demo 2>>"$TMPDIR/stderr"
status="$?"
set -e

stderr="$(<"$TMPDIR/stderr")"
[[ "$status" = "125" ]] || exit 1
[[ "$stderr" = before\\ Docker* ]] || exit 1
[[ "$stderr" = *"NanoCPUs can not be set"* ]] || exit 1
[[ "$stderr" = *"Docker E2E resource limits are incompatible with this Docker runtime"* ]] || exit 1
[[ "$stderr" = *"OPENCLAW_DOCKER_E2E_DISABLE_RESOURCE_LIMITS=1"* ]] || exit 1
[[ "$(grep -c '^run ' "$TMPDIR/docker-seen")" = "1" ]] || exit 1
test "$(<"$TMPDIR/tail-seen")" = "-c 65536"
[[ "$(<"$TMPDIR/mktemp-seen")" = -d* ]] || exit 1
[[ ! -e "$(<"$TMPDIR/diagnostic-dir")" ]] || exit 1
`,
    },
    {
      title: "rejects invalid Docker run pids limits before invoking docker",
      tempPrefix: "openclaw-docker-resource-pids-",
      scriptSource: (workDir: string) => repoShell(workDir)`

docker() {
  printf invoked >"$TMPDIR/docker-seen"
}
export -f docker

source "$ROOT_DIR/scripts/lib/docker-e2e-container.sh"

set +e
OPENCLAW_DOCKER_E2E_PIDS_LIMIT=many docker_e2e_docker_cmd run demo 2>"$TMPDIR/stderr"
status="$?"
set -e

[[ "$status" = "2" ]] || exit 1
[[ "$(<"$TMPDIR/stderr")" = *"invalid OPENCLAW_DOCKER_E2E_PIDS_LIMIT: many"* ]] || exit 1
[[ ! -e "$TMPDIR/docker-seen" ]] || exit 1
`,
    },
    ...[false, true].map((provided) => ({
      title: provided
        ? "keeps caller-provided functional Docker build packages"
        : "removes generated functional Docker build inputs",
      tempPrefix: "openclaw-docker-build-cleanup-",
      scriptSource: (workDir: string) => repoShell(workDir)`
${
  provided
    ? `
external_dir="$TMPDIR/external-package"
mkdir -p "$external_dir"
printf fixture >"$external_dir/openclaw-current.tgz"
export OPENCLAW_CURRENT_PACKAGE_TGZ="$external_dir/openclaw-current.tgz"
`
    : PACKAGE_BUILDER_NODE_SCRIPT
}
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"
${PACKAGE_BUILD_CONTEXT_PROBE_SCRIPT}
docker_e2e_build_or_reuse openclaw-test-image cleanup-proof "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" functional
test -f "$TMPDIR/build-context-seen"
${provided ? 'test -f "$OPENCLAW_CURRENT_PACKAGE_TGZ"' : ""}
leftovers="$(find "$TMPDIR" -maxdepth 1 \\( -name 'openclaw-docker-e2e-pack.*' -o -name 'openclaw-docker-e2e-package-context.*' \\) -print)"
if [[ -n "$leftovers" ]]; then
  printf 'leftover functional build inputs:\\n%s\\n' "$leftovers" >&2
  exit 1
fi
`,
    })),
    {
      title: "cleans generated package mounts after harness Docker runs",
      tempPrefix: "openclaw-docker-package-mount-cleanup-",
      scriptSource: (workDir: string) => repoShell(workDir)`
export DOCKER_COMMAND_TIMEOUT=3s

mkdir -p "$TMPDIR/bin"
cat >"$TMPDIR/bin/timeout" <<'SH'
#!/usr/bin/env bash
case "$1" in
  --kill-after=1s)
    exit 0
    ;;
  --kill-after=30s)
    timeout_args="$1 $2"
    shift 2
    ;;
  *)
    timeout_args="$1"
    shift
    ;;
esac
if [[ "\${1:-}" == "docker" && "\${2:-}" == "run" ]]; then
  printf "%s\\n" "$timeout_args" >"$TMPDIR/docker-timeout-seen"
fi
"$@"
SH
chmod +x "$TMPDIR/bin/timeout"
export PATH="$TMPDIR/bin:$PATH"

${PACKAGE_BUILDER_NODE_SCRIPT}

source "$ROOT_DIR/scripts/lib/docker-e2e-package.sh"

docker() {
  local last_arg=""
  local arg
  for arg in "$@"; do
    last_arg="$arg"
  done
  if [[ "$1" == "rm" ]]; then
    shift
    test "$1" = "-f"
    shift
    printf "rm %s\\n" "$1" >>"$TMPDIR/docker-lifecycle"
    printf "%s\\n" "$1" >>"$TMPDIR/docker-rm-seen"
    return 0
  fi
  if [[ "$1" == "inspect" ]]; then
    printf "inspect %s\\n" "$last_arg" >>"$TMPDIR/docker-lifecycle"
    if [[ "\${DOCKER_STUB_INSPECT_STATUS:-0}" != "0" ]]; then
      printf "%s\\n" "\${DOCKER_STUB_INSPECT_ERROR:-inspect failed}" >&2
      return "$DOCKER_STUB_INSPECT_STATUS"
    fi
    printf "ExitCode=%s\\nOOMKilled=%s\\nError=%s\\n" \\
      "\${DOCKER_STUB_EXIT_CODE:-0}" \\
      "\${DOCKER_STUB_OOM:-false}" \\
      "\${DOCKER_STUB_ERROR:-}"
    return 0
  fi

  local cidfile=""
  local mount_path=""
  local expect_volume_path=0
  local expect_cidfile=0
  for arg in "$@"; do
    test "$arg" != "--rm"
    if [[ "$expect_cidfile" == "1" ]]; then
      cidfile="$arg"
      expect_cidfile=0
      continue
    fi
    if [[ "$expect_volume_path" == "1" ]]; then
      mount_path="\${arg%%:*}"
      expect_volume_path=0
      continue
    fi
    if [[ "$arg" == "--cidfile" ]]; then
      expect_cidfile=1
      continue
    fi
    if [[ "$arg" == "-v" ]]; then
      expect_volume_path=1
    fi
  done

  test -n "$cidfile"
  test ! -e "$cidfile"
  printf "container-%s\\n" "\${DOCKER_STUB_STATUS:-0}" >"$cidfile"
  printf "run container-%s\\n" "\${DOCKER_STUB_STATUS:-0}" >>"$TMPDIR/docker-lifecycle"
  test -n "$mount_path"
  test -f "$mount_path"
  printf "%s\\n" "$mount_path" >"$TMPDIR/package-mount-seen"
  return "\${DOCKER_STUB_STATUS:-0}"
}
export -f docker

package_tgz="$(docker_e2e_prepare_package_tgz mount-cleanup)"
pack_dir="$(dirname "$package_tgz")"
docker_e2e_package_mount_args "$package_tgz"
export DOCKER_STUB_STATUS=7
export DOCKER_STUB_EXIT_CODE=137
export DOCKER_STUB_OOM=true
DOCKER_STUB_ERROR="$(printf '%05000d' 0)"
export DOCKER_STUB_ERROR
trap : INT
trap '' TERM
trap - HUP
original_traps="$(trap -p INT TERM HUP)"
docker_e2e_run_with_harness image-name bash -lc true 2>"$TMPDIR/failure-stderr" || run_status="$?"
test "$(trap -p INT TERM HUP)" = "$original_traps"
test "\${run_status:-0}" = "7"
test "$(cat "$TMPDIR/docker-timeout-seen")" = "--kill-after=30s 3s"
grep -qx "container-7" "$TMPDIR/docker-rm-seen"
test "$(sed -n '1p' "$TMPDIR/docker-lifecycle")" = "run container-7"
test "$(sed -n '2p' "$TMPDIR/docker-lifecycle")" = "inspect container-7"
test "$(sed -n '3p' "$TMPDIR/docker-lifecycle")" = "rm container-7"
grep -q '^Docker container state:$' "$TMPDIR/failure-stderr"
grep -q '^ExitCode=137$' "$TMPDIR/failure-stderr"
grep -q '^OOMKilled=true$' "$TMPDIR/failure-stderr"
test "$(wc -c <"$TMPDIR/failure-stderr")" -lt 5000
test -f "$TMPDIR/package-mount-seen"
test ! -e "$pack_dir"
test -z "$(find "$TMPDIR" -maxdepth 1 -name 'openclaw-docker-e2e-container.*' -print)"

external_dir="$TMPDIR/external-package"
mkdir -p "$external_dir"
printf fixture >"$external_dir/openclaw-current.tgz"
docker_e2e_package_mount_args "$external_dir/openclaw-current.tgz"
export DOCKER_STUB_STATUS=23
export DOCKER_STUB_INSPECT_STATUS=9
export DOCKER_STUB_INSPECT_ERROR="daemon unavailable"
docker_e2e_run_with_harness image-name bash -lc true 2>"$TMPDIR/inspect-failure-stderr" || inspect_failure_status="$?"
test "\${inspect_failure_status:-0}" = "23"
grep -q "Docker container state unavailable (inspect exit 9): daemon unavailable" "$TMPDIR/inspect-failure-stderr"
tail -n 3 "$TMPDIR/docker-lifecycle" >"$TMPDIR/inspect-failure-lifecycle"
printf "run container-23\\ninspect container-23\\nrm container-23\\n" >"$TMPDIR/expected-inspect-failure-lifecycle"
cmp "$TMPDIR/expected-inspect-failure-lifecycle" "$TMPDIR/inspect-failure-lifecycle"

unset DOCKER_STUB_STATUS DOCKER_STUB_EXIT_CODE DOCKER_STUB_OOM DOCKER_STUB_ERROR
unset DOCKER_STUB_INSPECT_STATUS DOCKER_STUB_INSPECT_ERROR
unset DOCKER_COMMAND_TIMEOUT
rm -f "$TMPDIR/docker-timeout-seen"
docker_e2e_run_with_harness image-name bash -lc true 2>"$TMPDIR/success-stderr"
test "$(trap -p INT TERM HUP)" = "$original_traps"
test "$(cat "$TMPDIR/docker-timeout-seen")" = "--kill-after=30s 3600s"
grep -qx "container-0" "$TMPDIR/docker-rm-seen"
test "$(tail -n 2 "$TMPDIR/docker-lifecycle")" = $'run container-0\\nrm container-0'
test ! -s "$TMPDIR/success-stderr"
test -f "$external_dir/openclaw-current.tgz"
`,
    },
    {
      title: "propagates shared E2E command timeouts into package-backed containers",
      tempPrefix: "openclaw-docker-package-timeout-env-",
      scriptSource: (workDir: string) => repoShell(workDir)`
source "$ROOT_DIR/scripts/lib/docker-e2e-package.sh"

package="$TMPDIR/openclaw-current.tgz"
printf fixture >"$package"
export OPENCLAW_E2E_NPM_INSTALL_TIMEOUT=42s
export OPENCLAW_E2E_COMMAND_TIMEOUT=23s
docker_e2e_package_mount_args "$package"
printf "%s\\n" "\${DOCKER_E2E_PACKAGE_ARGS[@]}" >"$TMPDIR/package-args"

grep -qx -- "-e" "$TMPDIR/package-args"
grep -qx -- "OPENCLAW_CURRENT_PACKAGE_TGZ=/tmp/openclaw-current.tgz" "$TMPDIR/package-args"
grep -qx -- "OPENCLAW_E2E_NPM_INSTALL_TIMEOUT=42s" "$TMPDIR/package-args"
grep -qx -- "OPENCLAW_E2E_COMMAND_TIMEOUT=23s" "$TMPDIR/package-args"
`,
    },
    {
      title: "cleans the heartbeat command when the wrapper is terminated",
      tempPrefix: "openclaw-docker-e2e-log-term-cleanup-",
      scriptSource: (workDir: string) => repoShell(workDir)`
export OPENCLAW_DOCKER_E2E_HEARTBEAT_TERM_GRACE_SECONDS=1

source "$ROOT_DIR/scripts/lib/docker-e2e-logs.sh"

command_pid_file="$TMPDIR/command.pid"
mkfifo "$TMPDIR/ready.pipe"
(
  run_logged_print_heartbeat plugins-run 30 bash -c 'trap "exit 0" TERM; printf "%s" "$$" > "$1"; printf "ready\\n" >&3; while true; do /bin/sleep 0.05; done' bash "$command_pid_file"
) 3>"$TMPDIR/ready.pipe" &
wrapper_pid="$!"
if ! IFS= read -r ready <"$TMPDIR/ready.pipe"; then
  kill -TERM "$wrapper_pid" 2>/dev/null || true
  echo "heartbeat command pid was not recorded" >&2
  exit 1
fi
command_pid="$(cat "$command_pid_file")"
kill -TERM "$wrapper_pid"
wait "$wrapper_pid" 2>/dev/null || true
# cleanup_heartbeat_command joins the exact command before the wrapper returns.
if kill -0 "$command_pid" 2>/dev/null; then
  echo "heartbeat command still alive after wrapper termination: $command_pid" >&2
  exit 1
fi
`,
    },
    {
      title: "cleans harness containers when heartbeat-wrapped Docker runs are terminated",
      tempPrefix: "openclaw-docker-e2e-harness-term-cleanup-",
      scriptSource: (workDir: string) => repoShell(workDir)`

${PASSTHROUGH_TIMEOUT_SETUP}

source "$ROOT_DIR/scripts/lib/docker-e2e-package.sh"

docker() {
  if [[ "$1" == "rm" ]]; then
    shift
    test "$1" = "-f"
    shift
    printf "%s\\n" "$1" >>"$TMPDIR/docker-rm-seen"
    return 0
  fi

  ${DOCKER_CIDFILE_PROBE}
  printf "container-term\\n" >"$cidfile"
  printf "started\\n" >"$TMPDIR/docker-started"
  printf "docker running\\n"
  trap 'exit 143' TERM
  printf "ready\\n" >&3
  while true; do /bin/sleep 0.05; done
}
export -f docker

mkfifo "$TMPDIR/ready.pipe"
(
  docker_e2e_run_logged_print_with_harness plugins-run image-name bash -lc true
) 3>"$TMPDIR/ready.pipe" &
wrapper_pid="$!"
IFS= read -r ready <"$TMPDIR/ready.pipe"
test -s "$TMPDIR/docker-started"
kill -TERM "$wrapper_pid" 2>/dev/null || true
wait "$wrapper_pid" 2>/dev/null || true
# The joined harness removes its container before the heartbeat wrapper returns.
grep -qx "container-term" "$TMPDIR/docker-rm-seen"
test -z "$(find "$TMPDIR" -maxdepth 1 -name 'openclaw-docker-e2e-container.*' -print)"
`,
    },
    {
      title: "normalizes zero-padded Docker E2E stats heartbeat intervals",
      tempPrefix: "openclaw-docker-e2e-stats-zero-heartbeat-",
      scriptSource: (workDir: string) => repoShell(workDir)`

source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"

docker_e2e_docker_cmd() {
  case "$1" in
    inspect) return 0 ;;
    stats) printf '{"MemUsage":"1MiB / 2MiB","CPUPerc":"0.1%%"}\\n'; return 0 ;;
    *) return 0 ;;
  esac
}

sleep() {
  SECONDS=$((SECONDS + \${1%%.*}))
}

kill_checks=0
kill() {
  if [[ "\${1:-}" == "-0" && "\${2:-}" == "sampled-docker-pid" ]]; then
    kill_checks=$((kill_checks + 1))
    [[ "$kill_checks" -le 6 ]]
    return
  fi
  command kill "$@"
}

stats_log="$TMPDIR/stats.log"
run_log="$TMPDIR/run.log"
sampler_log="$TMPDIR/sampler.log"
printf "container output\\n" >"$run_log"

docker_e2e_sample_stats_until_exit demo sampled-docker-pid "$stats_log" "$run_log" "Docker stats" 08 >"$sampler_log" 2>&1
output="$(cat "$sampler_log")"

[[ "$output" =~ Docker\\ stats\\ still\\ running\\ \\(([0-9]+)s\\ elapsed, ]]
heartbeat_elapsed="\${BASH_REMATCH[1]}"
(( heartbeat_elapsed >= 8 ))
[[ "$output" != *"value too great for base"* ]]
[[ -s "$stats_log" ]]
`,
    },
  ])("$title", async ({ tempPrefix, scriptSource }, { signal }) => {
    const workDir = tempDirs.make(tempPrefix);
    const script = scriptSource(workDir);

    await runDockerSnippet(script, signal);
  });

  describe.each(process.platform === "darwin" ? ["/bin/bash", "bash"] : ["/bin/bash"])(
    "%s EXIT-trap Docker status",
    (shell) => {
      const cases = [
        ["docker_e2e_docker_cmd", "normal"],
        ["docker_e2e_docker_run_cmd", "normal"],
        ["docker_e2e_docker_cmd", "no-diagnostics"],
        ["docker_e2e_docker_cmd", "node-watchdog"],
      ].map(([helper, mode]) => ({ helper, mode, entryStatus: 0, commandStatus: 43 }));
      it.each(cases)(
        "preserves $helper status $commandStatus in $mode after exit $entryStatus",
        ({ helper, mode, entryStatus, commandStatus }) => {
          const workDir = tempDirs.make("docker-exit-status-");
          writeExecutables(join(workDir, "bin"), {
            timeout: PASSTHROUGH_TIMEOUT_SCRIPT,
            node: `#!/bin/bash\nexec ${shellQuote(testNodeExecPath)} "$@"\n`,
            docker: `#!/bin/bash\nexit ${commandStatus}\n`,
          });
          const setup =
            mode === "no-diagnostics"
              ? "docker_e2e_resource_limit_temp_dir() { return 1; }"
              : mode === "node-watchdog"
                ? "docker_e2e_timeout_bin() { return 1; }"
                : "";
          const script = repoShell(workDir)`
export PATH="$TMPDIR/bin:$PATH"
export OPENCLAW_DOCKER_E2E_DISABLE_RESOURCE_LIMITS=1
source "$ROOT_DIR/scripts/lib/docker-e2e-container.sh"
${setup}
on_exit() {
  trap - EXIT
  set +e
  if ${helper} run demo; then
    observed=0
  else
    observed="$?"
  fi
  printf '%s\\n' "$observed"
  exit 0
}
trap on_exit EXIT
exit ${entryStatus}
`;
          const result = spawnSync(shell, ["--noprofile", "--norc", "-c", script], {
            encoding: "utf8",
            env: { ...process.env, BASH_ENV: "", ENV: "" },
          });
          expect(result.status, result.stderr).toBe(0);
          expect(result.stdout).toBe(`${commandStatus}\n`);
        },
      );
    },
  );

  it("uses a Node watchdog for Docker commands when timeout is unavailable", () => {
    const workDir = tempDirs.make("openclaw-docker-node-timeout-");
    writeExecutables(join(workDir, "bin"), {
      node: `#!/bin/bash\nexec ${shellQuote(process.execPath)} "$@"\n`,
      docker: `#!/bin/bash\ninput="$(/bin/cat)"\nprintf "%s|%s\\n" "$*" "$input" >"$TMPDIR/docker-seen"\nexit 13\n`,
    });

    const script = repoShell(workDir)`
export PATH="$TMPDIR/bin"
export DOCKER_COMMAND_TIMEOUT=7s
unset OPENCLAW_DOCKER_E2E_DISABLE_RESOURCE_LIMITS
unset OPENCLAW_DOCKER_E2E_MEMORY OPENCLAW_DOCKER_E2E_CPUS OPENCLAW_DOCKER_E2E_PIDS_LIMIT

source "$ROOT_DIR/scripts/lib/docker-e2e-container.sh"

set +e
printf payload | docker_e2e_docker_cmd run -i demo 2>"$TMPDIR/stderr"
status="$?"
set -e

stderr="$(<"$TMPDIR/stderr")"
[[ "$status" = "13" ]]
[[ "$stderr" = *"timeout command not found; using Node watchdog for Docker command timeout 7s"* ]]
[[ "$(<"$TMPDIR/docker-seen")" = "run -e OPENCLAW_NO_AUTO_UPDATE=1 --memory 8g --cpus 16 --pids-limit 2048 -i demo|payload" ]]
`;

    execDockerSnippet(script);
  });

  it("adds default Docker run resource limits without overriding explicit limits", () => {
    const workDir = tempDirs.make("openclaw-docker-resource-limits-");
    writeExecutables(join(workDir, "bin"), {
      timeout: `#!/bin/bash
set -euo pipefail
if [[ "$1" = "--kill-after=1s" ]]; then
  exit 0
fi
shift 2
"$@"
`,
    });

    const script = repoShell(workDir)`
export PATH="$TMPDIR/bin:$PATH"
unset OPENCLAW_DOCKER_E2E_DISABLE_RESOURCE_LIMITS
unset OPENCLAW_DOCKER_E2E_MEMORY OPENCLAW_DOCKER_E2E_CPUS OPENCLAW_DOCKER_E2E_PIDS_LIMIT
export OPENCLAW_DOCKER_E2E_AVAILABLE_CPUS=32

docker() {
  printf "%s\\n" "$*" >>"$TMPDIR/docker-seen"
}
export -f docker

source "$ROOT_DIR/scripts/lib/docker-e2e-container.sh"

docker_e2e_docker_cmd run demo
OPENCLAW_DOCKER_E2E_MEMORY=12g OPENCLAW_DOCKER_E2E_CPUS=4 OPENCLAW_DOCKER_E2E_PIDS_LIMIT=512 docker_e2e_docker_cmd run demo
OPENCLAW_DOCKER_E2E_AVAILABLE_CPUS=8 OPENCLAW_DOCKER_E2E_MEMORY=12g OPENCLAW_DOCKER_E2E_CPUS=16 OPENCLAW_DOCKER_E2E_PIDS_LIMIT=512 docker_e2e_docker_cmd run demo
docker_e2e_docker_cmd run --memory 2g --cpus 3 --pids-limit 99 demo
OPENCLAW_DOCKER_E2E_DISABLE_RESOURCE_LIMITS=1 docker_e2e_docker_cmd run demo

[[ "$(sed -n '1p' "$TMPDIR/docker-seen")" = "run -e OPENCLAW_NO_AUTO_UPDATE=1 --memory 8g --cpus 16 --pids-limit 2048 demo" ]]
[[ "$(sed -n '2p' "$TMPDIR/docker-seen")" = "run -e OPENCLAW_NO_AUTO_UPDATE=1 --memory 12g --cpus 4 --pids-limit 512 demo" ]]
[[ "$(sed -n '3p' "$TMPDIR/docker-seen")" = "run -e OPENCLAW_NO_AUTO_UPDATE=1 --memory 12g --cpus 8 --pids-limit 512 demo" ]]
[[ "$(sed -n '4p' "$TMPDIR/docker-seen")" = "run -e OPENCLAW_NO_AUTO_UPDATE=1 --memory 2g --cpus 3 --pids-limit 99 demo" ]]
[[ "$(sed -n '5p' "$TMPDIR/docker-seen")" = "run -e OPENCLAW_NO_AUTO_UPDATE=1 demo" ]]
`;

    execDockerSnippet(script);
  });

  for (const [shellSignal, expectedStatus] of [
    ["TERM", "143"],
    ["HUP", "129"],
  ] as const) {
    it(`escalates Docker watchdog children that ignore parent SIG${shellSignal}`, async ({
      signal,
    }) => {
      const workDir = tempDirs.make("openclaw-docker-node-signal-");
      const reporter = writeFixtureReceiptReporter(workDir);
      const readyPath = join(workDir, "ready");
      writeExecutables(join(workDir, "bin"), {
        node: `#!/bin/bash\nexec ${shellQuote(process.execPath)} "$@"\n`,
        docker: `#!/bin/bash
trap "" TERM HUP
printf "%s\\n" "$$" >"$TMPDIR/docker-pid"
printf "%s\\n" "$PPID" >"$TMPDIR/watchdog-pid"
${shellQuote(process.execPath)} ${shellQuote(reporter)} ${shellQuote(readyPath)} ready
while true; do /bin/sleep 1; done
`,
      });

      const script = repoRootShell`
TMPDIR=${shellQuote(workDir)}
export ROOT_DIR TMPDIR
export PATH="$TMPDIR/bin"
export DOCKER_COMMAND_TIMEOUT=30s
export OPENCLAW_DOCKER_TIMEOUT_KILL_GRACE_MS=100

source "$ROOT_DIR/scripts/lib/docker-e2e-container.sh"

docker_e2e_docker_cmd run demo

`;

      const runner = spawn("/bin/bash", ["--noprofile", "--norc", "-c", script], {
        env: { ...process.env, BASH_ENV: "", ENV: "" },
        stdio: "ignore",
      });
      const exited = waitForProcessExit(runner);
      try {
        await withinTest(
          fixtureEventBeforeSettlement(
            readyPath,
            "ready",
            exited,
            "docker child PID was not recorded",
          ),
          signal,
        );
        const watchdogPid = Number(readFileSync(join(workDir, "watchdog-pid"), "utf8"));
        const dockerPid = Number(readFileSync(join(workDir, "docker-pid"), "utf8"));
        process.kill(watchdogPid, `SIG${shellSignal}`);
        expect(await withinTest(exited, signal)).toBe(Number(expectedStatus));
        await waitForForeignProcessExit(dockerPid, signal);
      } finally {
        for (const name of ["watchdog-pid", "docker-pid"]) {
          const path = join(workDir, name);
          if (existsSync(path)) {
            try {
              process.kill(Number(readFileSync(path, "utf8")), "SIGKILL");
            } catch {}
          }
        }
        if (runner.exitCode === null && runner.signalCode === null) {
          runner.kill("SIGKILL");
        }
        await exited;
      }
    });
  }

  it("uses gtimeout when timeout is unavailable", () => {
    const workDir = tempDirs.make("openclaw-docker-gtimeout-");
    writeExecutables(join(workDir, "bin"), {
      gtimeout: `#!/bin/bash
set -euo pipefail
if [[ "$1" = "--kill-after=1s" ]]; then
  exit 0
fi
printf 'gtimeout:%s %s|%s\\n' "$1" "$2" "\${*:3}" >>"$TMPDIR/timeout-seen"
shift 2
"$@"
`,
    });

    const script = repoShell(workDir)`
export PATH="$TMPDIR/bin"
export OPENCLAW_DOCKER_E2E_RUN_TIMEOUT=13s
export OPENCLAW_DOCKER_E2E_AVAILABLE_CPUS=8
unset OPENCLAW_DOCKER_E2E_DISABLE_RESOURCE_LIMITS
unset OPENCLAW_DOCKER_E2E_MEMORY OPENCLAW_DOCKER_E2E_CPUS OPENCLAW_DOCKER_E2E_PIDS_LIMIT

docker() {
  printf "%s\\n" "$*" >>"$TMPDIR/docker-seen"
}
export -f docker

source "$ROOT_DIR/scripts/lib/docker-e2e-container.sh"

docker_e2e_docker_run_cmd run demo

[[ "$(<"$TMPDIR/timeout-seen")" = "gtimeout:--kill-after=30s 13s|docker run -e OPENCLAW_NO_AUTO_UPDATE=1 --memory 8g --cpus 8 --pids-limit 2048 demo" ]]
[[ "$(<"$TMPDIR/docker-seen")" = "run -e OPENCLAW_NO_AUTO_UPDATE=1 --memory 8g --cpus 8 --pids-limit 2048 demo" ]]
`;

    execDockerSnippet(script);
  });

  it.each(
    (
      [
        {
          script: BROWSER_CDP_SNAPSHOT_DOCKER_E2E_PATH,
          env: [["OPENCLAW_SKIP_DOCKER_BUILD", "1"]],
          invalid: [["OPENCLAW_BROWSER_CDP_SNAPSHOT_MAX_BYTES", "64kb"]],
          setupError: "",
        },
        {
          script: PLUGIN_LIFECYCLE_MATRIX_DOCKER_E2E_PATH,
          env: [["OPENCLAW_CURRENT_PACKAGE_TGZ", "/tmp/openclaw-missing-package.tgz"]],
          invalid: [
            ["OPENCLAW_PLUGIN_LIFECYCLE_PHASE_TIMEOUT_MS", "150ms"],
            ["OPENCLAW_PLUGIN_LIFECYCLE_MAX_CPU_CORE_RATIO", "0"],
          ],
          setupError: "OpenClaw package tarball does not exist",
        },
        {
          script: UPGRADE_SURVIVOR_DOCKER_E2E_PATH,
          env: [["OPENCLAW_UPGRADE_SURVIVOR_E2E_SKIP_BUILD", "1"]],
          invalid: [
            ["OPENCLAW_UPGRADE_SURVIVOR_START_BUDGET_SECONDS", "90s"],
            ["OPENCLAW_UPGRADE_SURVIVOR_PROBE_TIMEOUT_MS", "soon"],
            ["OPENCLAW_UPGRADE_SURVIVOR_PROBE_ATTEMPT_TIMEOUT_MS", "0"],
          ],
          setupError: "Docker image not found",
        },
      ] satisfies {
        script: string;
        env: [string, string][];
        invalid: [string, string][];
        setupError: string;
      }[]
    ).flatMap(({ invalid, ...setup }) =>
      invalid.map(([envName, value]) => ({ ...setup, envName, value })),
    ),
  )(
    "rejects invalid $envName before scenario setup",
    ({ script, env, envName, value, setupError }) => {
      const stderr = expectInvalidDockerEnv(script, envName, value, Object.fromEntries(env));
      if (setupError) {
        expect(stderr).not.toContain(setupError);
      }
    },
  );

  it("propagates frozen typed-onboarding ERR traps through nested helpers", () => {
    const runner = readFileSync(RELEASE_TYPED_ONBOARDING_DOCKER_E2E_PATH, "utf8");
    const invocation = runner.match(
      /-i "\$IMAGE_NAME" bash(?<flags>(?: +-[A-Za-z]+)*) scripts\/e2e\/lib\/release-typed-onboarding\/scenario\.sh/u,
    );
    expect(invocation?.groups?.flags).toBeDefined();
    const bashFlags = invocation?.groups?.flags?.trim().split(/ +/u).filter(Boolean) ?? [];
    const diagnostic = "typed-onboarding diagnostic status=23";
    const script = `set -euo pipefail
trap 'status=$?; printf "typed-onboarding diagnostic status=%s\\n" "$status" >&2' ERR
inner() { return 23; }
outer() { inner; }
outer
`;

    const result = spawnSync("bash", [...bashFlags, "-c", script], { encoding: "utf8" });

    expect(result.status).toBe(23);
    expect(result.stderr.trim().split("\n")).toEqual([diagnostic]);
  });

  it("keeps credentials out of typed-onboarding diagnostics", () => {
    const source = readFileSync("scripts/e2e/lib/release-typed-onboarding/scenario.sh", "utf8");
    expect(source).toContain("--suppress-gateway-token-output");
    expect(source).not.toContain('"$HOME/.openclaw/agents/main/agent/auth-profiles.json"');
  });

  it("propagates HTTP probe failures through command substitution", () => {
    const source = readFileSync(UPGRADE_SURVIVOR_RUN_SCRIPT, "utf8");
    const probeStart = source.indexOf("probe_gateway_endpoint() {");
    const probe = source.slice(probeStart, source.indexOf("\nstart_gateway()", probeStart));
    for (const exitCode of [0, 43]) {
      const result = spawnDockerSnippet(
        `set -eu
node() {
  if [ "$1" = scripts/e2e/lib/upgrade-survivor/probe-gateway.mjs ]; then
    return "$SURVIVOR_TEST_PROBE_EXIT"
  fi
  command "$SURVIVOR_TEST_NODE" "$@"
}
${probe}
seconds="$(probe_gateway_endpoint /healthz live unused.json)"
printf '%s\\n' "$seconds"
`,
        {
          encoding: "utf8",
          env: {
            ...process.env,
            SURVIVOR_TEST_NODE: process.execPath,
            SURVIVOR_TEST_PROBE_EXIT: String(exitCode),
          },
        },
      );
      expect(result.status, result.stderr).toBe(exitCode);
      if (exitCode === 0) {
        expect(result.stdout).toMatch(/^\d+\n$/);
      } else {
        expect(result.stdout).toBe("");
      }
    }
  });

  it("records an interrupted upgrade survivor phase as failed", async ({ signal }) => {
    const workDir = tempDirs.make("openclaw-upgrade-survivor-signal-");
    const binDir = join(workDir, "bin");
    const markerPath = join(workDir, "npm-started");
    const reporter = writeFixtureReceiptReporter(workDir);
    const summaryPath = join(workDir, "artifacts", "summary.json");
    writeExecutables(binDir, {
      npm: `#!/bin/sh
${shellQuote(process.execPath)} ${shellQuote(reporter)} "$FAKE_NPM_MARKER" ready
exec sleep 300
`,
      timeout: `#!/bin/sh
while [ "\${1#--}" != "$1" ]; do shift; done
shift
exec "$@"
`,
    });

    const child = spawn("bash", [UPGRADE_SURVIVOR_RUN_SCRIPT], {
      detached: true,
      env: {
        ...process.env,
        FAKE_NPM_MARKER: markerPath,
        OPENCLAW_TEST_STATE_FUNCTION_B64: Buffer.from(
          "openclaw_test_state_create() { :; }",
        ).toString("base64"),
        OPENCLAW_UPGRADE_SURVIVOR_BASELINE: "openclaw@2026.7.1-2",
        OPENCLAW_UPGRADE_SURVIVOR_CANDIDATE_SPEC: join(workDir, "unused.tgz"),
        OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT: join(workDir, "runtime"),
        OPENCLAW_UPGRADE_SURVIVOR_STATE_HOME_ROOT: join(workDir, "state-home"),
        OPENCLAW_UPGRADE_SURVIVOR_SUMMARY_JSON: summaryPath,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
      stdio: "ignore",
    });
    const childPid = child.pid;
    if (!childPid) {
      throw new Error("upgrade survivor process did not start");
    }
    const exitPromise = waitForProcessExit(child);

    try {
      await withinTest(
        fixtureEventBeforeSettlement(
          markerPath,
          "ready",
          exitPromise,
          "npm-started marker was not written",
        ),
        signal,
      );
      expect(existsSync(markerPath)).toBe(true);
      process.kill(-childPid, "SIGTERM");
      expect([await withinTest(exitPromise, signal), child.signalCode]).toEqual([143, null]);
      expect(
        readDiagnosticJson(join(workDir, "artifacts", "diagnostics", "raw.json")),
      ).toMatchObject({
        phase: "install-baseline",
        exitStatus: 143,
        signal: "SIGTERM",
      });
      const summary = readDiagnosticJson(summaryPath);
      expect(summary).toMatchObject({
        failure: {
          message: "phase install-baseline interrupted by SIGTERM",
          phase: "install-baseline",
        },
        status: "failed",
      });
      expect(summary.phases.at(-1)).toMatchObject({
        phase: "install-baseline",
        status: "started",
      });
      expect(
        readFileSync(join(workDir, "artifacts", "baseline-install.log"), "utf8"),
      ).not.toContain("Upgrade survivor summary:");
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        process.kill(-childPid, "SIGKILL");
      }
      await exitPromise;
    }
  });

  it.skipIf(process.platform !== "linux").for(["published", "current"])(
    "starts and stops the %s auth probe under its service manager",
    { timeout: 60_000 },
    async (lane, { signal }) => {
      const workDir = tempDirs.make("survivor-managed-probe-");
      const paths = readUpgradeSurvivorPaths(workDir);
      const artifacts = paths.artifactRoot;
      const stateDir = join(workDir, "state");
      mkdirSync(artifacts);
      mkdirSync(stateDir);
      const configPath = join(stateDir, "openclaw.json");
      const authored = '{"gateway":{"mode":"local","port":18789},"channels":{"whatsapp":{}}}\n';
      writeFileSync(configPath, authored);
      const childPath = join(workDir, "listener.mjs");
      const startsPath = join(workDir, "starts.jsonl");
      const portPath = join(workDir, "port");
      const readyPipe = join(workDir, "ready.pipe");
      execFileSync("mkfifo", [readyPipe]);
      writeFileSync(
        childPath,
        `${fixtureReceiptClientSource(receipts.endpoint)}
import fs from "node:fs";
import http from "node:http";
const identity = { pid: process.pid, managed: process.env.OPENCLAW_SYSTEMD_UNIT === "openclaw-gateway.service" };
const server = http.createServer((_req, res) => res.end(JSON.stringify({ ready: true, ...identity })));
const firstStart = !fs.existsSync(process.env.PORT_FILE);
const port = fs.existsSync(process.env.PORT_FILE) ? Number(fs.readFileSync(process.env.PORT_FILE, "utf8")) : 0;
server.listen(port, "127.0.0.1", () => {
  fs.writeFileSync(process.env.PORT_FILE, String(server.address().port));
  fs.appendFileSync(process.env.STARTS_FILE, JSON.stringify(identity) + "\\n");
  sendReceipt(process.env.STARTS_FILE, "ready");
  if (firstStart) fs.writeFileSync(process.env.READY_PIPE, "ready\\n");
  console.log("[gateway] ready on 127.0.0.1:" + server.address().port);
});
`,
      );
      const executable = join(workDir, "bin", "openclaw");
      const stagedUnit = join(workDir, "staged.service");
      writeFileSync(
        stagedUnit,
        buildSystemdUnit({
          programArguments: [process.execPath, executable, "gateway"],
          environment: { OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway.service" },
        }),
      );
      writeExecutables(join(workDir, "bin"), {
        openclaw: `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path"), { spawn, spawnSync } = require("node:child_process");
if (process.argv[2] === "doctor") process.exit(0);
if (process.argv[3] === "install") {
  const unit = path.join(process.env.HOME, ".config/systemd/user/openclaw-gateway.service");
  fs.mkdirSync(path.dirname(unit), { recursive: true });
  fs.copyFileSync(process.env.STAGED_UNIT, unit);
  for (const args of [["daemon-reload"], ["enable", "openclaw-gateway.service"], ["restart", "openclaw-gateway.service"]]) {
    const result = spawnSync("systemctl", ["--user", ...args], { stdio: "inherit" });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  process.exit(0);
}
const child = spawn(process.execPath, [process.env.LISTENER_SCRIPT], { stdio: "inherit" });
child.once("exit", () => process.exit(0));
// A wrapper exit must not strand the listening child outside its service owner.
process.on("SIGTERM", () => {
  if (!process.env.OPENCLAW_SYSTEMD_UNIT) process.exit(0);
});
`,
      });
      const env = {
        ...process.env,
        HOME: workDir,
        PATH: `${join(workDir, "bin")}:${process.env.PATH}`,
        npm_config_prefix: workDir,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_UPGRADE_SURVIVOR_BASELINE: "openclaw@2026.3.13",
        OPENCLAW_UPGRADE_SURVIVOR_UPDATE_RESTART_MODE: "auto-auth",
        ...paths.env,
        OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE: join(artifacts, "systemctl-shim.pid"),
        OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_LOG: join(artifacts, "systemctl-shim.log"),
        OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_DAEMON_LOG: join(
          artifacts,
          "systemctl-shim-gateway.log",
        ),
        OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SERVICE_INSTALL_JSON: join(artifacts, "install.json"),
        OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SERVICE_INSTALL_ERR: join(artifacts, "install.err"),
        OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR: join(workDir, "registry"),
        GATEWAY_AUTH_TOKEN_REF: "survivor-fixture-token",
        STAGED_UNIT: stagedUnit,
        LISTENER_SCRIPT: childPath,
        STARTS_FILE: startsPath,
        PORT_FILE: portPath,
        READY_PIPE: readyPipe,
      };
      const source = readFileSync(UPGRADE_SURVIVOR_RUN_SCRIPT, "utf8");
      const setup =
        lane === "published"
          ? source.slice(0, source.indexOf("phase storage-preflight"))
          : `source ${shellQuote(OPENCLAW_E2E_INSTANCE_HELPER_PATH)}\nsource ${shellQuote(UPGRADE_SURVIVOR_UPDATE_RESTART_AUTH_PATH)}`;
      // The published stop proof must inspect this fixture's listener, not a host Gateway.
      const tcpProbeAdapter = `
eval "$(declare -f openclaw_e2e_probe_tcp | sed '1s/openclaw_e2e_probe_tcp/fixture_probe_tcp/')"
openclaw_e2e_probe_tcp() {
  local port="$2"
  [ "$port" != 18789 ] || port="$(cat "$PORT_FILE")"
  fixture_probe_tcp "$1" "$port" "\${3:-400}"
}
`;
      const script = `${setup}
trap - EXIT ERR INT TERM
assert_prepublish_fixture_idle() { :; }
assert_baseline_state() { :; }
check_gateway_status() { :; }
${tcpProbeAdapter}
# This fixture chooses an ephemeral port; retain the actual readiness implementation.
eval "$(declare -f openclaw_e2e_wait_gateway_ready | sed '1s/openclaw_e2e_wait_gateway_ready/fixture_wait_gateway_ready/')"
openclaw_e2e_wait_gateway_ready() {
  IFS= read -r ready <"$READY_PIPE"
  fixture_wait_gateway_ready "$1" "$2" 20 "$(cat "$PORT_FILE")" "\${5:-strict}"
}
${lane === "published" ? "prepare_update_restart_probe" : 'prepare_update_restart_probe_current_install 18789 "$OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_DAEMON_LOG"'}
`;
      const bin = lane === "published" ? paths.binDir : join(workDir, "bin");
      const systemctlPath = join(bin, "systemctl");
      const systemctl = (...args: string[]) =>
        spawnSync(systemctlPath, ["--user", ...args], {
          env,
          encoding: "utf8",
          timeout: 40_000,
        });
      const probeListener = () =>
        spawnDockerSnippet(
          `source ${shellQuote(OPENCLAW_E2E_INSTANCE_HELPER_PATH)}
${tcpProbeAdapter}
openclaw_e2e_probe_tcp 127.0.0.1 18789 400`,
          { env, encoding: "utf8", timeout: 5_000 },
        );
      const records = (): Array<{ pid: number; managed: boolean }> =>
        existsSync(startsPath)
          ? readFileSync(startsPath, "utf8")
              .split("\n")
              .slice(0, -1)
              .filter(Boolean)
              .map((line) => JSON.parse(line))
          : [];
      try {
        const result = spawnDockerSnippet(script, {
          env,
          encoding: "utf8",
          timeout: 45_000,
        });
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(readFileSync(configPath, "utf8")).toBe(authored);
        const url = `http://127.0.0.1:${readFileSync(portPath, "utf8")}/readyz`;
        if (lane === "published") {
          expect(systemctl("is-active", "openclaw-gateway.service").status).toBe(3);
          expect(records()).toHaveLength(1);
          expect(isPidAlive(records()[0]!.pid)).toBe(false);
          await expect(fetch(url, { signal: AbortSignal.timeout(1_000) })).rejects.toThrow();
          expect(systemctl("start", "openclaw-gateway.service").status).toBe(0);
          await withinTest(receipts.waitFor(startsPath, "ready", 2), signal);
          expect(records()).toHaveLength(2);
        }
        const initial = (await (
          await fetch(url, { signal: AbortSignal.timeout(1_000) })
        ).json()) as { pid: number; managed: boolean };
        expect(initial.managed).toBe(true);
        // Restart/replacement ownership is covered by upgrade-survivor-systemd.test.ts.
        expect(probeListener().status).toBe(0);
        expect(systemctl("stop", "openclaw-gateway.service").status).toBe(0);
        expect(probeListener().status).toBe(1);
        await expect(fetch(url, { signal: AbortSignal.timeout(1_000) })).rejects.toThrow();
      } finally {
        systemctl("stop", "openclaw-gateway.service");
        for (const { pid } of records()) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }
      }
    },
  );

  it("returns the gateway readiness failure when startup is called conditionally", () => {
    const workDir = tempDirs.make("survivor-start-failure-");
    writeExecutables(join(workDir, "bin"), { openclaw: "#!/bin/sh\nexit 17\n" });
    const source = readFileSync(UPGRADE_SURVIVOR_RUN_SCRIPT, "utf8");
    const start = source.slice(
      source.indexOf("start_gateway() {"),
      source.indexOf("\nensure_gateway_started()"),
    );
    const result = spawnDockerSnippet(
      repoShell(workDir)`
export PATH="$TMPDIR/bin:$PATH"
source "$ROOT_DIR/${OPENCLAW_E2E_INSTANCE_HELPER_PATH}"
# An unrelated Gateway may be listening on the runner's fixed port.
openclaw_e2e_probe_http() { return 1; }
GATEWAY_LOG="$TMPDIR/gateway.log"
UPDATE_RESTART_MODE=manual
${start}
trap 'kill "$gateway_pid" 2>/dev/null || true; wait "$gateway_pid" 2>/dev/null || true' EXIT
start_status=0
start_gateway || start_status=$?
exit "$start_status"
`,
      { encoding: "utf8" },
    );
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain("Gateway exited before becoming ready");
  });

  it.each([
    ["doctor markers without legacy identities", "doctor", 23, '{"gateway":{"mode":"local"}}'],
    ["doctor", "doctor", 41, undefined],
    ["readiness", "readiness", 42, undefined],
    ["service-env", "service-env", 43, undefined],
    ["install", "install", 44, undefined],
  ] as const)(
    "restores authored config and scopes Doctor state after %s failure",
    (_label, failureStage, expectedStatus, config) => {
      const workDir = tempDirs.make(`openclaw-upgrade-survivor-${failureStage}-failure-`);
      const captureMarkers = `
  printf 'OPENCLAW_UPDATE_IN_PROGRESS=%s\\n' "\${OPENCLAW_UPDATE_IN_PROGRESS-unset}"
  printf 'OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR=%s\\n' "\${OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR-unset}"
  printf 'OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE=%s\\n' "\${OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE-unset}"
`;
      writeExecutables(join(workDir, "bin"), {
        openclaw: `#!/usr/bin/env bash
set -euo pipefail
printf '%s %s\n' "$OPENCLAW_CONFIG_PATH" "$*" >>"$CAPTURE_DIR/openclaw-calls"
if [ "\${1:-}" = doctor ]; then
  printf '%s\\n' "$@" >"$CAPTURE_DIR/doctor-argv"
  {
${captureMarkers}
  } >"$CAPTURE_DIR/doctor-env"
  [ "$FAILURE_STAGE" != doctor ] || exit "$DOCTOR_STATUS"
  exit 0
fi
if [ "\${1:-}" = gateway ] && [ "\${2:-}" = install ]; then
  [ "$FAILURE_STAGE" != install ] || exit 44
  sleep 30 >/dev/null 2>&1 &
  printf '%s\\n' "$!" >"$OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE"
  exit 0
fi
exec sleep 30
`,
      });

      const script = repoShell(workDir)`
export PATH="$TMPDIR/bin:$PATH"
export CAPTURE_DIR="$TMPDIR"
export FAILURE_STAGE="${failureStage}" DOCTOR_STATUS="${expectedStatus}"
unset OPENCLAW_UPDATE_IN_PROGRESS OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE
export OPENCLAW_STATE_DIR="$TMPDIR/state"
export OPENCLAW_CONFIG_PATH="$OPENCLAW_STATE_DIR/openclaw.json"
export OPENCLAW_UPGRADE_SURVIVOR_CONFIG_PARKING_HELPER="$ROOT_DIR/${UPGRADE_SURVIVOR_CONFIG_PARKING_PATH}"
export OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE="$TMPDIR/gateway.pid"
export OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_DAEMON_LOG="$TMPDIR/service.log"
export OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SERVICE_INSTALL_JSON="$TMPDIR/install.json"
export OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SERVICE_INSTALL_ERR="$TMPDIR/install.err"
export GATEWAY_AUTH_TOKEN_REF=upgrade-survivor-token
mkdir -p "$OPENCLAW_STATE_DIR"
authored_config=${shellQuote(config ?? '{"channels":{"discord":{"dm":{"policy":"allowlist","allowFrom":["123"]}}}}')}
printf '%s\n' "$authored_config" >"$OPENCLAW_CONFIG_PATH"
${CURRENT_INSTALL_PROBE_SETUP}
openclaw_e2e_wait_gateway_ready() {
  [ "$FAILURE_STAGE" != readiness ] || return 42
}
write_update_restart_service_auth_env() {
  [ "$FAILURE_STAGE" != service-env ] || return 43
}
status=0
prepare_update_restart_probe_current_install 18789 "$TMPDIR/gateway.log" >/dev/null 2>&1 || status=$?
printf '%s\n' "$status" >"$CAPTURE_DIR/status"
{
${captureMarkers}
} >"$CAPTURE_DIR/parent-env"
cmp -s "$OPENCLAW_CONFIG_PATH" <(printf '%s\n' "$authored_config")
[ ! -e "$TMPDIR/gateway.log.authored-config" ]
if [ -n "\${gateway_pid:-}" ]; then
  kill "$gateway_pid" >/dev/null 2>&1 || true
  wait "$gateway_pid" >/dev/null 2>&1 || true
fi
`;

      const result = spawnDockerSnippet(script);

      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(join(workDir, "status"), "utf8")).toBe(`${expectedStatus}\n`);
      const calls = readFileSync(join(workDir, "openclaw-calls"), "utf8");
      expect(calls).toContain(join(workDir, "state", "openclaw.json"));
      expect(calls).not.toContain("OPENCLAW_CONFIG_PATH=");
      expect(result.stderr).toBe("");
      for (const file of [
        "identity/device.json",
        "identity/device-auth.json",
        "devices/paired.json",
        "devices/pending.json",
      ]) {
        expect(existsSync(join(workDir, "state", file)), file).toBe(false);
      }
      expect(readFileSync(join(workDir, "doctor-argv"), "utf8").trimEnd().split("\n")).toEqual([
        "doctor",
        "--fix",
        "--non-interactive",
      ]);
      for (const [file, value] of [
        ["doctor-env", "1"],
        ["parent-env", "unset"],
      ] as const) {
        expect(readFileSync(join(workDir, file), "utf8")).toBe(
          `OPENCLAW_UPDATE_IN_PROGRESS=${value}\n` +
            `OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR=${value}\n` +
            `OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE=${value}\n`,
        );
      }
    },
  );

  it("prefers restore failure and retains the authored config snapshot", () => {
    const workDir = tempDirs.make("openclaw-upgrade-survivor-restore-failure-");
    writeExecutables(join(workDir, "bin"), {
      openclaw: `#!/usr/bin/env bash
set -euo pipefail
exit 41
`,
      "config-parking-wrapper.mjs": `import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
if (args[0] === "restore") {
  process.exit(57);
}
const result = spawnSync(
  process.execPath,
  [process.env.REAL_CONFIG_PARKING_HELPER, ...args],
  { stdio: "inherit", env: process.env },
);
process.exit(result.status ?? 1);
`,
    });

    const script = repoShell(workDir)`
export PATH="$TMPDIR/bin:$PATH"
export OPENCLAW_STATE_DIR="$TMPDIR/state"
export OPENCLAW_CONFIG_PATH="$OPENCLAW_STATE_DIR/openclaw.json"
export REAL_CONFIG_PARKING_HELPER="$ROOT_DIR/${UPGRADE_SURVIVOR_CONFIG_PARKING_PATH}"
export OPENCLAW_UPGRADE_SURVIVOR_CONFIG_PARKING_HELPER="$TMPDIR/bin/config-parking-wrapper.mjs"
mkdir -p "$OPENCLAW_STATE_DIR"
printf '%s\n' '{"channels":{"discord":{"dm":{"policy":"allowlist"}}}}' >"$OPENCLAW_CONFIG_PATH"
${CURRENT_INSTALL_PROBE_SETUP}
status=0
prepare_update_restart_probe_current_install 18789 "$TMPDIR/gateway.log" >/dev/null 2>&1 || status=$?
printf '%s\n' "$status" >"$TMPDIR/status"
`;

    const result = spawnDockerSnippet(script);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(workDir, "status"), "utf8")).toBe("57\n");
    expect(existsSync(join(workDir, "gateway.log.authored-config"))).toBe(true);
    expect(JSON.parse(readFileSync(join(workDir, "state", "openclaw.json"), "utf8"))).toEqual({
      channels: { discord: { dm: { policy: "allowlist" } } },
      plugins: { enabled: false },
      gateway: expect.objectContaining({ reload: { mode: "off" } }),
    });
  });

  it.skipIf(process.platform === "win32").for(["zombie", "unreadable or malformed"])(
    "settles a systemctl target only when proc stat proves exit (%s)",
    async (mode, { signal }) => {
      await expectSystemctlSettlement(signal, mode === "zombie");
    },
  );

  function runDiagnosticNode(args: string[], env: NodeJS.ProcessEnv) {
    return spawnSync(testNodeExecPath, args, { env, encoding: "utf8" });
  }

  function publishedDiagnostic(root: string, name: string, previous?: string) {
    const directories = readdirSync(root).filter((dir) => join(root, dir) !== previous);
    expect(directories).toHaveLength(1);
    const directory = join(root, directories[0]!);
    expect(readdirSync(directory)).toEqual([name]);
    const file = join(directory, name);
    return { directory, file, text: readFileSync(file, "utf8") };
  }

  it("records delegated post-core systemd callers only with the environment marker", () => {
    const workDir = tempDirs.make("openclaw-survivor-systemd-caller-");
    const preload = join(workDir, "proc-fixture.mjs");
    const output = join(workDir, "callers.jsonl");
    writeFileSync(
      preload,
      `import fs from "node:fs";
const readFileSync = fs.readFileSync;
fs.readFileSync = (file, ...args) => {
  if (file === "/proc/123/cmdline") return process.env.CALLER_ARGV.split("|").join("\\0");
  if (file === "/proc/123/environ") {
    if (process.env.CALLER_ENV === "EACCES") throw Object.assign(new Error("unreadable"), { code: "EACCES" });
    return process.env.CALLER_ENV;
  }
  if (file === "/proc/123/stat") return "123 (fixture) S 124";
  if (file === "/proc/124/cmdline") return "openclaw-doctor\\0";
  if (file === "/proc/124/stat") return "124 (fixture) S 1";
  return readFileSync(file, ...args);
};
`,
    );
    const delegatedArgv = [
      "node",
      "/package/dist/infra/update-migrated-finalize.worker.js",
      "--post-core",
    ];
    for (const [argv, marker, expected] of [
      [["openclaw-update"], "", ["update", "doctor"]],
      [delegatedArgv, "OPENCLAW_UPDATE_POST_CORE=1", ["update", "doctor"]],
      [delegatedArgv, "", ["doctor"]],
      [delegatedArgv, "EACCES", ["doctor"]],
    ] as const) {
      const child = runDiagnosticNode(
        [
          "--import",
          preload,
          "scripts/e2e/lib/upgrade-survivor/systemd-fixture.mjs",
          "record-caller",
          output,
          "123",
          "restart",
        ],
        { ...process.env, CALLER_ARGV: argv.join("|"), CALLER_ENV: marker },
      );
      expect(child.status, child.stderr).toBe(0);
      expect(JSON.parse(readFileSync(output, "utf8").trim().split("\n").at(-1)!)).toEqual({
        action: "restart",
        roles: expected,
      });
    }
  });

  it.each([
    ["error", 0, "update"],
    ["warning", 0, "--post-core"],
  ] as const)(
    "retains the original post-core %s result separately from exit %i via %s",
    (status, code, command) => {
      const { workDir, artifacts, resultDir, env, preloadOptions } = survivorPostCoreFixture();
      const result = {
        ...postCoreResult(status),
        npm: {
          changed: false,
          outcomes: [
            {
              pluginId: "example",
              status: "error",
              message: "review required token=POST_CORE_SECRET",
              currentVersion: "1.0.0",
              nextVersion: "2.0.0",
            },
          ],
        },
        warnings: [
          {
            pluginId: "example",
            reason: "review required",
            message: "token=POST_CORE_SECRET",
            guidance: [],
          },
        ],
        credentials: "PRIVATE_RESULT_EXTRA",
      };
      writeDiagnosticJson(join(workDir, "package.json"), {
        name: "openclaw",
        version: "2026.9.7",
        type: "module",
      });
      const childPath = join(
        workDir,
        command === "--post-core" ? "update-migrated-finalize.worker.js" : "cli.mjs",
      );
      writeFileSync(
        childPath,
        `import fs from "node:fs";
fs.writeFileSync(process.env.OPENCLAW_UPDATE_POST_CORE_RESULT_PATH, ${JSON.stringify(JSON.stringify(result))});
process.stdout.write("original stdout\\n");
process.exit(${code});
`,
      );
      const child = runDiagnosticNode([childPath, command, "--json"], {
        ...env,
        NODE_OPTIONS: preloadOptions,
      });
      expect(child.status, child.stderr).toBe(code);
      expect(child.stdout).toBe("original stdout\n");
      expect(
        readDiagnosticJson(join(artifacts, "diagnostics", `process-${child.pid}-started.json`)),
      ).toMatchObject({ role: "post-core", event: "started", packageVersion: "2026.9.7" });
      // The historical parent removes the handoff directory before attempting restart.
      rmSync(resultDir, { recursive: true });
      expect(existsSync(join(artifacts, "diagnostics", "post-core.json"))).toBe(true);
      expect(readDiagnosticJson(join(artifacts, "diagnostics", "post-core.json"))).toMatchObject({
        artifactRoot: realpathSync(artifacts),
        childExitCode: code,
      });
      captureSurvivorDiagnostics(artifacts, env);
      const { text, report } = publishSurvivorDiagnostics(workDir, artifacts, env);
      expect(text).not.toContain("POST_CORE_SECRET");
      expect(text).not.toContain("PRIVATE_RESULT_EXTRA");
      expect(report.postCore).toMatchObject({
        availability: "captured",
        childExitCode: code,
        result: {
          status,
          npm: {
            outcomes: [{ pluginId: "example", currentVersion: "1.0.0", nextVersion: "2.0.0" }],
          },
        },
      });
    },
  );

  it.each([
    "doctor",
    "worker",
    "missing-context",
    "delegated-missing-context",
    "wrong-file",
    "outside-tmp",
    "symlink",
    "hardlink",
    "oversize",
    "blocked-output",
  ])(
    "leaves post-core capture unavailable for %s without changing the child outcome",
    (scenario) => {
      const { workDir, artifacts, resultPath, env, preloadOptions } = survivorPostCoreFixture();
      const complete = JSON.stringify(postCoreResult("error"));
      writeFileSync(
        resultPath,
        scenario === "oversize" ? complete + " ".repeat(256 * 1024) : complete,
      );
      if (scenario === "missing-context" || scenario === "delegated-missing-context") {
        env.OPENCLAW_UPDATE_POST_CORE = "";
      }
      if (scenario === "wrong-file") {
        env.OPENCLAW_UPDATE_POST_CORE_RESULT_PATH = join(dirname(resultPath), "source-config.json");
      }
      if (scenario === "outside-tmp") {
        env.TMPDIR = artifacts;
      }
      if (scenario === "symlink" || scenario === "hardlink") {
        const outside = join(workDir, "private-result.json");
        writeFileSync(outside, complete);
        rmSync(resultPath);
        (scenario === "symlink" ? symlinkSync : linkSync)(outside, resultPath);
      }
      if (scenario === "blocked-output") {
        symlinkSync(workDir, join(artifacts, "diagnostics"));
      }
      const childPath = join(
        workDir,
        scenario === "delegated-missing-context"
          ? "update-migrated-finalize.worker.js"
          : "child.mjs",
      );
      writeFileSync(
        childPath,
        scenario === "worker"
          ? `
import { isMainThread, Worker } from "node:worker_threads";
if (isMainThread) await new Promise((resolve) => new Worker(new URL(import.meta.url), { argv: ["update"] }).once("exit", resolve));
process.exit(78);
`
          : "process.exit(78);",
      );
      const child = runDiagnosticNode(
        [
          childPath,
          scenario === "delegated-missing-context"
            ? "--post-core"
            : ["doctor", "worker"].includes(scenario)
              ? "doctor"
              : "update",
        ],
        { ...env, NODE_OPTIONS: preloadOptions },
      );
      expect(child.status, child.stderr).toBe(78);
      expect(child.signal).toBe(null);
      expect(child.stdout).toBe("");
      expect(existsSync(join(artifacts, "diagnostics", "post-core.json"))).toBe(false);
      if (scenario === "blocked-output") {
        rmSync(join(artifacts, "diagnostics"));
      }
      captureSurvivorDiagnostics(artifacts, env);
      const { report } = publishSurvivorDiagnostics(workDir, artifacts, env);
      expect(report.postCore).toEqual({
        availability: "unavailable",
        reason: "No complete exit snapshot; original outcome unknown",
      });
    },
  );

  it.each([UPGRADE_SURVIVOR_RUN_SCRIPT, UPGRADE_SURVIVOR_DOCKER_E2E_PATH])(
    "scopes the passive preload to the original update invocation in %s",
    (scriptPath) => {
      const { workDir, artifacts, env } = survivorPostCoreFixture();
      const source = readFileSync(scriptPath, "utf8");
      const published = scriptPath === UPGRADE_SURVIVOR_RUN_SCRIPT;
      const artifactSetup = published
        ? `source ${shellQuote(UPGRADE_SURVIVOR_PATHS_HELPER)}
resolve_upgrade_survivor_paths`
        : 'ARTIFACT_ROOT="$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT"';
      const update = published
        ? source.slice(
            source.indexOf("update_candidate() {"),
            source.indexOf("\nassert_root_managed_vps_cli_usable()"),
          ) + "\nupdate_candidate\nlane_exit=$?"
        : extractUpgradeSurvivorPayload(source)
            .split('echo "Running package update against the mounted tarball..."')[1]!
            .split('if [ "$update_status" -ne 0 ]; then')[0]! + "\nlane_exit=$update_status";
      const bin = join(workDir, "bin");
      writeExecutables(bin, {
        openclaw: `#!${testNodeExecPath}
const fs = require("node:fs"), path = require("node:path"), { spawnSync } = require("node:child_process");
fs.appendFileSync(path.join(process.env.TMPDIR,"invocations.jsonl"), JSON.stringify({argv:process.argv.slice(2), options:process.env.NODE_OPTIONS, artifactRoot:process.env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT})+"\\n");
if (process.env.OPENCLAW_UPDATE_POST_CORE === "1") {
  fs.writeFileSync(process.env.OPENCLAW_UPDATE_POST_CORE_RESULT_PATH, JSON.stringify({status:"error",changed:false,sync:{changed:false,switchedToBundled:[],switchedToNpm:[],warnings:[],errors:[]},npm:{changed:false,outcomes:[]},integrityDrifts:[]}));
  process.exit(0);
}
if (process.argv[2] !== "update") process.exit(0);
const resultDir = fs.mkdtempSync(path.join(process.env.TMPDIR,"openclaw-update-post-core-"));
const child = spawnSync(${JSON.stringify(testNodeExecPath)}, [__filename,"update","--json"], {env:{...process.env, OPENCLAW_UPDATE_POST_CORE:"1",OPENCLAW_UPDATE_POST_CORE_RESULT_PATH:path.join(resultDir,"plugins.json")}});
if (child.status !== 0) process.exit(90);
fs.rmSync(resultDir,{recursive:true});
process.exit(78);
`,
      });
      const result = spawnDockerSnippet(
        `
${artifactSetup}
openclaw_e2e_maybe_timeout() { shift; "$@"; }
openclaw_e2e_print_log() { :; }
candidate_update_spec() { printf "%s" "$OPENCLAW_CURRENT_PACKAGE_TGZ"; }
COMMAND_TIMEOUT=900s
command_timeout=900s
ROOT_MANAGED_VPS=0
UPDATE_RESTART_MODE=auto-auth
baseline_spec=openclaw@2026.7.1-2
candidate_version=2026.8.1
CANDIDATE_KIND=tarball
UPDATE_JSON="$ARTIFACT_ROOT/update.json"
UPDATE_ERR="$ARTIFACT_ROOT/update.err"
POST_UPDATE_VALIDATE_JSON="$ARTIFACT_ROOT/post-update-validate.json"
POST_UPDATE_VALIDATE_ERR="$ARTIFACT_ROOT/post-update-validate.err"
${update}
test "$NODE_OPTIONS" = --no-warnings || exit 91
exit "$lane_exit"
`,
        {
          encoding: "utf8",
          env: {
            ...env,
            OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: published ? undefined : artifacts,
            OPENCLAW_UPGRADE_SURVIVOR_SUMMARY_JSON: join(artifacts, "summary.json"),
            PATH: `${bin}:${process.env.PATH}`,
            OPENCLAW_UPDATE_POST_CORE: "",
            OPENCLAW_CURRENT_PACKAGE_TGZ: join(workDir, "candidate.tgz"),
          },
        },
      );
      expect(result.status, result.stdout + result.stderr).toBe(78);
      const calls = readFileSync(join(workDir, "invocations.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const observationRoot = calls[0].artifactRoot;
      expect(observationRoot).toEqual(
        published ? expect.stringMatching(`${artifacts}/update-observation\\.[^/]+$`) : artifacts,
      );
      const snapshot = readDiagnosticJson(join(observationRoot, "diagnostics", "post-core.json"));
      expect(snapshot).toMatchObject({
        artifactRoot: realpathSync(observationRoot),
        childExitCode: 0,
        result: { status: "error" },
      });
      expect(calls[0].argv).toEqual([
        "update",
        "--tag",
        join(workDir, "candidate.tgz"),
        "--yes",
        "--json",
        ...(published ? ["--no-restart"] : []),
      ]);
      expect(calls[1].options).toBe(calls[0].options);
      expect(calls[0].options).toContain("--no-warnings --import=");
      expect(calls[1].artifactRoot).toBe(observationRoot);
      for (const call of calls.slice(2)) {
        expect(call.options).toBe("--no-warnings");
        expect(call.artifactRoot).toBe(artifacts);
      }
    },
  );

  it.each(["pid-only", "request-only", "replaced"])(
    "requires an update-owned service replacement after consent recovery (%s)",
    (mode) => {
      const workDir = tempDirs.make("openclaw-survivor-recovery-restart-");
      const artifacts = join(workDir, "artifacts");
      const bin = join(workDir, "bin");
      mkdirSync(artifacts);
      const pidFile = join(artifacts, "supervisor.pid");
      const logFile = join(artifacts, "systemctl.log");
      const invocation = join(artifacts, "update-invoked");
      writeFileSync(pidFile, "12345\n");
      // An earlier baseline restart must not count for the recovery invocation.
      writeFileSync(logFile, "--user restart openclaw-gateway.service\n");
      writeExecutables(bin, {
        systemctl: "#!/usr/bin/env bash\nexit 0\n",
        openclaw: `#!${process.execPath}
const fs = require("node:fs");
if (process.argv[2] !== "update") throw new Error("expected updater invocation");
fs.writeFileSync(${JSON.stringify(invocation)}, "update\\n");
if (["pid-only", "replaced"].includes(process.env.RESTART_TEST_MODE)) fs.writeFileSync(process.env.OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE, "23456\\n");
if (["request-only", "replaced"].includes(process.env.RESTART_TEST_MODE)) fs.appendFileSync(process.env.OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_LOG, "--user restart openclaw-gateway.service\\n");
console.log(JSON.stringify({status:"ok",after:{version:"2026.8.1"},steps:[{name:"global update",exitCode:0}]}));
`,
      });
      const source = readFileSync(UPGRADE_SURVIVOR_RUN_SCRIPT, "utf8");
      const update = source.slice(
        source.indexOf("update_candidate() {"),
        source.indexOf("\nassert_root_managed_vps_cli_usable()"),
      );
      const result = spawnDockerSnippet(
        `set -eu
source ${shellQuote(UPGRADE_SURVIVOR_UPDATE_RESTART_AUTH_PATH)}
openclaw_e2e_maybe_timeout() { shift; "$@"; }
candidate_update_spec() { printf '%s' fixture.tgz; }
read_installed_version() { printf '%s' 2026.8.1; }
ARTIFACT_ROOT=${shellQuote(artifacts)}
SYSTEMCTL_SHIM_PID_FILE=${shellQuote(pidFile)}
SYSTEMCTL_SHIM_LOG=${shellQuote(logFile)}
UPDATE_JSON="$ARTIFACT_ROOT/update.json"
UPDATE_ERR="$ARTIFACT_ROOT/update.err"
COMMAND_TIMEOUT=900s
ROOT_MANAGED_VPS=0
UPDATE_RESTART_MODE=auto-auth
SCENARIO=base
update_repair_required=1
baseline_spec=openclaw@2026.4.15
candidate_version=2026.8.1
CANDIDATE_KIND=tarball
${update}
update_candidate 1
`,
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ""}`,
            RESTART_TEST_MODE: mode,
            OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE: pidFile,
            OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_LOG: logFile,
          },
        },
      );
      expect(result.status, result.stdout + result.stderr).toBe(mode === "replaced" ? 0 : 1);
      expect(readFileSync(invocation, "utf8")).toBe("update\n");
    },
  );

  it.each(["sqlite", "historical"])(
    "observes or explicitly omits persisted plugin identity without changing source artifacts (%s)",
    (storage) => {
      const { workDir, artifacts, env } = survivorPostCoreFixture();
      const state = join(workDir, "state-root");
      const root = join(state, "npm", "example");
      mkdirSync(join(root, "dist"), { recursive: true });
      const doctorBytes = Buffer.from([0x2f, 0x2f, 0xff, 0x0a]);
      writeFileSync(join(root, "dist", "doctor-contract-api.js"), doctorBytes);
      writeFileSync(join(root, "doctor-contract-api.ts"), "PRIVATE_CODE_PAYLOAD");
      writeFileSync(join(root, "contract-api.js"), "throw new Error('must not execute')");
      writeDiagnosticJson(join(root, "package.json"), {
        name: "@example/plugin",
        version: "1.0.0",
        credentials: "PRIVATE_PACKAGE_FIELD",
      });
      writeDiagnosticJson(join(root, "openclaw.plugin.json"), {
        id: "example",
        version: "1.0.0",
        configSchema: { secret: "PRIVATE_MANIFEST_FIELD" },
      });
      writeDiagnosticJson(join(state, "openclaw.json"), {
        credentials: "PRIVATE_CONFIG_FIELD",
        plugins: { installs: { secret: "PRIVATE_CONFIG_RECORD" } },
      });
      const missingRoot = join(state, "npm", "missing");
      mkdirSync(missingRoot);
      const index = {
        installRecords: {
          example: {
            resolvedVersion: "2.0.0",
            integrity: "sha512-recorded",
            credentials: "PRIVATE_RECORD_FIELD",
          },
        },
        plugins: [
          {
            pluginId: "example",
            rootDir: root,
            packageVersion: "2.0.0",
            enabled: true,
            origin: "global",
            doctorContractHash: "a".repeat(64),
            credentials: "PRIVATE_INDEX_FIELD",
          },
          { pluginId: "missing", rootDir: missingRoot, doctorContractHash: "b".repeat(64) },
        ],
        credentials: "PRIVATE_INDEX_TOP_LEVEL",
      };
      if (storage !== "historical") {
        const dbPath = join(state, "state", "openclaw.sqlite");
        mkdirSync(dirname(dbPath), { recursive: true });
        const writer = spawnSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `import { writePluginInstallIndexForE2E } from "./scripts/e2e/lib/plugin-index-sqlite.mjs";
writePluginInstallIndexForE2E(${JSON.stringify(index)}, { stateDir: ${JSON.stringify(state)} });`,
          ],
          { encoding: "utf8" },
        );
        expect(writer.status, writer.stderr).toBe(0);
      } else {
        mkdirSync(join(state, "plugins"));
        writeDiagnosticJson(join(state, "plugins", "installs.json"), index);
      }
      const stateFiles = () =>
        listDirectoryTreeStrictSync(state)
          .map((walkEntry) => walkEntry.dirent)
          .filter((entry) => entry.isFile())
          .map((entry) => {
            const file = join(entry.parentPath, entry.name);
            const stat = statSync(file);
            return [
              file,
              stat.mtimeMs,
              stat.ctimeMs,
              stat.size,
              createHash("sha256").update(readFileSync(file)).digest("hex"),
            ];
          });
      const before = stateFiles();
      const capturePath = copySurvivorCaptureClosure(workDir);
      const captured = spawnSync(
        process.execPath,
        [capturePath, "capture", artifacts, "update-candidate", "1"],
        {
          env: {
            ...env,
            OPENCLAW_STATE_DIR: state,
            OPENCLAW_CONFIG_PATH: join(state, "openclaw.json"),
          },
          encoding: "utf8",
          cwd: workDir,
        },
      );
      expect(captured.status, captured.stderr).toBe(0);
      expect(stateFiles()).toEqual(before);
      const { text, report } = publishSurvivorDiagnostics(workDir, artifacts);
      expect(text).not.toContain("PRIVATE_");
      const identity = report.pluginIdentity;
      expect(identity.availability).toBe("observed");
      expect(identity.reader).toContain("historical fallback");
      expect(identity.evidence).toContain("not observed loaded modules");
      expect(identity.plugins[0]).toMatchObject({
        pluginId: "example",
        packageVersion: "2.0.0",
        enabled: true,
        origin: "global",
        package: { version: "1.0.0" },
        manifest: { id: "example", version: "1.0.0" },
        recorded: { resolvedVersion: "2.0.0", integrity: "sha512-recorded" },
        versionMatchesIndex: false,
        versionMatchesRecord: false,
        doctor: {
          path: "dist/doctor-contract-api.js",
          sha256: createHash("sha256").update(doctorBytes).digest("hex"),
          matchesRecorded: false,
        },
      });
      expect(identity.plugins[1].doctor).toMatchObject({
        path: null,
        sha256: null,
        observation: "no current artifact found",
      });
      expect(readdirSync(join(workDir, "public"))).toEqual(["failure.json"]);
    },
  );

  it.each([
    "index-symlink",
    "index-hardlink",
    "index-oversize",
    "index-cap",
    "root-symlink",
    "doctor-symlink",
    "doctor-hardlink",
    "doctor-oversize",
  ])("refuses unsafe plugin identity input (%s)", (scenario) => {
    const { workDir, artifacts, env } = survivorPostCoreFixture();
    const state = join(workDir, "state-root");
    const root = join(state, "plugin");
    mkdirSync(root, { recursive: true });
    mkdirSync(join(state, "plugins"));
    const indexPath = join(state, "plugins", "installs.json");
    const doctorPath = join(root, "doctor-contract-api.js");
    const outside = join(workDir, "private-source");
    writeFileSync(outside, "PRIVATE_UNSAFE_PLUGIN_SENTINEL");
    writeDiagnosticJson(indexPath, {
      installRecords: {},
      plugins: Array.from({ length: scenario === "index-cap" ? 129 : 1 }, () => ({
        pluginId: "example",
        rootDir: root,
        doctorContractHash: "a".repeat(64),
      })),
    });
    if (scenario.startsWith("index-") && scenario !== "index-cap") {
      rmSync(indexPath);
      if (scenario === "index-oversize") {
        writeFileSync(indexPath, " ".repeat(1024 * 1024 + 1));
      } else {
        (scenario === "index-symlink" ? symlinkSync : linkSync)(outside, indexPath);
      }
    } else if (scenario === "root-symlink") {
      rmSync(root, { recursive: true });
      symlinkSync(workDir, root);
    } else if (scenario.startsWith("doctor-")) {
      if (scenario === "doctor-oversize") {
        writeFileSync(doctorPath, " ".repeat(256 * 1024 + 1) + "PRIVATE_OVERSIZE_PLUGIN");
      } else {
        (scenario === "doctor-symlink" ? symlinkSync : linkSync)(outside, doctorPath);
      }
    }
    captureSurvivorDiagnostics(artifacts, {
      ...env,
      OPENCLAW_STATE_DIR: state,
    });
    const { text, report } = publishSurvivorDiagnostics(workDir, artifacts);
    expect(text).not.toContain("PRIVATE_");
    if (scenario.startsWith("index-")) {
      expect(report.pluginIdentity.availability).toBe("unknown");
      expect(report.omissions["plugin identity"]).toBeDefined();
    } else {
      expect(report.pluginIdentity.plugins[0].doctor.sha256).toBeNull();
      expect(report.pluginIdentity.plugins[0].doctor.observation).toContain("unsafe");
    }
  });

  it("retains a failed service child and sanitizes diagnostics without executing the candidate", async ({
    signal,
  }) => {
    const workDir = tempDirs.make("openclaw-survivor-diagnostics-");
    const artifacts = join(workDir, "artifacts");
    const state = join(workDir, "home", ".openclaw");
    const unitDir = join(workDir, "home", ".config", "systemd", "user");
    mkdirSync(artifacts);
    mkdirSync(join(state, "logs"), { recursive: true });
    mkdirSync(unitDir, { recursive: true });
    mkdirSync(join(artifacts, "npm-prefix"));
    const secret = "sk-survivor-secret-should-never-be-uploaded";
    const privateSentinel = "PRIVATE_CONFIG_AND_NPM_PREFIX_SENTINEL";
    writeDiagnosticJson(join(state, "openclaw.json"), { privateSentinel });
    writeFileSync(join(state, "auth-profiles.json"), privateSentinel);
    writeFileSync(join(artifacts, "npm-prefix", "credential"), privateSentinel);
    writeFileSync(join(artifacts, "config-recipe.json"), privateSentinel);
    writeFileSync(join(state, "gateway.systemd.env"), `API_KEY=${secret}\n`);
    writeFileSync(join(state, "logs", "gateway-restart.log"), `restart: token=${secret}\n`);
    writeFileSync(
      join(unitDir, "openclaw-gateway.service"),
      `[Service]\nExecStart=${testNodeExecPath} gateway --token ${secret}\nWorkingDirectory=/safe/service\nEnvironment="API_KEY=${secret}"\n`,
    );
    writeFileSync(join(artifacts, "doctor.log"), `doctor: token=${secret}\n`);
    writeFileSync(join(artifacts, "update.err"), `post-core failure: token=${secret}\n`);
    const logPath = join(artifacts, "systemctl-shim-gateway.log");
    writeFileSync(`${logPath}.bootstrap.log`, `bootstrap: token=${secret}\n`);
    const childPath = join(workDir, "child.mjs");
    writeFileSync(
      childPath,
      `console.error("first startup boundary failure"); process.exit(78);\n`,
    );
    const supervisor = startUpgradeSurvivorSupervisor(
      workDir,
      `${shellQuote(process.execPath)} ${shellQuote(childPath)}`,
      { OPENCLAW_SYSTEMCTL_SHIM_DAEMON_LOG: logPath },
    );
    await expectSupervisorExit(supervisor, signal);
    const observation = readDiagnosticJson(`${logPath}.exit.json`);
    expect(observation.last).toMatchObject({ code: 78, signal: null });
    const managerEnv = {
      HOME: join(workDir, "home"),
      OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_DAEMON_LOG: logPath,
      OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_LOG: join(artifacts, "systemctl-shim.log"),
      OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE: join(workDir, "missing.pid"),
    };
    const shimPath = installUpgradeSurvivorSystemctlShim(workDir, managerEnv);
    const shown = spawnSync("bash", [shimPath, ...SURVIVOR_SERVICE_SHOW_ARGS], {
      encoding: "utf8",
      env: {
        ...process.env,
        ...managerEnv,
      },
    });
    expect(shown.status, shown.stderr).toBe(0);
    expect(shown.stdout).toContain("ExecMainStatus=78");
    const fixtureEnv = {
      HOME: join(workDir, "home"),
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: join(state, "openclaw.json"),
      npm_config_prefix: join(artifacts, "npm-prefix"),
    };
    const candidate = join(artifacts, "npm-prefix", "lib", "node_modules", "openclaw");
    mkdirSync(join(candidate, "dist", "plugin-sdk"), { recursive: true });
    writeFileSync(join(candidate, "package.json"), '{"type":"module"}');
    writeFileSync(
      join(candidate, "dist", "plugin-sdk", "logging-core.js"),
      'throw new Error("candidate redactor must not execute");',
    );
    captureSurvivorDiagnostics(artifacts, fixtureEnv);
    const rawPath = join(artifacts, "diagnostics", "raw.json");
    const raw = readFileSync(rawPath, "utf8");
    expect(raw).toContain(secret);
    expect(raw).not.toContain(privateSentinel);
    const snapshot = JSON.parse(raw);
    snapshot.config.contents = privateSentinel;
    snapshot.logs["auth-profiles.json"] = privateSentinel;
    snapshot.omissions["doctor.log"] = privateSentinel;
    snapshot.extra = privateSentinel;
    writeDiagnosticJson(rawPath, snapshot);
    const { uploaded, text, report } = publishSurvivorDiagnostics(workDir, artifacts, fixtureEnv);
    expect(readdirSync(uploaded)).toEqual(["failure.json"]);
    expect(text).not.toContain(secret);
    expect(text).not.toContain(privateSentinel);
    expect(report).toMatchObject({
      phase: "update-candidate",
      outcome: "failed",
      exitStatus: 1,
      signal: null,
    });
    expect(report.logs["systemctl-shim-gateway.log"]).toContain("first startup boundary failure");
    expect(report.logs["systemctl-shim-gateway.log.bootstrap.log"]).toContain("bootstrap:");
    expect(report.logs["doctor.log"]).toContain("doctor:");
    expect(report.logs["update.err"]).toContain("post-core failure:");
    expect(report.logs["gateway-restart.log"]).toContain("restart:");
    expect(report.service.childExits).toEqual([
      expect.objectContaining({ code: 78, signal: null }),
      expect.objectContaining({ code: 78, signal: null }),
    ]);
    expect(report.service).toMatchObject({
      WorkingDirectory: "/safe/service",
      environmentKeys: ["API_KEY"],
      environmentFileKeys: ["API_KEY"],
    });
    expect(report.service.ExecStart).toContain("node gateway --token");
    expect(report.config.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("retains supervisor bootstrap stderr without inventing a child exit", async ({ signal }) => {
    const workDir = tempDirs.make("openclaw-survivor-bootstrap-");
    const unitDir = join(workDir, ".config", "systemd", "user");
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(
      join(unitDir, "openclaw-gateway.service"),
      `[Service]\nExecStart="${process.execPath}" unused\n`,
    );
    const binDir = join(workDir, "bin");
    const reporter = writeFixtureReceiptReporter(workDir);
    const readyPath = join(workDir, "bootstrap.ready");
    writeExecutables(binDir, {
      node: `#!/bin/sh
case "$1" in
  *.supervisor.mjs) echo supervisor-bootstrap-failure >&2; ${shellQuote(process.execPath)} ${shellQuote(reporter)} ${shellQuote(readyPath)} ready; exit 17 ;;
esac
exec ${shellQuote(process.execPath)} "$@"
`,
    });
    const logPath = join(workDir, "gateway.log");
    const fixtureEnv = {
      ...process.env,
      HOME: workDir,
      OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_DAEMON_LOG: logPath,
      OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_LOG: join(workDir, "systemctl.log"),
      OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE: join(workDir, "supervisor.pid"),
    };
    const shimPath = installUpgradeSurvivorSystemctlShim(workDir, fixtureEnv);
    const started = spawnSync("bash", [shimPath, "--user", "start", "openclaw-gateway.service"], {
      encoding: "utf8",
      env: { ...fixtureEnv, PATH: `${binDir}:${process.env.PATH ?? ""}` },
    });
    expect(started.status, started.stderr).toBe(0);
    const bootstrapPath = `${logPath}.bootstrap.log`;
    await withinTest(receipts.waitFor(readyPath, "ready"), signal);
    expect(readFileSync(bootstrapPath, "utf8")).toContain("supervisor-bootstrap-failure");
    expect(existsSync(`${logPath}.exit.json`)).toBe(false);
    const shown = spawnSync("bash", [shimPath, ...SURVIVOR_SERVICE_SHOW_ARGS], {
      encoding: "utf8",
      env: fixtureEnv,
    });
    expect(shown.status, shown.stderr).toBe(0);
    expect(shown.stdout).not.toContain("ExecMainStatus=");
  });

  it.each([UPGRADE_SURVIVOR_RUN_SCRIPT, UPGRADE_SURVIVOR_DOCKER_E2E_PATH])(
    "collects before cleanup without masking failure or breaking success in %s",
    (scriptPath) => {
      const source = readFileSync(scriptPath, "utf8");
      const setup =
        scriptPath === UPGRADE_SURVIVOR_RUN_SCRIPT
          ? source.split("\nphase storage-preflight storage_preflight")[0]
          : extractUpgradeSurvivorPayload(source).split(
              "\nopenclaw_e2e_eval_test_state_from_b64",
            )[0];
      for (const [exitCode, blocked, completed] of [
        [78, false, true],
        [78, true, true],
        [0, true, true],
        [0, false, false],
      ] as const) {
        const workDir = tempDirs.make("openclaw-survivor-exit-diagnostics-");
        const paths = readUpgradeSurvivorPaths(workDir);
        const artifacts = paths.artifactRoot;
        mkdirSync(artifacts);
        if (blocked) {
          writeFileSync(join(artifacts, "diagnostics"), "not a directory");
        }
        let observationSetup = "";
        if (scriptPath === UPGRADE_SURVIVOR_RUN_SCRIPT && exitCode === 0 && completed) {
          const initialRoot = join(artifacts, "update-observation.initial");
          const recoveryRoot = join(artifacts, "update-observation.recovery");
          for (const [index, observationRoot] of [initialRoot, recoveryRoot].entries()) {
            mkdirSync(join(observationRoot, "diagnostics"), { recursive: true });
            writeDiagnosticJson(join(observationRoot, "diagnostics/post-core.json"), {
              artifactRoot: realpathSync(observationRoot),
              childExitCode: index === 0 ? 1 : 0,
              result: postCoreResult(index === 0 ? "error" : "ok"),
            });
          }
          observationSetup = `initial_update_observation_root=${shellQuote(initialRoot)}
last_update_observation_root=${shellQuote(recoveryRoot)}`;
        }
        const result = spawnDockerSnippet(
          `${setup}
CURRENT_PHASE=update-candidate
run_completed=${completed ? 1 : 0}
${observationSetup}
${scriptPath === UPGRADE_SURVIVOR_RUN_SCRIPT ? "" : `UPDATE_ERR=${shellQuote(paths.updateErr)}`}
printf "original startup error\\n" >"$UPDATE_ERR"
cleanup() { printf "cleanup replacement\\n" >"$UPDATE_ERR"; }
exit ${exitCode}
`,
          {
            encoding: "utf8",
            env: {
              ...process.env,
              HOME: workDir,
              OPENCLAW_STATE_DIR: workDir,
              OPENCLAW_CONFIG_PATH: join(workDir, "absent"),
              OPENCLAW_UPGRADE_SURVIVOR_BASELINE: "openclaw@2026.7.1-2",
              ...paths.env,
              OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: paths.artifactRoot,
            },
          },
        );
        const expectedStatus = exitCode || (completed ? 0 : 1);
        expect(result.status, result.stderr).toBe(expectedStatus);
        expect(readFileSync(paths.updateErr, "utf8")).toContain("cleanup replacement");
        if (!blocked) {
          const report = readDiagnosticJson(join(artifacts, "diagnostics", "raw.json"));
          expect(report.exitStatus).toBe(expectedStatus);
          expect(report.logs["update.err"]).toContain("original startup error");
        } else if (exitCode) {
          expect(result.stdout + result.stderr).toContain("diagnostics missing");
        } else {
          expect(result.stdout + result.stderr).not.toContain("diagnostics missing");
        }
        if (observationSetup) {
          expect(readDiagnosticJson(paths.summaryJson)).toMatchObject({
            status: "passed",
            firstHopPostCore: {
              availability: "captured",
              childExitCode: 1,
              result: { status: "error" },
            },
          });
        }
      }
    },
  );

  it.each([false, true])(
    "publishes only on the host and preserves Docker outcomes (published baseline: %s)",
    (publishedBaseline) => {
      for (const [exitCode, capturePresent, summaryStatus] of [
        [42, true, null],
        [42, false, null],
        [0, false, "passed"],
        [0, false, "failed"],
      ] as const) {
        if (!publishedBaseline && summaryStatus === "failed") {
          continue;
        }
        const workDir = tempDirs.make("openclaw-survivor-host-publication-");
        const artifacts = join(workDir, "private");
        const registry = join(workDir, "registry");
        const publicRoot = join(workDir, "public");
        const binDir = join(workDir, "bin");
        mkdirSync(join(artifacts, "diagnostics"), { recursive: true });
        mkdirSync(registry);
        writeFileSync(
          join(artifacts, "diagnostics", "raw.json"),
          '{"stale":"PRIVATE_STALE_SENTINEL"}',
        );
        writeFileSync(
          join(artifacts, "diagnostics", "post-core.json"),
          '{"stale":"PRIVATE_POST_CORE_SENTINEL"}',
        );
        writeFileSync(join(artifacts, "summary.json"), '{"stale":"PRIVATE_SUMMARY_SENTINEL"}');
        writeFileSync(join(workDir, "candidate.tgz"), "unused by fake Docker");
        writeDiagnosticJson(join(registry, "prepublish-plugin-registry.json"), {
          sourceSha: "a".repeat(40),
          candidateVersion: "2026.8.1",
          packages: [],
        });
        const phases = [
          { phase: "update-candidate", status: "started", at: "2026-09-01T00:00:00.000Z" },
          { phase: "update-candidate", status: "passed", at: "2026-09-01T00:00:01.000Z" },
        ];
        const publicSummary = {
          ...successSummary("2026.7.1-2", "2026.8.1", { scenario: "base" }),
          updateOutcome: "recoverable",
          updateRecovery: "capability-consent",
          timings: { startupSeconds: 4, healthzSeconds: 1, readyzSeconds: 1, statusSeconds: 2 },
          phases,
          firstHopPostCore: {
            availability: "captured",
            childExitCode: 1,
            result: { status: "error" },
          },
        };
        const completedSummary = {
          ...publicSummary,
          status: summaryStatus ?? "passed",
          candidate: { ...publicSummary.candidate, spec: "PRIVATE_PACKAGE_PATH" },
          updateRestartSource: null,
          phases: phases.map((event) =>
            Object.assign({}, event, { private: "PRIVATE_PHASE_FIELD" }),
          ),
          firstHopPostCore: {
            ...publicSummary.firstHopPostCore,
            result: {
              ...postCoreResult("error"),
              changed: true,
              reason: "requires capability consent token=HOST_PUBLICATION_SECRET",
              warnings: [],
              private: "PRIVATE_POST_CORE_FIELD",
            },
          },
          config: { token: "PRIVATE_CONFIG_FIELD" },
          watchosDirectNode: { credentials: "PRIVATE_WATCH_FIELD" },
          restartFixture: { token: "PRIVATE_RESTART_FIELD" },
        };
        writeDiagnosticJson(join(workDir, "completed-summary.json"), completedSummary);
        writeExecutables(binDir, {
          docker: `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = run ]; then
  printf "%s\\n" "$@" >"$TMPDIR/docker-args"
  if [ ! -e "$TMPDIR/skip-optional-logs" ]; then
    test ! -e "$TMPDIR/public"
  fi
  test ! -e "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_DIR/diagnostics/raw.json"
  test ! -e "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_DIR/diagnostics/post-core.json"
  test ! -e "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_DIR/summary.json"
  if [ "${capturePresent}" = true ]; then
    printf "startup failure token=HOST_PUBLICATION_SECRET\\n" >"$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_DIR/update.err"
    ${shellQuote(process.execPath)} ${shellQuote(join(process.cwd(), UPGRADE_SURVIVOR_DIAGNOSTICS_PATH))} capture "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_DIR" update-candidate ${exitCode}
  fi
  if [ "${publishedBaseline}" = true ] && [ "${exitCode}" = 0 ]; then
    cp "$TMPDIR/completed-summary.json" "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_DIR/summary.json"
    if [ -e "$TMPDIR/skip-optional-logs" ]; then
      printf '{"status":"ok","marker":"CURRENT_HOP","token":"HOST_PUBLICATION_SECRET"}\\n' >"$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_DIR/update.json"
    else
      printf 'historical preamble\\n{"status":"ok","marker":"FIRST_HOP"}\\n{"status":"warning","token":"HOST_PUBLICATION_SECRET"}\\n' >"$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_DIR/update.json"
      printf '{"status":"ok","marker":"REPAIR"}\\n' >"$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_DIR/repair.json"
      printf '{"status":"ok","marker":"RECOVERY"}\\n' >"$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_DIR/recovery-update.json"
    fi
  fi
  exit ${exitCode}
fi
exit 0
`,
        });
        const runWrapper = () =>
          spawnSync("bash", [join(process.cwd(), UPGRADE_SURVIVOR_DOCKER_E2E_PATH)], {
            encoding: "utf8",
            cwd: workDir,
            env: {
              ...process.env,
              HOME: workDir,
              TMPDIR: workDir,
              PATH: `${binDir}:${process.env.PATH ?? ""}`,
              OPENCLAW_CONFIG_PATH: join(workDir, "absent"),
              OPENCLAW_STATE_DIR: workDir,
              OPENCLAW_SKIP_DOCKER_BUILD: "1",
              OPENCLAW_CURRENT_PACKAGE_TGZ: join(workDir, "candidate.tgz"),
              OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR: registry,
              OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_DIR: artifacts,
              OPENCLAW_UPGRADE_SURVIVOR_PUBLISHED_BASELINE: publishedBaseline ? "1" : "0",
              OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC: "openclaw@2026.7.1-2",
              OPENCLAW_DOCKER_ALL_LOG_DIR: "public",
            },
          });
        const result = runWrapper();
        expect(result.status, result.stdout + result.stderr).toBe(exitCode);
        const dockerArgs = readFileSync(join(workDir, "docker-args"), "utf8");
        expect(dockerArgs).toContain(`${artifacts}:/tmp/openclaw-upgrade-survivor-artifacts`);
        expect(dockerArgs).not.toContain(publicRoot);
        expect(dockerArgs).not.toContain(":/tmp/openclaw-upgrade-survivor-artifacts/diagnostics");
        if (capturePresent) {
          const { text } = publishedDiagnostic(publicRoot, "failure.json");
          expect(text).toContain("startup failure");
          expect(text).not.toContain("HOST_PUBLICATION_SECRET");
          expect(JSON.parse(text).exitStatus).toBe(exitCode);
        } else if (exitCode) {
          expect(result.stderr).toContain("diagnostics missing");
          expect(
            readdirSync(publicRoot).flatMap((dir) => readdirSync(join(publicRoot, dir))),
          ).toEqual([]);
        } else if (publishedBaseline && summaryStatus === "passed") {
          expect(existsSync(publicRoot), "passed published run must publish its receipt").toBe(
            true,
          );
          const { directory, file, text } = publishedDiagnostic(publicRoot, "summary.json");
          expect(text).not.toMatch(/PRIVATE_|HOST_PUBLICATION_SECRET/);
          const receipt = JSON.parse(text);
          expect(receipt).toMatchObject(publicSummary);
          expect(receipt.logs["update.json"]).toContain("historical preamble");
          expect(receipt.logs["update.json"]).toContain("FIRST_HOP");
          expect(receipt.logs["update.json"]).toContain('"status":"warning"');
          expect(receipt.logs["update.json"]).not.toMatch(/REPAIR|RECOVERY/);
          expect(receipt.logs["repair.json"]).toContain("REPAIR");
          expect(receipt.logs["recovery-update.json"]).toContain("RECOVERY");
          expect(result.stderr).not.toContain("diagnostics missing");

          writeFileSync(join(workDir, "skip-optional-logs"), "1");
          writeDiagnosticJson(join(workDir, "completed-summary.json"), {
            ...completedSummary,
            updateOutcome: "success",
            updateRecovery: null,
            firstHopPostCore: { availability: "unavailable" },
          });
          const reusedResult = runWrapper();
          expect(reusedResult.status, reusedResult.stdout + reusedResult.stderr).toBe(0);
          expect(reusedResult.stderr).not.toContain("diagnostics missing");
          const { text: reusedText } = publishedDiagnostic(publicRoot, "summary.json", directory);
          expect(reusedText).not.toMatch(/PRIVATE_|HOST_PUBLICATION_SECRET/);
          const reusedReceipt = JSON.parse(reusedText);
          expect(reusedReceipt).toMatchObject({
            status: "passed",
            updateOutcome: "success",
            updateRecovery: null,
          });
          expect(reusedReceipt.logs["update.json"]).toContain("CURRENT_HOP");
          expect(reusedReceipt.logs["update.json"]).not.toMatch(/FIRST_HOP|REPAIR|RECOVERY/);
          expect(
            reusedReceipt.logs,
            "reused directory must not publish previous-run repair or recovery",
          ).toMatchObject({ "repair.json": null, "recovery-update.json": null });
          expect(readFileSync(file, "utf8")).toBe(text);
        } else if (publishedBaseline) {
          expect(result.stderr).toContain("diagnostics missing");
          expect(
            readdirSync(publicRoot).flatMap((dir) => readdirSync(join(publicRoot, dir))),
          ).toEqual([]);
        } else {
          expect(existsSync(publicRoot)).toBe(false);
          expect(result.stderr).not.toContain("diagnostics missing");
        }
      }
    },
  );

  it("stops supervised gateway restarts after the systemd burst limit", async ({ signal }) => {
    const workDir = tempDirs.make("openclaw-update-restart-supervisor-");
    const countPath = join(workDir, "starts");
    const logPath = join(workDir, "daemon.log");
    const command =
      'node -e \'require("node:fs").appendFileSync(process.env.COUNT_FILE, "x"); process.exit(1)\'';
    const supervisor = startUpgradeSurvivorSupervisor(
      workDir,
      command,
      {
        COUNT_FILE: countPath,
        OPENCLAW_SYSTEMCTL_SHIM_DAEMON_LOG: logPath,
      },
      { fastRestart: true, restartWindowMs: 5_000 },
    );
    await expectSupervisorExit(supervisor, signal);
    expect(readFileSync(countPath, "utf8")).toBe("xxxxx");
    expect(readFileSync(logPath, "utf8")).toContain(
      "[systemctl-shim] gateway restart limit reached",
    );
  });

  it.skipIf(process.platform === "win32")(
    "terminates supervised gateway descendants at the systemd stop timeout",
    async ({ signal }) => {
      const fixture = survivorProcessGroupFixture(`${fixtureReceiptClientSource(receipts.endpoint)}
process.on("SIGTERM", () => {
  setTimeout(() => {
    fs.appendFileSync(process.env.STATE_FILE, "-graceful");
    process.exit(0);
  }, 50);
});
const descendant = spawn(process.execPath, [process.env.DESCENDANT_SCRIPT], {
  stdio: ["ignore", "ignore", "ignore", "ipc"],
});
descendant.once("message", () => {
  fs.writeFileSync(process.env.STATE_FILE, "ready");
  sendReceipt(process.env.STATE_FILE, "ready");
});
setInterval(() => {}, 1_000);
`);
      const { supervisor, statePath, exited } = fixture;
      try {
        await withinTest(
          fixtureEventBeforeSettlement(
            statePath,
            "ready",
            exited,
            `supervisor readiness missing (exit=${supervisor.exitCode}, signal=${supervisor.signalCode})`,
          ),
          signal,
        );
        const descendantPid = fixture.pid();
        expect(descendantPid).toBeGreaterThan(1);
        expect(isPidAlive(descendantPid)).toBe(true);

        supervisor.kill("SIGTERM");
        expect(await withinTest(exited, signal)).toBe(0);
        expect(readFileSync(statePath, "utf8")).toBe("ready-graceful");
        // The supervisor exits only after drainProcessGroup observes the group absent.
        expect(isPidAlive(descendantPid)).toBe(false);
      } finally {
        await fixture.stop();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "drains the previous gateway process group before restarting",
    async ({ signal }) => {
      const fixture = survivorProcessGroupFixture(
        `
fs.appendFileSync(process.env.STARTS_FILE, "x");
const starts = fs.readFileSync(process.env.STARTS_FILE, "utf8").length;
if (starts === 1) {
  const descendant = spawn(process.execPath, [process.env.DESCENDANT_SCRIPT], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  descendant.once("message", () => process.exit(1));
  setInterval(() => {}, 1_000);
} else {
  const pid = Number.parseInt(fs.readFileSync(process.env.DESCENDANT_PID_FILE, "utf8"), 10);
  let running = false;
  try {
    process.kill(pid, 0);
    running = true;
    const statPath = "/proc/" + pid + "/stat";
    if (fs.existsSync(statPath)) running = fs.readFileSync(statPath, "utf8").split(" ")[2] !== "Z";
  } catch {}
  fs.writeFileSync(process.env.REPLACEMENT_FILE, running ? "overlap" : "drained");
  process.exit(78);
}
`,
        true,
      );
      try {
        expect(await withinTest(fixture.exited, signal)).toBe(0);
        expect(fixture.pid()).toBeGreaterThan(1);
        expect(fixture.starts()).toBe("xx");
        expect(fixture.replacement()).toBe("drained");
      } finally {
        await fixture.stop();
      }
    },
  );

  it("leaves capability consent and service restart to the updater", () => {
    const source = readFileSync(UPGRADE_SURVIVOR_RUN_SCRIPT, "utf8");
    expect(source).not.toContain("update_args+=(--accept-capabilities)");
    expect(source).not.toContain("systemctl --user restart openclaw-gateway.service");
    for (const path of [UPGRADE_SURVIVOR_DOCKER_E2E_PATH, UPGRADE_SURVIVOR_RUN_SCRIPT]) {
      expect(readFileSync(path, "utf8")).not.toContain(
        'openclaw_e2e_print_log "$SYSTEMCTL_SHIM_LOG"',
      );
    }
    expect(source).not.toContain('openclaw_e2e_print_log "$SYSTEMCTL_SHIM_DAEMON_LOG"');
  });

  it("preserves caller-owned file descriptors around harness runs", () => {
    const workDir = tempDirs.make("openclaw-docker-harness-fd-");
    const script = String.raw`
set -euo pipefail
ROOT_DIR=${shellQuote(process.cwd())}
TMPDIR=${shellQuote(workDir)}
export ROOT_DIR TMPDIR

${PASSTHROUGH_TIMEOUT_SETUP}

source "$ROOT_DIR/scripts/lib/docker-e2e-package.sh"

docker() {
  ${DOCKER_CIDFILE_PROBE}
  printf "container-fd\n" >"$cidfile"
  cat >/dev/null
}
export -f docker

exec 19>"$TMPDIR/caller-fd"
docker_e2e_run_with_harness image-name bash -s <<'SH'
true
SH
printf "preserved\n" >&19
exec 19>&-
grep -Fxq preserved "$TMPDIR/caller-fd"
`;

    execDockerSnippet(script);
  });

  it.each(
    (
      [
        ["release-upgrade-user-journey", "generated-success"],
        ["release-user-journey", "provided-run-failure"],
        ["release-media-memory", "marked-other-name"],
      ] satisfies [string, string][]
    ).map(([label, scenario]) => ({ label, scenario })),
  )("cleans release package runner $label on $scenario", ({ label, scenario }) => {
    const workDir = join(realpathSync(tempDirs.make("openclaw-release-cleanup-")), "with spaces");
    const binDir = join(workDir, "bin");
    const evidenceDir = join(workDir, "retained evidence");
    const packageRecord = join(workDir, "package-path");
    const eventsPath = join(workDir, "events.jsonl");
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(join(evidenceDir, "sentinel"), "keep evidence");
    writeFileSync(join(workDir, "sentinel"), "keep unrelated file");
    writeFileSync(eventsPath, "");

    const provided = scenario.startsWith("provided-") || scenario === "marked-other-name";
    const providedDir = join(workDir, "provided package");
    const providedPackage = join(
      providedDir,
      scenario === "marked-other-name" ? "other.tgz" : "openclaw-current.tgz",
    );
    if (provided) {
      mkdirSync(providedDir);
      writeFileSync(providedPackage, "fixture package");
      writeFileSync(packageRecord, providedPackage);
      if (scenario === "marked-other-name") {
        writeFileSync(join(providedDir, ".openclaw-docker-e2e-generated-package"), "");
      }
    }

    const commandStub = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const command = path.basename(process.argv[1]);
const scenario = ${JSON.stringify(scenario)};
const packageRecord = ${JSON.stringify(packageRecord)};
const record = (...event) => fs.appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify(event) + "\\n");
if (command === "node") {
  if (args[0].endsWith("/package-openclaw-for-docker.mjs")) {
    const output = path.join(args[args.indexOf("--output-dir") + 1], args[args.indexOf("--output-name") + 1]);
    fs.writeFileSync(output, "fixture package");
    fs.writeFileSync(packageRecord, output);
    record("package", output);
    console.log(output);
    process.exit(0);
  }
  if (/\\/openclaw-test-state\\.(mts|mjs)$/.test(args[0])) {
    console.log("export OPENCLAW_STATE_DIR=/tmp/release-cleanup-fixture");
    process.exit(0);
  }
}
if (command === "rm") {
  record("rm", ...args);
  const result = spawnSync("/bin/rm", args, { stdio: "inherit" });
  process.exit(result.status ?? 99);
}
if (command === "docker") {
  record("docker", ...args);
  if (args[0] === "image" && args[1] === "inspect") process.exit(0);
  if (args[0] === "rm") process.exit(0);
  if (args[0] === "inspect") {
    console.log("ExitCode=7\\nOOMKilled=false\\nError=fixture run failure");
    process.exit(0);
  }
  if (args[0] === "run") {
    const packagePath = fs.readFileSync(packageRecord, "utf8");
    if (!args.includes(packagePath + ":/tmp/openclaw-current.tgz:ro")) throw new Error("package mount missing");
    if (fs.readFileSync(packagePath, "utf8") !== "fixture package") throw new Error("package unavailable during run");
    fs.writeFileSync(args[args.indexOf("--cidfile") + 1], "fixture-container\\n");
    const evidenceMount = args.find(arg => arg.endsWith(":/tmp/release-upgrade-evidence"));
    if (evidenceMount) fs.writeFileSync(path.join(evidenceMount.split(":")[0], "result.txt"), "keep run evidence");
    console.log("fixture container output");
    process.exit(scenario === "provided-run-failure" ? 7 : 0);
  }
}
throw new Error("unexpected fixture command: " + command + " " + JSON.stringify(args));
`;
    writeExecutables(binDir, {
      node: commandStub,
      docker: commandStub,
      rm: commandStub,
      timeout: PASSTHROUGH_TIMEOUT_SCRIPT,
    });

    const result = spawnSync("/bin/bash", [`scripts/e2e/${label}-docker.sh`], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        PATH: `${binDir}:/usr/bin:/bin`,
        HOME: workDir,
        TMPDIR: workDir,
        OPENCLAW_CURRENT_PACKAGE_TGZ: provided ? providedPackage : "",
        OPENCLAW_SKIP_DOCKER_BUILD: "1",
        OPENCLAW_DOCKER_E2E_REQUIRE_LOCAL_IMAGE: "1",
        OPENCLAW_DOCKER_E2E_AVAILABLE_CPUS: "2",
        OPENCLAW_RELEASE_UPGRADE_ARTIFACT_DIR: evidenceDir,
      },
    });
    const expectedStatus = scenario === "provided-run-failure" ? 1 : 0;
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(expectedStatus);

    const packagePath = readFileSync(packageRecord, "utf8");
    const packDir = dirname(packagePath);
    const events: string[][] = readFileSync(eventsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const packageRemovals = events.filter((event) => event[0] === "rm" && event.includes(packDir));
    const logPrefix = join(workDir, `openclaw-${label}.`);
    const logRemoval = events.find(
      (event) => event[0] === "rm" && event.some((arg) => arg.startsWith(logPrefix)),
    );
    const logs = readdirSync(workDir).filter((name) => join(workDir, name).startsWith(logPrefix));
    expect(existsSync(packagePath)).toBe(provided);
    expect(logs).toHaveLength(0);
    if (provided) {
      expect(readFileSync(providedPackage, "utf8")).toBe("fixture package");
      expect(packageRemovals).toEqual([]);
    } else {
      expect(packageRemovals).toEqual([["rm", "-rf", packDir]]);
    }
    const run = events.find((event) => event[0] === "docker" && event[1] === "run");
    expect(run).toContain(packagePath + ":/tmp/openclaw-current.tgz:ro");
    expect(logRemoval).toEqual(["rm", "-f", expect.stringMatching(/^.+$/)]);
    if (packageRemovals.length > 0) {
      expect(events.indexOf(packageRemovals[0]!)).toBeLessThan(events.indexOf(logRemoval!));
    }
    if (scenario === "provided-run-failure") {
      expect(result.stdout + result.stderr).toContain("fixture container output");
    }
    if (label === "release-upgrade-user-journey") {
      const runs = readdirSync(evidenceDir).filter((name) => name.startsWith("run."));
      expect(runs).toHaveLength(1);
      const runName = runs[0];
      if (runName === undefined) {
        throw new Error("Expected retained run evidence");
      }
      expect(readFileSync(join(evidenceDir, runName, "result.txt"), "utf8")).toBe(
        "keep run evidence",
      );
    }
    expect(
      readdirSync(workDir).some((name) => name.startsWith("openclaw-docker-e2e-container.")),
    ).toBe(false);
    expect(readFileSync(join(evidenceDir, "sentinel"), "utf8")).toBe("keep evidence");
    expect(readFileSync(join(workDir, "sentinel"), "utf8")).toBe("keep unrelated file");
  });

  it("preserves failing heredoc output and status through Docker E2E heartbeat logging", () => {
    const workDir = tempDirs.make("openclaw-docker-e2e-log-failing-stdin-");
    const script = repoShell(workDir)`

source "$ROOT_DIR/scripts/lib/docker-e2e-logs.sh"

run_logged_print_heartbeat plugins-run 30 bash -s <<'SH'
printf "captured failure output\\n"
exit 37
SH
`;

    const result = spawnDockerSnippet(script);

    expect(result.status).toBe(37);
    expect(result.stdout).toBe("captured failure output\n");
    expect(result.stderr).toBe("");
  });

  it("verifies fs-safe through a pnpm-style linked package root", () => {
    const root = realpathSync(tempDirs.make("openclaw-linked-package-proof-"));
    const modules = join(root, "node_modules");
    const virtualModules = join(modules, ".pnpm/openclaw@fixture/node_modules");
    const physicalRoot = join(virtualModules, "openclaw");
    const logicalRoot = join(modules, "openclaw");
    const fsSafe = join(virtualModules, "@openclaw/fs-safe");
    mkdirSync(physicalRoot, { recursive: true });
    mkdirSync(fsSafe, { recursive: true });
    writeFileSync(join(physicalRoot, "package.json"), '{"name":"openclaw"}');
    writeFileSync(
      join(physicalRoot, "cli.cjs"),
      'process.stdout.write(require.resolve("@openclaw/fs-safe"));',
    );
    writeFileSync(
      join(fsSafe, "package.json"),
      JSON.stringify({
        name: "@openclaw/fs-safe",
        type: "module",
        exports: {
          ".": "./dist/index.js",
          "./config": "./config.js",
          "./durability": "./durability.js",
        },
      }),
    );
    mkdirSync(join(fsSafe, "dist"), { recursive: true });
    writeFileSync(join(fsSafe, "dist/index.js"), "export {};\n");
    writeFileSync(
      join(fsSafe, "config.js"),
      'export function configureFsSafeNative({ mode }) { if (mode !== "off") throw new Error("fixture requires fallback mode"); }',
    );
    writeFileSync(
      join(fsSafe, "durability.js"),
      `
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
export async function sha256File(file) {
  return { digest: createHash("sha256").update(await readFile(file)).digest("hex") };
}
`,
    );
    symlinkSync(physicalRoot, logicalRoot, process.platform === "win32" ? "junction" : "dir");
    expect(
      execFileSync(process.execPath, [join(logicalRoot, "cli.cjs")], { encoding: "utf8" }),
    ).toBe(join(fsSafe, "dist/index.js"));
    for (const packageRoot of [physicalRoot, logicalRoot]) {
      const result = spawnSync(
        process.execPath,
        [
          "scripts/docker/verify-fs-safe-native.mjs",
          "--package-root",
          packageRoot,
          "--mode",
          "fallback",
        ],
        { encoding: "utf8", timeout: 10_000 },
      );
      expect(result.status, result.stdout + result.stderr).toBe(0);
    }
  });

  it("builds and cleans package-lane images without touching shared image tags", () => {
    const root = realpathSync(tempDirs.make("openclaw-package-image-owner-"));
    for (const file of [
      DOCKER_PACKAGE_INSTALL_E2E_PATH,
      DOCKER_E2E_IMAGE_HELPER_PATH,
      DOCKER_E2E_PACKAGE_HELPER_PATH,
      HELPER_PATH,
      "scripts/lib/docker-e2e-logs.sh",
      "scripts/lib/docker-e2e-container.sh",
      "scripts/lib/docker-e2e-watchdog.mjs",
      "scripts/lib/direct-run.mjs",
      "scripts/lib/docker-e2e-resource-diagnostics.sh",
      PREPUBLISH_PLUGIN_REGISTRY_HELPER_PATH,
    ]) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      copyFileSync(file, join(root, file));
    }
    mkdirSync(join(root, "packages/normalization-core/src"), { recursive: true });
    mkdirSync(join(root, "packages/llm-core/src"), { recursive: true });
    copyFileSync("packages/llm-core/src/types.ts", join(root, "packages/llm-core/src/types.ts"));
    const tarball = join(root, "candidate.tgz");
    writeFileSync(tarball, "synthetic package admission fixture");
    const registry = join(root, "registry");
    mkdirSync(registry);
    writeFileSync(
      join(registry, "prepublish-plugin-registry.json"),
      JSON.stringify({
        sourceSha: "a".repeat(40),
        candidateVersion: "2026.9.1",
        packages: [],
      }),
    );
    const log = join(root, "docker.jsonl");
    const bin = join(root, "bin");
    writeExecutables(bin, {
      pnpm: '#!/bin/bash\n[[ "$*" == test:docker:package-install ]] || exit 97\nexec bash scripts/e2e/docker-package-install.sh\n',
      docker: `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === 'build') process.exit(0);
if (args[0] === 'image' && args[1] === 'inspect') process.exit(args[2] === 'shared-bare:fixture' ? 0 : 1);
if (args[0] === 'image' && args[1] === 'rm' || args[0] === 'rm') process.exit(0);
// No container body runs. Fail the final creation to exercise the real owner's cleanup.
if (args[0] === 'run' && fs.readFileSync(${JSON.stringify(log)}, 'utf8').trim().split('\\n').map(JSON.parse).filter(call => call[0] === 'run').length < 4) process.exit(0);
process.exit(73);
`,
    });
    const command = mainLanes.find((lane) => lane.name === "docker-package-install")?.command;
    expect(command).toBeDefined();
    const result = spawnDockerSnippet(command!, {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
      env: {
        PATH: `${bin}:${dirname(testNodeExecPath)}:/usr/bin:/bin`,
        TMPDIR: root,
        OPENCLAW_CURRENT_PACKAGE_TGZ: tarball,
        OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR: registry,
        OPENCLAW_DOCKER_E2E_IMAGE: "shared-bare:fixture",
        OPENCLAW_DOCKER_E2E_REQUIRE_LOCAL_IMAGE: "1",
        OPENCLAW_DOCKER_BUILD_ON_MISSING: "0",
      },
    });
    expect(result.status, result.stdout + result.stderr).toBe(73);
    const calls = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const builds = calls.filter((args) => args[0] === "build");
    expect(builds.map((args) => args[args.indexOf("--target") + 1])).toEqual(["bare", "musl"]);
    const tags = builds.map((args) => args[args.indexOf("-t") + 1]);
    expect(new Set(tags).size).toBe(2);
    expect(calls.flat()).not.toContain("shared-bare:fixture");
    expect(
      calls
        .filter((args) => args[0] === "image" && args[1] === "rm")
        .flatMap((args) => args.slice(2)),
    ).toEqual(tags);
    expect(calls.findIndex((args) => args[0] === "run")).toBeGreaterThan(calls.indexOf(builds[1]!));
    const runs = calls.filter((args) => args[0] === "run");
    expect(runs).toHaveLength(4);
    for (const args of runs) {
      expect(args).toContain(`${tarball}:/tmp/openclaw-current.tgz:ro`);
      expect(args).toContain(`${registry}:/tmp/openclaw-prepublish-plugin-registry:ro`);
      expect(args[args.indexOf("--entrypoint") + 1]).toBe(
        "/opt/openclaw-e2e/scripts/e2e/lib/prepublish-plugin-registry.sh",
      );
    }
  });

  it.each(["invalid summary"])("cleans the direct binding runner after %s", (scenario) => {
    const fixture = containerCleanupFixture(scenario);
    const result = spawnSync("/bin/bash", [PLUGIN_BINDING_COMMAND_ESCAPE_DOCKER_E2E_PATH], {
      env: fixture.env,
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain("expected focused Vitest summary for exactly 3 passed tests");
    expectContainerCleanup(fixture, "openclaw-plugin-binding-command-escape-e2e-");
  });

  it.for([
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ] as const)(
    "cleans the actual cron runner and its harness on %s",
    async ([childSignal, status], { signal }) => {
      const fixture = containerCleanupFixture("signal");
      const runner = spawn("/bin/bash", ["scripts/e2e/cron-cli-docker.sh"], {
        env: fixture.env,
        stdio: "ignore",
      });
      const exited = waitForProcessExit(runner);
      try {
        await withinTest(
          fixtureEventBeforeSettlement(
            fixture.readyPath,
            "ready",
            exited,
            "Docker PID file was not written",
          ),
          signal,
        );
        runner.kill(childSignal);
        expect(await withinTest(exited, signal)).toBe(status);
        expectContainerCleanup(fixture, "openclaw-cron-cli-e2e-");
        expect(isPidAlive(Number(readFileSync(fixture.pidPath, "utf8")))).toBe(false);
      } finally {
        if (runner.exitCode === null && runner.signalCode === null) {
          runner.kill("SIGTERM");
          await exited;
        }
        if (existsSync(fixture.pidPath)) {
          const pid = Number(readFileSync(fixture.pidPath, "utf8"));
          if (isPidAlive(pid)) {
            process.kill(pid, "SIGKILL");
            await waitForForeignProcessExit(pid, signal);
          }
        }
      }
    },
  );

  it("copies the complete bun harness closure into the package-install lane", () => {
    const packageRunner = readFileSync(DOCKER_PACKAGE_INSTALL_E2E_PATH, "utf8");
    const listMatch = /for harness_path in \\\n([^;]*); do/u.exec(packageRunner);
    expect(listMatch, "bun harness copy list").toBeTruthy();
    const copiedRoots = [...(listMatch?.[1] ?? "").matchAll(/[^\s\\]+/gu)].map((match) => match[0]);
    expect(copiedRoots.length).toBeGreaterThan(0);
    for (const root of copiedRoots) {
      expect(existsSync(root), `${root} missing from repo`).toBe(true);
    }
    const isCopied = (file: string) =>
      copiedRoots.some((root) => file === root || file.startsWith(`${root}/`));

    // Walk every source/import/spawn reachable from the bun smoke entrypoint.
    // Anything outside the copied roots crashes the bun proof container at
    // runtime on its /repo mount, the way the #129552 e2e-instance drift did.
    const pending = ["scripts/e2e/bun-global-install-smoke.sh"];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const file = pending.pop() ?? "";
      if (visited.has(file)) {
        continue;
      }
      visited.add(file);
      expect(existsSync(file), `${file} referenced by the bun harness is missing`).toBe(true);
      const body = readFileSync(file, "utf8");
      const requirements: string[] = [];
      for (const match of body.matchAll(/source "\$ROOT_DIR\/([^"]+)"/gu)) {
        requirements.push(match[1] ?? "");
      }
      for (const match of body.matchAll(/source "\$[0-9A-Z_]+_LIB_DIR\/([^"]+)"/gu)) {
        requirements.push(join(dirname(file), match[1] ?? ""));
      }
      // Type-only imports are erased at runtime, so they need no copied file.
      for (const match of body.matchAll(
        /(?:^|\n)(?:import|export)(\s+type\b)?[^;]*?from "(\.\.?\/[^"]+)"/gu,
      )) {
        if (!match[1]) {
          requirements.push(join(dirname(file), match[2] ?? ""));
        }
      }
      for (const match of body.matchAll(/\bnode (scripts\/[^\s"']+\.(?:mjs|ts))/gu)) {
        requirements.push(match[1] ?? "");
      }
      for (const requirement of requirements) {
        expect(
          isCopied(requirement),
          `${file} needs ${requirement} inside the bun harness copy roots`,
        ).toBe(true);
        pending.push(requirement);
      }
    }
    expect(visited.size).toBeGreaterThan(3);
  });

  it("keeps suspension capabilities under the invoking user", () => {
    const source = readFileSync(GATEWAY_NETWORK_DOCKER_E2E_PATH, "utf8");
    expect(source).toMatch(/if \[\[ ! -O "\$CAPABILITIES_DIR" \]\]/u);
    expect(source).toMatch(/if \[\[ ! -O "\$CAPABILITIES_PATH" \]\]/u);
    expect(source).not.toMatch(/--user 0:0|\bch(?:own|mod)\b/u);
    expect(source).not.toContain('rm -rf "$CAPABILITIES_DIR"');
  });

  it.each([
    ["Dockerfile", " AS dependency-inputs\n"],
    [CLEANUP_SMOKE_DOCKERFILE_PATH, "WORKDIR /repo\n"],
  ])("runs root lifecycles from the dependency inputs copied by %s", (file, stageMarker) => {
    const dockerfile = readFileSync(file, "utf8");
    const stageStart = dockerfile.indexOf(stageMarker);
    expect(stageStart).toBeGreaterThanOrEqual(0);
    const installIndex = dockerfile.indexOf("pnpm install --frozen-lockfile", stageStart);
    expect(installIndex).toBeGreaterThan(stageStart);
    const root = tempDirs.make("openclaw-docker-lifecycle-");
    // Execute with the image's explicit file inputs, without the later full-source COPY.
    const copies = dockerfile.slice(stageStart, installIndex).matchAll(/^COPY (.+)$/gm);
    for (const [, instruction] of copies) {
      const paths = instruction!.trim().split(/\s+/);
      if (paths[0]!.startsWith("--")) {
        continue;
      }
      const destination = paths.pop()!;
      for (const source of paths) {
        if (!statSync(source).isFile()) {
          continue;
        }
        const target = join(root, destination, destination.endsWith("/") ? basename(source) : "");
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(source, target);
      }
    }
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    for (const lifecycle of ["preinstall", "postinstall", "prepare"]) {
      const [command, ...args] = manifest.scripts[lifecycle].split(/\s+/);
      expect(command).toBe("node");
      const result = spawnSync(testNodeExecPath, args, {
        cwd: root,
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: join(root, "home"), npm_config_user_agent: "pnpm/12" },
      });
      expect(result.status, `${file} ${lifecycle}: ${result.stderr}`).toBe(0);
    }
  });

  it("selects one release-owned Windows helper mount", () => {
    const script = repoRootShell`
export DOCKER_E2E_HARNESS_ROOT_DIR=/trusted-harness
export DOCKER_E2E_WINDOWS_HELPERS_PATH=/selected/scripts/windows-cmd-helpers.mjs
source "$ROOT_DIR/scripts/lib/docker-e2e-package.sh"
docker_e2e_harness_mount_args
for ((index = 1; index < \${#DOCKER_E2E_HARNESS_ARGS[@]}; index += 2)); do
  printf "%s\\n" "\${DOCKER_E2E_HARNESS_ARGS[$index]}"
done
`;
    const mounts = execDockerSnippet(script)
      .trim()
      .split("\n")
      .filter((mount) => mount.endsWith(":/app/scripts/windows-cmd-helpers.mjs:ro"));

    expect(mounts).toEqual([
      "/selected/scripts/windows-cmd-helpers.mjs:/app/scripts/windows-cmd-helpers.mjs:ro",
    ]);
  });

  it("keeps a stalled multi-node health request inside the probe deadline", () => {
    const runner = readFileSync(MULTI_NODE_UPDATE_DOCKER_E2E_PATH, "utf8");
    const startMarker = "if PORT=18789 node <<NODE\n";
    const endMarker = "\nNODE\n  then";
    const start = runner.indexOf(startMarker);
    const end = runner.indexOf(endMarker, start + startMarker.length);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const probe = runner.slice(start + startMarker.length, end);
    const workDir = tempDirs.make("openclaw-multi-node-health-timeout-");
    const preloadPath = join(workDir, "stalling-fetch.mjs");

    writeFileSync(
      preloadPath,
      [
        "// Advance the deadline when the request aborts without waiting 30 wall-clock seconds.",
        "const realSetTimeout = globalThis.setTimeout;",
        "let now = 0;",
        "Date.now = () => now;",
        "Object.defineProperty(AbortSignal, 'timeout', { value(delayMs) {",
        "  const controller = new AbortController();",
        "  realSetTimeout(() => {",
        "    now += delayMs;",
        "    controller.abort(new DOMException('health deadline elapsed', 'TimeoutError'));",
        "  }, 0);",
        "  return controller.signal;",
        "} });",
        "globalThis.fetch = async (_url, init = {}) => await new Promise((_resolve, reject) => {",
        "  init.signal.addEventListener('abort', () => {",
        "    process.stderr.write('hung fetch aborted\\n');",
        "    reject(init.signal.reason);",
        "  }, { once: true });",
        "});",
      ].join("\n"),
    );

    const result = spawnSync(
      process.execPath,
      ["--import", pathToFileURL(preloadPath).href, "--input-type=module", "--eval", probe],
      {
        encoding: "utf8",
        env: { ...process.env, PORT: "18789" },
        timeout: 5_000,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr.match(/hung fetch aborted/gu)).toHaveLength(1);
    expect(result.stderr).toContain("health deadline elapsed");
  });

  it("reports the installed doctor switch unit through the systemd manager", async () => {
    // Removal must not discover an operator's identically named system service.
    const { unitPath, inspect, runtime } = doctorSwitchFixture("openclaw-doctor-busctl-shim-");
    mkdirSync(dirname(unitPath), { recursive: true });
    writeFileSync(
      unitPath,
      [
        "[Service]",
        'ExecStart=/usr/bin/node "/opt/openclaw git/dist/index.js" gateway --port 18789',
        'WorkingDirectory="/opt/openclaw git"',
        'Environment="GREETING=hello world" OPENCLAW_PROFILE=fixture',
        "EnvironmentFile=-%h/.openclaw/gateway.systemd.env",
        "UnsetEnvironment=STALE_FLAG",
      ].join("\n"),
    );

    const programArguments = [
      "/usr/bin/node",
      "/opt/openclaw git/dist/index.js",
      "gateway",
      "--port",
      "18789",
    ];
    expect(await inspect()).toMatchObject({
      programArguments,
      workingDirectory: "/opt/openclaw git",
      sourcePath: unitPath,
      definitionPaths: [unitPath],
      environment: { GREETING: "hello world", OPENCLAW_PROFILE: "fixture" },
    });

    const definition = readFileSync(unitPath, "utf8");
    expect((await inspect(true))?.programArguments).toEqual(programArguments);
    expect(await runtime()).toMatchObject({
      status: "stopped",
      systemd: { managerUid: process.getuid?.(), tasksCurrent: 0 },
    });
    expect(readFileSync(unitPath, "utf8")).toBe(definition);
    rmSync(unitPath);
    expect(await inspect(true)).toBeNull();
    expect((await runtime()).status).toBe("unknown");
  });

  it("distinguishes a missing named doctor switch unit from failed or unsupported inspection", async () => {
    const serviceName = "openclaw-gateway-fixture.service";
    const { unitPath, invoke, inspect } = doctorSwitchFixture(
      "openclaw-doctor-busctl-absence-",
      serviceName,
      "openclaw-gateway-fixture",
    );
    expect(await inspect()).toBeNull();
    const loadArgs = [
      "--user",
      "--json=short",
      "call",
      "org.freedesktop.systemd1",
      "/org/freedesktop/systemd1",
      "org.freedesktop.systemd1.Manager",
      "LoadUnit",
      "s",
      serviceName,
    ];
    const missing = invoke(loadArgs);
    expect(missing.status).toBe(1);
    expect(missing.stderr.trim()).toBe(`Call failed: Unit ${serviceName} not found.`);
    for (const args of [
      [...loadArgs, "extra"],
      [...loadArgs.slice(0, -1), "../missing.service"],
      [...loadArgs.slice(0, -1), "unrelated.service"],
      ["--user", "--json=short", "list"],
    ]) {
      const unsupported = invoke(args);
      expect(unsupported.status).toBe(1);
      expect(unsupported.stderr).not.toContain("not found.");
    }
    mkdirSync(dirname(unitPath), { recursive: true });
    writeFileSync(
      unitPath,
      "[Service]\nExecStart=/usr/bin/node /opt/profile/openclaw.mjs gateway\nEnvironment=OLD=stale\nEnvironment=\nEnvironment=KEEP=current REMOVE=value\nUnsetEnvironment=KEEP\nUnsetEnvironment=\nUnsetEnvironment=REMOVE\nEnvironmentFile=/missing/required.env\nEnvironmentFile=\n",
    );
    const command = await inspect();
    expect([command?.sourcePath, command?.environment]).toEqual([unitPath, { KEEP: "current" }]);
    rmSync(unitPath);
    mkdirSync(unitPath);
    const unreadable = invoke(loadArgs);
    expect(unreadable.status).toBe(1);
    expect(unreadable.stderr).not.toContain("not found.");
    const staleObject = invoke([
      "--user",
      "--json=short",
      "get-property",
      "org.freedesktop.systemd1",
      "/org/freedesktop/systemd1/unit/openclaw_2dgateway_2dfixture_2eservice",
      "org.freedesktop.systemd1.Unit",
      "FragmentPath",
      "DropInPaths",
      "NeedDaemonReload",
      "LoadState",
    ]);
    expect(staleObject.status).toBe(1);
    expect(staleObject.stdout).not.toContain('"loaded"');
  });

  it("mounts the selected Doctor contract and canonical-path shims from the same checkout", () => {
    const workDir = tempDirs.make("openclaw-doctor-contract-mounts-");
    const targetRoot = join(workDir, "selected target");
    const contractPath = "scripts/e2e/lib/doctor-install-switch";
    const shimNames = ["systemctl", "loginctl", "busctl", "systemd-exec-start.mjs"];
    const targetContract = join(targetRoot, contractPath);
    mkdirSync(join(targetContract, "shims"), { recursive: true });
    copyFileSync(DOCTOR_SWITCH_SCENARIO_PATH, join(targetContract, "scenario.sh"));
    for (const name of shimNames) {
      copyFileSync(join(contractPath, "shims", name), join(targetContract, "shims", name));
    }
    writeFileSync(join(workDir, "openclaw-current.tgz"), "unused package transport fixture");
    writeExecutables(join(workDir, "bin"), {
      timeout: PASSTHROUGH_TIMEOUT_SCRIPT,
      docker: `#!/bin/bash
set -euo pipefail
case "$1 \${2:-}" in
  "image inspect") exit 0 ;;
  "run "*) printf '%s\\0' "$@" >"$TMPDIR/docker-run-args" ;;
  *) exit 9 ;;
esac
`,
    });
    const script = repoShell(workDir)`
export PATH="$TMPDIR/bin:$PATH"
export OPENCLAW_SKIP_DOCKER_BUILD=1
export OPENCLAW_DOCKER_E2E_IMAGE=doctor-contract-fixture
export OPENCLAW_CURRENT_PACKAGE_TGZ="$TMPDIR/openclaw-current.tgz"
unset DOCKER_E2E_HARNESS_ROOT_DIR OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR OPENCLAW_DOCKER_E2E_REPO_ROOT
export OPENCLAW_DOCKER_E2E_REPO_ROOT=${shellQuote(targetRoot)}
bash "$ROOT_DIR/scripts/e2e/doctor-install-switch-docker.sh"
`;
    const result = spawnDockerSnippet(script, {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    const args = readFileSync(join(workDir, "docker-run-args"), "utf8").split("\0");
    const mounts = args.flatMap((arg, index) => (arg === "-v" ? [args[index + 1]] : []));
    // Service inspection uses /usr/local/bin, outside the target directory overlay.
    // Both views must select one fixture while shared helpers stay trusted.
    expect(mounts.filter((mount) => mount?.includes(":/usr/local/bin/"))).toEqual(
      shimNames.map(
        (name) => `${targetRoot}/${contractPath}/shims/${name}:/usr/local/bin/${name}:ro`,
      ),
    );
    expect(mounts).toContain(`${targetRoot}/${contractPath}:/app/${contractPath}:ro`);
    expect(mounts).toContain(`${process.cwd()}/scripts/e2e:/app/scripts/e2e:ro`);
    expect(mounts).toContain(`${process.cwd()}/scripts/lib:/app/scripts/lib:ro`);
    expect(args).toContain("doctor-contract-fixture");
    expect(args).toContain(`${contractPath}/scenario.sh`);
  });

  it("installs binding smoke dependencies without lifecycle scripts", () => {
    expect(readFileSync(PLUGIN_BINDING_COMMAND_ESCAPE_DOCKERFILE_PATH, "utf8")).toContain(
      "pnpm install --frozen-lockfile --ignore-scripts",
    );
  });
});
