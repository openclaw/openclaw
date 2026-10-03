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
import { afterEach, describe, expect, it } from "vitest";
import { mainLanes } from "../../scripts/lib/docker-e2e-scenarios.mts";
import { buildSystemdUnit } from "../../src/daemon/systemd-unit.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  copySurvivorCaptureClosure,
  UPGRADE_SURVIVOR_DIAGNOSTICS_PATH,
} from "../helpers/upgrade-survivor-diagnostics.js";
import {
  readUpgradeSurvivorPaths,
  UPGRADE_SURVIVOR_PATHS_HELPER,
} from "./upgrade-survivor-paths.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const testNodeExecPath = resolveTestNodeExecPath();

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
const INSTALL_E2E_RUNNER_PATH = "scripts/docker/install-sh-e2e/run.sh";
const CLEANUP_DOCKER_SMOKE_PATH = "scripts/test-cleanup-docker.sh";
const INSTALL_E2E_DOCKER_SMOKE_PATH = "scripts/test-install-sh-e2e-docker.sh";
const LIVE_CLI_BACKEND_DOCKER_PATH = "scripts/test-live-cli-backend-docker.sh";
const LIVE_BUILD_DOCKER_PATH = "scripts/test-live-build-docker.sh";
const OPENWEBUI_DOCKER_E2E_PATH = "scripts/e2e/openwebui-docker.sh";
const ONBOARD_DOCKER_E2E_PATH = "scripts/e2e/onboard-docker.sh";
const KITCHEN_SINK_RPC_DOCKER_E2E_PATH = "scripts/e2e/kitchen-sink-rpc-docker.sh";
const CODEX_ON_DEMAND_DOCKER_E2E_PATH = "scripts/e2e/codex-on-demand-docker.sh";
const MCP_CODE_MODE_GATEWAY_DOCKER_E2E_PATH = "scripts/e2e/mcp-code-mode-gateway-docker.sh";
const MCP_CODE_MODE_GATEWAY_LIVE_DOCKER_E2E_PATH =
  "scripts/e2e/mcp-code-mode-gateway-live-docker.sh";
const CODEX_MEDIA_PATH_SCENARIO_PATH = "scripts/e2e/lib/codex-media-path/scenario.sh";
const OPENAI_CHAT_TOOLS_SCENARIO_PATH = "scripts/e2e/lib/openai-chat-tools/scenario.sh";
const CODEX_NPM_PLUGIN_LIVE_DOCKER_E2E_PATH = "scripts/e2e/codex-npm-plugin-live-docker.sh";
const LIVE_PLUGIN_TOOL_DOCKER_E2E_PATH = "scripts/e2e/live-plugin-tool-docker.sh";
const NPM_ONBOARD_CHANNEL_AGENT_DOCKER_E2E_PATH = "scripts/e2e/npm-onboard-channel-agent-docker.sh";
const PLUGIN_BINDING_COMMAND_ESCAPE_DOCKER_E2E_PATH =
  "scripts/e2e/plugin-binding-command-escape-docker.sh";
const PLUGIN_BINDING_COMMAND_ESCAPE_DOCKERFILE_PATH =
  "scripts/e2e/plugin-binding-command-escape.Dockerfile";
const MULTI_NODE_UPDATE_DOCKER_E2E_PATH = "scripts/e2e/multi-node-update-docker.sh";
const AGENT_BUNDLE_MCP_TOOLS_DOCKER_E2E_PATH = "scripts/e2e/agent-bundle-mcp-tools-docker.sh";
const CLEANUP_SMOKE_DOCKERFILE_PATH = "scripts/docker/cleanup-smoke/Dockerfile";
const CLEANUP_SMOKE_RUN_PATH = "scripts/docker/cleanup-smoke/run.sh";
const KITCHEN_SINK_PLUGIN_DOCKER_E2E_PATH = "scripts/e2e/kitchen-sink-plugin-docker.sh";
const PLUGIN_UPDATE_CORRUPT_SCENARIO_PATH =
  "scripts/e2e/lib/plugin-update/corrupt-update-scenario.sh";
const PLUGIN_LIFECYCLE_MATRIX_DOCKER_E2E_PATH = "scripts/e2e/plugin-lifecycle-matrix-docker.sh";
const DOCTOR_SWITCH_SCENARIO_PATH = "scripts/e2e/lib/doctor-install-switch/scenario.sh";
const DOCTOR_SWITCH_BUSCTL_SHIM_PATH = "scripts/e2e/lib/doctor-install-switch/shims/busctl";
const DOCTOR_SWITCH_SYSTEMD_EXEC_START_PATH =
  "scripts/e2e/lib/doctor-install-switch/shims/systemd-exec-start.mjs";
const UPGRADE_SURVIVOR_DOCKER_E2E_PATH = "scripts/e2e/upgrade-survivor-docker.sh";
const UPGRADE_SURVIVOR_DIAGNOSTICS_PUBLISH_PATH = "scripts/upgrade-survivor-diagnostics.mjs";
const PREPUBLISH_PLUGIN_REGISTRY_HELPER_PATH = "scripts/e2e/lib/prepublish-plugin-registry.sh";
const UPDATE_CHANNEL_SWITCH_DOCKER_E2E_PATH = "scripts/e2e/update-channel-switch-docker.sh";
const RELEASE_UPGRADE_USER_JOURNEY_SCENARIO_PATH =
  "scripts/e2e/lib/release-upgrade-user-journey/scenario.sh";
const RELEASE_TYPED_ONBOARDING_SCENARIO_PATH =
  "scripts/e2e/lib/release-typed-onboarding/scenario.sh";
const RELEASE_TYPED_ONBOARDING_DOCKER_E2E_PATH = "scripts/e2e/release-typed-onboarding-docker.sh";
const RELEASE_USER_JOURNEY_SCENARIO_PATH = "scripts/e2e/lib/release-user-journey/scenario.sh";
const UPGRADE_SURVIVOR_RUN_SCRIPT = "scripts/e2e/lib/upgrade-survivor/run.sh";
const UPGRADE_SURVIVOR_UPDATE_RESTART_AUTH_PATH =
  "scripts/e2e/lib/upgrade-survivor/update-restart-auth.sh";
const UPGRADE_SURVIVOR_CONFIG_PARKING_PATH = "scripts/e2e/lib/upgrade-survivor/config-parking.mjs";
const GATEWAY_NETWORK_DOCKER_E2E_PATH = "scripts/e2e/gateway-network-docker.sh";
const BROWSER_CDP_SNAPSHOT_DOCKER_E2E_PATH = "scripts/e2e/browser-cdp-snapshot-docker.sh";
const SANDBOX_BROWSER_SIDECAR_DOCKER_E2E_PATH = "scripts/e2e/sandbox-browser-sidecar-docker.sh";
const SANDBOX_BROWSER_SIDECAR_SCENARIO_PATH =
  "scripts/e2e/lib/sandbox-browser-sidecar/scenario.mjs";

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

const BOUNDED_CLIENT_LOG_DOCKER_E2E_SCRIPTS = [
  "scripts/e2e/cron-mcp-cleanup-docker.sh",
  "scripts/e2e/mcp-channels-docker.sh",
  "scripts/e2e/mcp-code-mode-gateway-docker.sh",
  "scripts/e2e/mcp-code-mode-gateway-live-docker.sh",
] as const;

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
  return { root, temp, log, env, events, pidPath };
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

function writeExecutables(directory: string, files: Record<string, string>): void {
  mkdirSync(directory, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(directory, name), contents, { mode: 0o755 });
  }
}

function expectTextToIncludeAll(text: string, snippets: readonly string[]): void {
  for (const snippet of snippets) {
    expect(text).toContain(snippet);
  }
}

