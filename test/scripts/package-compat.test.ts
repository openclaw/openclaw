import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixtureCapabilityConsentArgs } from "../../scripts/e2e/lib/package-compat.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const consent = "--accept-capabilities";
const BASH_BIN = process.platform === "win32" ? "bash" : "/bin/bash";

function writeCandidate(
  root: string,
  options: {
    commands?: string[];
    helpStatus?: number;
    hang?: boolean;
    exitCode?: number;
    preserveUninstallIntent?: boolean;
  } = {},
  name = "candidate.cjs",
) {
  const entry = path.join(root, name);
  writeFileSync(
    entry,
    `
const fs = require('node:fs');
const options = ${JSON.stringify(options)};
const args = process.argv.slice(2);
fs.appendFileSync(process.env.ARGV_LOG, JSON.stringify(args) + '\\n');
const supported = (options.commands ?? ['install', 'enable', 'update']).includes(args[1]);
if (args.includes('--help')) {
  console.log('OpenClaw 2026.8.1\\nOptions:');
  console.log(supported ? '  --accept-capabilities  Accept capabilities' : '  --force  Confirm source');
  if (options.hang) setInterval(() => {}, 1000);
  else process.exit(options.helpStatus ?? 0);
} else {
  if (options.preserveUninstallIntent) {
    const marker = process.env.ARGV_LOG + '.disabled';
    if (args[0] === 'plugins' && args[2] === 'demo-plugin-npm') {
      if (args[1] === 'uninstall') fs.writeFileSync(marker, 'disabled');
      if (args[1] === 'enable') fs.rmSync(marker, { force: true });
    }
    if (args[0] === 'demo-npm' && fs.existsSync(marker)) {
      console.error('OpenClaw does not know the command "demo-npm".');
      process.exit(43);
    }
  }
  const accepted = args.includes('--accept-capabilities');
  if (accepted && !supported) {
    console.error('unknown option --accept-capabilities');
    process.exit(2);
  }
  if (args[2]?.includes('invalid-metadata') || args[2] === 'missing-version') process.exit(41);
  const needsConsent = args[0] === 'plugins' && (args[1] === 'install' ||
    (args[1] === 'enable' && args[2] === 'claude-bundle-e2e') ||
    (args[1] === 'update' && args[2] === 'marketplace-shortcut' && !args.includes('--dry-run')));
  if (supported && needsConsent && !accepted) {
    console.error('requires capability consent');
    process.exit(42);
  }
  console.log('{}');
  process.exit(options.exitCode ?? 0);
}
`,
  );
  return entry;
}

function runCandidate(
  script: string,
  options: Parameters<typeof writeCandidate>[1] = {},
  replacement = false,
) {
  const root = tempDirs.make("openclaw-consent-");
  const entry = writeCandidate(root, options);
  if (replacement) {
    writeCandidate(root, {}, "replacement.cjs");
  }
  const result = spawnSync(BASH_BIN, ["-c", `set -euo pipefail\n${script}`], {
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      HOME: root,
      OPENCLAW_ENTRY: entry,
      OPENCLAW_PLUGINS_TMP_DIR: root,
      KITCHEN_SINK_TMP_DIR: root,
      ARGV_LOG: path.join(root, "argv.jsonl"),
      OPENCLAW_PLUGINS_E2E_CLAWHUB: "0",
      OPENCLAW_PLUGINS_CLI_TIMEOUT: "5s",
      OPENCLAW_TEST_STATE_SCRIPT_B64: Buffer.from(":").toString("base64"),
    },
  });
  const log = path.join(root, "argv.jsonl");
  const calls: string[][] = existsSync(log)
    ? readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];
  return { ...result, calls };
}

function fixtureNode(directory: "plugins" | "kitchen-sink-plugin", extra = "") {
  return `node() {
  case "$1" in
${extra}    scripts/e2e/lib/${directory}/assertions.mjs) return 0 ;;
    *) command node "$@" ;;
  esac
}`;
}

