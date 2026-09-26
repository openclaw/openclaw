import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertPreservedPluginActivation,
  assertSolePluginPolicy,
  readEnabledPolicyPlugins,
} from "../../scripts/e2e/lib/upgrade-survivor/legacy-operator-plugin-policy.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const hooks = { enabled: true, path: "/survivor-hooks", token: "synthetic-survivor-hook-token" };
const specimen = { hooks, plugins: { slots: { memory: "memory-core" } } };
const baseline = { baselineVersion: "2026.9.2", enabledPlugins: ["memory-core", "telegram"] };
const policy = () => ({
  plugins: {
    allow: ["memory-core", "telegram"],
    deny: ["device-pair"],
    slots: { memory: "memory-core" },
  },
  channels: { telegram: { enabled: true } },
  hooks,
});
const baselineInventory = () => ({
  plugins: [
    { id: "memory-core", installed: true, enabled: true, state: "enabled" },
    { id: "telegram", installed: true, enabled: true, state: "enabled" },
    { id: "device-pair", installed: true, enabled: false, state: "disabled" },
  ],
});
const candidateInventory = () => ({
  plugins: baselineInventory().plugins.map((plugin) =>
    Object.assign({}, plugin, {
      runtime: { state: plugin.id === "memory-core" ? "active" : "unloaded" },
    }),
  ),
});

