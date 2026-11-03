import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { registryFixture } from "./prepublish-plugin-registry.fixture.js";

const runnerPath = "scripts/e2e/npm-onboard-channel-agent-docker.sh";
const version = "2026.8.1";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const testNodeExecPath = resolveTestNodeExecPath();

type Scenario = {
  consent?: boolean;
  registry?: boolean;
  channel?: "telegram" | "discord" | "slack";
  bundled?: boolean;
  sourcePlugin?: boolean;
  helpFailure?: boolean;
  doctorExitCode?: number;
  dirtyState?: boolean;
};

function writeFixture(file: string, content: string | Record<string, unknown>, executable = false) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content), {
    mode: executable ? 0o755 : undefined,
  });
}

function installArgs(id: string, source: boolean) {
  return [
    "plugins",
    "install",
    ...(source ? [`npm:@openclaw/${id}@${version}`, "--pin"] : [id]),
    "--accept-capabilities",
  ];
}

function runScenario(scenario: Scenario = {}) {
  const root = tempDirs.make("openclaw-onboard-shell-");
  const home = join(root, "home");
  const bin = join(root, "bin");
  const packageRoot = join(root, "package");
  const eventsPath = join(root, "events.jsonl");
  const redactorPath = join(root, "redactor.mjs");
  const channel = scenario.channel ?? "telegram";
  const bundled = scenario.bundled ?? channel === "telegram";
  mkdirSync(join(home, ".openclaw"), { recursive: true });
  if (scenario.dirtyState) {
    writeFixture(join(home, ".openclaw", "existing-state"), "unrelated fixture state");
  }
  mkdirSync(packageRoot);
  writeFixture(eventsPath, "");
  writeFixture(
    redactorPath,
    'export const redactSensitiveText = (text) => text.replaceAll("synthetic-private-doctor", "[redacted]");\n',
  );
  if (bundled) {
    mkdirSync(join(packageRoot, "dist/extensions", channel), { recursive: true });
  }
  const cli = join(bin, "openclaw");
  writeFixture(
    cli,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const env = process.env;
fs.appendFileSync(env.EVENTS, JSON.stringify(args) + "\\n");
const events = fs.readFileSync(env.EVENTS, "utf8").trim().split("\\n").map(JSON.parse);
const current = env.CONSENT === "1";
const fail = (message) => { console.error(message); process.exit(31); };
if (args.includes("--help")) {
  console.log("OpenClaw ${version}\\nUsage: openclaw plugins install [options] <source>");
  if (current) console.log("  --accept-capabilities  Accept reviewed plugin capabilities");
  if (env.HELP_FAILURE === "1") process.exit(29);
} else if (args[0] === "plugins") {
  if (!current) fail("legacy package must retain automatic setup");
  if (!args.includes("--accept-capabilities")) fail("capability consent missing");
  if (args[2] === "codex" || args[2].startsWith("npm:@openclaw/codex@")) {
    if (events.some((event) => event[0] === "onboard")) fail("runtime installed after onboard");
  } else {
    if (!events.some((event) => event[0] === "onboard")) fail("channel installed before onboard");
    installChannelDependency();
  }
} else if (args[0] === "onboard") {
  if (current && !events.some((event) => event[0] === "plugins" && !event.includes("--help"))) {
    fail("required runtime unavailable before onboarding");
  }
} else if (args[0] === "channels" && args[1] === "add" && env.BUNDLED === "0") {
  if (current && !fs.existsSync(dependencyPath())) fail("external channel needs consent first");
  if (!current) installChannelDependency();
} else if (args[0] === "identity") {
  console.log("execution-fixture");
} else if (args[0] === "doctor" && env.DOCTOR_EXIT_CODE) {
  console.error("doctor fixture stopped: synthetic-private-doctor");
  process.exit(Number(env.DOCTOR_EXIT_CODE));
}
function dependencyPath() {
  const dep = { telegram: "grammy", discord: "discord-api-types", slack: "@slack/bolt" }[env.OPENCLAW_NPM_ONBOARD_CHANNEL];
  return path.join(env.HOME, ".openclaw/node_modules", dep, "package.json");
}
function installChannelDependency() {
  const file = dependencyPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{}");
}
`,
    true,
  );
  writeFixture(
    join(bin, "node"),
    `#!/bin/bash
if [ "$1" = scripts/e2e/lib/npm-onboard-channel-agent/assertions.mjs ]; then
  exec "$REAL_NODE" "$FIXTURE_CLI" assertion "\${@:2}"
fi
if [ "$1" = scripts/e2e/lib/npm-onboard-channel-agent/execution-identity.mjs ]; then
  if [ "$2" = clean-home ]; then exec "$REAL_NODE" "$@"; fi
  if [ "$2" = run-id ]; then printf '%s' admitted-run-fixture; exit 0; fi
  # Projection/storage assertions have their own real SQLite support tests.
  [ "$2" = verify ] || exit 0
  exec "$REAL_NODE" "$FIXTURE_CLI" identity "\${@:2}"
fi
exec "$REAL_NODE" "$@"
`,
    true,
  );

  // Execute the actual container program. Only container /tmp paths are mapped
  // into this test's directory; the shared consent/timeout/registry helpers run unchanged.
  const runner = readFileSync(runnerPath, "utf8");
  const containerScript = runner.match(/<<'EOF'; then\n([\s\S]*?)\nEOF\n/u)?.[1];
  if (!containerScript) {
    throw new Error("npm onboarding container program not found");
  }
  const testState = `
OPENCLAW_TEST_STATE_HOME="$HOME"
export OPENCLAW_STATE_DIR="$HOME/.openclaw"
export OPENCLAW_CONFIG_PATH="$OPENCLAW_STATE_DIR/openclaw.json"
openclaw_e2e_install_package() { mkdir -p "$HOME/.openclaw"; }
openclaw_e2e_package_root() { printf '%s' "$PACKAGE_ROOT"; }
openclaw_e2e_package_entrypoint() { printf '%s/openclaw.mjs' "$PACKAGE_ROOT"; }
openclaw_e2e_start_mock_openai() { :; }
openclaw_e2e_wait_mock_openai() { :; }
openclaw_e2e_start_gateway() { "$FIXTURE_CLI" gateway-start; printf '%s' fixture-gateway; }
openclaw_e2e_wait_gateway_ready() { :; }
openclaw_e2e_stop_process() {
  if [ "$1" = fixture-gateway ]; then
    "$FIXTURE_CLI" gateway-stop
  elif [ -n "$1" ]; then
    kill "$1" >/dev/null 2>&1 || true
    wait "$1" >/dev/null 2>&1 || true
  fi
}
`;
  const registryEnv = scenario.registry
    ? registryFixture(root, ["@openclaw/codex", "@openclaw/discord", "@openclaw/slack"], version)
        .env
    : {};
  const result = spawnSync("bash", ["-s"], {
    input: containerScript.replaceAll("/tmp/", `${root}/`),
    encoding: "utf8",
    timeout: 20_000,
    env: {
      HOME: home,
      OPENCLAW_HOME: home,
      PATH: [bin, dirname(testNodeExecPath), process.env.PATH].filter(Boolean).join(delimiter),
      TMPDIR: root,
      REAL_NODE: testNodeExecPath,
      FIXTURE_CLI: cli,
      PACKAGE_ROOT: packageRoot,
      EVENTS: eventsPath,
      CONSENT: scenario.consent === false ? "0" : "1",
      BUNDLED: bundled ? "1" : "0",
      HELP_FAILURE: scenario.helpFailure ? "1" : "0",
      DOCTOR_EXIT_CODE: scenario.doctorExitCode ? String(scenario.doctorExitCode) : "",
      OPENCLAW_E2E_REDACTOR_MODULE: redactorPath,
      OPENCLAW_E2E_COMMAND_TIMEOUT: "5s",
      OPENCLAW_E2E_TIMEOUT_KILL_GRACE_MS: "10",
      OPENCLAW_NPM_ONBOARD_CHANNEL: channel,
      OPENCLAW_NPM_ONBOARD_USE_SOURCE_PLUGIN_PACKAGE: scenario.sourcePlugin ? "1" : "0",
      OPENCLAW_TEST_STATE_SCRIPT_B64: Buffer.from(testState).toString("base64"),
      ...registryEnv,
    },
  });
  const events = readFileSync(eventsPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
  const installs = events.filter((args) => args[0] === "plugins" && !args.includes("--help"));
  const logs = readdirSync(root)
    .filter((file) => file.startsWith("openclaw-") && file.endsWith(".log"))
    .map((file) => readFileSync(join(root, file), "utf8"))
    .join("\n");
  const detail = `${result.stdout}\n${result.stderr}\n${logs}`;
  expect(result.error, detail).toBeUndefined();
  return { result, events, installs, detail };
}

it("publishes redirected Doctor diagnostics with its exit status", () => {
  const { result, events } = runScenario({ doctorExitCode: 124 });
  expect(result.status).toBe(124);
  expect(`${result.stdout}\n${result.stderr}`).toContain("doctor fixture stopped: [redacted]");
  expect(`${result.stdout}\n${result.stderr}`).not.toContain("synthetic-private-doctor");
  expect(events.some((args) => args[0] === "agent")).toBe(false);
});

it("does not load the redactor for empty failure logs", () => {
  const root = tempDirs.make("openclaw-onboard-empty-log-");
  const logPath = join(root, "onboard.json");
  const redactorPath = join(root, "redactor.mjs");
  writeFixture(logPath, "");
  writeFixture(redactorPath, 'throw new Error("empty logs must not load redaction");\n');
  const result = spawnSync(
    "/bin/bash",
    [
      "-c",
      'source "$1"; openclaw_e2e_print_log "$2"',
      "fixture",
      "scripts/lib/openclaw-e2e-instance.sh",
      logPath,
    ],
    { encoding: "utf8", env: { ...process.env, OPENCLAW_E2E_REDACTOR_MODULE: redactorPath } },
  );
  expect(result).toMatchObject({ status: 0, stderr: "", stdout: `--- ${logPath} ---\n` });
});

it.each([false, true])(
  "onboards the reviewed Codex source and audits the turn across restart (registry=%s)",
  (registry) => {
    const { result, events, installs, detail } = runScenario({ registry });
    expect(result.status, detail).toBe(0);
    expect(installs).toEqual([installArgs("codex", registry)]);
    const onboard = events.find((args) => args[0] === "onboard");
    expect(events.indexOf(onboard!)).toBeLessThan(
      events.findIndex((args) => args[1] === "configure-mock-model"),
    );
    const optIn = events.findIndex(
      (args) => args.join(" ") === "config set logging.audit.executionIdentity true",
    );
    const turn = events.findIndex((args) => args[0] === "agent");
    expect(optIn).toBeGreaterThanOrEqual(0);
    expect(optIn).toBeLessThan(turn);
    expect(events.filter((args) => args[0] === "agent")).toHaveLength(1);
    expect(
      events
        .slice(turn + 1)
        .filter((args) =>
          ["gateway-start", "gateway-stop", "audit"].some((name) => name === args[0]),
        )
        .map((args) => args.slice(0, 3)),
    ).toEqual([
      ["gateway-start"],
      ["audit", "--run", "admitted-run-fixture"],
      ["gateway-stop"],
      ["gateway-start"],
      ["audit", "--execution", "execution-fixture"],
      ["gateway-stop"],
    ]);
  },
);

it.each([
  { registry: false, channel: "telegram" as const },
  { registry: true, channel: "slack" as const, sourcePlugin: true },
])("keeps same-version legacy setup automatic: $channel registry=$registry", (scenario) => {
  const { result, installs, detail } = runScenario({ ...scenario, consent: false });
  expect(result.status, detail).toBe(0);
  expect(installs).toEqual([]);
});

it.each([
  { channel: "telegram" as const, bundled: true, sourcePlugin: true },
  { channel: "discord" as const, bundled: true },
  { channel: "discord" as const },
  { channel: "slack" as const, sourcePlugin: true },
])("prepares only the selected external channel: %j", (scenario) => {
  const { result, installs, detail } = runScenario({ ...scenario, registry: true });
  expect(result.status, detail).toBe(0);
  expect(installs.slice(1)).toEqual(
    scenario.bundled ? [] : [installArgs(scenario.channel, scenario.sourcePlugin ?? false)],
  );
});

it.each<[Scenario, string]>([
  [{ dirtyState: true }, "package proof inherited existing state"],
  [
    { channel: "discord", sourcePlugin: true },
    "source channel fixture requires OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR",
  ],
])("rejects invalid fixture admission before any CLI call: %j", (scenario, error) => {
  const { result, events, detail } = runScenario(scenario);
  expect(result.status, detail).not.toBe(0);
  expect(detail).toContain(error);
  expect(events).toEqual([]);
});

it("stops at a failed help probe before mutation", () => {
  const { result, events, detail } = runScenario({ helpFailure: true });
  expect(result.status, detail).toBe(29);
  expect(events).toEqual([["plugins", "install", "--help"]]);
});
