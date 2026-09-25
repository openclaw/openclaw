import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { publishDiagnostics } from "../../scripts/e2e/lib/upgrade-survivor/diagnostics.mjs";
import { resolveDockerE2ePlan } from "../../scripts/lib/docker-e2e-plan.mts";
import { parseUpgradeSurvivorScenarios } from "../../scripts/lib/upgrade-survivor-policy.mjs";
import { redactSensitiveText } from "../../src/logging/redact.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { readUpgradeSurvivorPaths } from "./upgrade-survivor-paths.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const assertionsPath = "scripts/e2e/lib/upgrade-survivor/assertions.mjs";

it("plans the named missing-load-path row without adding aggregate coverage", () => {
  const { plan } = resolveDockerE2ePlan({
    includeOpenWebUI: false,
    liveMode: "all",
    orderLanes: (lanes) => lanes,
    planReleaseAll: false,
    profile: "all",
    releaseChunk: "core",
    selectedLaneNames: ["published-upgrade-survivor"],
    timingStore: undefined,
    upgradeSurvivorBaselines: "2026.9.3",
    upgradeSurvivorScenarios: "missing-load-path",
  });
  expect(plan.lanes).toHaveLength(1);
  expect(plan.lanes[0]).toMatchObject({
    name: "published-upgrade-survivor-2026.9.3-missing-load-path",
    command: expect.stringContaining("OPENCLAW_UPGRADE_SURVIVOR_SCENARIO='missing-load-path'"),
  });
  for (const aggregate of ["reported-issues", "far-reaching"]) {
    expect(parseUpgradeSurvivorScenarios(aggregate)).not.toContain("missing-load-path");
  }
});

it.each(["source", "compiled"])(
  "dispatches missing-load-path stages after loading the %s fixture",
  (loading) => {
    const root = tempDirs.make("openclaw-missing-load-path-dispatch-");
    const configPath = path.join(root, "openclaw.json");
    const paths = readUpgradeSurvivorPaths(root, {
      OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT: root,
      OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: "missing-load-path",
    });
    const artifactRoot = paths.artifactRoot;
    const pluginRoot = path.join(root, "custom-plugins", "survivor-unavailable-path");
    writeFileSync(configPath, JSON.stringify({ plugins: { allow: [], entries: {} } }));
    const env = {
      ...process.env,
      OPENCLAW_CONFIG_PATH: configPath,
      ...paths.env,
      OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: artifactRoot,
    };
    const run = (stage: string) =>
      execFileSync(resolveTestNodeExecPath(), [assertionsPath, "missing-load-path", stage], {
        env,
        encoding: "utf8",
      });

    run("seed");
    expect(existsSync(path.join(pluginRoot, "openclaw.plugin.json"))).toBe(true);
    const seededConfig = readFileSync(configPath, "utf8");
    let entry = path.join(pluginRoot, "index.mjs");
    if (loading === "compiled") {
      const compiledRoot = path.join(root, "compiled-plugin");
      mkdirSync(compiledRoot);
      const compiledEntry = path.join(compiledRoot, "index.mjs");
      copyFileSync(entry, compiledEntry);
      entry = compiledEntry;
    }
    execFileSync(
      resolveTestNodeExecPath(),
      [
        "--input-type=module",
        "-e",
        `const { default: plugin } = await import(${JSON.stringify(pathToFileURL(entry).href)}); plugin.register();`,
      ],
      { env },
    );
    if (loading === "compiled") {
      const receiptPath = path.join(
        artifactRoot,
        "missing-load-path",
        "baseline-registration.json",
      );
      const receipt = readFileSync(receiptPath);
      writeFileSync(receiptPath, JSON.stringify({ registrationToken: "previous-fixture" }));
      expect(() => run("unavailable")).toThrow(
        "The published baseline did not load the configured fixture plugin",
      );
      expect(existsSync(pluginRoot)).toBe(true);
      expect(readFileSync(configPath, "utf8")).toBe(seededConfig);
      writeFileSync(receiptPath, receipt);
    }

    expect(run("unavailable")).toContain("Removed loaded baseline plugin source before update:");
    expect(existsSync(pluginRoot)).toBe(false);
    expect(readFileSync(configPath, "utf8")).toBe(seededConfig);
  },
);

const convergenceRestartMessage =
  "OpenClaw plugin migration inputs changed during startup convergence; refusing to report the gateway ready. Restart OpenClaw so state migrations run against the final config and plugin inventory.";