function clawhubScenario(live = true, spec?: string, id?: string, serve = false) {
  return `
export OPENCLAW_PLUGINS_SWEEP_SOURCE_ONLY=1
export OPENCLAW_PLUGINS_E2E_CLAWHUB=1
export OPENCLAW_PLUGINS_E2E_LIVE_CLAWHUB=${live ? "1" : "0"}
${spec ? `export OPENCLAW_PLUGINS_E2E_CLAWHUB_SPEC=${spec}` : "unset OPENCLAW_PLUGINS_E2E_CLAWHUB_SPEC"}
${id ? `export OPENCLAW_PLUGINS_E2E_CLAWHUB_ID=${id}` : "unset OPENCLAW_PLUGINS_E2E_CLAWHUB_ID"}
source scripts/e2e/lib/plugins/sweep.sh
${
  spec || serve
    ? fixtureNode(
        "plugins",
        serve
          ? `    scripts/e2e/lib/clawhub-fixture-server.cjs)
      printf '12345\\n' > "$3"
      while true; do sleep 1; done
      ;;
`
          : "",
      )
    : ""
}
run_plugins_clawhub_scenario
`;
}

const installsFor = (calls: string[][]) =>
  calls.filter((args) => args[1] === "install" && !args.includes("--help"));

const fixtureCommand = `
source scripts/lib/openclaw-e2e-instance.sh
openclaw_e2e_fixture_plugin_command openclaw_e2e_maybe_timeout 5s node "$OPENCLAW_ENTRY" --
`.trim();

// Replace artifact construction and inventory assertions, not the CLI runner or scenario order.
const sweepFixtureLoader = `
source() {
  if [[ "$1" == scripts/e2e/lib/plugins/fixtures.sh ]]; then
    pack_fixture_archive() { :; }
    pack_fixture_plugin_with_invalid_extension_entry() { :; }
    start_npm_fixture_registry() { :; }
    openclaw_plugins_cleanup_fixture_servers() { :; }
  else
    builtin source "$@"
  fi
}
${fixtureNode("plugins", '    scripts/e2e/lib/fixture.mjs) mkdir -p "$3" ;;\n')}
git() { printf 'fixture-commit\\n'; }
source scripts/e2e/lib/plugins/sweep.sh
`;

const kitchenFixtureLoader = `
export KITCHEN_SINK_SWEEP_SOURCE_ONLY=1
source scripts/e2e/lib/kitchen-sink-plugin/sweep.sh
${fixtureNode("kitchen-sink-plugin")}
KITCHEN_SINK_LABEL=fixture
KITCHEN_SINK_ID=fixture-id
KITCHEN_SINK_SPEC=fixture-spec
KITCHEN_SINK_PREINSTALL_SPEC=preinstall-spec
KITCHEN_SINK_SOURCE=npm
run_success_scenario
KITCHEN_SINK_SPEC=missing-version
run_failure_scenario
`;

