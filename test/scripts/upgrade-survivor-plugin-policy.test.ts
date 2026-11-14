import { mkdirSync, symlinkSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  assertPreservedPluginActivation,
  assertSolePluginPolicy,
  readEnabledPolicyPlugins,
} from "../../scripts/e2e/lib/upgrade-survivor/legacy-operator-plugin-policy.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  readJson,
  runProcess,
  writeExecutable,
  writeJson,
} from "./upgrade-survivor-shard.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const policyScript = "scripts/e2e/lib/upgrade-survivor/legacy-operator-plugin-policy.mjs";
const policySource = `source ${policyScript.replace(/\.mjs$/, ".sh")}`;
const run = (command: string, args: string[], env: NodeJS.ProcessEnv = {}) =>
  runProcess(command, args, { ...process.env, ...env });
const runPolicyShell = (body: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) =>
  run("bash", ["-euo", "pipefail", "-c", `${policySource}\n${body}`, "policy-cell", ...args], env);
function policyPaths() {
  const root = tempDirs.make("openclaw-policy-");
  const source = join(root, "source");
  const artifacts = join(root, "artifacts");
  const prefix = join(root, "npm-prefix");
  const packageRoot = join(prefix, "lib/node_modules/openclaw");
  for (const directory of [source, artifacts, packageRoot, join(prefix, "bin")]) {
    mkdirSync(directory, { recursive: true });
  }
  return { root, source, artifacts, prefix, packageRoot, configPath: join(root, "openclaw.json") };
}

const hooks = { enabled: true, path: "/survivor-hooks", token: "synthetic-survivor-hook-token" };
const specimen = { hooks, plugins: { slots: { memory: "memory-core" } } };
const baseline = { baselineVersion: "2026.9.2", enabledPlugins: ["memory-core", "telegram"] };
const config = {
  plugins: {
    allow: ["memory-core", "telegram"],
    deny: ["device-pair"],
    slots: { memory: "memory-core" },
  },
  channels: { telegram: { enabled: true } },
  hooks,
};
const inventory = (runtime?: { state: string | undefined }) => ({
  plugins: ["memory-core", "telegram", "device-pair"].map((id) => ({
    id,
    installed: true,
    enabled: id !== "device-pair",
    runtime: runtime ? (id === "memory-core" ? runtime : { state: "unloaded" }) : undefined,
  })),
});
const candidateInventory = (state: string | undefined = "active") => inventory({ state });

it("authors the isolated baseline with the existing explicit survivor model route", () => {
  const { root, source, artifacts, prefix, packageRoot, configPath } = policyPaths();
  const provider = {
    baseUrl: "http://127.0.0.1:18888/v1",
    api: "openai-completions",
    apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
    models: [{ id: "gpt-5.6-luna" }],
  };
  writeJson(join(source, "legacy-operator-webhooks.json"), {
    seeded: true,
    baselineVersion: "2026.9.2",
    entry: { enabled: true },
    hooks,
    model: "survivor/gpt-5.6-luna",
    provider,
  });
  writeJson(join(packageRoot, "package.json"), { name: "openclaw", version: "2026.9.2" });
  writeJson(configPath, {});
  writeExecutable(
    join(packageRoot, "openclaw.mjs"),
    `#!${process.execPath}
import fs from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "config" && args[1] === "set") {
  const config = JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH));
  config[args[2]] = JSON.parse(args[3]);
  fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(config));
} else if (args[0] === "config" && args[1] === "validate") {
  console.log(JSON.stringify({ valid: true, warnings: [] }));
} else {
  throw new Error("unexpected fixture command");
}
`,
  );
  symlinkSync("../lib/node_modules/openclaw/openclaw.mjs", join(prefix, "bin/openclaw"));
  const result = run(process.execPath, [policyScript, "seed", source, "2026.9.2"], {
    PATH: `${join(prefix, "bin")}${delimiter}${process.env.PATH ?? ""}`,
    npm_config_prefix: prefix,
    OPENCLAW_STATE_DIR: root,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: artifacts,
  });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const authored = readJson(configPath);
  expect(authored.models.providers.survivor).toEqual(provider);
  expect(authored.agents.defaults.model.primary).toBe("survivor/gpt-5.6-luna");
  expect(authored.plugins.allow).toEqual(["webhooks"]);
});