it.skipIf(process.platform === "win32").each([
  { version: "2026.6.1", provision: true, installExit: 0 },
  { version: "2026.7.1-2", companionVersion: "2026.7.1", provision: true, installExit: 0 },
  { version: "2026.6.35", provision: true, installExit: 0 },
  { version: "2026.7.33", provision: true, installExit: 0 },
  { version: "2026.7.35", provision: true, installExit: 0 },
  { version: "2026.8.1", provision: true, installExit: 0 },
  { version: "2026.8.2", provision: true, installExit: 0 },
  { version: "2026.9.1-beta.1", provision: true, installExit: 0 },
  { version: "2026.9.1", provision: false, installExit: 0 },
  { version: "2026.9.4", provision: false, installExit: 0 },
  { version: "2026.9.5", provision: false, installExit: 0 },
  { version: "2026.8.2", provision: true, installExit: 42 },
])(
  "provisions the published companion cohort for $version (install exit $installExit)",
  ({ version, companionVersion = version, provision, installExit }) => {
    const result = spawnSync(
      "bash",
      [
        "-c",
        `set -euo pipefail
source scripts/e2e/lib/prepublish-plugin-registry.sh
source scripts/e2e/lib/upgrade-survivor/missing-load-path.sh
baseline_version="$1"
SCENARIO=base
UPDATE_RESTART_MODE=manual
ARTIFACT_ROOT=/unused
OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_URL=https://candidate.example.invalid
OPENCLAW_NPM_REGISTRY_UPSTREAM=https://published.example.invalid
NPM_CONFIG_REGISTRY=https://candidate.example.invalid
phase() { shift; "$@"; }
openclaw_e2e_fixture_plugin_command() {
  test "$NPM_CONFIG_REGISTRY" = https://published.example.invalid || return 90
  printf 'install:%s\\n' "$*"
  return ${installExit}
}
start_missing_load_path_baseline() { printf 'start\\n'; }
check_gateway_probes() { :; }
stop_gateway() { :; }
run_missing_load_path_fixture baseline
test "$NPM_CONFIG_REGISTRY" = https://candidate.example.invalid
`,
        "published-companion-cohort",
        version,
      ],
      { encoding: "utf8" },
    );
    expect(result.status, result.stdout + result.stderr).toBe(installExit);
    const plugins = provision ? (installExit ? ["codex"] : ["codex", "discord", "whatsapp"]) : [];
    expect(result.stdout.trim().split("\n")).toEqual([
      ...plugins.map(
        (plugin) =>
          `install:openclaw -- plugins install @openclaw/${plugin}@${companionVersion} --force`,
      ),
      ...(installExit ? [] : ["start"]),
    ]);
  },
);