describe("sole-plugin upgrade acceptance", () => {
  it("authors the isolated baseline with the existing explicit survivor model route", () => {
    const root = tempDirs.make("openclaw-policy-route-");
    const source = join(root, "source");
    const artifacts = join(root, "artifacts");
    const prefix = join(root, "npm-prefix");
    const packageRoot = join(prefix, "lib/node_modules/openclaw");
    const configPath = join(root, "openclaw.json");
    for (const directory of [source, artifacts, packageRoot, join(prefix, "bin")]) {
      mkdirSync(directory, { recursive: true });
    }
    const provider = {
      baseUrl: "http://127.0.0.1:18888/v1",
      api: "openai-completions",
      apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
      models: [{ id: "gpt-5.6-luna" }],
    };
    writeFileSync(
      join(source, "legacy-operator-webhooks.json"),
      JSON.stringify({
        seeded: true,
        baselineVersion: "2026.9.2",
        entry: { enabled: true },
        hooks,
        model: "survivor/gpt-5.6-luna",
        provider,
      }),
    );
    writeFileSync(join(packageRoot, "package.json"), '{"name":"openclaw","version":"2026.9.2"}');
    writeFileSync(configPath, "{}");
    writeFileSync(
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
      { mode: 0o755 },
    );
    symlinkSync("../lib/node_modules/openclaw/openclaw.mjs", join(prefix, "bin/openclaw"));
    const result = spawnSync(
      process.execPath,
      [
        "scripts/e2e/lib/upgrade-survivor/legacy-operator-plugin-policy.mjs",
        "seed",
        source,
        "2026.9.2",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${join(prefix, "bin")}${delimiter}${process.env.PATH ?? ""}`,
          npm_config_prefix: prefix,
          OPENCLAW_STATE_DIR: root,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: artifacts,
        },
      },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const authored = JSON.parse(readFileSync(configPath, "utf8"));
    expect(authored.models.providers.survivor).toEqual(provider);
    expect(authored.agents.defaults.model.primary).toBe("survivor/gpt-5.6-luna");
    expect(authored.plugins.allow).toEqual(["webhooks"]);
  });

  it("isolates inherited Discord discovery from policy authoring and Gateway startup", () => {
    const root = tempDirs.make("openclaw-policy-env-");
    const artifacts = join(root, "artifacts");
    const prefix = join(root, "npm-prefix");
    mkdirSync(artifacts);
    mkdirSync(prefix);
    writeFileSync(join(artifacts, "legacy-operator-webhooks.json"), '{"seeded":true}');
    const result = spawnSync(
      "bash",
      [
        "-euo",
        "pipefail",
        "-c",
        `source scripts/e2e/lib/upgrade-survivor/legacy-operator-plugin-policy.sh
ARTIFACT_ROOT="$1"
RUNTIME_ROOT="$2"
npm_config_prefix="$3"
baseline_version=2026.9.2
candidate_version=2026.9.6
assert_policy_env() {
  if [ -n "\${DISCORD_BOT_TOKEN+x}" ]; then
    printf 'inherited Discord discovery reached isolated policy boundary\\n' >&2
    return 1
  fi
  [ "$GATEWAY_AUTH_TOKEN_REF" = synthetic-gateway-hook-token ]
  [ "$TELEGRAM_BOT_TOKEN" = synthetic-telegram-token ]
}
node() {
  if [ "$1" = scripts/e2e/lib/upgrade-survivor/legacy-operator-plugin-policy.mjs ]; then
    assert_policy_env
    printf '%s\\n' "$2"
    return
  fi
  command node "$@"
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
        "policy-cell",
        artifacts,
        join(root, "runtime"),
        prefix,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          DISCORD_BOT_TOKEN: "synthetic-discord-token",
          GATEWAY_AUTH_TOKEN_REF: "synthetic-gateway-hook-token",
          TELEGRAM_BOT_TOKEN: "synthetic-telegram-token",
        },
      },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(
      expect.arrayContaining(["seed", "gateway", "main-preserved"]),
    );
  });

  it.each(["2026.9.3", "2026.9.4"])(
    "leaves the %s historical migration cell with its existing owner",
    (baselineVersion) => {
      const result = spawnSync(
        "bash",
        [
          "-c",
          'set -euo pipefail; source scripts/e2e/lib/upgrade-survivor/legacy-operator-plugin-policy.sh; ARTIFACT_ROOT=unused; RUNTIME_ROOT=unused; npm_config_prefix=unused; baseline_version="$1"; node() { return 97; }; legacy_operator_plugin_policy verify',
          "policy-cell",
          baselineVersion,
        ],
        { encoding: "utf8" },
      );
      expect(result.status, result.stdout + result.stderr).toBe(0);
    },
  );

  it("preserves allowed channel and slot policy without opening the allowlist", () => {
    const config = policy();
    for (const allow of [["telegram"], ["memory-core"], ["memory-core", "telegram"]]) {
      expect(() =>
        assertSolePluginPolicy(
          { ...config, plugins: { ...config.plugins, allow } },
          specimen,
          baseline,
        ),
      ).not.toThrow();
    }
    expect(() =>
      assertSolePluginPolicy(
        { ...config, plugins: { ...config.plugins, enabled: false } },
        specimen,
        baseline,
      ),
    ).toThrow("disabled permitted channel or slot plugins");
    for (const allow of [[], ["memory-core", "telegram", "unrelated"]]) {
      expect(() =>
        assertSolePluginPolicy(
          { ...config, plugins: { ...config.plugins, allow } },
          specimen,
          baseline,
        ),
      ).toThrow("restrictive plugin allowlist");
    }
  });

  it("rejects a retained retired reference or a changed core-hook configuration", () => {
    for (const retained of [
      { entries: { webhooks: { enabled: true } } },
      { deny: ["webhooks", "device-pair"] },
    ]) {
      const config = policy();
      expect(() =>
        assertSolePluginPolicy(
          { ...config, plugins: { ...config.plugins, ...retained } },
          specimen,
          baseline,
        ),
      ).toThrow("retired");
    }
    expect(() =>
      assertSolePluginPolicy(
        { ...policy(), hooks: { ...hooks, enabled: false } },
        specimen,
        baseline,
      ),
    ).toThrow("ordinary hooks changed");
    const config = policy();
    expect(() =>
      assertSolePluginPolicy(
        { ...config, plugins: { ...config.plugins, deny: [] } },
        specimen,
        baseline,
      ),
    ).toThrow("unrelated plugin denial was removed");
    expect(() =>
      assertSolePluginPolicy(
        { ...config, channels: { telegram: { enabled: false } } },
        specimen,
        baseline,
      ),
    ).toThrow("configured Telegram channel was disabled");
    expect(() =>
      assertSolePluginPolicy(
        { ...config, plugins: { ...config.plugins, slots: { memory: "none" } } },
        specimen,
        baseline,
      ),
    ).toThrow("selected memory slot changed");
  });

  it("reads the actual 9.2 eligibility shape and checks candidate runtime separately", () => {
    expect(readEnabledPolicyPlugins(baselineInventory())).toEqual(baseline.enabledPlugins);
    expect(assertPreservedPluginActivation(candidateInventory(), baseline)).toEqual([
      "memory-core",
    ]);
    expect(() => readEnabledPolicyPlugins({ plugins: [] })).toThrow(
      "omitted or duplicated installed plugin",
    );
    expect(() =>
      assertPreservedPluginActivation(candidateInventory(), { ...baseline, enabledPlugins: [] }),
    ).toThrow("widened or lost plugin activation");
    for (const id of ["memory-core", "telegram", "device-pair"]) {
      const changed = candidateInventory();
      const plugin = changed.plugins.find((entry) => entry.id === id)!;
      plugin.enabled = !plugin.enabled;
      expect(() => assertPreservedPluginActivation(changed, baseline)).toThrow(
        "wrong activation policy",
      );
    }
    expect(() =>
      assertPreservedPluginActivation(candidateInventory(), {
        ...baseline,
        enabledPlugins: [...baseline.enabledPlugins, "missing-survivor"],
      }),
    ).toThrow("widened or lost plugin activation");
    const widened = candidateInventory();
    widened.plugins.push({
      id: "unrelated",
      installed: true,
      enabled: true,
      state: "enabled",
      runtime: { state: "unloaded" },
    });
    expect(() => assertPreservedPluginActivation(widened, baseline)).toThrow(
      "widened or lost plugin activation",
    );
    widened.plugins.at(-1)!.enabled = false;
    widened.plugins.at(-1)!.runtime.state = "active";
    expect(() => assertPreservedPluginActivation(widened, baseline)).toThrow(
      "activated forbidden plugin unrelated",
    );
    for (const state of ["service-failed", undefined]) {
      const broken = {
        plugins: candidateInventory().plugins.map((plugin, index) =>
          index === 0 ? Object.assign({}, plugin, { runtime: { state } }) : plugin,
        ),
      };
      expect(() => assertPreservedPluginActivation(broken, baseline)).toThrow(
        "failed or is unknown",
      );
    }
  });
});