it("isolates inherited Discord discovery from policy authoring and Gateway startup", () => {
  const { root, artifacts, prefix } = policyPaths();
  writeJson(join(artifacts, "legacy-operator-webhooks.json"), { seeded: true });
  const result = runPolicyShell(
    `ARTIFACT_ROOT="$1"
RUNTIME_ROOT="$2"
npm_config_prefix="$3"
baseline_version=2026.9.2
candidate_version=2026.9.6
assert_policy_env() {
  [ -z "\${DISCORD_BOT_TOKEN+x}" ] || return 1
  [ "$GATEWAY_AUTH_TOKEN_REF" = synthetic-gateway-hook-token ]
  [ "$TELEGRAM_BOT_TOKEN" = synthetic-telegram-token ]
}
node() {
  if [ "$1" != scripts/e2e/lib/upgrade-survivor/legacy-operator-plugin-policy.mjs ]; then command node "$@"; return; fi
  assert_policy_env
  printf '%s\\n' "$2"
}
start_gateway() { assert_policy_env; printf 'gateway\\n'; }
stop_gateway() { :; }
read_installed_version() { printf '2026.9.2\\n'; }
update_candidate() { assert_policy_env; update_outcome=success; update_repair_required=0; }
legacy_operator_plugin_policy capture
legacy_operator_plugin_policy verify
[ "$DISCORD_BOT_TOKEN" = synthetic-discord-token ]
printf 'main-preserved\\n'
`,
    [artifacts, join(root, "runtime"), prefix],
    {
      DISCORD_BOT_TOKEN: "synthetic-discord-token",
      GATEWAY_AUTH_TOKEN_REF: "synthetic-gateway-hook-token",
      TELEGRAM_BOT_TOKEN: "synthetic-telegram-token",
    },
  );
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout.trim().split("\n")).toEqual(
    expect.arrayContaining(["seed", "gateway", "main-preserved"]),
  );
});

it("retains non-9.2 migration ownership", () => {
  const result = runPolicyShell(
    'ARTIFACT_ROOT=unused; RUNTIME_ROOT=unused; npm_config_prefix=unused; baseline_version="$1"; node() { return 97; }; legacy_operator_plugin_policy verify',
    ["2026.9.3"],
  );
  expect(result.status, result.stdout + result.stderr).toBe(0);
});

it("preserves channel and slot policy while rejecting retired or widened permissions", () => {
  const check = (plugins: object = {}, overrides: object = {}) =>
    assertSolePluginPolicy(
      { ...config, ...overrides, plugins: { ...config.plugins, ...plugins } },
      specimen,
      baseline,
    );
  expect(() => check({ allow: ["telegram"] })).not.toThrow();
  const rejects = (plugins: object, error: string, overrides = {}) =>
    expect(() => check(plugins, overrides)).toThrow(error);
  rejects({ enabled: false }, "disabled permitted channel or slot plugins");
  for (const allow of [[], ["memory-core", "telegram", "unrelated"]]) {
    rejects({ allow }, "restrictive plugin allowlist");
  }
  rejects({ entries: { webhooks: { enabled: true } } }, "retired");
  rejects({ deny: ["webhooks", "device-pair"] }, "retired");
  rejects({ deny: [] }, "unrelated plugin denial was removed");
  rejects({ slots: { memory: "none" } }, "selected memory slot changed");
  rejects({}, "ordinary hooks changed", { hooks: { ...hooks, enabled: false } });
  rejects({}, "configured Telegram channel was disabled", {
    channels: { telegram: { enabled: false } },
  });
});

it("reads the actual 9.2 eligibility shape and checks candidate runtime separately", () => {
  const rejects = (actual: unknown, error: string, state = baseline) =>
    expect(() => assertPreservedPluginActivation(actual, state)).toThrow(error);
  expect(readEnabledPolicyPlugins(inventory())).toEqual(baseline.enabledPlugins);
  expect(assertPreservedPluginActivation(candidateInventory(), baseline)).toEqual(["memory-core"]);
  expect(() => readEnabledPolicyPlugins({ plugins: [] })).toThrow(
    "omitted or duplicated installed plugin",
  );
  for (const enabledPlugins of [[], [...baseline.enabledPlugins, "missing-survivor"]]) {
    rejects(candidateInventory(), "widened or lost plugin activation", {
      ...baseline,
      enabledPlugins,
    });
  }
  for (const id of ["memory-core", "device-pair"]) {
    const changed = candidateInventory();
    const plugin = changed.plugins.find((entry) => entry.id === id)!;
    plugin.enabled = !plugin.enabled;
    rejects(changed, "wrong activation policy");
  }
  const widened = candidateInventory();
  widened.plugins.push({ ...candidateInventory().plugins[1]!, id: "unrelated" });
  rejects(widened, "widened or lost plugin activation");
  widened.plugins.at(-1)!.enabled = false;
  widened.plugins.at(-1)!.runtime!.state = "active";
  rejects(widened, "activated forbidden plugin unrelated");
  for (const state of ["service-failed", undefined]) {
    rejects(inventory({ state }), "failed or is unknown");
  }
});