function expectTextToIncludeInOrder(text: string, snippets: readonly string[]): void {
  let offset = 0;
  for (const snippet of snippets) {
    const index = text.indexOf(snippet, offset);
    expect(index).toBeGreaterThanOrEqual(offset);
    offset = index + snippet.length;
  }
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
function writeUpgradeSurvivorStopPolicy(workDir: string, timeoutMs = 330_000): string {
  const policyPath = join(workDir, "stop-policy-" + timeoutMs + ".mjs");
  writeFileSync(
    policyPath,
    [
      'if (process.argv.length !== 3 || process.argv[2] !== "stop-context") {',
      '  throw new Error("Unexpected supervisor policy request");',
      "}",
      "process.stdout.write(" +
        JSON.stringify(
          JSON.stringify({ stopTimeoutMs: timeoutMs, killMode: "control-group", controlGroup: "" }),
        ) +
        ");",
    ].join("\n"),
  );
  return policyPath;
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

async function waitForProcessExit(child: ChildProcess, timeoutMs = 5_000): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return child.exitCode;
  }
  return await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("process did not exit before its test deadline"));
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
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
      if (Number.isSafeInteger(pid) && pid > 1 && isProcessRunning(pid)) {
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
setInterval(() => {}, 1_000);
`,
  );
  return descendantPath;
}

async function forEachUpgradeSurvivorSystemctlShim(
  callback: (fixture: {
    pid: number;
    pidPath: string;
    run: (procStat?: string, settled?: boolean) => number | null;
    readLog: () => string[];
    scriptPath: string;
  }) => void | Promise<void>,
): Promise<void> {
  for (const scriptPath of [UPGRADE_SURVIVOR_UPDATE_RESTART_AUTH_PATH]) {
    const workDir = tempDirs.make("openclaw-systemctl-shim-");
    const binDir = join(workDir, "bin");
    const pidPath = join(workDir, "gateway.pid");
    const childPidPath = join(workDir, "child.pid");
    const child = spawn(process.execPath, [writeTermIgnoringDescendant(workDir)], {
      env: { ...process.env, DESCENDANT_PID_FILE: childPidPath },
      stdio: "ignore",
    });
    try {
      for (let attempt = 0; attempt < 100 && !existsSync(childPidPath); attempt += 1) {
        await delay(10);
      }
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
      const shimPath = installUpgradeSurvivorSystemctlShim(workDir, fixtureEnv, scriptPath);
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
      const readLog = () =>
        readFileSync(fixtureEnv.OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_LOG, "utf8")
          .trim()
          .split("\n");

      await callback({ pid, pidPath, run, readLog, scriptPath });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await waitForProcessExit(child).catch(() => undefined);
    }
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
  const match = script.match(/(resolve_default_cleanup_platform\(\) \{[\s\S]*?\n\})\n\nPLATFORM=/u);
  if (!match) {
    throw new Error("resolve_default_cleanup_platform was not found");
  }
  return execDockerSnippet(
    `${match[1]}\nuname() { if [[ "\${1:-}" == "-m" ]]; then printf "%s" "$FAKE_UNAME_ARCH"; else command uname "$@"; fi; }\nresolve_default_cleanup_platform`,
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
run_logged_print_heartbeat isolated-shell 30 printf 'fixture output\\n'
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

  it("treats Docker registry auth 5xx failures as transient build failures", () => {
    const workDir = tempDirs.make("openclaw-docker-build-transient-");
    const logPath = join(workDir, "docker-build.log");
    writeFileSync(
      logPath,
      [
        "#3 ERROR: failed to authorize: failed to fetch oauth token: unexpected status from POST request to https://auth.docker.io/token: 504 Gateway Timeout: error code: 504",
        "ERROR: failed to solve: failed to resolve source metadata for docker.io/docker/dockerfile:1.7",
      ].join("\n"),
    );

    const script = repoRootShell`
LOG_PATH=${shellQuote(logPath)}
source "$ROOT_DIR/scripts/lib/docker-build.sh"
docker_build_transient_failure "$LOG_PATH"
`;

    execDockerSnippet(script);
  });

  it("detects compiler processes killed by the OOM killer", () => {
    const workDir = tempDirs.make("openclaw-docker-build-killed-compiler-");
    const logPath = join(workDir, "docker-build.log");
    writeFileSync(logPath, "c++: fatal error: Killed signal terminated program cc1plus\n");

    const script = repoRootShell`
LOG_PATH=${shellQuote(logPath)}
source "$ROOT_DIR/scripts/lib/docker-build.sh"
docker_build_resource_exhausted_failure "$LOG_PATH"
`;

    execDockerSnippet(script);
  });

  it("retries Corepack connect timeouts without misreading Dockerfile comments as OOM", () => {
    const workDir = tempDirs.make("openclaw-docker-build-connect-timeout-");
    const logPath = join(workDir, "docker-build.log");
    writeFileSync(
      logPath,
      [
        '# Docker builds on small VMs may otherwise fail with "Killed" (exit 137).',
        "ConnectTimeoutError: Connect Timeout Error (attempted addresses: 192.0.2.1:443)",
      ].join("\n"),
    );

    const script = repoRootShell`
LOG_PATH=${shellQuote(logPath)}
source "$ROOT_DIR/scripts/lib/docker-build.sh"
docker_build_transient_failure "$LOG_PATH"
if docker_build_resource_exhausted_failure "$LOG_PATH"; then
  exit 3
fi
`;

    execDockerSnippet(script);
  });

  it("routes standalone Docker smoke runs through the timeout-aware helper", () => {
    const cleanupSmoke = readFileSync(CLEANUP_DOCKER_SMOKE_PATH, "utf8");
    const installE2eSmoke = readFileSync(INSTALL_E2E_DOCKER_SMOKE_PATH, "utf8");

    expect(cleanupSmoke).toContain('source "$ROOT_DIR/scripts/lib/docker-e2e-container.sh"');
    expect(cleanupSmoke).toContain(
      'DOCKER_COMMAND_TIMEOUT="${DOCKER_COMMAND_TIMEOUT:-${OPENCLAW_CLEANUP_SMOKE_DOCKER_TIMEOUT:-600s}}"',
    );
    expect(cleanupSmoke).toContain(
      'docker_e2e_docker_run_cmd run --rm --platform "$PLATFORM" -t "${limit_args[@]}" "$IMAGE_NAME"',
    );
    expect(cleanupSmoke).not.toContain('docker run --rm --platform "$PLATFORM" -t "$IMAGE_NAME"');

    expect(installE2eSmoke).toContain('source "$ROOT_DIR/scripts/lib/docker-e2e-container.sh"');
    expect(installE2eSmoke).toContain(
      'DOCKER_COMMAND_TIMEOUT="${DOCKER_COMMAND_TIMEOUT:-${OPENCLAW_INSTALL_E2E_DOCKER_TIMEOUT:-2700s}}"',
    );
    expect(installE2eSmoke).toContain("docker_e2e_docker_run_cmd run --rm \\");
    expect(installE2eSmoke).not.toContain("docker run --rm \\");
  });

  it("runs the sandbox browser sidecar proof from the package-installed image", () => {
    const scenario = readFileSync(SANDBOX_BROWSER_SIDECAR_SCENARIO_PATH, "utf8");

    expectTextToIncludeInOrder(scenario, [
      "process.env.HOME =",
      "process.env.OPENCLAW_STATE_DIR =",
      "process.env.OPENCLAW_CONFIG_PATH =",
      'await import("openclaw/plugin-sdk/agent-harness-runtime")',
    ]);
    expect(scenario).not.toMatch(/from\s+["']openclaw\/plugin-sdk\/agent-harness-runtime["']/u);
    expect(scenario).toContain('"sandbox", "list", "--browser", "--json"');
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

  it("gives cleanup-smoke builds enough Node heap while preserving explicit callers", () => {
    const cleanupRun = readFileSync(CLEANUP_SMOKE_RUN_PATH, "utf8");
    expect(cleanupRun).toContain("ensure_cleanup_smoke_node_options()");
    expect(cleanupRun).toContain('export NODE_OPTIONS="$current"');
    expect(cleanupRun).toContain("--max-old-space-size=8192");
    expect(cleanupRun).toContain('*" --max-old-space-size="*');
    expect(cleanupRun).toContain('*" --max_old_space_size="*');
    expect(cleanupRun.indexOf("ensure_cleanup_smoke_node_options")).toBeLessThan(
      cleanupRun.indexOf("pnpm build >/tmp/openclaw-cleanup-build.log"),
    );
  });

  it("rejects invalid cleanup-smoke log byte limits", () => {
    const workDir = tempDirs.make("openclaw-cleanup-smoke-log-invalid-");
    const logPath = join(workDir, "cleanup.log");
    writeFileSync(logPath, "cleanup output\n");
    const script = `
set -euo pipefail
LOG_PATH=${shellQuote(logPath)}
export OPENCLAW_CLEANUP_SMOKE_LOG_PRINT_BYTES=64kb

${cleanupSmokeLogTailHelpers()}

print_log_tail "$LOG_PATH"
`;

    const result = spawnDockerSnippet(script);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("invalid OPENCLAW_CLEANUP_SMOKE_LOG_PRINT_BYTES: 64kb");
    expect(result.stdout).toBe("");
  });

  it("normalizes zero-padded cleanup-smoke log byte limits", () => {
    const workDir = tempDirs.make("openclaw-cleanup-smoke-log-tail-");
    const logPath = join(workDir, "cleanup.log");
    writeFileSync(logPath, "old-cleanup-output-recent\n");
    const script = `
set -euo pipefail
LOG_PATH=${shellQuote(logPath)}
export OPENCLAW_CLEANUP_SMOKE_LOG_PRINT_BYTES=0008

${cleanupSmokeLogTailHelpers()}

print_log_tail "$LOG_PATH"
`;

    const result = spawnDockerSnippet(script);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("truncated: showing last 8");
    expect(result.stdout).toContain("-recent\n");
    expect(result.stdout).not.toContain("old-cleanup-output");
    expect(result.stderr).toBe("");
  });

  it("prints Docker MCP client logs through the bounded helper", () => {
    for (const scriptPath of BOUNDED_CLIENT_LOG_DOCKER_E2E_SCRIPTS) {
      const script = readFileSync(scriptPath, "utf8");

      expect(script, scriptPath).toContain('source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"');
      expect(script.match(/docker_e2e_print_log "\$CLIENT_LOG"/g), scriptPath).toHaveLength(2);
      expect(script, scriptPath).not.toContain('cat "$CLIENT_LOG"');
    }
  });

  it("prints in-container Docker client logs through bounded helpers", () => {
    for (const scriptPath of [CODEX_MEDIA_PATH_SCENARIO_PATH, OPENAI_CHAT_TOOLS_SCENARIO_PATH]) {
      const script = readFileSync(scriptPath, "utf8");

      expect(script, scriptPath).toContain("source scripts/lib/openclaw-e2e-instance.sh");
      expect(script, scriptPath).toContain('openclaw_e2e_print_log "$CLIENT_LOG"');
      expect(script, scriptPath).not.toContain('cat "$CLIENT_LOG"');
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

  it("lets Testbox fall back to building when a reused Docker image is missing", () => {
    const helper = readFileSync(HELPER_PATH, "utf8");
    const e2eImageHelper = readFileSync(DOCKER_E2E_IMAGE_HELPER_PATH, "utf8");
    const liveBuild = readFileSync(LIVE_BUILD_DOCKER_PATH, "utf8");
    const liveCliBackend = readFileSync(LIVE_CLI_BACKEND_DOCKER_PATH, "utf8");

    expectTextToIncludeAll(helper, [
      "docker_build_on_missing_enabled()",
      "OPENCLAW_DOCKER_BUILD_ON_MISSING",
      "OPENCLAW_TESTBOX",
    ]);

    expect(e2eImageHelper).toContain("docker_build_on_missing_enabled");
    expect(e2eImageHelper).toContain("Docker image not available; building");
    expect(e2eImageHelper).toContain('docker_e2e_docker_cmd image inspect "$image_name"');
    expect(e2eImageHelper).toContain('docker_e2e_docker_cmd pull "$image_name"');
    expect(liveBuild).toContain('source "$SCRIPT_ROOT_DIR/scripts/lib/docker-e2e-container.sh"');
    expect(liveBuild).toContain(
      'DOCKER_COMMAND_TIMEOUT="${DOCKER_COMMAND_TIMEOUT:-${OPENCLAW_LIVE_DOCKER_PULL_TIMEOUT:-600s}}"',
    );
    expect(liveBuild).toContain(
      'LIVE_IMAGE_PULL_ATTEMPTS="${OPENCLAW_LIVE_DOCKER_PULL_ATTEMPTS:-3}"',
    );
    expect(liveBuild).toContain('docker_e2e_docker_cmd image inspect "$LIVE_IMAGE_NAME"');
    expect(liveBuild).toContain('docker_e2e_docker_cmd pull "$LIVE_IMAGE_NAME"');
    expect(liveBuild).not.toContain('docker image inspect "$LIVE_IMAGE_NAME"');
    expect(liveBuild).not.toContain('docker pull "$LIVE_IMAGE_NAME"');
    expect(liveBuild).toContain("Live-test image not available; building");
    const openWebUi = readFileSync(OPENWEBUI_DOCKER_E2E_PATH, "utf8");
    expect(openWebUi).toContain(
      'OPENWEBUI_IMAGE="${OPENWEBUI_IMAGE:-ghcr.io/open-webui/open-webui:v0.11.0@sha256:72c0ba641ba75e7aa52655cb242570906ececd09b1140fb736483038a22b3228}"',
    );
    expect(openWebUi).toContain(
      'DOCKER_COMMAND_TIMEOUT="$DOCKER_PULL_TIMEOUT" docker_e2e_docker_cmd pull "$OPENWEBUI_IMAGE"',
    );
    expect(openWebUi).toContain(
      "node scripts/e2e/lib/openwebui/http-probe.mjs 'http://$OW_NAME:$WEBUI_PORT/health' 200",
    );
    expect(openWebUi).not.toContain(
      'timeout "$DOCKER_PULL_TIMEOUT" docker pull "$OPENWEBUI_IMAGE"',
    );
    expect(openWebUi).not.toContain(
      "node scripts/e2e/lib/openwebui/http-probe.mjs 'http://$OW_NAME:$WEBUI_PORT/' lt500",
    );
    expect(liveCliBackend).toContain(
      'OPENCLAW_LIVE_DOCKER_REPO_ROOT="$ROOT_DIR" "$TRUSTED_HARNESS_DIR/scripts/test-live-build-docker.sh"',
    );
    expect(liveCliBackend).toContain("codex-cli is no longer a bundled CLI backend");
    expect(liveCliBackend).not.toContain("==> Direct Codex CLI probe ok");
    expect(liveCliBackend).not.toContain(
      'echo "==> Reuse live-test image: $LIVE_IMAGE_NAME (OPENCLAW_SKIP_DOCKER_BUILD=1)"',
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
    const helper = readFileSync(DOCKER_E2E_IMAGE_HELPER_PATH, "utf8");
    const scripts = [
      readFileSync(ONBOARD_DOCKER_E2E_PATH, "utf8"),
      readFileSync(KITCHEN_SINK_PLUGIN_DOCKER_E2E_PATH, "utf8"),
      readFileSync(KITCHEN_SINK_RPC_DOCKER_E2E_PATH, "utf8"),
      readFileSync(OPENWEBUI_DOCKER_E2E_PATH, "utf8"),
    ];

    expect(helper).toContain("docker_e2e_read_nonnegative_decimal_env()");
    for (const script of scripts) {
      expect(script).toContain("docker_e2e_read_nonnegative_decimal_env");
    }

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

  it("keeps Testbox image-build fallback before isolating live MCP code-mode runtime flags", () => {
    const script = readFileSync(MCP_CODE_MODE_GATEWAY_LIVE_DOCKER_E2E_PATH, "utf8");
    const buildIndex = script.indexOf('docker_e2e_build_or_reuse "$IMAGE_NAME"');
    const unsetIndex = script.indexOf("unset OPENCLAW_TESTBOX");

    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(unsetIndex).toBeGreaterThan(buildIndex);
    expect(unsetIndex).toBeLessThan(script.indexOf("docker_e2e_run_with_harness"));
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

docker_build_run e2e-build -t demo-image .

grep -q '^--kill-after=30s 17s|env DOCKER_BUILDKIT=1 docker build --progress=plain --build-arg GITHUB_ACTIONS -t demo-image .$' "$TMPDIR/timeout-seen"
grep -q '^build --progress=plain --build-arg GITHUB_ACTIONS -t demo-image .$' "$TMPDIR/docker-seen"
`;

    execDockerSnippet(script);
  });

  it("stops the tracked build command without retrying when interrupted", async () => {
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

    const waitForFile = async (filePath: string) => {
      for (let attempt = 0; attempt < 500; attempt += 1) {
        if (existsSync(filePath)) {
          return;
        }
        await delay(10);
      }
      throw new Error(`file was not written: ${filePath}`);
    };
    const waitForExit = async (child: ReturnType<typeof spawn>) =>
      await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
    const waitForDead = async (pid: number) => {
      for (let attempt = 0; attempt < 500; attempt += 1) {
        try {
          process.kill(pid, 0);
        } catch {
          return;
        }
        await delay(10);
      }
      throw new Error(`process stayed alive: ${pid}`);
    };
    const runInterruptedBuild = async (signal: NodeJS.Signals, expectedCode: number) => {
      rmSync(join(workDir, "docker.pid"), { force: true });
      rmSync(join(workDir, "docker.term"), { force: true });
      rmSync(join(workDir, "docker.ready"), { force: true });
      rmSync(join(workDir, "docker.block"), { force: true });
      rmSync(join(workDir, "docker-count"), { force: true });
      const runner = spawn(join(workDir, "runner.sh"), {
        env: { ...process.env, TMPDIR: workDir },
        stdio: "ignore",
      });
      try {
        const pidPath = join(workDir, "docker.pid");
        await waitForFile(pidPath);
        await waitForFile(join(workDir, "docker.ready"));
        const buildPid = Number.parseInt(readFileSync(pidPath, "utf8"), 10);

        runner.kill(signal);
        const exit = await waitForExit(runner);

        expect(exit).toEqual({ code: expectedCode, signal: null });
        await waitForFile(join(workDir, "docker.term"));
        expect(readFileSync(join(workDir, "docker-count"), "utf8").trim()).toBe("1");
        await waitForDead(buildPid);
      } finally {
        if (runner.exitCode === null && runner.signalCode === null) {
          runner.kill("SIGKILL");
        }
      }
    };

    await runInterruptedBuild("SIGTERM", 143);
    await runInterruptedBuild("SIGINT", 130);
  });

  it("normalizes zero-padded centralized Docker build heartbeat intervals", () => {
    const script = repoRootShell`
export ROOT_DIR
export OPENCLAW_DOCKER_BUILD_HEARTBEAT_SECONDS=08

source "$ROOT_DIR/scripts/lib/docker-build.sh"

[[ "$(docker_build_heartbeat_seconds)" = "8" ]]
`;

    execDockerSnippet(script);
  });

  it("normalizes zero-padded centralized Docker build retry counts", () => {
    const script = repoRootShell`
export ROOT_DIR
export OPENCLAW_DOCKER_BUILD_RETRIES=08

source "$ROOT_DIR/scripts/lib/docker-build.sh"

[[ "$(docker_build_retry_count)" = "8" ]]
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

  it("fails centralized Docker builds fast when timeout is unavailable", () => {
    const workDir = tempDirs.make("openclaw-docker-build-timeout-required-");
    mkdirSync(join(workDir, "bin"));
    const script = repoShell(workDir)`
export PATH="$TMPDIR/bin"
export OPENCLAW_DOCKER_BUILD_TIMEOUT=19s

dirname() {
  /usr/bin/dirname "$@"
}

grep() {
  /usr/bin/grep "$@"
}

cat() {
  /bin/cat "$@"
}

rm() {
  /bin/rm "$@"
}

mktemp() {
  /usr/bin/mktemp "$@"
}

docker() {
  printf "%s\\n" "$*" >"$TMPDIR/docker-seen"
}
export -f dirname grep cat rm mktemp docker

source "$ROOT_DIR/scripts/lib/docker-build.sh"

set +e
docker_build_run e2e-build -t demo-image . >"$TMPDIR/stdout" 2>"$TMPDIR/stderr"
status="$?"
set -e

stdout="$(<"$TMPDIR/stdout")"
[[ "$status" = "1" ]]
[[ "$stdout" = *"timeout command not found; cannot bound Docker command after 19s"* ]]
[[ ! -e "$TMPDIR/docker-seen" ]]
`;

    execDockerSnippet(script);
  });

  it.each([
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
    {
      title: "removes functional Docker build package inputs after the build",
      tempPrefix: "openclaw-docker-build-cleanup-",
      scriptSource: (workDir: string) => repoShell(workDir)`

${PACKAGE_BUILDER_NODE_SCRIPT}

source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"

${PACKAGE_BUILD_CONTEXT_PROBE_SCRIPT}

docker_e2e_build_or_reuse \\
  openclaw-test-image \\
  cleanup-proof \\
  "$ROOT_DIR/scripts/e2e/Dockerfile" \\
  "$ROOT_DIR" \\
  functional

test -f "$TMPDIR/build-context-seen"
leftovers="$(find "$TMPDIR" -maxdepth 1 \\( \\
  -name 'openclaw-docker-e2e-pack.*' \\
  -o -name 'openclaw-docker-e2e-package-context.*' \\
\\) -print)"
if [[ -n "$leftovers" ]]; then
  printf 'leftover functional build inputs:\\n%s\\n' "$leftovers" >&2
  exit 1
fi
`,
    },
    {
      title: "keeps caller-provided functional Docker build packages",
      tempPrefix: "openclaw-docker-build-external-package-",
      scriptSource: (workDir: string) => repoShell(workDir)`

external_dir="$TMPDIR/external-package"
mkdir -p "$external_dir"
printf fixture >"$external_dir/openclaw-current.tgz"
OPENCLAW_CURRENT_PACKAGE_TGZ="$external_dir/openclaw-current.tgz"
export OPENCLAW_CURRENT_PACKAGE_TGZ

source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"

${PACKAGE_BUILD_CONTEXT_PROBE_SCRIPT}

docker_e2e_build_or_reuse \\
  openclaw-test-image \\
  external-package-proof \\
  "$ROOT_DIR/scripts/e2e/Dockerfile" \\
  "$ROOT_DIR" \\
  functional

test -f "$TMPDIR/build-context-seen"
test -f "$OPENCLAW_CURRENT_PACKAGE_TGZ"
leftovers="$(find "$TMPDIR" -maxdepth 1 -name 'openclaw-docker-e2e-package-context.*' -print)"
if [[ -n "$leftovers" ]]; then
  printf 'leftover functional build context:\\n%s\\n' "$leftovers" >&2
  exit 1
fi
`,
    },
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
docker_e2e_run_with_harness image-name bash -lc true 2>"$TMPDIR/failure-stderr" || run_status="$?"
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
(
  run_logged_print_heartbeat plugins-run 30 bash -c 'trap "exit 0" TERM; printf "%s" "$$" > "$1"; while true; do /bin/sleep 0.05; done' bash "$command_pid_file"
) &
wrapper_pid="$!"
for _ in $(seq 1 100); do
  [ -s "$command_pid_file" ] && break
  /bin/sleep 0.01
done
if [ ! -s "$command_pid_file" ]; then
  kill -TERM "$wrapper_pid" 2>/dev/null || true
  echo "heartbeat command pid was not recorded" >&2
  exit 1
fi
command_pid="$(cat "$command_pid_file")"
kill -TERM "$wrapper_pid"
for _ in $(seq 1 50); do
  if ! kill -0 "$command_pid" 2>/dev/null; then
    wait "$wrapper_pid" 2>/dev/null || true
    exit 0
  fi
  /bin/sleep 0.01
done
kill -TERM "$command_pid" 2>/dev/null || true
kill -TERM "$wrapper_pid" 2>/dev/null || true
echo "heartbeat command still alive after wrapper termination: $command_pid" >&2
exit 1
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

  local cidfile=""
  local expect_cidfile=0
  local arg
  for arg in "$@"; do
    if [[ "$expect_cidfile" == "1" ]]; then
      cidfile="$arg"
      expect_cidfile=0
      continue
    fi
    if [[ "$arg" == "--cidfile" ]]; then
      expect_cidfile=1
    fi
  done

  test -n "$cidfile"
  printf "container-term\\n" >"$cidfile"
  printf "started\\n" >"$TMPDIR/docker-started"
  printf "docker running\\n"
  trap 'exit 143' TERM
  while true; do /bin/sleep 0.05; done
}
export -f docker

(
  docker_e2e_run_logged_print_with_harness plugins-run image-name bash -lc true
) &
wrapper_pid="$!"
for _ in $(seq 1 50); do
  [ -s "$TMPDIR/docker-started" ] && break
  /bin/sleep 0.01
  kill -0 "$wrapper_pid" 2>/dev/null || true
done
test -s "$TMPDIR/docker-started"
kill -TERM "$wrapper_pid" 2>/dev/null || true
wait "$wrapper_pid" 2>/dev/null || true
for _ in $(seq 1 50); do
  grep -qx "container-term" "$TMPDIR/docker-rm-seen" 2>/dev/null && break
  /bin/sleep 0.01
done
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
  ])("$title", ({ tempPrefix, scriptSource }) => {
    const workDir = tempDirs.make(tempPrefix);
    const script = scriptSource(workDir);

    execDockerSnippet(script);
  });

  it("derives the browser CDP image from the shared functional image", () => {
    const workDir = tempDirs.make("openclaw-browser-cdp-shared-image-");
    writeExecutables(join(workDir, "bin"), {
      docker: `#!/usr/bin/env bash
printf "%s\\n" "$*" >>"$TMPDIR/docker-seen"
case "$1 $2" in
  "image inspect")
    exit 0
    ;;
  "inspect -f")
    printf "true\\n"
    exit 0
    ;;
  "rm -f")
    exit 0
    ;;
  "run "*)
    printf "container-id\\n"
    exit 0
    ;;
  "exec "*)
    exit 0
    ;;
  "logs --tail")
    printf "Disabled Playwright AI snapshot chunk: pw-ai-optional.js\\n"
    exit 0
    ;;
esac
case "$1" in
  build)
    exit 0
    ;;
esac
exit 9
`,
      node: `#!/usr/bin/env bash
printf "echo state\\n"
`,
      timeout: `#!/usr/bin/env bash