it.skipIf(process.platform === "win32").each([
  { mode: "ready", code: 0, launches: 1, restarted: false },
  { mode: "convergence-once", code: 0, launches: 2, restarted: true },
  { mode: "convergence-repeated", code: 1, launches: 2, restarted: true },
  { mode: "unrelated", code: 1, launches: 1, restarted: false },
  { mode: "partial-diagnostic", code: 1, launches: 1, restarted: false },
  { mode: "other-exit", code: 1, launches: 1, restarted: false },
  { mode: "live-refusal", code: 1, launches: 1, restarted: false },
  { mode: "timeout", code: 1, launches: 1, restarted: false },
  { mode: "bad-budget", code: 2, launches: 0, restarted: false },
  { mode: "bad-clock", code: 17, launches: 0, restarted: false },
])("handles published baseline provisioning: $mode", ({ mode, code, launches, restarted }) => {
  const root = tempDirs.make("survivor-published-baseline-");
  const bin = path.join(root, "bin");
  const state = path.join(root, "state");
  const artifactRoot = path.join(root, "artifacts");
  const configPath = path.join(state, "openclaw.json");
  const launchFile = path.join(root, "launches.jsonl");
  const readyFile = path.join(root, "ready");
  for (const directory of [bin, state, path.join(artifactRoot, "missing-load-path")]) {
    mkdirSync(directory, { recursive: true });
  }
  const authoredConfig = JSON.stringify({ configuredPluginIntent: "preserve-before-candidate" });
  writeFileSync(configPath, authoredConfig);
  writeFileSync(launchFile, "");
  writeFileSync(
    path.join(bin, "openclaw"),
    `#!${resolveTestNodeExecPath()}
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const env = process.env;
const previous = fs.readFileSync(env.FIXTURE_LAUNCHES, "utf8").trim();
const attempt = previous ? previous.split("\\n").length + 1 : 1;
const args = process.argv.slice(2);
assert.deepEqual(args, ["gateway", "--port", "18789", "--bind", "loopback", "--allow-unconfigured"]);
assert.equal(env.NPM_CONFIG_REGISTRY, "https://published.example.invalid");
assert.equal(env.npm_config_registry, env.NPM_CONFIG_REGISTRY);
assert.equal(env.BUN_CONFIG_REGISTRY, env.NPM_CONFIG_REGISTRY);
const prepared = path.join(env.OPENCLAW_STATE_DIR, "converged-plugin-inputs");
if (attempt > 1) assert.equal(fs.readFileSync(prepared, "utf8"), "published convergence retained");
fs.appendFileSync(env.FIXTURE_LAUNCHES, JSON.stringify({
  attempt, pid: process.pid, config: env.OPENCLAW_CONFIG_PATH, state: env.OPENCLAW_STATE_DIR,
  registry: env.NPM_CONFIG_REGISTRY, args, token: env.OPENCLAW_GATEWAY_TOKEN, password: env.OPENCLAW_GATEWAY_PASSWORD,
}) + "\\n");
const mode = env.FIXTURE_MODE;
if (mode === "live-refusal" || mode === "timeout") {
  fs.writeSync(1, "startup trace detail\\n".repeat(mode === "timeout" ? 16384 : 1024));
  fs.writeSync(1, "startup trace: runtime.plugins.complete 10.0ms token=sk-SyntheticStartupTraceSecret1234567890\\n");
}
if ((mode === "convergence-once" && attempt === 1) || mode === "convergence-repeated" || mode === "other-exit" || mode === "live-refusal") {
  fs.writeFileSync(prepared, "published convergence retained");
  process.stdout.write(env.FIXTURE_RESTART_MESSAGE + "\\n");
  if (mode !== "live-refusal") process.exit(mode === "other-exit" ? 2 : 1);
} else if (mode === "unrelated" || mode === "partial-diagnostic") {
  process.stdout.write(mode === "unrelated" ? "unrelated startup failure\\n" : "OpenClaw plugin migration inputs changed during startup convergence\\n");
  process.exit(1);
} else if (mode !== "timeout") {
  fs.writeFileSync(env.FIXTURE_READY, "ready");
  process.stdout.write("[gateway] ready\\n");
}
process.on("SIGTERM", () => {
  process.stdout.write("Gateway stopped after observation\\n", () => process.exit(0));
});
setInterval(() => {}, 1000);
`,
    { mode: 0o755 },
  );
  const runnerSource = readFileSync("scripts/e2e/lib/upgrade-survivor/run.sh", "utf8");
  const startGateway = runnerSource.slice(
    runnerSource.indexOf("start_gateway() {"),
    runnerSource.indexOf("\nensure_gateway_started() {"),
  );
  const script = path.join(root, "baseline.sh");
  writeFileSync(
    script,
    `#!/usr/bin/env bash
set -Eeuo pipefail
source scripts/lib/openclaw-e2e-instance.sh
source scripts/e2e/lib/prepublish-plugin-registry.sh
source scripts/e2e/lib/upgrade-survivor/missing-load-path.sh
${startGateway}
gateway_pid=""
cleanup() {
  local result="$?"
  trap - EXIT
  openclaw_e2e_stop_process "$gateway_pid"
  exit "$result"
}
trap cleanup EXIT
# Keep the real child/readiness policy, with a short test-only probe window and no host socket.
eval "$(declare -f openclaw_e2e_wait_gateway_ready | sed '1s/openclaw_e2e_wait_gateway_ready/fixture_wait_gateway_ready/')"
openclaw_e2e_wait_gateway_ready() { fixture_wait_gateway_ready "$1" "$2" 4 "$4" "$5"; }
openclaw_e2e_probe_http() { [ -f "$FIXTURE_READY" ]; }
probe_gateway_endpoint() {
  printf '{"body":{"ready":true},"status":200}\\n' >"$3"
}
if [ "$FIXTURE_MODE" = bad-clock ]; then node() { return 17; }; fi
phase() { shift; "$@"; }
check_gateway_probes() { [ -f "$FIXTURE_READY" ]; printf 'baseline-probes\\n'; }
stop_gateway() { openclaw_e2e_stop_process "$gateway_pid"; gateway_pid=""; printf 'baseline-stopped\\n'; }
baseline_version=2026.9.2
SCENARIO=base
UPDATE_RESTART_MODE=manual
run_missing_load_path_fixture baseline
test "$NPM_CONFIG_REGISTRY" = https://candidate.example.invalid
printf 'baseline-complete\\n'
`,
  );
  const result = spawnSync("bash", [script], {
    encoding: "utf8",
    timeout: 10_000,
    env: {
      PATH: `${bin}${path.delimiter}${path.dirname(resolveTestNodeExecPath())}:/usr/bin:/bin`,
      HOME: root,
      ARTIFACT_ROOT: artifactRoot,
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_URL: "https://candidate.example.invalid",
      OPENCLAW_NPM_REGISTRY_UPSTREAM: "https://published.example.invalid",
      NPM_CONFIG_REGISTRY: "https://candidate.example.invalid",
      OPENCLAW_GATEWAY_TOKEN: "fixture-inherited-token",
      OPENCLAW_GATEWAY_PASSWORD: "fixture-inherited-password",
      FIXTURE_MODE: mode,
      FIXTURE_LAUNCHES: launchFile,
      FIXTURE_READY: readyFile,
      FIXTURE_RESTART_MESSAGE: convergenceRestartMessage,
      OPENCLAW_UPGRADE_SURVIVOR_START_BUDGET_SECONDS: mode === "bad-budget" ? "0" : "90",
    },
  });
  expect(result.status, result.stdout + result.stderr).toBe(code);
  const observed = readFileSync(launchFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as {
          pid: number;
          config: string;
          state: string;
          token?: string;
          password?: string;
        },
    );
  expect(observed).toHaveLength(launches);
  expect(new Set(observed.map((entry) => entry.pid)).size).toBe(launches);
  for (const entry of observed) {
    expect(entry).toMatchObject({ config: configPath, state });
    expect(entry.token).toBeUndefined();
    expect(entry.password).toBeUndefined();
  }
  expect(readFileSync(configPath, "utf8")).toBe(authoredConfig);
  const refusedLog = path.join(
    artifactRoot,
    "missing-load-path",
    "baseline-gateway-convergence-refusal.log",
  );
  expect(existsSync(refusedLog)).toBe(restarted);
  if (restarted) {
    expect(readFileSync(refusedLog, "utf8")).toBe(`${convergenceRestartMessage}\n`);
    expect(result.stdout).toContain("restarting once with the same config, state, and port");
  }
  expect(result.stdout.includes("baseline-complete")).toBe(code === 0);
  expect(result.stdout.includes("baseline-probes")).toBe(code === 0);
  expect(result.stdout.includes("baseline-stopped")).toBe(code === 0);
  const gatewayLog = path.join(artifactRoot, "missing-load-path", "baseline-gateway.log");
  const observationLog = path.join(artifactRoot, "missing-load-path", "startup-readiness.log");
  const diagnosticLog = [gatewayLog, observationLog]
    .filter(existsSync)
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  const liveFailure = mode === "live-refusal" || mode === "timeout";
  expect(diagnosticLog.includes("Startup readiness observation after failure")).toBe(liveFailure);
  if (liveFailure) {
    expect(diagnosticLog).toContain('{"body":{"ready":true},"status":200}');
    expect(readFileSync(gatewayLog, "utf8")).toContain("Gateway stopped after observation");
    const captured = spawnSync(
      resolveTestNodeExecPath(),
      [
        "scripts/e2e/lib/upgrade-survivor/diagnostics.mjs",
        "capture",
        artifactRoot,
        "missing-load-path-baseline-start",
        String(result.status),
        "",
        artifactRoot,
      ],
      {
        encoding: "utf8",
        timeout: 10_000,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          OPENCLAW_STATE_DIR: state,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT: root,
        },
      },
    );
    expect(captured.status, captured.stderr).toBe(0);
    const published = path.join(root, "published");
    publishDiagnostics(artifactRoot, published, redactSensitiveText);
    const report = JSON.parse(readFileSync(path.join(published, "failure.json"), "utf8"));
    expect(Object.values(report.logs).join("\n")).toContain('{"body":{"ready":true},"status":200}');
    expect(JSON.stringify(report)).not.toContain("sk-SyntheticStartupTraceSecret1234567890");
    if (mode === "live-refusal") {
      expect(report.logs["missing-load-path/baseline-gateway.log"]).toContain(
        "startup trace: runtime.plugins.complete",
      );
    }
    expect(report.omissions["missing-load-path/baseline-gateway.log"]).toContain(
      mode === "timeout" ? "input exceeds cap" : "truncated at a complete line",
    );
  }
});