describe("package fixture consent compatibility", () => {
  describe.each([true, false])("consent support=%s", (supported) => {
    const run = (script: string, options: Parameters<typeof writeCandidate>[1] = {}) => {
      const result = runCandidate(script, { commands: supported ? undefined : [], ...options });
      expect(result.status, result.stderr).toBe(0);
      return result.calls;
    };
    it("runs the plugin sweep with selective consent", () => {
      const calls = run(sweepFixtureLoader, { preserveUninstallIntent: true });
      const mutations = calls.filter((args) => args[0] === "plugins" && !args.includes("--help"));
      expect(installsFor(mutations)).toHaveLength(12);
      for (const args of mutations) {
        const positive =
          (args[1] === "install" && !args.some((arg) => arg.includes("invalid-metadata"))) ||
          args[1] === "enable" ||
          (args[1] === "update" &&
            args[2] === "marketplace-shortcut" &&
            !args.includes("--dry-run"));
        expect(args.includes(consent), args.join(" ")).toBe(supported && positive);
      }
      expect(mutations.filter((args) => args[1] === "update")).toHaveLength(5);
      expect(mutations.filter((args) => args[1] === "enable").map((args) => args[2])).toEqual([
        "demo-plugin-npm",
        "claude-bundle-e2e",
      ]);
    });

    it("runs kitchen-sink success and registry failure", () => {
      const calls = run(kitchenFixtureLoader);
      const installs = installsFor(calls);
      expect(installs.map((args) => [args[2], args.includes(consent)])).toEqual([
        ["preinstall-spec", supported],
        ["fixture-spec", supported],
        ["missing-version", false],
      ]);
      expect(calls.find((args) => args[1] === "enable")).not.toContain(consent);
    });

    it("consents to ClawHub install but not unchanged update", () => {
      const calls = run(
        clawhubScenario(true, "clawhub:@example/consent-fixture", "consent-fixture"),
      );
      expect(installsFor(calls)[0]?.includes(consent)).toBe(supported);
      expect(calls.find((args) => args[1] === "update")).not.toContain(consent);
    });
  });

  it("probes each command and preserves literal argv", () => {
    const result = runCandidate(
      `${fixtureCommand} plugins install 'file:a b/$(literal)' --force ''
${fixtureCommand} plugins enable fixture
${fixtureCommand} plugins update fixture`,
      { commands: ["install", "update"] },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toEqual([
      ["plugins", "install", "--help"],
      ["plugins", "install", "file:a b/$(literal)", "--force", "", consent],
      ["plugins", "enable", "--help"],
      ["plugins", "enable", "fixture"],
      ["plugins", "update", "--help"],
      ["plugins", "update", "fixture", consent],
    ]);
  });

  it("requires an explicit package identity for live ClawHub E2E", () => {
    const result = runCandidate(clawhubScenario());

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("the Kitchen Sink listing has been retired");
  });

  it.each([
    [false, "openclaw-kitchen-sink-fixture", "clawhub:@openclaw/plugin-e2e-fixture"],
    [true, "custom-plugin", "clawhub:@example/custom-plugin"],
  ] as const)("selects the ClawHub identity (live=%s)", (live, expectedId, expectedSpec) => {
    const result = runCandidate(
      clawhubScenario(live, live ? expectedSpec : undefined, live ? expectedId : undefined, true),
    );

    expect(result.status, result.stderr).toBe(0);
    const install = installsFor(result.calls)[0];
    expect(install?.[2]).toBe(expectedSpec);
    expect(result.calls.filter((args) => args[1] === "inspect").map((args) => args[2])).toEqual([
      expectedId,
      expectedId,
    ]);
    expect(result.calls.find((args) => args[1] === "update")?.[2]).toBe(expectedId);
    expect(result.calls.find((args) => args[1] === "uninstall")?.[2]).toBe(expectedSpec);
  });

  it.each([
    ["  \u001b[32m--accept-capabilities\u001b[0m  Accept\n", [consent]],
    ["  --accept-capabilities-extra  Other\n", []],
    ["See --accept-capabilities in newer releases\n", []],
  ])("reads only an advertised option from help %j", (help, expected) => {
    expect(fixtureCapabilityConsentArgs(help)).toEqual(expected);
  });

  it.each([
    ["plugins", "error"],
    ["plugins", "timeout"],
    ["kitchen-sink", "error"],
    ["kitchen-sink", "timeout"],
  ])("%s logger fails before mutation on help %s", (suite, failure) => {
    const prefix = suite === "plugins" ? "OPENCLAW_PLUGINS" : "KITCHEN_SINK";
    const directory = suite === "plugins" ? "plugins" : "kitchen-sink-plugin";
    const runner = suite === "plugins" ? "plugins" : "kitchen_sink";
    const result = runCandidate(
      `
export ${prefix}_SWEEP_SOURCE_ONLY=1
export ${prefix}_CLI_TIMEOUT=1s
source scripts/e2e/lib/${directory}/sweep.sh
run_${runner}_fixture_logged failure plugins install fixture --force
`,
      failure === "error" ? { helpStatus: 47 } : { hang: true },
    );
    expect(result.status, result.stderr).toBe(failure === "error" ? 47 : 124);
    expect(result.stdout + result.stderr).toContain("help probe failed");
    expect(result.calls).toEqual([["plugins", "install", "--help"]]);
  });

  it("returns the mutation exit status", () => {
    const result = runCandidate(`${fixtureCommand} plugins install fixture`, { exitCode: 49 });
    expect(result.status).toBe(49);
    expect(result.calls.at(-1)).toEqual(["plugins", "install", "fixture", consent]);
  });

  it("reprobes a replacement at the same executable path and version", () => {
    const result = runCandidate(
      `${fixtureCommand} plugins install fixture
cp "$HOME/replacement.cjs" "$OPENCLAW_ENTRY"
${fixtureCommand} plugins install fixture`,
      { commands: [] },
      true,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toEqual([
      ["plugins", "install", "--help"],
      ["plugins", "install", "fixture"],
      ["plugins", "install", "--help"],
      ["plugins", "install", "fixture", consent],
    ]);
  });
});