case "\${1:-}" in
  --kill-after=1s | --kill-after=30s)
    shift 2
    ;;
  *)
    shift
    ;;
esac
exec "$@"
`,
    });

    const script = repoRootShell`
TMPDIR=${shellQuote(workDir)}
export ROOT_DIR TMPDIR
export PATH="$TMPDIR/bin:$PATH"
export OPENCLAW_SKIP_DOCKER_BUILD=1
export OPENCLAW_DOCKER_E2E_IMAGE=shared-functional
export OPENCLAW_DOCKER_ALL_LANE_NAME=browser-cdp-snapshot

bash "$ROOT_DIR/scripts/e2e/browser-cdp-snapshot-docker.sh"

grep -q '^image inspect shared-functional$' "$TMPDIR/docker-seen"
grep -Fq 'build --progress=plain --build-arg GITHUB_ACTIONS -t openclaw-browser-cdp-snapshot-e2e:browser-cdp-snapshot' "$TMPDIR/docker-seen"
grep -Fq ' openclaw-browser-cdp-snapshot-e2e:browser-cdp-snapshot ' "$TMPDIR/docker-seen"
if grep -Fq ' shared-functional ' "$TMPDIR/docker-seen"; then
  echo "browser CDP lane reused the shared image without Chromium" >&2
  exit 1
fi
`;

    expect(execDockerSnippet(script)).toContain(
      "Disabled Playwright AI snapshot chunk: pw-ai-optional.js",
    );
  });

  it("fails fast on invalid browser CDP snapshot byte limits", () => {
    const result = spawnSync("bash", [BROWSER_CDP_SNAPSHOT_DOCKER_E2E_PATH], {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_BROWSER_CDP_SNAPSHOT_MAX_BYTES: "64kb",
        OPENCLAW_SKIP_DOCKER_BUILD: "1",
      },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("invalid OPENCLAW_BROWSER_CDP_SNAPSHOT_MAX_BYTES: 64kb");
  });

  it("forwards browser CDP snapshot byte limits into the Docker runner", () => {
    const runner = readFileSync(BROWSER_CDP_SNAPSHOT_DOCKER_E2E_PATH, "utf8");
    expect(runner).toContain(
      "docker_e2e_read_positive_int_env OPENCLAW_BROWSER_CDP_SNAPSHOT_MAX_BYTES 524288",
    );
    expect(runner).toContain('-e "OPENCLAW_BROWSER_CDP_SNAPSHOT_MAX_BYTES=$SNAPSHOT_MAX_BYTES"');
  });

  it("uses Playwright Chromium for the browser CDP snapshot image", () => {
    const runner = readFileSync(BROWSER_CDP_SNAPSHOT_DOCKER_E2E_PATH, "utf8");
    expect(runner).toContain("ENV PLAYWRIGHT_BROWSERS_PATH=/home/appuser/.cache/ms-playwright");
    expect(runner).toContain("playwright-core/cli.js install --with-deps chromium");
    expect(runner).not.toContain("apt-get install -y --no-install-recommends chromium");
  });

  it("opens the browser CDP fixture before snapshotting", () => {
    const runner = readFileSync(BROWSER_CDP_SNAPSHOT_DOCKER_E2E_PATH, "utf8");
    const quarantineIndex = runner.indexOf(
      "quarantine_browser_cdp_pw_ai_chunks dist /tmp/openclaw-browser-cdp",
    );
    const configIndex = runner.indexOf("node scripts/e2e/lib/fixture.mjs browser-cdp");
    const openIndex = runner.indexOf(
      'browser \\"\\${base_args[@]}\\" --browser-profile docker-cdp open',
    );
    const doctorIndex = runner.indexOf(
      'browser \\"\\${base_args[@]}\\" --browser-profile docker-cdp doctor --deep',
    );
    const snapshotIndex = runner.indexOf(
      'browser \\"\\${base_args[@]}\\" --browser-profile docker-cdp snapshot --interactive',
    );

    expect(quarantineIndex).toBeGreaterThan(-1);
    expect(configIndex).toBeGreaterThan(-1);
    expect(configIndex).toBeGreaterThan(quarantineIndex);
    expect(openIndex).toBeGreaterThan(-1);
    expect(openIndex).toBeGreaterThan(configIndex);
    expect(doctorIndex).toBeGreaterThan(openIndex);
    expect(snapshotIndex).toBeGreaterThan(doctorIndex);
    expect(runner).toContain(">/tmp/browser-cdp-doctor.txt 2>&1 || true");
    expect(runner).toContain("failed to disable Playwright AI snapshot chunk");
  });

  it("fails Docker commands fast when timeout is unavailable", () => {
    const workDir = tempDirs.make("openclaw-docker-timeout-required-");
    mkdirSync(join(workDir, "bin"));
    const script = repoShell(workDir)`
export PATH="$TMPDIR/bin"
export DOCKER_COMMAND_TIMEOUT=7s

docker() {
  printf "%s\\n" "$*" >"$TMPDIR/docker-seen"
}
export -f docker

source "$ROOT_DIR/scripts/lib/docker-e2e-container.sh"

set +e
docker_e2e_docker_cmd ps 2>"$TMPDIR/stderr"
status="$?"
set -e

stderr="$(<"$TMPDIR/stderr")"
[[ "$status" = "127" ]]
[[ "$stderr" = *"timeout command not found; cannot bound Docker command after 7s"* ]]
[[ ! -e "$TMPDIR/docker-seen" ]]
`;

    execDockerSnippet(script);
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
    it(`escalates Docker watchdog children that ignore parent SIG${shellSignal}`, () => {
      const workDir = tempDirs.make("openclaw-docker-node-signal-");
      writeExecutables(join(workDir, "bin"), {
        node: `#!/bin/bash\nexec ${shellQuote(process.execPath)} "$@"\n`,
        docker: `#!/bin/bash
trap "" TERM HUP
printf "%s\\n" "$$" >"$TMPDIR/docker-pid"
printf "%s\\n" "$PPID" >"$TMPDIR/watchdog-pid"
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

docker_e2e_docker_cmd run demo &
watchdog_pid="$!"
for ((i = 0; i < 100; i += 1)); do
  [ -s "$TMPDIR/docker-pid" ] && [ -s "$TMPDIR/watchdog-pid" ] && break
  /bin/sleep 0.02
done
[ -s "$TMPDIR/docker-pid" ]
[ -s "$TMPDIR/watchdog-pid" ]
kill -${shellSignal} "$(/bin/cat "$TMPDIR/watchdog-pid")"
set +e
wait "$watchdog_pid"
status="$?"
set -e
[ "$status" = "${expectedStatus}" ]
docker_pid="$(/bin/cat "$TMPDIR/docker-pid")"
for ((i = 0; i < 100; i += 1)); do
  kill -0 "$docker_pid" 2>/dev/null || exit 0
  /bin/sleep 0.02
done
echo "docker child still alive after watchdog termination" >&2
exit 1
`;

      execDockerSnippet(script);
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

  it("passes plugin lifecycle sampler timeout overrides into Docker", () => {
    const runner = readFileSync(PLUGIN_LIFECYCLE_MATRIX_DOCKER_E2E_PATH, "utf8");
    expectTextToIncludeAll(runner, [
      "append_positive_int_env()",
      "append_positive_number_env()",
      "append_positive_int_env OPENCLAW_PLUGIN_LIFECYCLE_PHASE_TIMEOUT_MS",
      "append_positive_int_env OPENCLAW_PLUGIN_LIFECYCLE_TIMEOUT_KILL_GRACE_MS",
      "append_positive_int_env OPENCLAW_PLUGIN_LIFECYCLE_METRIC_POLL_MS",
      "append_positive_int_env OPENCLAW_PLUGIN_LIFECYCLE_MAX_RSS_KB",
      "append_positive_int_env OPENCLAW_PLUGIN_LIFECYCLE_MAX_WALL_MS",
      "append_positive_number_env OPENCLAW_PLUGIN_LIFECYCLE_MAX_CPU_CORE_RATIO",
      'docker_e2e_run_with_harness \\\n  "${DOCKER_ENV_ARGS[@]}"',
    ]);
  });

  it.each([
    ["phase timeout", "OPENCLAW_PLUGIN_LIFECYCLE_PHASE_TIMEOUT_MS", "150ms"],
    ["CPU ratio", "OPENCLAW_PLUGIN_LIFECYCLE_MAX_CPU_CORE_RATIO", "0"],
  ])(
    "rejects invalid plugin lifecycle Docker %s overrides before package setup",
    (_label, envName, value) => {
      const stderr = expectInvalidDockerEnv(
        PLUGIN_LIFECYCLE_MATRIX_DOCKER_E2E_PATH,
        envName,
        value,
        { OPENCLAW_CURRENT_PACKAGE_TGZ: "/tmp/openclaw-missing-package.tgz" },
      );
      expect(stderr).not.toContain("OpenClaw package tarball does not exist");
    },
  );

  it("wraps direct Docker E2E npm installs with the shared timeout helper", () => {
    const multiNode = readFileSync(MULTI_NODE_UPDATE_DOCKER_E2E_PATH, "utf8");
    const updateChannel = readFileSync(UPDATE_CHANNEL_SWITCH_DOCKER_E2E_PATH, "utf8");
    const doctorSwitch = readFileSync(DOCTOR_SWITCH_SCENARIO_PATH, "utf8");
    const releaseUpgrade = readFileSync(RELEASE_UPGRADE_USER_JOURNEY_SCENARIO_PATH, "utf8");
    const upgradeSurvivor = readFileSync(UPGRADE_SURVIVOR_RUN_SCRIPT, "utf8");
    const pluginCorrupt = readFileSync(PLUGIN_UPDATE_CORRUPT_SCENARIO_PATH, "utf8");

    expect(multiNode).toContain(
      'openclaw_e2e_install_package "$ARTIFACTS/install-a.log" "OpenClaw package under node-A prefix" "$NPM_PREFIX_A"',
    );
    expectTextToIncludeAll(updateChannel, [
      'openclaw_e2e_maybe_timeout "${OPENCLAW_E2E_NPM_INSTALL_TIMEOUT:-600s}" npm install --omit=dev --no-fund --no-audit',
      'openclaw_e2e_maybe_timeout "${OPENCLAW_E2E_NPM_INSTALL_TIMEOUT:-600s}" npm install -g --prefix /tmp/npm-prefix --omit=optional "$pkg_tgz_path"',
      "openclaw_e2e_print_log /tmp/openclaw-git-install.log",
      'openclaw_e2e_print_log "$package_install_log"',
    ]);

    expect(updateChannel).not.toContain("cat /tmp/openclaw-git-install.log");
    expect(updateChannel).not.toContain('cat "$package_install_log"');
    expectTextToIncludeAll(doctorSwitch, [
      'openclaw_e2e_maybe_timeout "${OPENCLAW_E2E_NPM_INSTALL_TIMEOUT:-600s}" npm install --omit=dev --no-fund --no-audit',
      'openclaw_e2e_maybe_timeout "${OPENCLAW_E2E_NPM_INSTALL_TIMEOUT:-600s}" npm install -g --prefix /tmp/npm-prefix --omit=optional "$package_tgz"',
      "openclaw_e2e_print_log /tmp/openclaw-git-install.log",
    ]);
    for (const script of [releaseUpgrade, upgradeSurvivor, pluginCorrupt]) {
      expect(script).toContain(
        'openclaw_e2e_maybe_timeout "${OPENCLAW_E2E_NPM_INSTALL_TIMEOUT:-600s}" npm install -g',
      );
    }
  });

  it("keeps upgrade survivor mutable state off the host-mounted artifact tree", () => {
    const runner = readFileSync(UPGRADE_SURVIVOR_DOCKER_E2E_PATH, "utf8");
    const publishedRunner = readFileSync(UPGRADE_SURVIVOR_RUN_SCRIPT, "utf8");
    expect(readFileSync(UPGRADE_SURVIVOR_PATHS_HELPER, "utf8")).toContain(
      "openclaw-upgrade-survivor-runtime",
    );

    for (const script of [runner, publishedRunner]) {
      expectTextToIncludeAll(script, [
        "OPENCLAW_UPGRADE_SURVIVOR_TMPDIR",
        "OPENCLAW_UPGRADE_SURVIVOR_TEST_STATE_TMPDIR",
        'export npm_config_cache="${OPENCLAW_UPGRADE_SURVIVOR_NPM_CACHE:-$OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT/npm-cache}"',
        'export NPM_CONFIG_CACHE="$npm_config_cache"',
        'chmod 700 "$npm_config_cache" || true',
      ]);

      expect(script).not.toContain('export TMPDIR="$ARTIFACT_ROOT/tmp"');
      expect(script).not.toContain('export TMPDIR="$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/tmp"');
      expect(script).not.toContain('export npm_config_cache="$ARTIFACT_ROOT/npm-cache"');
      expect(script).not.toContain(
        'export npm_config_cache="$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/npm-cache"',
      );
    }
  });

  it("starts the upgrade survivor plugin registry before updates with scenario-owned config", () => {
    const runner = readFileSync(UPGRADE_SURVIVOR_DOCKER_E2E_PATH, "utf8");
    const publishedRunner = readFileSync(UPGRADE_SURVIVOR_RUN_SCRIPT, "utf8");

    const runnerPluginRegistryIndex = runner.indexOf("\nconfigure_plugin_registry\n");
    const runnerCompanionInstallIndex = runner.indexOf("\ninstall_companion_plugins\n");
    const runnerUpdateIndex = runner.indexOf(
      '\necho "Running package update against the mounted tarball..."\n',
    );
    expect(runnerPluginRegistryIndex).toBeLessThan(runnerCompanionInstallIndex);
    expect(runnerCompanionInstallIndex).toBeLessThan(runnerUpdateIndex);
    expect(
      publishedRunner.indexOf("phase configure-plugin-registry configure_plugin_registry"),
    ).toBeLessThan(publishedRunner.indexOf("phase update-candidate update_candidate"));
    const runnerClawHubIndex = runner.indexOf("\nconfigure_clawhub_fixture\n");
    const runnerPrepareIndex = runner.indexOf(
      'prepare_update_restart_probe_current_install "$PORT" "$GATEWAY_LOG"',
    );
    expect(runnerClawHubIndex).toBeGreaterThan(-1);
    expect(runnerClawHubIndex).toBeLessThan(runnerPluginRegistryIndex);
    expect(runnerPluginRegistryIndex).toBeLessThan(runnerCompanionInstallIndex);
    expect(runnerCompanionInstallIndex).toBeLessThan(runnerPrepareIndex);
    expect(runnerPrepareIndex).toBeLessThan(runnerUpdateIndex);
    const publishedClawHubIndex = publishedRunner.indexOf(
      "phase configure-clawhub-fixture configure_clawhub_fixture",
    );
    const publishedPrepareIndex = publishedRunner.indexOf(
      "phase prepare-update-restart-probe prepare_update_restart_probe",
    );
    const publishedPluginRegistryIndex = publishedRunner.indexOf(
      "phase configure-plugin-registry configure_plugin_registry",
    );
    expect(publishedClawHubIndex).toBeGreaterThan(-1);
    expect(publishedClawHubIndex).toBeLessThan(publishedPrepareIndex);
    expect(publishedPrepareIndex).toBeLessThan(publishedPluginRegistryIndex);
    expect(publishedPluginRegistryIndex).toBeLessThan(
      publishedRunner.indexOf("phase update-candidate update_candidate"),
    );
    expect(publishedRunner).toContain(
      [
        'if [ "$SCENARIO" = "configured-plugin-installs" ] || [ "$SCENARIO" = "sqlite-volume" ]; then',
        '  export MATRIX_ACCESS_TOKEN="upgrade-survivor-matrix-token"',
        '  export BRAVE_API_KEY="BSA_upgrade_survivor_brave_key"',
        "fi",
      ].join("\n"),
    );
    expect(runner).toContain(
      [
        'if [ "$SCENARIO" = "configured-plugin-installs" ] || [ "$SCENARIO" = "sqlite-volume" ]; then',
        '  export BRAVE_API_KEY="BSA_upgrade_survivor_brave_key"',
        "fi",
      ].join("\n"),
    );
    expect(publishedRunner).not.toContain(
      '\nexport MATRIX_ACCESS_TOKEN="upgrade-survivor-matrix-token"\n',
    );
    expect(publishedRunner).not.toContain(
      '\nexport BRAVE_API_KEY="BSA_upgrade_survivor_brave_key"\n',
    );
    expect(runner).not.toContain('\nexport BRAVE_API_KEY="BSA_upgrade_survivor_brave_key"\n');
  });

  it("keeps upgrade survivor wrappers and the embedded payload valid bash", () => {
    for (const path of [UPGRADE_SURVIVOR_DOCKER_E2E_PATH, UPGRADE_SURVIVOR_RUN_SCRIPT]) {
      const result = spawnSync("bash", ["-n", path], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
    }
    const wrapper = readFileSync(UPGRADE_SURVIVOR_DOCKER_E2E_PATH, "utf8");
    const inner = spawnSync("bash", ["-n"], {
      input: extractUpgradeSurvivorPayload(wrapper),
      encoding: "utf8",
    });
    expect(inner.status, inner.stderr).toBe(0);
  });

  it("wraps package-backed scenario OpenClaw CLI calls with the shared timeout helper", () => {
    const paths = [
      CODEX_ON_DEMAND_DOCKER_E2E_PATH,
      CODEX_MEDIA_PATH_SCENARIO_PATH,
      CODEX_NPM_PLUGIN_LIVE_DOCKER_E2E_PATH,
      LIVE_PLUGIN_TOOL_DOCKER_E2E_PATH,
      NPM_ONBOARD_CHANNEL_AGENT_DOCKER_E2E_PATH,
      UPDATE_CHANNEL_SWITCH_DOCKER_E2E_PATH,
      RELEASE_UPGRADE_USER_JOURNEY_SCENARIO_PATH,
      "scripts/e2e/lib/release-media-memory/scenario.sh",
      "scripts/e2e/lib/release-plugin-marketplace/scenario.sh",
      "scripts/e2e/lib/release-typed-onboarding/scenario.sh",
      "scripts/e2e/lib/release-user-journey/scenario.sh",
    ];

    for (const path of paths) {
      const script = readFileSync(path, "utf8");

      expect(script, path).toContain("openclaw_e2e_enable_openclaw_cli_timeout");
    }
    expect(readFileSync(RELEASE_UPGRADE_USER_JOURNEY_SCENARIO_PATH, "utf8")).toContain(
      'openclaw_e2e_run_command node "$baseline_entry" onboard',
    );
  });

  it("preserves actionable, secret-safe typed onboarding failure diagnostics", () => {
    const script = readFileSync(RELEASE_TYPED_ONBOARDING_SCENARIO_PATH, "utf8");
    expect(script).toContain("set -Eeuo pipefail");
    expect(script).toContain("{ exec 3>&-; } 2>/dev/null || true");
    expect(script).toContain("--suppress-gateway-token-output");
    expect(script).not.toContain("exec 3>&- 2>/dev/null || true");
    expect(script).not.toContain('"$HOME/.openclaw/agents/main/agent/auth-profiles.json"');
  });

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

  it("prints channel-add failures through the shared E2E logger", () => {
    const script = readFileSync(NPM_ONBOARD_CHANNEL_AGENT_DOCKER_E2E_PATH, "utf8");
    expect(script).toContain(
      'openclaw_e2e_run_logged channel-add "$OPENCLAW_E2E_CLI_BIN" channels add --channel "$CHANNEL" "${CHANNEL_ADD_ARGS[@]}"',
    );
    expect(script).not.toContain("/tmp/openclaw-channel-add.log");
  });

  it("keeps append-only mock E2E state under per-run scratch roots", () => {
    const scripts: [string, string][] = [
      [RELEASE_TYPED_ONBOARDING_SCENARIO_PATH, "release-typed-onboarding"],
      [RELEASE_USER_JOURNEY_SCENARIO_PATH, "release-user-journey"],
      [RELEASE_UPGRADE_USER_JOURNEY_SCENARIO_PATH, "release-upgrade-user-journey"],
      [NPM_ONBOARD_CHANNEL_AGENT_DOCKER_E2E_PATH, "npm-onboard-channel-agent"],
    ];
    for (const [path, label] of scripts) {
      const script = readFileSync(path, "utf8");
      expect(script, path).toContain(
        'scenario_tmp="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-' + label + '.XXXXXX")"',
      );
      expect(script, path).toContain('rm -rf "$scenario_tmp"');
      expect(script, path).toContain(
        'MOCK_REQUEST_LOG="$scenario_tmp/' +
          (label === "npm-onboard-channel-agent"
            ? "mock-openai-requests.jsonl"
            : "openai-requests.jsonl") +
          '"',
      );
      if (label !== "npm-onboard-channel-agent") {
        expect(script, path).toContain('LOG_DIR="$scenario_tmp/logs"');
      }
      if (label === "release-user-journey" || label === "release-upgrade-user-journey") {
        expect(script, path).toContain('CLICKCLACK_STATE="$scenario_tmp/clickclack.json"');
      }
      expect(script, path).not.toMatch(/\/tmp\/openclaw-release-[\w-]+\.(?:log|json|err|txt)/u);
      expect(script, path).not.toContain("/tmp/openclaw-mock-openai-requests.jsonl");
    }
  });

  it("kills timed Docker scenario runners after the grace period", () => {
    const multiNode = readFileSync(MULTI_NODE_UPDATE_DOCKER_E2E_PATH, "utf8");
    const upgradeSurvivor = readFileSync(UPGRADE_SURVIVOR_DOCKER_E2E_PATH, "utf8");

    expect(multiNode).toContain('timeout --kill-after=30s "$DOCKER_RUN_TIMEOUT" bash -lc');
    expect(upgradeSurvivor).toContain(
      'ROOT_DIR="$(cd "${OPENCLAW_DOCKER_E2E_REPO_ROOT:-$HARNESS_ROOT_DIR}" && pwd)"',
    );
    expect(upgradeSurvivor).toContain('DOCKER_E2E_HARNESS_ROOT_DIR="$HARNESS_ROOT_DIR"');
    expect(upgradeSurvivor).toContain(
      '-v "$UPGRADE_RUNNER:/tmp/openclaw-upgrade-survivor-run.sh:ro"',
    );
    expect(upgradeSurvivor).toContain(
      'timeout --kill-after=30s "$DOCKER_RUN_TIMEOUT" bash /tmp/openclaw-upgrade-survivor-run.sh',
    );
    expect(upgradeSurvivor).toContain('timeout --kill-after=30s "$DOCKER_RUN_TIMEOUT" bash -lc');
    for (const script of [multiNode, upgradeSurvivor]) {
      expect(script).not.toContain('timeout "$DOCKER_RUN_TIMEOUT"');
    }
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

  it("records an interrupted upgrade survivor phase as failed", async () => {
    const workDir = tempDirs.make("openclaw-upgrade-survivor-signal-");
    const binDir = join(workDir, "bin");
    const markerPath = join(workDir, "npm-started");
    const summaryPath = join(workDir, "artifacts", "summary.json");
    writeExecutables(binDir, {
      npm: `#!/bin/sh
touch "$FAKE_NPM_MARKER"
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
    const exitPromise = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });

    try {
      for (let attempt = 0; attempt < 500 && !existsSync(markerPath); attempt += 1) {
        await delay(10);
      }
      expect(existsSync(markerPath)).toBe(true);
      process.kill(-childPid, "SIGTERM");
      const exit = await exitPromise;

      expect(exit).toEqual({ code: 143, signal: null });
      const diagnostics = JSON.parse(
        readFileSync(join(workDir, "artifacts", "diagnostics", "raw.json"), "utf8"),
      );
      expect(diagnostics).toMatchObject({
        phase: "install-baseline",
        exitStatus: 143,
        signal: "SIGTERM",
      });
      const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
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
    }
  });

  it("keeps multi-node update Docker artifacts isolated by default", () => {
    const multiNode = readFileSync(MULTI_NODE_UPDATE_DOCKER_E2E_PATH, "utf8");
    expect(multiNode).toContain(
      'RUN_ID="${OPENCLAW_MULTI_NODE_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"',
    );
    expect(multiNode).toContain(
      'ARTIFACT_DIR="${OPENCLAW_MULTI_NODE_ARTIFACT_DIR:-$ROOT_DIR/.artifacts/multi-node-update/$RUN_ID}"',
    );
    expect(multiNode).toContain('-v "$ARTIFACT_DIR:/tmp/artifacts"');
    expect(multiNode).not.toContain(
      'ARTIFACT_DIR="${OPENCLAW_MULTI_NODE_ARTIFACT_DIR:-$ROOT_DIR/.artifacts/multi-node-update}"',
    );
  });

  it("reuses the shared bare image for multi-node update targeted runs", () => {
    const workDir = tempDirs.make("openclaw-multi-node-shared-image-");
    writeFileSync(join(workDir, "openclaw-current.tgz"), "fake package");
    writeExecutables(join(workDir, "bin"), {
      docker: `#!/usr/bin/env bash
printf "%s\\n" "$*" >>"$TMPDIR/docker-seen"
case "$1 $2" in
  "image inspect")
    exit 0
    ;;
  "run "*)
    exit 0
    ;;
esac
exit 9
`,
      timeout: `#!/usr/bin/env bash
case "\${1:-}" in
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
exec "$@"
`,
    });

    const script = repoRootShell`
TMPDIR=${shellQuote(workDir)}
export ROOT_DIR TMPDIR
export PATH="$TMPDIR/bin:$PATH"
export OPENCLAW_SKIP_DOCKER_BUILD=1
export OPENCLAW_DOCKER_E2E_IMAGE=shared-bare
export OPENCLAW_CURRENT_PACKAGE_TGZ="$TMPDIR/openclaw-current.tgz"
export OPENCLAW_MULTI_NODE_ARTIFACT_DIR="$TMPDIR/artifacts"

bash "$ROOT_DIR/scripts/e2e/multi-node-update-docker.sh"

grep -q '^image inspect shared-bare$' "$TMPDIR/docker-seen"
grep -Fq ' shared-bare ' "$TMPDIR/docker-seen"
if grep -Fq 'openclaw-multi-node-update-e2e' "$TMPDIR/docker-seen"; then
  echo "multi-node update lane ignored the shared targeted image" >&2
  exit 1
fi
`;

    execDockerSnippet(script);
  });

  it("bounds upgrade survivor foreground OpenClaw CLI calls", () => {
    const runner = readFileSync(UPGRADE_SURVIVOR_DOCKER_E2E_PATH, "utf8");
    const publishedRunner = readFileSync(UPGRADE_SURVIVOR_RUN_SCRIPT, "utf8");
    const updateRestartAuth = readFileSync(UPGRADE_SURVIVOR_UPDATE_RESTART_AUTH_PATH, "utf8");

    expectTextToIncludeAll(runner, [
      'source "$HARNESS_ROOT_DIR/scripts/lib/openclaw-e2e-instance.sh"',
      'START_BUDGET_SECONDS="$(openclaw_e2e_read_positive_int_env OPENCLAW_UPGRADE_SURVIVOR_START_BUDGET_SECONDS 300)"',
      'STATUS_BUDGET_SECONDS="$(openclaw_e2e_read_positive_int_env OPENCLAW_UPGRADE_SURVIVOR_STATUS_BUDGET_SECONDS 30)"',
      '-e OPENCLAW_UPGRADE_SURVIVOR_START_BUDGET_SECONDS="$START_BUDGET_SECONDS"',
      '-e OPENCLAW_UPGRADE_SURVIVOR_STATUS_BUDGET_SECONDS="$STATUS_BUDGET_SECONDS"',
      'START_BUDGET="$(openclaw_e2e_read_positive_int_env OPENCLAW_UPGRADE_SURVIVOR_START_BUDGET_SECONDS 300)"',
      'STATUS_BUDGET="$(openclaw_e2e_read_positive_int_env OPENCLAW_UPGRADE_SURVIVOR_STATUS_BUDGET_SECONDS 30)"',
      'COMMAND_TIMEOUT="${OPENCLAW_UPGRADE_SURVIVOR_COMMAND_TIMEOUT:-900s}"',
      '-e OPENCLAW_UPGRADE_SURVIVOR_COMMAND_TIMEOUT="$COMMAND_TIMEOUT"',
      'command_timeout="${OPENCLAW_UPGRADE_SURVIVOR_COMMAND_TIMEOUT:-900s}"',
      'openclaw_e2e_maybe_timeout "$command_timeout" env -u OPENCLAW_GATEWAY_TOKEN',
      'openclaw_e2e_maybe_timeout "$command_timeout" openclaw doctor --fix --non-interactive',
      'openclaw_e2e_maybe_timeout "$command_timeout" openclaw config validate',
      'openclaw_e2e_maybe_timeout "$command_timeout" openclaw gateway status',
      'openclaw gateway --port "$PORT" --bind loopback --allow-unconfigured',
      'PROBE_TIMEOUT_MS="$(openclaw_e2e_read_nonnegative_int_env OPENCLAW_UPGRADE_SURVIVOR_PROBE_TIMEOUT_MS 60000)"',
      "openclaw_e2e_read_positive_int_env OPENCLAW_UPGRADE_SURVIVOR_PROBE_ATTEMPT_TIMEOUT_MS 5000",
      "openclaw_e2e_read_positive_int_env OPENCLAW_UPGRADE_SURVIVOR_PROBE_MAX_BODY_BYTES 1048576",
      '-e OPENCLAW_UPGRADE_SURVIVOR_PROBE_TIMEOUT_MS="$PROBE_TIMEOUT_MS"',
      '-e OPENCLAW_UPGRADE_SURVIVOR_PROBE_ATTEMPT_TIMEOUT_MS="$PROBE_ATTEMPT_TIMEOUT_MS"',
      '-e OPENCLAW_UPGRADE_SURVIVOR_PROBE_MAX_BODY_BYTES="$PROBE_MAX_BODY_BYTES"',
      "readyz_probe_args=(",
      'readyz_probe_args+=(--allow-failing "$OPENCLAW_UPGRADE_SURVIVOR_READYZ_ALLOW_FAILING")',
      "readyz_probe_args+=(--allow-degraded-ready)",
      'node scripts/e2e/lib/upgrade-survivor/probe-gateway.mjs "${readyz_probe_args[@]}"',
      "OPENCLAW_UPGRADE_SURVIVOR_READYZ_ALLOW_FAILING",
      "OPENCLAW_UPGRADE_SURVIVOR_READYZ_ALLOW_DEGRADED",
    ]);

    expect(publishedRunner).toContain(
      'COMMAND_TIMEOUT="${OPENCLAW_UPGRADE_SURVIVOR_COMMAND_TIMEOUT:-900s}"',
    );
    expect(publishedRunner).toContain(
      'budget="$(openclaw_e2e_read_positive_int_env OPENCLAW_UPGRADE_SURVIVOR_START_BUDGET_SECONDS 300)"',
    );
    expect(publishedRunner).toContain(
      'budget="$(openclaw_e2e_read_positive_int_env OPENCLAW_UPGRADE_SURVIVOR_STATUS_BUDGET_SECONDS 30)"',
    );
    expect(publishedRunner).toContain(
      'openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" openclaw --version',
    );
    expect(publishedRunner).toContain(
      'openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" openclaw config validate >"$BASELINE_CONFIG_VALIDATE_LOG"',
    );
    expect(publishedRunner).toContain(
      'openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" "${update_env[@]}" openclaw',
    );
    expect(publishedRunner).toContain(
      'openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" "${root_cli_env[@]}" openclaw',
    );
    expect(publishedRunner).toContain(
      'openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" openclaw update repair',
    );
    expect(publishedRunner).toContain("--accept-capabilities --yes --no-restart --json");
    expect(publishedRunner).toContain(
      'openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" openclaw config validate',
    );
    expect(publishedRunner).toContain(
      'openclaw_e2e_maybe_timeout "$COMMAND_TIMEOUT" openclaw gateway status',
    );
    expect(publishedRunner).toContain('openclaw gateway --port "$port" --bind loopback');

    expect(updateRestartAuth).toContain(
      'command_timeout="${OPENCLAW_UPGRADE_SURVIVOR_COMMAND_TIMEOUT:-900s}"',
    );
    expectTextToIncludeAll(updateRestartAuth, [
      "command=(env -u OPENCLAW_GATEWAY_TOKEN -u OPENCLAW_GATEWAY_PASSWORD openclaw gateway install --force --json)",
      'openclaw_e2e_maybe_timeout "$command_timeout" "${command[@]}"',
    ]);
  });

  it.skipIf(process.platform !== "linux").each(["published", "current"])(
    "starts the %s auth probe under the manager that owns its restart and stop",
    async (lane) => {
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
      writeFileSync(
        childPath,
        `import fs from "node:fs";
import http from "node:http";
const identity = { pid: process.pid, managed: process.env.OPENCLAW_SYSTEMD_UNIT === "openclaw-gateway.service" };
const server = http.createServer((_req, res) => res.end(JSON.stringify(identity)));
const port = fs.existsSync(process.env.PORT_FILE) ? Number(fs.readFileSync(process.env.PORT_FILE, "utf8")) : 0;
server.listen(port, "127.0.0.1", () => {
  fs.writeFileSync(process.env.PORT_FILE, String(server.address().port));
  fs.appendFileSync(process.env.STARTS_FILE, JSON.stringify(identity) + "\\n");
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
  for _ in {1..200}; do [ -s "$PORT_FILE" ] && break; sleep 0.01; done
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
          expect(isProcessRunning(records()[0]!.pid)).toBe(false);
          await expect(fetch(url, { signal: AbortSignal.timeout(1_000) })).rejects.toThrow();
          expect(systemctl("start", "openclaw-gateway.service").status).toBe(0);
          for (let attempt = 0; attempt < 200 && records().length < 2; attempt++) {
            await delay(10);
          }
          expect(records()).toHaveLength(2);
        }
        const initial = (await (
          await fetch(url, { signal: AbortSignal.timeout(1_000) })
        ).json()) as { pid: number; managed: boolean };
        expect(initial.managed).toBe(true);
        expect(systemctl("restart", "openclaw-gateway.service").status).toBe(0);
        const expectedStarts = lane === "published" ? 3 : 2;
        for (let attempt = 0; attempt < 200 && records().length < expectedStarts; attempt++) {
          await delay(10);
        }
        expect(records()).toHaveLength(expectedStarts);
        const replacement = (await (
          await fetch(url, { signal: AbortSignal.timeout(1_000) })
        ).json()) as { pid: number; managed: boolean };
        expect(replacement.managed).toBe(true);
        expect(replacement.pid).not.toBe(initial.pid);
        expect(isProcessRunning(initial.pid)).toBe(false);
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
    60_000,
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
  });

  it("scopes candidate setup Doctor markers without creating legacy device identities", () => {
    const workDir = tempDirs.make("openclaw-upgrade-survivor-doctor-env-");
    writeExecutables(join(workDir, "bin"), {
      openclaw: `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$@" >"$CAPTURE_DIR/doctor-argv"
{
  printf 'OPENCLAW_UPDATE_IN_PROGRESS=%s\\n' "\${OPENCLAW_UPDATE_IN_PROGRESS-unset}"
  printf 'OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR=%s\\n' "\${OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR-unset}"
  printf 'OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE=%s\\n' "\${OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE-unset}"
} >"$CAPTURE_DIR/doctor-env"
exit 23
`,
    });

    const script = repoShell(workDir)`
export PATH="$TMPDIR/bin:$PATH"
export CAPTURE_DIR="$TMPDIR"
export OPENCLAW_STATE_DIR="$TMPDIR/state"
export OPENCLAW_CONFIG_PATH="$OPENCLAW_STATE_DIR/openclaw.json"
export OPENCLAW_UPGRADE_SURVIVOR_CONFIG_PARKING_HELPER="$ROOT_DIR/${UPGRADE_SURVIVOR_CONFIG_PARKING_PATH}"
mkdir -p "$OPENCLAW_STATE_DIR"
printf '%s\n' '{"gateway":{"mode":"local"}}' >"$OPENCLAW_CONFIG_PATH"
unset OPENCLAW_UPDATE_IN_PROGRESS
unset OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR
unset OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE
source "$ROOT_DIR/${OPENCLAW_E2E_INSTANCE_HELPER_PATH}"
source "$ROOT_DIR/${UPGRADE_SURVIVOR_UPDATE_RESTART_AUTH_PATH}"
install_update_restart_systemctl_shim() { :; }
openclaw_e2e_maybe_timeout() {
  shift
  "$@"
}
if prepare_update_restart_probe_current_install 18789 "$TMPDIR/gateway.log" >/dev/null 2>&1; then
  echo "doctor unexpectedly succeeded" >&2
  exit 3
fi
{
  printf 'OPENCLAW_UPDATE_IN_PROGRESS=%s\\n' "\${OPENCLAW_UPDATE_IN_PROGRESS-unset}"
  printf 'OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR=%s\\n' "\${OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR-unset}"
  printf 'OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE=%s\\n' "\${OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE-unset}"
} >"$CAPTURE_DIR/parent-env"
`;

    const result = spawnDockerSnippet(script);

    expect(result.status).toBe(0);
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
    expect(readFileSync(join(workDir, "doctor-env"), "utf8")).toBe(
      [
        "OPENCLAW_UPDATE_IN_PROGRESS=1",
        "OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR=1",
        "OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE=1",
        "",
      ].join("\n"),
    );
    expect(readFileSync(join(workDir, "parent-env"), "utf8")).toBe(
      [
        "OPENCLAW_UPDATE_IN_PROGRESS=unset",
        "OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR=unset",
        "OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE=unset",
        "",
      ].join("\n"),
    );
  });

  it.each([
    ["doctor", 41],
    ["readiness", 42],
    ["service-env", 43],
    ["install", 44],
  ] as const)(
    "restores the canonical authored config after %s failure",
    (failureStage, expectedStatus) => {
      const workDir = tempDirs.make(`openclaw-upgrade-survivor-${failureStage}-failure-`);
      writeExecutables(join(workDir, "bin"), {
        openclaw: `#!/usr/bin/env bash
set -euo pipefail
printf '%s %s\n' "$OPENCLAW_CONFIG_PATH" "$*" >>"$CAPTURE_DIR/openclaw-calls"
if [ "\${1:-}" = doctor ]; then
  [ "$FAILURE_STAGE" != doctor ] || exit 41
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
export FAILURE_STAGE="${failureStage}"
export OPENCLAW_STATE_DIR="$TMPDIR/state"
export OPENCLAW_CONFIG_PATH="$OPENCLAW_STATE_DIR/openclaw.json"
export OPENCLAW_UPGRADE_SURVIVOR_CONFIG_PARKING_HELPER="$ROOT_DIR/${UPGRADE_SURVIVOR_CONFIG_PARKING_PATH}"
export OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE="$TMPDIR/gateway.pid"
export OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_DAEMON_LOG="$TMPDIR/service.log"
export OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SERVICE_INSTALL_JSON="$TMPDIR/install.json"
export OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SERVICE_INSTALL_ERR="$TMPDIR/install.err"
export GATEWAY_AUTH_TOKEN_REF=upgrade-survivor-token
mkdir -p "$OPENCLAW_STATE_DIR"
authored_config='{"channels":{"discord":{"dm":{"policy":"allowlist","allowFrom":["123"]}}}}'
printf '%s\n' "$authored_config" >"$OPENCLAW_CONFIG_PATH"
source "$ROOT_DIR/${OPENCLAW_E2E_INSTANCE_HELPER_PATH}"
source "$ROOT_DIR/${UPGRADE_SURVIVOR_UPDATE_RESTART_AUTH_PATH}"
install_update_restart_systemctl_shim() { :; }
openclaw_e2e_maybe_timeout() {
  shift
  "$@"
}
openclaw_e2e_wait_gateway_ready() {
  [ "$FAILURE_STAGE" != readiness ] || return 42
}
write_update_restart_service_auth_env() {
  [ "$FAILURE_STAGE" != service-env ] || return 43
}
status=0
prepare_update_restart_probe_current_install 18789 "$TMPDIR/gateway.log" >/dev/null 2>&1 || status=$?
printf '%s\n' "$status" >"$CAPTURE_DIR/status"
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
source "$ROOT_DIR/${OPENCLAW_E2E_INSTANCE_HELPER_PATH}"
source "$ROOT_DIR/${UPGRADE_SURVIVOR_UPDATE_RESTART_AUTH_PATH}"
install_update_restart_systemctl_shim() { :; }
openclaw_e2e_maybe_timeout() {
  shift
  "$@"
}
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

  it("keeps upgrade survivor auto-auth success summary set -u safe", () => {
    const runner = readFileSync(UPGRADE_SURVIVOR_DOCKER_E2E_PATH, "utf8");
    const summaryDefaultIndex = runner.indexOf('startup_summary="n/a"');
    const autoAuthIndex = runner.indexOf(
      'if [ "$UPDATE_RESTART_MODE" = "auto-auth" ]; then',
      summaryDefaultIndex,
    );
    const manualSummaryIndex = runner.indexOf('startup_summary="${start_seconds}s"', autoAuthIndex);
    const successIndex = runner.indexOf(
      "startup=${startup_summary} status=${status_seconds}s",
      manualSummaryIndex,
    );

    expect(summaryDefaultIndex).toBeGreaterThan(-1);
    expect(autoAuthIndex).toBeGreaterThan(summaryDefaultIndex);
    expect(manualSummaryIndex).toBeGreaterThan(autoAuthIndex);
    expect(successIndex).toBeGreaterThan(manualSummaryIndex);
  });

  it.skipIf(process.platform === "win32")(
    "stops promptly when the systemctl target is a zombie with spaces and parentheses in comm",
    async () => {
      await forEachUpgradeSurvivorSystemctlShim(({ pid, run, readLog, scriptPath }) => {
        const procTail = Array.from({ length: 49 }, (_, field) => field + 1).join(" ");
        expect(run(`${pid} (gateway (old) worker) Z ${procTail}`, true), scriptPath).toBe(0);
        expect(readLog()).toEqual([
          "--user stop openclaw-gateway.service",
          "proc-stat-read",
          "proc-stat-read",
        ]);
        expect(isProcessRunning(pid)).toBe(true);
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "waits for a killable systemctl target when proc stat is unreadable or malformed",
    async () => {
      await forEachUpgradeSurvivorSystemctlShim(({ pid, pidPath, run, readLog, scriptPath }) => {
        for (const procStat of [undefined, `${pid} (gateway) Z`]) {
          // Reaching the wait sentinel proves the shell did not mistake missing stat data for exit.
          expect(run(procStat), `${scriptPath}: ${procStat ?? "unreadable"}`).toBe(97);
          expect(readLog()).toEqual([
            "--user stop openclaw-gateway.service",
            "proc-stat-read",
            "wait",
          ]);
          expect(isProcessRunning(pid)).toBe(true);
          expect(readFileSync(pidPath, "utf8")).toBe(`${pid}\n`);
        }
      });
    },
  );

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
    for (const [argv, marker, expected] of [
      [["openclaw-update"], "", ["update", "doctor"]],
      [
        ["node", "/package/dist/infra/update-migrated-finalize.worker.js", "--post-core"],
        "OPENCLAW_UPDATE_POST_CORE=1",
        ["update", "doctor"],
      ],
      [
        ["node", "/package/dist/infra/update-migrated-finalize.worker.js", "--post-core"],
        "",
        ["doctor"],
      ],
      [
        ["node", "/package/dist/infra/update-migrated-finalize.worker.js", "--post-core"],
        "EACCES",
        ["doctor"],
      ],
    ] as const) {
      const child = spawnSync(
        testNodeExecPath,
        [
          "--import",
          preload,
          "scripts/e2e/lib/upgrade-survivor/systemd-fixture.mjs",
          "record-caller",
          output,
          "123",
          "restart",
        ],
        {
          env: { ...process.env, CALLER_ARGV: argv.join("|"), CALLER_ENV: marker },
          encoding: "utf8",
        },
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
        status,
        changed: false,
        sync: {
          changed: false,
          switchedToBundled: [],
          switchedToNpm: [],
          warnings: [],
          errors: [],
        },
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
        integrityDrifts: [],
        credentials: "PRIVATE_RESULT_EXTRA",
      };
      writeFileSync(
        join(workDir, "package.json"),
        JSON.stringify({ name: "openclaw", version: "2026.9.7", type: "module" }),
      );
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
      const child = spawnSync(testNodeExecPath, [childPath, command, "--json"], {
        env: { ...env, NODE_OPTIONS: preloadOptions },
        encoding: "utf8",
      });
      expect(child.status, child.stderr).toBe(code);
      expect(child.stdout).toBe("original stdout\n");
      expect(
        JSON.parse(
          readFileSync(join(artifacts, "diagnostics", `process-${child.pid}-started.json`), "utf8"),
        ),
      ).toMatchObject({ role: "post-core", event: "started", packageVersion: "2026.9.7" });
      // The historical parent removes the handoff directory before attempting restart.
      rmSync(resultDir, { recursive: true });
      expect(existsSync(join(artifacts, "diagnostics", "post-core.json"))).toBe(true);
      expect(
        JSON.parse(readFileSync(join(artifacts, "diagnostics", "post-core.json"), "utf8")),
      ).toMatchObject({ artifactRoot: realpathSync(artifacts), childExitCode: code });
      const captured = runSurvivorDiagnostics("capture", artifacts, ["update-candidate", "1"], env);
      expect(captured.status, captured.stderr).toBe(0);
      const uploaded = join(workDir, "public");
      const published = runSurvivorDiagnostics("publish", artifacts, [uploaded], env);
      expect(published.status, published.stderr).toBe(0);
      const text = readFileSync(join(uploaded, "failure.json"), "utf8");
      expect(text).not.toContain("POST_CORE_SECRET");
      expect(text).not.toContain("PRIVATE_RESULT_EXTRA");
      expect(JSON.parse(text).postCore).toMatchObject({
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
      const complete = JSON.stringify({
        status: "error",
        changed: false,
        sync: {
          changed: false,
          switchedToBundled: [],
          switchedToNpm: [],
          warnings: [],
          errors: [],
        },
        npm: { changed: false, outcomes: [] },
        integrityDrifts: [],
      });
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
      const child = spawnSync(
        testNodeExecPath,
        [
          childPath,
          scenario === "delegated-missing-context"
            ? "--post-core"
            : ["doctor", "worker"].includes(scenario)
              ? "doctor"
              : "update",
        ],
        { env: { ...env, NODE_OPTIONS: preloadOptions }, encoding: "utf8" },
      );
      expect(child.status, child.stderr).toBe(78);
      expect(child.signal).toBe(null);
      expect(child.stdout).toBe("");
      expect(existsSync(join(artifacts, "diagnostics", "post-core.json"))).toBe(false);
      if (scenario === "blocked-output") {
        rmSync(join(artifacts, "diagnostics"));
      }
      const capture = runSurvivorDiagnostics("capture", artifacts, ["update-candidate", "1"], env);
      expect(capture.status, capture.stderr).toBe(0);
      const published = runSurvivorDiagnostics(
        "publish",
        artifacts,
        [join(workDir, "public")],
        env,
      );
      expect(published.status, published.stderr).toBe(0);
      const report = JSON.parse(readFileSync(join(workDir, "public", "failure.json"), "utf8"));
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
      const snapshot = JSON.parse(
        readFileSync(join(observationRoot, "diagnostics", "post-core.json"), "utf8"),
      );
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
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          name: "@example/plugin",
          version: "1.0.0",
          credentials: "PRIVATE_PACKAGE_FIELD",
        }),
      );
      writeFileSync(
        join(root, "openclaw.plugin.json"),
        JSON.stringify({
          id: "example",
          version: "1.0.0",
          configSchema: { secret: "PRIVATE_MANIFEST_FIELD" },
        }),
      );
      writeFileSync(
        join(state, "openclaw.json"),
        JSON.stringify({
          credentials: "PRIVATE_CONFIG_FIELD",
          plugins: { installs: { secret: "PRIVATE_CONFIG_RECORD" } },
        }),
      );
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
        writeFileSync(join(state, "plugins", "installs.json"), JSON.stringify(index));
      }
      const stateFiles = () =>
        readdirSync(state, { recursive: true, withFileTypes: true })
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
      const published = runSurvivorDiagnostics("publish", artifacts, [join(workDir, "public")]);
      expect(published.status, published.stderr).toBe(0);
      const text = readFileSync(join(workDir, "public", "failure.json"), "utf8");
      expect(text).not.toContain("PRIVATE_");
      const report = JSON.parse(text);
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
    writeFileSync(
      indexPath,
      JSON.stringify({
        installRecords: {},
        plugins: Array.from({ length: scenario === "index-cap" ? 129 : 1 }, () => ({
          pluginId: "example",
          rootDir: root,
          doctorContractHash: "a".repeat(64),
        })),
      }),
    );
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
    const captured = runSurvivorDiagnostics("capture", artifacts, ["update-candidate", "1"], {
      ...env,
      OPENCLAW_STATE_DIR: state,
    });
    expect(captured.status, captured.stderr).toBe(0);
    const published = runSurvivorDiagnostics("publish", artifacts, [join(workDir, "public")]);
    expect(published.status, published.stderr).toBe(0);
    const text = readFileSync(join(workDir, "public", "failure.json"), "utf8");
    expect(text).not.toContain("PRIVATE_");
    const report = JSON.parse(text);
    if (scenario.startsWith("index-")) {
      expect(report.pluginIdentity.availability).toBe("unknown");
      expect(report.omissions["plugin identity"]).toBeDefined();
    } else {
      expect(report.pluginIdentity.plugins[0].doctor.sha256).toBeNull();
      expect(report.pluginIdentity.plugins[0].doctor.observation).toContain("unsafe");
    }
  });

  it.each([true])(
    "retains a failed service child and only sanitized diagnostics (candidate redactor: %s)",
    async (candidateRedactorPresent) => {
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
      writeFileSync(join(state, "openclaw.json"), JSON.stringify({ privateSentinel }));
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
      const supervisorPath = join(workDir, "supervisor.mjs");
      writeFileSync(
        supervisorPath,
        extractUpgradeSurvivorSupervisor(
          readFileSync(UPGRADE_SURVIVOR_UPDATE_RESTART_AUTH_PATH, "utf8"),
        ),
      );
      const supervisor = spawn(process.execPath, [supervisorPath], {
        env: {
          ...process.env,
          OPENCLAW_SYSTEMCTL_SHIM_DAEMON_LOG: logPath,
          OPENCLAW_SYSTEMCTL_SHIM_MANAGER_ENV: "{}",
          OPENCLAW_SYSTEMCTL_SHIM_MANAGER_SCRIPT: writeUpgradeSurvivorStopPolicy(workDir),
          OPENCLAW_SYSTEMCTL_SHIM_EXEC_START: `${shellQuote(process.execPath)} ${shellQuote(childPath)}`,
        },
        stdio: "ignore",
      });
      expect(await waitForProcessExit(supervisor)).toBe(0);
      const observation = JSON.parse(readFileSync(`${logPath}.exit.json`, "utf8"));
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
      // One candidate is absent; the other has a redactor that must never execute.
      if (candidateRedactorPresent) {
        const candidate = join(artifacts, "npm-prefix", "lib", "node_modules", "openclaw");
        mkdirSync(join(candidate, "dist", "plugin-sdk"), { recursive: true });
        writeFileSync(join(candidate, "package.json"), '{"type":"module"}');
        writeFileSync(
          join(candidate, "dist", "plugin-sdk", "logging-core.js"),
          'throw new Error("candidate redactor must not execute");',
        );
      }
      const result = runSurvivorDiagnostics(
        "capture",
        artifacts,
        ["update-candidate", "1"],
        fixtureEnv,
      );
      expect(result.status, result.stderr).toBe(0);
      const rawPath = join(artifacts, "diagnostics", "raw.json");
      const raw = readFileSync(rawPath, "utf8");
      expect(raw).toContain(secret);
      expect(raw).not.toContain(privateSentinel);
      const snapshot = JSON.parse(raw);
      snapshot.config.contents = privateSentinel;
      snapshot.logs["auth-profiles.json"] = privateSentinel;
      snapshot.omissions["doctor.log"] = privateSentinel;
      snapshot.extra = privateSentinel;
      writeFileSync(rawPath, JSON.stringify(snapshot));
      const uploaded = join(workDir, "public");
      const published = runSurvivorDiagnostics("publish", artifacts, [uploaded], fixtureEnv);
      expect(published.status, published.stderr).toBe(0);
      expect(readdirSync(uploaded)).toEqual(["failure.json"]);
      const text = readFileSync(join(uploaded, "failure.json"), "utf8");
      expect(text).not.toContain(secret);
      expect(text).not.toContain(privateSentinel);
      const report = JSON.parse(text);
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
    },
  );

  it.each([UPGRADE_SURVIVOR_UPDATE_RESTART_AUTH_PATH])(
    "retains supervisor bootstrap stderr without inventing a child exit in %s",
    async (scriptPath) => {
      const workDir = tempDirs.make("openclaw-survivor-bootstrap-");
      const unitDir = join(workDir, ".config", "systemd", "user");
      mkdirSync(unitDir, { recursive: true });
      writeFileSync(
        join(unitDir, "openclaw-gateway.service"),
        `[Service]\nExecStart="${process.execPath}" unused\n`,
      );
      const binDir = join(workDir, "bin");
      writeExecutables(binDir, {
        node: `#!/bin/sh
case "$1" in
  *.supervisor.mjs) echo supervisor-bootstrap-failure >&2; exit 17 ;;
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
      const shimPath = installUpgradeSurvivorSystemctlShim(workDir, fixtureEnv, scriptPath);
      const started = spawnSync("bash", [shimPath, "--user", "start", "openclaw-gateway.service"], {
        encoding: "utf8",
        env: { ...fixtureEnv, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      });
      expect(started.status, started.stderr).toBe(0);
      const bootstrapPath = `${logPath}.bootstrap.log`;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (
          existsSync(bootstrapPath) &&
          readFileSync(bootstrapPath, "utf8").includes("supervisor-bootstrap-failure")
        ) {
          break;
        }
        await delay(10);
      }
      expect(readFileSync(bootstrapPath, "utf8")).toContain("supervisor-bootstrap-failure");
      expect(existsSync(`${logPath}.exit.json`)).toBe(false);
      const shown = spawnSync("bash", [shimPath, ...SURVIVOR_SERVICE_SHOW_ARGS], {
        encoding: "utf8",
        env: fixtureEnv,
      });
      expect(shown.status, shown.stderr).toBe(0);
      expect(shown.stdout).not.toContain("ExecMainStatus=");
    },
  );

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
            writeFileSync(
              join(observationRoot, "diagnostics/post-core.json"),
              JSON.stringify({
                artifactRoot: realpathSync(observationRoot),
                childExitCode: index === 0 ? 1 : 0,
                result: {
                  status: index === 0 ? "error" : "ok",
                  changed: false,
                  sync: {
                    changed: false,
                    switchedToBundled: [],
                    switchedToNpm: [],
                    warnings: [],
                    errors: [],
                  },
                  npm: { changed: false, outcomes: [] },
                  integrityDrifts: [],
                },
              }),
            );
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
          const report = JSON.parse(
            readFileSync(join(artifacts, "diagnostics", "raw.json"), "utf8"),
          );
          expect(report.exitStatus).toBe(expectedStatus);
          expect(report.logs["update.err"]).toContain("original startup error");
        } else if (exitCode) {
          expect(result.stdout + result.stderr).toContain("diagnostics missing");
        } else {
          expect(result.stdout + result.stderr).not.toContain("diagnostics missing");
        }
        if (observationSetup) {
          expect(JSON.parse(readFileSync(paths.summaryJson, "utf8"))).toMatchObject({
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
        writeFileSync(
          join(registry, "prepublish-plugin-registry.json"),
          JSON.stringify({ sourceSha: "a".repeat(40), candidateVersion: "2026.8.1", packages: [] }),
        );
        const phases = [
          { phase: "update-candidate", status: "started", at: "2026-09-01T00:00:00.000Z" },
          { phase: "update-candidate", status: "passed", at: "2026-09-01T00:00:01.000Z" },
        ];
        const completedSummary = {
          status: summaryStatus ?? "passed",
          baseline: { spec: "openclaw@2026.7.1-2", version: "2026.7.1-2" },
          candidate: { kind: "tarball", version: "2026.8.1", spec: "PRIVATE_PACKAGE_PATH" },
          scenario: "base",
          installedVersion: "2026.8.1",
          candidateInstallMode: "updater",
          updateRestartMode: "manual",
          updateOutcome: "recoverable",
          updateRecovery: "capability-consent",
          updateRestartSource: null,
          timings: { startupSeconds: 4, healthzSeconds: 1, readyzSeconds: 1, statusSeconds: 2 },
          phases: phases.map((event) => ({ ...event, private: "PRIVATE_PHASE_FIELD" })),
          firstHopPostCore: {
            availability: "captured",
            childExitCode: 1,
            result: {
              status: "error",
              changed: true,
              reason: "requires capability consent token=HOST_PUBLICATION_SECRET",
              sync: {
                changed: false,
                switchedToBundled: [],
                switchedToNpm: [],
                warnings: [],
                errors: [],
              },
              warnings: [],
              npm: { changed: false, outcomes: [] },
              integrityDrifts: [],
              private: "PRIVATE_POST_CORE_FIELD",
            },
          },
          config: { token: "PRIVATE_CONFIG_FIELD" },
          watchosDirectNode: { credentials: "PRIVATE_WATCH_FIELD" },
          restartFixture: { token: "PRIVATE_RESTART_FIELD" },
        };
        writeFileSync(join(workDir, "completed-summary.json"), JSON.stringify(completedSummary));
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
          const directories = readdirSync(publicRoot);
          expect(directories).toHaveLength(1);
          const uploaded = join(publicRoot, directories[0]!);
          expect(readdirSync(uploaded)).toEqual(["failure.json"]);
          const text = readFileSync(join(uploaded, "failure.json"), "utf8");
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
          const directories = readdirSync(publicRoot);
          expect(directories).toHaveLength(1);
          const uploaded = join(publicRoot, directories[0]!);
          expect(readdirSync(uploaded)).toEqual(["summary.json"]);
          const text = readFileSync(join(uploaded, "summary.json"), "utf8");
          expect(text).not.toMatch(/PRIVATE_|HOST_PUBLICATION_SECRET/);
          const receipt = JSON.parse(text);
          expect(receipt).toMatchObject({
            status: "passed",
            baseline: completedSummary.baseline,
            candidate: { kind: "tarball", version: "2026.8.1" },
            scenario: "base",
            installedVersion: "2026.8.1",
            candidateInstallMode: "updater",
            updateRestartMode: "manual",
            updateOutcome: "recoverable",
            updateRecovery: "capability-consent",
            timings: completedSummary.timings,
            phases,
            firstHopPostCore: {
              availability: "captured",
              childExitCode: 1,
              result: { status: "error" },
            },
          });
          expect(receipt.logs["update.json"]).toContain("historical preamble");
          expect(receipt.logs["update.json"]).toContain("FIRST_HOP");
          expect(receipt.logs["update.json"]).toContain('"status":"warning"');
          expect(receipt.logs["update.json"]).not.toMatch(/REPAIR|RECOVERY/);
          expect(receipt.logs["repair.json"]).toContain("REPAIR");
          expect(receipt.logs["recovery-update.json"]).toContain("RECOVERY");
          expect(result.stderr).not.toContain("diagnostics missing");

          writeFileSync(join(workDir, "skip-optional-logs"), "1");
          writeFileSync(
            join(workDir, "completed-summary.json"),
            JSON.stringify({
              ...completedSummary,
              updateOutcome: "success",
              updateRecovery: null,
              firstHopPostCore: { availability: "unavailable" },
            }),
          );
          const reusedResult = runWrapper();
          expect(reusedResult.status, reusedResult.stdout + reusedResult.stderr).toBe(0);
          expect(reusedResult.stderr).not.toContain("diagnostics missing");
          const reusedDirectories = readdirSync(publicRoot).filter((dir) => dir !== directories[0]);
          expect(reusedDirectories).toHaveLength(1);
          const reusedText = readFileSync(
            join(publicRoot, reusedDirectories[0]!, "summary.json"),
            "utf8",
          );
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
          expect(readFileSync(join(uploaded, "summary.json"), "utf8")).toBe(text);
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

  it("stops supervised gateway restarts after the systemd burst limit", async () => {
    const workDir = tempDirs.make("openclaw-update-restart-supervisor-");
    const scripts = [readFileSync(UPGRADE_SURVIVOR_UPDATE_RESTART_AUTH_PATH, "utf8")];

    for (const [index, script] of scripts.entries()) {
      const supervisorPath = join(workDir, `supervisor-${index}.mjs`);
      const countPath = join(workDir, `starts-${index}`);
      const logPath = join(workDir, `daemon-${index}.log`);
      const source = extractUpgradeSurvivorSupervisor(script)
        .replace("const restartDelayMs = 5_000;", "const restartDelayMs = 5;")
        .replace("const restartWindowMs = 60_000;", "const restartWindowMs = 5_000;");
      writeFileSync(supervisorPath, source);

      const command =
        'node -e \'require("node:fs").appendFileSync(process.env.COUNT_FILE, "x"); process.exit(1)\'';
      const supervisor = spawn(process.execPath, [supervisorPath], {
        env: {
          ...process.env,
          COUNT_FILE: countPath,
          OPENCLAW_SYSTEMCTL_SHIM_DAEMON_LOG: logPath,
          OPENCLAW_SYSTEMCTL_SHIM_MANAGER_ENV: "{}",
          OPENCLAW_SYSTEMCTL_SHIM_MANAGER_SCRIPT: writeUpgradeSurvivorStopPolicy(workDir),
          OPENCLAW_SYSTEMCTL_SHIM_EXEC_START: command,
        },
        stdio: "ignore",
      });
      const exitCode = await waitForProcessExit(supervisor);

      expect(exitCode).toBe(0);
      expect(readFileSync(countPath, "utf8")).toBe("xxxxx");
      expect(readFileSync(logPath, "utf8")).toContain(
        "[systemctl-shim] gateway restart limit reached",
      );
    }
  });

  it.skipIf(process.platform === "win32")(
    "terminates supervised gateway descendants at the systemd stop timeout",
    async () => {
      const workDir = tempDirs.make("openclaw-update-restart-process-group-");
      const descendantPath = writeTermIgnoringDescendant(workDir);
      const gatewayPath = join(workDir, "gateway.mjs");
      writeFileSync(
        gatewayPath,
        `import fs from "node:fs";
import { spawn } from "node:child_process";
process.on("SIGTERM", () => {
  setTimeout(() => {
    fs.appendFileSync(process.env.STATE_FILE, "-graceful");
    process.exit(0);
  }, 50);
});
spawn(process.execPath, [process.env.DESCENDANT_SCRIPT], { stdio: "ignore" });
const ready = setInterval(() => {
  if (!fs.existsSync(process.env.DESCENDANT_PID_FILE)) return;
  clearInterval(ready);
  fs.writeFileSync(process.env.STATE_FILE, "ready");
}, 5);
setInterval(() => {}, 1_000);
`,
      );
      const scripts = [readFileSync(UPGRADE_SURVIVOR_UPDATE_RESTART_AUTH_PATH, "utf8")];

      for (const [index, script] of scripts.entries()) {
        const supervisorPath = join(workDir, `process-group-supervisor-${index}.mjs`);
        const statePath = join(workDir, `process-group-state-${index}`);
        const descendantPidPath = join(workDir, `process-group-descendant-${index}.pid`);
        const logPath = join(workDir, `process-group-daemon-${index}.log`);
        const source = extractUpgradeSurvivorSupervisor(script);
        writeFileSync(supervisorPath, source);

        const supervisor = spawn(process.execPath, [supervisorPath], {
          env: {
            ...process.env,
            DESCENDANT_PID_FILE: descendantPidPath,
            DESCENDANT_SCRIPT: descendantPath,
            OPENCLAW_SYSTEMCTL_SHIM_DAEMON_LOG: logPath,
            OPENCLAW_SYSTEMCTL_SHIM_MANAGER_ENV: "{}",
            OPENCLAW_SYSTEMCTL_SHIM_MANAGER_SCRIPT: writeUpgradeSurvivorStopPolicy(workDir, 200),
            OPENCLAW_SYSTEMCTL_SHIM_EXEC_START: `${shellQuote(process.execPath)} ${shellQuote(gatewayPath)}`,
            STATE_FILE: statePath,
          },
          stdio: "ignore",
        });
        try {
          for (let attempt = 0; attempt < 100 && !existsSync(statePath); attempt += 1) {
            await delay(10);
          }
          expect(
            existsSync(statePath),
            `${supervisorPath}: readiness missing (exit=${supervisor.exitCode}, signal=${supervisor.signalCode})`,
          ).toBe(true);
          const descendantPid = Number.parseInt(readFileSync(descendantPidPath, "utf8"), 10);
          expect(descendantPid).toBeGreaterThan(1);
          expect(isProcessRunning(descendantPid)).toBe(true);

          supervisor.kill("SIGTERM");
          expect(await waitForProcessExit(supervisor)).toBe(0);
          expect(readFileSync(statePath, "utf8")).toBe("ready-graceful");
          for (let attempt = 0; attempt < 100 && isProcessRunning(descendantPid); attempt += 1) {
            await delay(10);
          }
          expect(isProcessRunning(descendantPid)).toBe(false);
        } finally {
          await stopUpgradeSurvivorSupervisor(supervisor, descendantPidPath);
        }
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "drains the previous gateway process group before restarting",
    async () => {
      const workDir = tempDirs.make("openclaw-update-restart-process-group-restart-");
      const descendantPath = writeTermIgnoringDescendant(workDir);
      const gatewayPath = join(workDir, "restart-gateway.mjs");
      writeFileSync(
        gatewayPath,
        `import fs from "node:fs";
import { spawn } from "node:child_process";
fs.appendFileSync(process.env.STARTS_FILE, "x");
const starts = fs.readFileSync(process.env.STARTS_FILE, "utf8").length;
if (starts === 1) {
  spawn(process.execPath, [process.env.DESCENDANT_SCRIPT], { stdio: "ignore" });
  const ready = setInterval(() => {
    if (!fs.existsSync(process.env.DESCENDANT_PID_FILE)) return;
    clearInterval(ready);
    process.exit(1);
  }, 5);
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
      );
      const scripts = [readFileSync(UPGRADE_SURVIVOR_UPDATE_RESTART_AUTH_PATH, "utf8")];

      for (const [index, script] of scripts.entries()) {
        const supervisorPath = join(workDir, `restart-group-supervisor-${index}.mjs`);
        const startsPath = join(workDir, `restart-group-starts-${index}`);
        const descendantPidPath = join(workDir, `restart-group-descendant-${index}.pid`);
        const replacementPath = join(workDir, `restart-group-replacement-${index}`);
        const logPath = join(workDir, `restart-group-daemon-${index}.log`);
        const source = extractUpgradeSurvivorSupervisor(script).replace(
          "const restartDelayMs = 5_000;",
          "const restartDelayMs = 5;",
        );
        writeFileSync(supervisorPath, source);

        const supervisor = spawn(process.execPath, [supervisorPath], {
          env: {
            ...process.env,
            DESCENDANT_PID_FILE: descendantPidPath,
            DESCENDANT_SCRIPT: descendantPath,
            OPENCLAW_SYSTEMCTL_SHIM_DAEMON_LOG: logPath,
            OPENCLAW_SYSTEMCTL_SHIM_MANAGER_ENV: "{}",
            OPENCLAW_SYSTEMCTL_SHIM_MANAGER_SCRIPT: writeUpgradeSurvivorStopPolicy(workDir, 200),
            OPENCLAW_SYSTEMCTL_SHIM_EXEC_START: `${shellQuote(process.execPath)} ${shellQuote(gatewayPath)}`,
            REPLACEMENT_FILE: replacementPath,
            STARTS_FILE: startsPath,
          },
          stdio: "ignore",
        });
        try {
          expect(await waitForProcessExit(supervisor)).toBe(0);
          const descendantPid = Number.parseInt(readFileSync(descendantPidPath, "utf8"), 10);
          expect(descendantPid).toBeGreaterThan(1);
          expect(readFileSync(startsPath, "utf8")).toBe("xx");
          expect(readFileSync(replacementPath, "utf8")).toBe("drained");
        } finally {
          await stopUpgradeSurvivorSupervisor(supervisor, descendantPidPath);
        }
      }
    },
  );

  it.each([
    ["start budget", "OPENCLAW_UPGRADE_SURVIVOR_START_BUDGET_SECONDS", "90s"],
    ["probe timeout", "OPENCLAW_UPGRADE_SURVIVOR_PROBE_TIMEOUT_MS", "soon"],
    ["probe attempt timeout", "OPENCLAW_UPGRADE_SURVIVOR_PROBE_ATTEMPT_TIMEOUT_MS", "0"],
  ])("rejects invalid upgrade survivor Docker %s before Docker setup", (_label, envName, value) => {
    const stderr = expectInvalidDockerEnv(UPGRADE_SURVIVOR_DOCKER_E2E_PATH, envName, value, {
      OPENCLAW_UPGRADE_SURVIVOR_E2E_SKIP_BUILD: "1",
    });
    expect(stderr).not.toContain("Docker image not found");
  });

  it("bounds upgrade survivor failure log diagnostics", () => {
    const runner = readFileSync(UPGRADE_SURVIVOR_DOCKER_E2E_PATH, "utf8");
    const publishedRunner = readFileSync(UPGRADE_SURVIVOR_RUN_SCRIPT, "utf8");
    const updateRestartAuth = readFileSync(UPGRADE_SURVIVOR_UPDATE_RESTART_AUTH_PATH, "utf8");

    expectTextToIncludeInOrder(runner, [
      "update_status=$?",
      'if [ "$update_status" -ne 0 ]; then',
      'echo "openclaw update failed" >&2',
      'openclaw config validate --json >"$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/post-update-validate.json"',
      'echo "post-update config validation probe status=$validate_status" >&2',
      'openclaw_e2e_print_log "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/post-update-validate.err" >&2 || true',
      'openclaw_e2e_print_log "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/post-update-validate.json" >&2 || true',
      'openclaw_e2e_print_log "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/update.err" >&2 || true',
      'openclaw_e2e_print_log "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/update.json" >&2 || true',
      'exit "$update_status"',
    ]);
    expectTextToIncludeInOrder(publishedRunner, [
      "local update_status=0",
      'openclaw "${update_args[@]}" >"$update_json" 2>"$update_err" || update_status=$?',
      "assert-recoverable-update-json",
      "assert-successful-update-json",
      'echo "openclaw update failed before the recoverable post-core boundary" >&2',
      'openclaw config validate --json >"$POST_UPDATE_VALIDATE_JSON"',
      'echo "post-update config validation probe status=$validate_status" >&2',
      'openclaw_e2e_print_log "$POST_UPDATE_VALIDATE_ERR" >&2 || true',
      'openclaw_e2e_print_log "$POST_UPDATE_VALIDATE_JSON" >&2 || true',
      'openclaw_e2e_print_log "$update_err" >&2 || true',
      'openclaw_e2e_print_log "$update_json" >&2 || true',
      'return "$update_status"',
    ]);
    expect(publishedRunner).not.toContain("update_args+=(--accept-capabilities)");
    expectTextToIncludeInOrder(publishedRunner, [
      "phase doctor run_doctor",
      "phase assert-survival assert_survival",
      "phase fixture-plugin-consent repair_fixture_plugin_consent",
      "phase transcript-export node scripts/e2e/lib/upgrade-survivor/assertions.mjs assert-meeting-transcript-export",
      "phase gateway-start ensure_gateway_started",
    ]);
    expect(publishedRunner).not.toContain("systemctl --user restart openclaw-gateway.service");
    expect(publishedRunner).toContain("phase recovery-update-restart update_candidate 1");

    expectTextToIncludeAll(runner, [
      'openclaw_e2e_print_log "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/update.err"',
      'openclaw_e2e_print_log "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/update.json"',
      'openclaw_e2e_print_log "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/post-update-validate.err"',
      'openclaw_e2e_print_log "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/post-update-validate.json"',
      'openclaw_e2e_print_log "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/doctor.log"',
      'openclaw_e2e_print_log "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/status.err"',
      'openclaw_e2e_print_log "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/status.json"',
      'openclaw_e2e_print_log "$GATEWAY_LOG"',
      'openclaw_e2e_print_log "$SYSTEMCTL_SHIM_DAEMON_LOG"',
      'openclaw_e2e_print_log "$log_file"',
    ]);

    expect(runner).not.toContain('cat "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/update.err"');
    expect(runner).not.toContain('cat "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/update.json"');
    expect(runner).not.toContain(
      'cat "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/post-update-validate.err"',
    );
    expect(runner).not.toContain(
      'cat "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/post-update-validate.json"',
    );
    expect(runner).not.toContain('cat "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/doctor.log"');
    expect(runner).not.toContain('cat "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/status.err"');
    expect(runner).not.toContain('cat "$OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT/status.json"');
    expect(runner).not.toContain('cat "$GATEWAY_LOG"');
    expect(runner).not.toContain('cat "$SYSTEMCTL_SHIM_DAEMON_LOG"');
    expect(runner).not.toContain('cat "$log_file"');
    expect(runner).not.toContain('openclaw_e2e_print_log "$SYSTEMCTL_SHIM_LOG"');

    expect(publishedRunner).toContain('openclaw_e2e_print_log "$BASELINE_INSTALL_LOG"');
    expect(publishedRunner).toContain('openclaw_e2e_print_log "$BASELINE_CONFIG_VALIDATE_LOG"');
    expect(updateRestartAuth).toContain('openclaw_e2e_print_log "$result_err"');
    expect(updateRestartAuth).toContain('openclaw_e2e_print_log "$result_out"');
    expect(publishedRunner).toContain('openclaw_e2e_print_log "$update_err"');
    expect(publishedRunner).toContain('openclaw_e2e_print_log "$update_json"');
    expect(publishedRunner).toContain('openclaw_e2e_print_log "$DOCTOR_LOG"');
    expect(publishedRunner).toContain('openclaw_e2e_print_log "$GATEWAY_LOG"');
    expect(publishedRunner).toContain('openclaw_e2e_print_log "$STATUS_ERR"');
    expect(publishedRunner).toContain('openclaw_e2e_print_log "$STATUS_JSON"');
    expect(publishedRunner).toContain('openclaw_e2e_print_log "$log_file"');
    expect(publishedRunner).not.toContain('cat "$BASELINE_INSTALL_LOG"');
    expect(publishedRunner).not.toContain('cat "$BASELINE_CONFIG_VALIDATE_LOG"');
    expect(updateRestartAuth).not.toContain('cat "$result_err"');
    expect(updateRestartAuth).not.toContain('cat "$result_out"');
    expect(publishedRunner).not.toContain('cat "$UPDATE_ERR"');
    expect(publishedRunner).not.toContain('cat "$UPDATE_JSON"');
    expect(publishedRunner).not.toContain('cat "$DOCTOR_LOG"');
    expect(publishedRunner).not.toContain('cat "$GATEWAY_LOG"');
    expect(publishedRunner).not.toContain('cat "$STATUS_ERR"');
    expect(publishedRunner).not.toContain('cat "$STATUS_JSON"');
    expect(publishedRunner).not.toContain('cat "$log_file"');
    expect(publishedRunner).not.toContain('openclaw_e2e_print_log "$SYSTEMCTL_SHIM_LOG"');
    expect(publishedRunner).not.toContain('openclaw_e2e_print_log "$SYSTEMCTL_SHIM_DAEMON_LOG"');
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
  local cidfile=""
  local expect_cidfile=0
  local arg
  for arg in "$@"; do
    if [[ "$expect_cidfile" == "1" ]]; then
      cidfile="$arg"
      expect_cidfile=0
      continue
    fi
    if [[ "$arg" == "--cidfile" ]]; then
      expect_cidfile=1
    fi
  done
  test -n "$cidfile"
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

  it("copies the pnpm lockfile into the runtime image before normalizing its permissions", () => {
    const dockerfile = readFileSync("Dockerfile", "utf8");
    const copy = "COPY --from=runtime-assets --chown=node:node /app/pnpm-lock.yaml .";
    const chmod = "chmod a+r /app/pnpm-lock.yaml";

    expect(dockerfile).toContain(copy);
    expect(dockerfile.indexOf(copy)).toBeLessThan(dockerfile.indexOf(chmod));
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
      "scripts/lib/docker-e2e-resource-diagnostics.sh",
      PREPUBLISH_PLUGIN_REGISTRY_HELPER_PATH,
    ]) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      copyFileSync(file, join(root, file));
    }
    mkdirSync(join(root, "packages/normalization-core/src"), { recursive: true });
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

  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ] as const)("cleans the actual cron runner and its harness on %s", async (signal, status) => {
    const fixture = containerCleanupFixture("signal");
    const runner = spawn("/bin/bash", ["scripts/e2e/cron-cli-docker.sh"], {
      env: fixture.env,
      stdio: "ignore",
    });
    try {
      await expect.poll(() => existsSync(fixture.pidPath), { timeout: 5_000 }).toBe(true);
      runner.kill(signal);
      expect(await waitForProcessExit(runner)).toBe(status);
      expectContainerCleanup(fixture, "openclaw-cron-cli-e2e-");
      expect(isProcessRunning(Number(readFileSync(fixture.pidPath, "utf8")))).toBe(false);
    } finally {
      if (runner.exitCode === null && runner.signalCode === null) {
        runner.kill("SIGTERM");
        await waitForProcessExit(runner);
      }
      if (existsSync(fixture.pidPath)) {
        const pid = Number(readFileSync(fixture.pidPath, "utf8"));
        if (isProcessRunning(pid)) {
          process.kill(pid, "SIGKILL");
          await expect.poll(() => isProcessRunning(pid), { timeout: 5_000 }).toBe(false);
        }
      }
    }
  });

  it.each(
    [
      {
        layout: "June",
        clientPath: "scripts/e2e/agent-bundle-mcp-tools-docker-client.ts",
        distPrefix: "../../dist",
        helperImport: "./lib/temp-state-dir.ts",
        scenarios: ["success", "empty extraction", "altered extraction"],
      },
      {
        layout: "July",
        clientPath: "test/e2e/qa-lab/runtime/agent-bundle-mcp-tools-docker-client.ts",
        distPrefix: "../../../../dist",
        helperImport: "../../../../scripts/e2e/lib/temp-state-dir.ts",
        scenarios: ["success"],
      },
    ].flatMap((layout) =>
      layout.scenarios.map((scenario) => ({
        layout: layout.layout,
        clientPath: layout.clientPath,
        distPrefix: layout.distPrefix,
        helperImport: layout.helperImport,
        scenario,
      })),
    ),
  )(
    "stages the committed $layout bundle-MCP client through the real runner: $scenario",
    (layout) => {
      const root = tempDirs.make("openclaw-bundle-client-");
      const source = join(root, "source");
      const bin = join(root, "bin");
      mkdirSync(source);
      mkdirSync(bin);
      const helperPath = "scripts/e2e/lib/temp-state-dir.ts";
      const client = [
        `import { disposeAllSessionMcpRuntimes, getOrCreateSessionMcpRuntime } from "${layout.distPrefix}/agents/agent-bundle-mcp-runtime.js";`,
        `import { createE2eStateDir } from "${layout.helperImport}";`,
        'throw new Error("target client must not execute in the staging fixture");',
        "",
      ].join("\n");
      const helper =
        'export async function createE2eStateDir() { throw new Error("not executed"); }\n';
      const manifest = `${JSON.stringify({ name: "openclaw", type: "module", version: "2026.7.33" })}\n`;
      for (const [relative, content] of Object.entries({
        "package.json": manifest,
        [layout.clientPath]: client,
        [helperPath]: helper,
        "src/agents/agent-bundle-mcp-runtime.ts":
          "export async function getOrCreateSessionMcpRuntime() {}\nexport async function disposeAllSessionMcpRuntimes() {}\n",
        "src/agents/embedded-agent-runner/run/runtime-context-prompt.ts":
          "type Params = { modelPrompt?: string; };\nextractInternalRuntimeContext();\n",
      })) {
        mkdirSync(dirname(join(source, relative)), { recursive: true });
        writeFileSync(join(source, relative), content);
      }
      const git = (...args: string[]) =>
        execFileSync(
          "git",
          ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args],
          { cwd: source, encoding: "utf8" },
        ).trim();
      git("init", "-q");
      git("config", "user.email", "test@example.invalid");
      git("config", "user.name", "Test");
      git("add", ".");
      git("commit", "-qm", "fixture");
      const selectedSha = git("rev-parse", "HEAD");
      writeFileSync(join(source, layout.clientPath), "dirty client decoy\n");
      mkdirSync(dirname(join(source, helperPath)), { recursive: true });
      writeFileSync(join(source, helperPath), "dirty helper decoy\n");
      writeFileSync(join(source, "package.json"), '{"type":"commonjs"}\n');
      const capture = join(root, "docker.jsonl");
      const removals = join(root, "removals.jsonl");
      const tempPaths = join(root, "temp-paths.jsonl");
      const logPath = join(root, "runner log");
      writeFileSync(join(root, "retained-evidence"), "keep");
      writeExecutables(bin, {
        mktemp: `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const home = fs.realpathSync(process.env.HOME);
let created;
if (args[0] === "-t") {
  created = path.join(home, "runner log");
  fs.writeFileSync(created, "", { flag: "wx" });
} else {
  const parent = fs.realpathSync(path.dirname(path.resolve(args.at(-1))));
  if (args[0] !== "-d" || (parent !== home && !parent.startsWith(home + path.sep))) {
    throw new Error("unexpected temporary directory outside fixture");
  }
  const result = spawnSync("/usr/bin/mktemp", args, { encoding: "utf8" });
  if (result.status !== 0) process.exit(result.status ?? 1);
  created = result.stdout.trim();
}
fs.appendFileSync(process.env.FIXTURE_TEMP_PATHS, JSON.stringify({ args, path: created }) + "\\n");
console.log(created);
`,
        rm: `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const home = fs.realpathSync(process.env.HOME);
for (const arg of args.filter(arg => !arg.startsWith("-"))) {
  const parent = fs.realpathSync(path.dirname(path.resolve(arg)));
  if (parent !== home && !parent.startsWith(home + path.sep)) throw new Error("unexpected removal outside fixture");
}
fs.appendFileSync(process.env.FIXTURE_REMOVALS, JSON.stringify(args) + "\\n");
fs.appendFileSync(process.env.FIXTURE_DOCKER_CAPTURE, JSON.stringify({ args: ["host-rm", ...args], staged: null }) + "\\n");
const result = spawnSync("/bin/rm", args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`,
      });
      if (layout.scenario === "empty extraction" || layout.scenario === "altered extraction") {
        const realTar = execDockerSnippet("command -v tar").trim();
        writeExecutables(bin, {
          tar: `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (${JSON.stringify(layout.scenario)} === "empty extraction") {
  process.stdin.resume();
} else {
  const result = spawnSync(${JSON.stringify(realTar)}, args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
  fs.appendFileSync(path.join(args[args.indexOf("-C") + 1], ${JSON.stringify(layout.clientPath)}), "altered bytes\\n");
}
`,
        });
      }
      writeExecutables(bin, {
        docker: `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
let staged = null;
const mount = args.find(arg => arg.endsWith(":/tmp/openclaw-frozen-agent-bundle-mcp-tools:ro"));
if (args[0] === "run" && mount) {
  const root = mount.slice(0, mount.indexOf(":"));
  const client = path.join(root, process.env.FIXTURE_CLIENT_PATH);
  staged = {
    root,
    client: fs.readFileSync(client, "utf8"),
    helper: fs.readFileSync(path.resolve(path.dirname(client), process.env.FIXTURE_HELPER_IMPORT), "utf8"),
    manifest: fs.readFileSync(path.join(root, "package.json"), "utf8"),
    dist: fs.readlinkSync(path.join(root, "dist")),
    modules: fs.readlinkSync(path.join(root, "node_modules")),
    mode: fs.statSync(root).mode & 0o777,
    entries: fs.readdirSync(root, { recursive: true }).sort()
  };
}
fs.appendFileSync(process.env.FIXTURE_DOCKER_CAPTURE, JSON.stringify({ args, staged }) + "\\n");
`,
      });
      const result = spawnSync("/bin/bash", [AGENT_BUNDLE_MCP_TOOLS_DOCKER_E2E_PATH], {
        encoding: "utf8",
        timeout: 30_000,
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          HOME: root,
          TMPDIR: root,
          OPENCLAW_DOCKER_E2E_REPO_ROOT: source,
          OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: "1",
          OPENCLAW_SELECTED_SHA: selectedSha,
          OPENCLAW_TOOLING_SHA: "b".repeat(40),
          OPENCLAW_SKIP_DOCKER_BUILD: "1",
          OPENCLAW_DOCKER_E2E_REQUIRE_LOCAL_IMAGE: "1",
          FIXTURE_DOCKER_CAPTURE: capture,
          FIXTURE_CLIENT_PATH: layout.clientPath,
          FIXTURE_HELPER_IMPORT: layout.helperImport,
          FIXTURE_REMOVALS: removals,
          FIXTURE_TEMP_PATHS: tempPaths,
        },
      });
      const calls: Array<{
        args: string[];
        staged: {
          root: string;
          client: string;
          helper: string;
          manifest: string;
          dist: string;
          modules: string;
          mode: number;
          entries: string[];
        } | null;
      }> = existsSync(capture)
        ? readFileSync(capture, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
        : [];
      const createdPaths: Array<{ args: string[]; path: string }> = existsSync(tempPaths)
        ? readFileSync(tempPaths, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
        : [];
      const stagedRoot = createdPaths.find(
        (entry) =>
          entry.args[0] === "-d" &&
          entry.args[1] === join(root, "openclaw-frozen-agent-bundle-mcp-tools.XXXXXX"),
      )?.path;
      expect(readFileSync(join(root, "retained-evidence"), "utf8")).toBe("keep");
      if (!stagedRoot) {
        throw new Error("missing captured staged directory");
      }
      expect(createdPaths.find((entry) => entry.args[0] === "-t")?.path).toBe(logPath);
      const containerRemoval = calls.findIndex((call) => call.args[0] === "rm");
      const logRemoval = calls.findIndex(
        (call) => call.args[0] === "host-rm" && call.args[1] === "-f" && call.args[2] === logPath,
      );
      const directoryRemoval = calls.findIndex(
        (call) =>
          call.args[0] === "host-rm" && call.args[1] === "-rf" && call.args[2] === stagedRoot,
      );
      expect(containerRemoval).toBeGreaterThanOrEqual(0);
      expect(logRemoval, result.stderr + result.stdout).toBeGreaterThan(containerRemoval);
      expect(directoryRemoval).toBeGreaterThan(logRemoval);
      if (layout.scenario !== "success") {
        expect(result.status, result.stderr + result.stdout).not.toBe(0);
        expect(calls.every((call) => call.args[0] === "rm" || call.args[0] === "host-rm")).toBe(
          true,
        );
        expect(
          readdirSync(root).filter((entry) =>
            entry.startsWith("openclaw-frozen-agent-bundle-mcp-tools."),
          ),
        ).toEqual([]);
        if (layout.scenario === "empty extraction") {
          expect(result.stderr).toContain("missing regular staged");
        }
        if (layout.scenario === "altered extraction") {
          expect(result.stderr).toContain("differs from selected source");
        }
        return;
      }
      expect(result.status, result.stderr + result.stdout).toBe(0);
      const run = calls.find((call) => call.args[0] === "run");
      if (!run?.staged) {
        throw new Error("runner did not mount the selected client");
      }
      expect(run.staged.root).toBe(stagedRoot);
      expect(run.staged).toMatchObject({
        client,
        helper,
        manifest,
        dist: "/app/dist",
        modules: "/app/node_modules",
        mode: 0o755,
      });
      expect(run.args.at(-1)).toContain(
        `tsx /tmp/openclaw-frozen-agent-bundle-mcp-tools/${layout.clientPath}`,
      );
      expect(run.staged.entries).not.toContain("src");
      expect(existsSync(run.staged.root)).toBe(false);
      expect(calls.filter((call) => call.args[0] === "run")).toHaveLength(1);
    },
  );

  it("passes source-qualified overrides without leaking frozen control-plane identity", () => {
    const runner = readFileSync(MCP_CODE_MODE_GATEWAY_DOCKER_E2E_PATH, "utf8");

    expectTextToIncludeAll(runner, [
      "MCP_CODE_MODE_SEED_ENV_ARGS=()",
      "OPENCLAW_FROZEN_TARGET_MCP_MEMORY_CONFIG_MODE=agent",
      "OPENCLAW_FROZEN_TARGET_MCP_CODE_MODE_CATALOG_MODE=legacy",
      '"${MCP_CODE_MODE_SEED_ENV_ARGS[@]}"',
    ]);
    for (const path of [
      MCP_CODE_MODE_GATEWAY_DOCKER_E2E_PATH,
      ONBOARD_DOCKER_E2E_PATH,
      "scripts/e2e/session-runtime-context-docker.sh",
    ]) {
      const source = readFileSync(path, "utf8");
      expect(source).not.toContain('-e "OPENCLAW_SELECTED_SHA=$OPENCLAW_SELECTED_SHA"');
      expect(source).not.toContain('-e "OPENCLAW_TOOLING_SHA=$OPENCLAW_TOOLING_SHA"');
    }
    const liveGateway = readFileSync("scripts/test-live-gateway-models-docker.sh", "utf8");
    expect(liveGateway).not.toContain("OPENCLAW_SELECTED_SHA");
    expect(liveGateway).not.toContain("OPENCLAW_TOOLING_SHA");
    expectTextToIncludeAll(liveGateway, [
      'openclaw_resolve_frozen_live_cli_backend_package_mode "$ROOT_DIR"',
      "OPENCLAW_FROZEN_TARGET_LIVE_CLI_BACKEND_PACKAGE_MODE=legacy",
    ]);
  });

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
      for (const match of body.matchAll(/from "(\.\.?\/[^"]+)"/gu)) {
        requirements.push(join(dirname(file), match[1] ?? ""));
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

  it("proves gateway suspension across a same-container process restart", () => {
    const runner = readFileSync(GATEWAY_NETWORK_DOCKER_E2E_PATH, "utf8");
    expectTextToIncludeAll(runner, [
      'source "$ROOT_DIR/scripts/lib/frozen-target-compat.sh"',
      "plugins enable admin-http-rpc",
      "/tmp/gateway-network-configured",
      'CAPABILITIES_DIR="$(mktemp -d',
      "GW_CAPABILITIES_PATH=$CAPABILITIES_CONTAINER_PATH",
      'CAPABILITIES_HOST_USER="$(id -u)"',
      'CAPABILITIES_HOST_GROUP="$(id -g)"',
      'if [[ ! -O "$CAPABILITIES_DIR" ]]',
      '--user "$CAPABILITIES_HOST_USER:$CAPABILITIES_HOST_GROUP"',
      "trap cleanup EXIT",
      '[[ -z "$CAPABILITIES_PATH" ]] || rm -f "$CAPABILITIES_PATH"',
      '[[ -z "$CAPABILITIES_DIR" ]] || rmdir "$CAPABILITIES_DIR"',
      'if [[ ! -O "$CAPABILITIES_PATH" ]]',
      'rm "$CAPABILITIES_PATH"',
      'rmdir "$CAPABILITIES_DIR"',
      'if [[ "$SUSPENSION_CAPABILITY" == "unsupported" ]]',
      "openclaw_frozen_target_omissions_authorized",
      "run_suspension_phase() {",
      "GW_MODE=suspension-$stage-restart",
      "run_suspension_phase pre",
      "run_suspension_phase post",
      "GW_URL=ws://127.0.0.1:$PORT",
      'SUSPENSION_STATE_PATH="/tmp/gateway-network-suspension.json"',
      'container_id="$(docker_e2e_docker_cmd inspect',
      'docker_e2e_docker_cmd stop "$GW_NAME"',
      'docker_e2e_docker_cmd start "$GW_NAME"',
      'if [[ "$restarted_container_id" != "$container_id" ]]',
      "openclaw_e2e_probe_http http://127.0.0.1:$PORT/readyz ok 400",
      'run_logged_print "gateway-network-suspension-$stage"',
      '"phase":"container-restart","durationMs":%d',
    ]);
    expect(runner).not.toContain('source "$ROOT_DIR/scripts/lib/live-docker-auth.sh"');
    expect(runner).not.toContain("openclaw_live_chown_bind_dirs_for_container_user");
    expect(runner).not.toContain("gateway-network-capabilities-dir");
    expect(runner).not.toContain("IMAGE_USER=");
    expect(runner).not.toContain("--user 0:0");
    expect(runner).not.toContain("chown");
    expect(runner).not.toContain("chmod");
    expect(runner).not.toContain('rm -rf "$CAPABILITIES_DIR"');

    const parseIndex = runner.indexOf('SUSPENSION_CAPABILITY="$(');
    const ownershipIndex = runner.indexOf('if [[ ! -O "$CAPABILITIES_PATH" ]]');
    const unlinkIndex = runner.indexOf('rm "$CAPABILITIES_PATH"', ownershipIndex);
    const rmdirIndex = runner.indexOf('rmdir "$CAPABILITIES_DIR"', ownershipIndex);
    const capabilityBranchIndex = runner.indexOf(
      'if [[ "$SUSPENSION_CAPABILITY" == "unsupported" ]]',
    );
    expect(parseIndex).toBeGreaterThanOrEqual(0);
    expect(ownershipIndex).toBeGreaterThan(parseIndex);
    expect(unlinkIndex).toBeGreaterThan(ownershipIndex);
    expect(rmdirIndex).toBeGreaterThan(unlinkIndex);
    expect(capabilityBranchIndex).toBeGreaterThan(rmdirIndex);
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
    const home = tempDirs.make("openclaw-doctor-busctl-shim-");
    const serviceName = "openclaw-gateway.service";
    const unitPath = join(home, ".config", "systemd", "user", serviceName);
    mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
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
    const binDir = join(home, "bin");
    writeExecutables(binDir, {
      busctl: readFileSync(DOCTOR_SWITCH_BUSCTL_SHIM_PATH, "utf8"),
      "systemd-exec-start.mjs": readFileSync(DOCTOR_SWITCH_SYSTEMD_EXEC_START_PATH, "utf8"),
    });
    const { readSystemdServiceExecStart } =
      await import("../../src/daemon/systemd-service-files.js");
    const loadedEnv = {
      HOME: home,
      PATH: `${binDir}:${process.env.PATH}`,
      OPENCLAW_SYSTEMD_UNIT: serviceName,
      XDG_RUNTIME_DIR: join(home, "runtime"),
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(home, "runtime", "bus")}`,
    };
    expect(
      // The production 5s deadline budgets for native busctl; the Node shim's cold
      // spawn can exceed its per-call slice under load, so widen it here.
      await readSystemdServiceExecStart(loadedEnv, { requireEffective: true, timeoutMs: 30_000 }),
    ).toMatchObject({
      programArguments,
      workingDirectory: "/opt/openclaw git",
      sourcePath: unitPath,
      definitionPaths: [unitPath],
      environment: { GREETING: "hello world", OPENCLAW_PROFILE: "fixture" },
    });

    const definition = readFileSync(unitPath, "utf8");
    const loadedCommand = await readSystemdServiceExecStart(loadedEnv, {
      requireEffective: true,
      requireLoaded: true,
      timeoutMs: 30_000,
    });
    expect(loadedCommand?.programArguments).toEqual(programArguments);
    const { readLoadedSystemdServiceRuntime } =
      await import("../../src/daemon/systemd-loaded-runtime.js");
    const runtime = await readLoadedSystemdServiceRuntime(loadedEnv, 30_000);
    expect(runtime).toMatchObject({
      status: "stopped",
      systemd: { managerUid: process.getuid?.(), tasksCurrent: 0 },
    });
    expect(readFileSync(unitPath, "utf8")).toBe(definition);
    rmSync(unitPath);
    expect(
      await readSystemdServiceExecStart(loadedEnv, {
        requireEffective: true,
        requireLoaded: true,
        timeoutMs: 30_000,
      }),
    ).toBeNull();
    expect((await readLoadedSystemdServiceRuntime(loadedEnv, 30_000)).status).toBe("unknown");
  });

  it("distinguishes a missing named doctor switch unit from failed or unsupported inspection", async () => {
    const home = tempDirs.make("openclaw-doctor-busctl-absence-");
    const binDir = join(home, "bin");
    const serviceName = "openclaw-gateway-fixture.service";
    const unitPath = join(home, ".config/systemd/user", serviceName);
    writeExecutables(binDir, {
      // Bind fixture identity here: native manager children do not inherit OpenClaw selectors.
      busctl: readFileSync(DOCTOR_SWITCH_BUSCTL_SHIM_PATH, "utf8").replace(
        "process.env.OPENCLAW_SYSTEMD_UNIT",
        JSON.stringify(serviceName),
      ),
      "systemd-exec-start.mjs": readFileSync(DOCTOR_SWITCH_SYSTEMD_EXEC_START_PATH, "utf8"),
    });
    const env = {
      HOME: home,
      PATH: `${binDir}:${process.env.PATH}`,
      OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway-fixture",
      XDG_RUNTIME_DIR: join(home, "runtime"),
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(home, "runtime", "bus")}`,
    };
    const { readSystemdServiceExecStart } =
      await import("../../src/daemon/systemd-service-files.js");
    expect(
      await readSystemdServiceExecStart(env, { requireEffective: true, timeoutMs: 30_000 }),
    ).toBeNull();
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
    const invoke = (args: string[]) =>
      spawnSync(join(binDir, "busctl"), args, { env, encoding: "utf8" });
    const managerVersion = invoke([
      "--user",
      "--auto-start=no",
      "get-property",
      "org.freedesktop.systemd1",
      "/org/freedesktop/systemd1",
      "org.freedesktop.systemd1.Manager",
      "Version",
    ]);
    expect(managerVersion.status, managerVersion.stderr).toBe(0);
    expect(managerVersion.stdout.trim()).toBe('s "252.39-1~deb12u2"');
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
    const command = await readSystemdServiceExecStart(env, {
      requireEffective: true,
      timeoutMs: 30_000,
    });
    expect(command?.sourcePath).toBe(unitPath);
    expect(command?.environment).toEqual({ KEEP: "current" });
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

  it.each(["selected"] as const)(
    "mounts the %s Doctor contract and canonical-path shims from the same checkout",
    (targetMode) => {
      const workDir = tempDirs.make("openclaw-doctor-contract-mounts-");
      const targetRoot =
        targetMode === "selected" ? join(workDir, "selected target") : process.cwd();
      const contractPath = "scripts/e2e/lib/doctor-install-switch";
      const shimNames = ["systemctl", "loginctl", "busctl", "systemd-exec-start.mjs"];
      if (targetMode === "selected") {
        const targetContract = join(targetRoot, contractPath);
        mkdirSync(join(targetContract, "shims"), { recursive: true });
        copyFileSync(DOCTOR_SWITCH_SCENARIO_PATH, join(targetContract, "scenario.sh"));
        for (const name of shimNames) {
          copyFileSync(join(contractPath, "shims", name), join(targetContract, "shims", name));
        }
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
${targetMode === "selected" ? `export OPENCLAW_DOCKER_E2E_REPO_ROOT=${shellQuote(targetRoot)}` : ""}
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
    },
  );

  it("passes installer tag env to bash, not curl", () => {
    const runner = readFileSync(INSTALL_E2E_RUNNER_PATH, "utf8");
    expect(runner).toContain('OPENCLAW_BETA=1 bash "$installer"');
    expect(runner).toContain('OPENCLAW_VERSION="$INSTALL_TAG" bash "$installer"');
    expect(runner).not.toContain('OPENCLAW_BETA=1 curl -fsSL "$INSTALL_URL" | bash');
    expect(runner).not.toContain(
      'OPENCLAW_VERSION="$INSTALL_TAG" curl -fsSL "$INSTALL_URL" | bash',
    );
  });

  it("keeps the plugin binding command escape Docker smoke focused", () => {
    const runner = readFileSync(PLUGIN_BINDING_COMMAND_ESCAPE_DOCKER_E2E_PATH, "utf8");
    const dockerfile = readFileSync(PLUGIN_BINDING_COMMAND_ESCAPE_DOCKERFILE_PATH, "utf8");

    expectTextToIncludeAll(runner, [
      "--reporter=verbose -t",
      'DOCKER_RUN_TIMEOUT="${OPENCLAW_PLUGIN_BINDING_COMMAND_ESCAPE_DOCKER_RUN_TIMEOUT:-900s}"',
      'DOCKER_COMMAND_TIMEOUT="$DOCKER_RUN_TIMEOUT" docker_e2e_docker_run_cmd run --rm',
      "lets authorized (plugin-owned binding commands fall through to command processing|gateway-style plugin commands escape plugin-owned bindings)",
      "keeps unauthorized plugin-owned binding slash replies suppressed while routed to the bound plugin",
      "expected focused Vitest summary for exactly 3 passed tests",
    ]);
    expect(runner).not.toContain("-- --reporter=verbose");

    expect(runner).not.toMatch(/(^|\n)docker run --rm/u);

    expect(runner).not.toContain(
      "keeps unauthorized plugin-owned binding slash text routed to the bound plugin",
    );

    expect(dockerfile).toContain("OPENCLAW_DISABLE_BUNDLED_PLUGIN_POSTINSTALL=1");
    expect(dockerfile).toContain("pnpm install --frozen-lockfile --ignore-scripts\n");
  });
});
