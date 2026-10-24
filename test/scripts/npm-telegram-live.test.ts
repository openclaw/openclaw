import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import YAML from "yaml";
import { resolveFrozenTelegramScenarioOmissions } from "../../scripts/e2e/lib/npm-telegram-live/resolve-target-scenarios.mts";
import { testing } from "../../scripts/e2e/npm-telegram-live-runner.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const DOCKER_SCRIPT_PATH = path.resolve(TEST_DIR, "../../scripts/e2e/npm-telegram-live-docker.sh");
const PREPARE_PACKAGE_PATH = path.resolve(
  TEST_DIR,
  "../../scripts/e2e/lib/npm-telegram-live/prepare-package.mts",
);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const script = readFileSync(DOCKER_SCRIPT_PATH, "utf8");
const exactMarker = "telegram-reply-chain-exact-marker";

const mkTempRoot = () => tempDirs.make("openclaw-npm-telegram-live-");

function frozenSource(files: Record<string, string>) {
  // The resolver writes overlays beside the checkout; keep both under tracked cleanup.
  const fixtureRoot = mkTempRoot();
  const root = path.join(fixtureRoot, "target");
  mkdirSync(root);
  for (const [file, source] of Object.entries(files)) {
    writeFixture(root, file, source);
  }
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  git("add", ".");
  git(...gitIdentity, "commit", "-qm", "target", "--allow-empty");
  const sha = git("rev-parse", "HEAD");
  const output = path.join(fixtureRoot, "github.env");
  const qualify = (selectedSha = sha) => {
    execFileSync(process.execPath, [resolver, root], {
      env: { ...process.env, OPENCLAW_SELECTED_SHA: selectedSha, GITHUB_ENV: output },
      stdio: "pipe",
    });
    return Object.fromEntries(
      read(output)
        .trim()
        .split("\n")
        .map((line) => line.split(/[=](.*)/su, 2)),
    );
  };
  return { sha, qualify };
}

function writeFixture(
  root: string,
  relativePath: string,
  source: string | Record<string, unknown>,
) {
  const file = path.join(root, relativePath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof source === "string" ? source : JSON.stringify(source));
  return file;
}

function runHotpathCandidate(consentSupported: boolean) {
  const root = mkTempRoot();
  const hotpath = script.slice(
    script.indexOf('if [ "${OPENCLAW_NPM_TELEGRAM_SKIP_HOTPATH:-0}" != "1" ]'),
    script.indexOf('\nexport OPENCLAW_NPM_TELEGRAM_SUT_COMMAND="$sut_command"'),
  );
  writeFileSync(
    path.join(root, "openclaw"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$ARGV_LOG"; if [[ "$*" == "plugins install --help" && "$CONSENT_SUPPORTED" == "1" ]]; then printf '  --accept-capabilities  Accept reviewed plugin capabilities\\n'; fi
`,
    { mode: 0o755 },
  );
  execFileSync(
    "bash",
    [
      "-c",
      `set -Eeuo pipefail
source scripts/lib/openclaw-e2e-instance.sh
openclaw_e2e_run_command() { "$@"; }
runtime_home="$FIXTURE_ROOT/runtime"
mkdir -p "$runtime_home"
sut_command="$FIXTURE_ROOT/openclaw"
${hotpath}`,
    ],
    {
      cwd: path.resolve(TEST_DIR, "../.."),
      env: {
        ...process.env,
        ARGV_LOG: path.join(root, "argv.log"),
        CONSENT_SUPPORTED: consentSupported ? "1" : "0",
        FIXTURE_ROOT: root,
      },
    },
  );
  return readFileSync(path.join(root, "argv.log"), "utf8").trim().split("\n");
}

it("keeps bounded installation and redacted runtime logging", () => {
  expect(script).toMatch(
    /"\$timeout_bin" (?:--kill-after=\S+ )?"\$npm_install_timeout" npm install/u,
  );
  expect(script).not.toContain('cat "$run_log"');
});

it("uses unique direct-run output dirs by default", () => {
  const root = mkTempRoot();
  const firstDir = testing.resolvePackageTelegramOutputDir({}, root);
  const secondDir = testing.resolvePackageTelegramOutputDir({}, root);

  expect(path.dirname(firstDir)).toBe(path.join(root, ".artifacts", "qa-e2e"));
  expect(path.basename(firstDir)).toMatch(/^npm-telegram-live-[a-z0-9]+-[a-f0-9]{8}$/u);
  expect(secondDir).not.toBe(firstDir);
  expect(
    testing.resolvePackageTelegramOutputDir(
      { OPENCLAW_NPM_TELEGRAM_OUTPUT_DIR: ".artifacts/custom" },
      root,
    ),
  ).toBe(".artifacts/custom");
});

it("keeps the installed OpenClaw command as the package SUT", async () => {
  const prefix = mkTempRoot();
  const command = path.join(prefix, "bin", "openclaw");
  const harnessCommand = path.join(mkTempRoot(), "bin", "openclaw");
  for (const executable of [command, harnessCommand]) {
    mkdirSync(path.dirname(executable), { recursive: true });
    writeFileSync(executable, "#!/bin/sh\n", { mode: 0o755 });
  }
  const env = { NPM_CONFIG_PREFIX: prefix };

  await expect(testing.resolveTrustedOpenClawCommand(command, env)).resolves.toEqual({
    executablePath: command,
    usePackagedPlugins: true,
  });
  await expect(testing.resolveTrustedOpenClawCommand(harnessCommand, env)).rejects.toThrow(
    "OPENCLAW_NPM_TELEGRAM_SUT_COMMAND must resolve inside NPM_CONFIG_PREFIX.",
  );
});

it("requires Convex leases instead of static credentials", () => {
  const { result, runs } = captureDocker({
    OPENCLAW_NPM_TELEGRAM_CREDENTIAL_SOURCE: "env",
    OPENCLAW_NPM_TELEGRAM_SKIP_CREDENTIAL_PREFLIGHT: "0",
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Telegram package QA requires Convex credential mode.");
  expect(runs).toEqual([]);
});

it.each([false, true])(
  "runs the onboarding hotpath with candidate consent support=%s",
  (supported) => {
    const calls = runHotpathCandidate(supported);
    expect(calls.filter((call) => call.startsWith("plugins install @openclaw/codex"))).toEqual(
      supported ? ["plugins install @openclaw/codex --accept-capabilities"] : [],
    );
    expect(calls.some((call) => call.startsWith("onboard "))).toBe(true);
  },
);

it("adds loadable private SDK exports without replacing existing harness exports", () => {
  const root = mkTempRoot();
  const harnessManifestPath = path.join(root, "package.json");
  const existingGatewayExport = {
    types: "./existing/gateway-runtime.d.ts",
    default: "./existing/gateway-runtime.js",
  };
  writeFixture(root, "package.json", {
    name: "openclaw",
    type: "module",
    exports: {
      "./kept": "./dist/kept.js",
      "./plugin-sdk/gateway-runtime": existingGatewayExport,
    },
  });

  execFileSync(process.execPath, [PREPARE_PACKAGE_PATH, harnessManifestPath]);

  const prepared = JSON.parse(readFileSync(harnessManifestPath, "utf8")) as {
    exports: Record<string, unknown>;
  };
  expect(prepared.exports["./kept"]).toBe("./dist/kept.js");
  expect(prepared.exports["./plugin-sdk/gateway-runtime"]).toEqual(existingGatewayExport);
  writeFixture(root, "dist/plugin-sdk/qa-lab.js", "export const harnessOnly = true;\n");
  // Resolve the private manifest with Node, without the test runner's source SDK aliases.
  const loader = writeFixture(
    root,
    "load-private.mjs",
    `import assert from "node:assert/strict";
assert.equal((await import("openclaw/plugin-sdk/qa-lab")).harnessOnly, true);`,
  );
  execFileSync(process.execPath, [loader], { cwd: root });
});

it.each([
  ["SOURCE", "convex", "env", testing.resolveCredentialSource],
  ["ROLE", "ci", "maintainer", testing.resolveCredentialRole],
] as const)("lets npm credential %s override shared QA env", (key, selected, shared, resolve) => {
  expect(
    resolve({
      [`OPENCLAW_NPM_TELEGRAM_CREDENTIAL_${key}`]: selected,
      [`OPENCLAW_QA_CREDENTIAL_${key}`]: shared,
    }),
  ).toBe(selected);
});

it("maps repeated RTT env onto package Telegram live options", () => {
  expect(
    testing.resolveRttOptions({
      OPENCLAW_NPM_TELEGRAM_RTT_SAMPLES: "7",
      OPENCLAW_NPM_TELEGRAM_RTT_TIMEOUT_MS: "45000",
      OPENCLAW_NPM_TELEGRAM_RTT_MAX_FAILURES: "2",
      OPENCLAW_NPM_TELEGRAM_RTT_CHECKS: "channel-canary",
    }),
  ).toEqual({
    scenarioId: "channel-canary",
    count: 7,
    timeoutMs: 45_000,
    maxFailures: 2,
  });
});

it.each([
  ["selects the explicit RTT scenario", undefined, [exactMarker], [exactMarker]],
  [
    "promotes RTT while deduplicating in order",
    `telegram-status-command,${exactMarker},telegram-status-command`,
    [exactMarker, "telegram-status-command", "telegram-status-command"],
    [exactMarker, "telegram-status-command"],
  ],
] as const)("%s", (_name, scenarios, requested, resolved) => {
  const env = {
    OPENCLAW_NPM_TELEGRAM_RTT_CHECKS: exactMarker,
    OPENCLAW_NPM_TELEGRAM_SCENARIOS: scenarios,
  };
  const seenScenarioIds: string[][] = [];
  const selection = testing.resolvePackageTelegramScenarios(env, (scenarioIds) => {
    seenScenarioIds.push([...scenarioIds]);
    return [...new Set(scenarioIds)];
  });

  expect(selection).toEqual({
    explicitRttScenarioId: exactMarker,
    scenarioIds: requested,
    resolvedScenarioIds: resolved,
  });
  expect(seenScenarioIds).toEqual([requested]);
  expect(testing.resolveRttOptions(env, selection.scenarioIds)).toMatchObject({
    scenarioId: exactMarker,
  });
});

it("qualifies default scenarios but preserves explicit selection", () => {
  const supported = "telegram-policy-hot-reload";
  const omitted = "telegram-group-policy-hot-reload";
  const { qualify } = frozenSource({
    [`qa/scenarios/channels/${supported}.yaml`]: `id: ${supported}`,
  });
  const env = qualify();
  const resolve = (ids: readonly string[]) => (ids.length ? [...ids] : [supported, omitted]);
  expect(testing.resolvePackageTelegramScenarios(env, resolve).resolvedScenarioIds).toEqual([
    supported,
  ]);
  for (const key of ["OPENCLAW_NPM_TELEGRAM_SCENARIOS", "OPENCLAW_NPM_TELEGRAM_RTT_CHECKS"]) {
    expect(
      testing.resolvePackageTelegramScenarios({ ...env, [key]: omitted }, resolve)
        .resolvedScenarioIds,
    ).toEqual([omitted]);
  }
  expect(() => qualify("0".repeat(40))).toThrow(
    "frozen Telegram source checkout does not match package source SHA",
  );
});

it("combines only the unsupported frozen Telegram scenario contracts", () => {
  const root = mkTempRoot();
  const writeOwner = (file: string, source: string) => writeFixture(root, file, source);
  writeOwner("src/agents/embedded-agent-subscribe.ts", "void params.onPartialReply(data);");
  writeOwner("extensions/telegram/src/draft-stream.ts", "flush: loop.flush,");
  writeOwner(
    "extensions/telegram/src/bot-message-dispatch.ts",
    "enqueueDraftLaneEvent(async () => {});",
  );

  const partial = "telegram-partial-failure-recovery";
  const sourceGated = "telegram-prepared-delivery-recovery";
  expect(resolveFrozenTelegramScenarioOmissions(root)).toEqual(
    expect.arrayContaining([partial, sourceGated]),
  );
  writeOwner("extensions/telegram/src/draft-stream.ts", "waitForInFlight();");
  expect(resolveFrozenTelegramScenarioOmissions(root)).not.toContain(partial);
  writeOwner(`qa/scenarios/channels/${sourceGated}.yaml`, `id: ${sourceGated}\n`);
  expect(resolveFrozenTelegramScenarioOmissions(root)).not.toContain(sourceGated);
});

it("rejects multiple explicit RTT scenario ids", () => {
  expect(() =>
    testing.resolvePackageTelegramScenarioSelection({
      OPENCLAW_NPM_TELEGRAM_RTT_CHECKS: `channel-canary,${exactMarker}`,
    }),
  ).toThrow("OPENCLAW_NPM_TELEGRAM_RTT_CHECKS accepts at most one scenario id; got 2");
});

it("continues the selected scenario with the leased primary participant", () => {
  const probe = testing.createRoundTripProbe(testing.resolveRttOptions({}));

  expect(probe).toMatchObject({
    scenarioId: "channel-canary",
    count: 20,
    timeoutMs: 30_000,
    markerPrefix: "QA-TELEGRAM-RTT",
    textPrefix: "@openclaw Telegram RTT check. Reply exactly: ",
    chainReplies: true,
    input: { fromScenario: true, senderId: "primary" },
  });
});

it.each([
  [
    "keeps focused non-RTT selections unchanged",
    ["telegram-status-command"],
    ["telegram-status-command"],
  ],
  [
    "does not duplicate an already selected RTT canary",
    ["telegram-status-command", "channel-canary"],
    ["channel-canary", "telegram-status-command"],
  ],
] as const)("%s", (_name, requested, expected) => {
  const options = testing.resolveRttOptions({}, requested);

  expect(testing.prioritizeRoundTripProbeScenario(requested, options)).toEqual(expected);
});

it("rejects invalid repeated RTT env", () => {
  expect(() =>
    testing.resolveRttOptions({
      OPENCLAW_NPM_TELEGRAM_RTT_SAMPLES: "7samples",
    }),
  ).toThrow("invalid OPENCLAW_NPM_TELEGRAM_RTT_SAMPLES: 7samples");
});

it("projects current config for historical package 2026.7.2-beta.3", () => {
  const mutateConfig = testing.resolvePackageConfigMutation({
    OPENCLAW_NPM_TELEGRAM_PACKAGE_VERSION: "2026.7.2-beta.3",
  });
  const defaults = {
    workspace: "/tmp/qa",
    models: { "openai/gpt-5.6-luna": { alias: "qa", agentRuntime: { id: "openclaw" } } },
  };
  const memory = { backend: "builtin", citations: "off", qmd: { command: "qmd" } };
  const config = {
    agents: {
      defaults: {
        ...structuredClone(defaults),
        modelPolicy: { allow: ["openai/gpt-5.6-luna"] },
      },
      entries: { qa: { model: "mock-openai/qa" } },
    },
    memory: { ...structuredClone(memory), search: { enabled: false } },
    plugins: { enabled: true },
  } as Parameters<NonNullable<typeof mutateConfig>>[0];

  expect(mutateConfig?.(config)).toEqual({
    agents: {
      defaults,
      list: [{ id: "qa", model: "mock-openai/qa" }],
    },
    memory,
    plugins: config.plugins,
  });
  expect(config.agents).toHaveProperty("entries.qa");
  expect(config.memory).toHaveProperty("search.enabled", false);
});

it.each(["2026.7.2", "main"])(
  "leaves current or nonexact package version %s unchanged",
  (packageVersion) => {
    expect(
      testing.resolvePackageConfigMutation({
        OPENCLAW_NPM_TELEGRAM_PACKAGE_VERSION: packageVersion,
      }),
    ).toBeUndefined();
  },
);

it.each([
  ["passes when every scenario passes", "", true],
  ["does not read missing summaries when failures are allowed", "1", false],
] as const)("%s", async (_name, allowFailures, hasSummary) => {
  const summaryPath = path.join(mkTempRoot(), "qa-suite-summary.json");
  if (hasSummary) {
    writeFixture(path.dirname(summaryPath), path.basename(summaryPath), {
      run: { status: "completed" },
      scenarios: [{ status: "pass" }],
    });
  }

  await expect(
    testing.shouldFailPackageTelegramRun(
      { summaryPath },
      { OPENCLAW_NPM_TELEGRAM_ALLOW_FAILURES: allowFailures },
    ),
  ).resolves.toBe(false);
});

const scenarioPath = "qa/scenarios/channels/telegram-repeated-command-authorization.yaml";
const trusted = readFileSync(path.join(repoRoot, scenarioPath), "utf8");
const silent = "              - waitForNoOutbound:\n                  quietMs: 3000\n";
const explicit =
  "              - waitForOutbound:\n" +
  "                  conversation: { id: telegram-command-room, kind: channel }\n" +
  "                  textIncludes: You are not authorized to use this command.\n" +
  "                  timeoutMs: 60000\n";
const read = (file: string) => readFileSync(file, "utf8");
const gitIdentity = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test"];
const resolver = path.join(
  repoRoot,
  "scripts/e2e/lib/npm-telegram-live/resolve-target-scenarios.mts",
);

function resolveFixture(source: string, selectedSha?: string) {
  const { sha, qualify } = frozenSource({ [scenarioPath]: source });
  return { sha, env: qualify(selectedSha) };
}

function captureSuiteMounts(overlay?: string) {
  const { result, runs } = captureDocker({ OPENCLAW_NPM_TELEGRAM_COMMAND_SCENARIO: overlay ?? "" });
  assert.equal(result.status, 0, result.stderr);
  return runs[1]!;
}

it("mounts a source-qualified trusted denial action without changing restored command proof", () => {
  // Frozen YAML selects the contract but must never supply executable expressions.
  const { sha, env } = resolveFixture(
    trusted.replace(silent, explicit).replace("title:", "# target-only-untrusted-content\ntitle:"),
  );
  const overlay = env.OPENCLAW_NPM_TELEGRAM_COMMAND_SCENARIO;
  assert.ok(overlay);
  const actual = read(overlay);
  expect(actual).toContain(`# Frozen package source ${sha}: explicit authorization denial.`);
  expect(actual).not.toContain("target-only-untrusted-content");
  expect(YAML.parse(actual)).toEqual(YAML.parse(trusted.replace(silent, explicit)));
  expect(env.OPENCLAW_NPM_TELEGRAM_OMIT_DEFAULT_SCENARIOS).not.toContain(
    "telegram-repeated-command-authorization",
  );
  const mounts = captureSuiteMounts(overlay);
  const baseIndex = mounts.indexOf(`${repoRoot}/qa/scenarios:/app/qa/scenarios:ro`);
  expect(baseIndex).toBeGreaterThan(0);
  expect(mounts.indexOf(`${overlay}:/app/${scenarioPath}:ro`)).toBeGreaterThan(baseIndex);
});

it("keeps current silent denial on the normal trusted scenario mount", () => {
  const { env } = resolveFixture(trusted);
  expect(env.OPENCLAW_NPM_TELEGRAM_COMMAND_SCENARIO).toBeUndefined();
  expect(captureSuiteMounts().filter((arg) => arg.includes(scenarioPath))).toEqual([]);
});

it("refuses unknown source contracts and mismatched selected source identities", () => {
  expect(() => resolveFixture(trusted.replace(silent, ""))).toThrow();
  expect(() => resolveFixture(trusted.replace(silent, explicit), "0".repeat(40))).toThrow();
  expect(() => captureSuiteMounts("/missing/frozen-scenario.yaml")).toThrow();
});

const scenario = "telegram-published-upgrade-bindings";
const published = "openclaw@2026.9.6";
const candidatePath = "/package-under-test/candidate.tgz";
function upgradeFixture() {
  const root = tempDirs.make("openclaw-telegram-upgrade-");
  const candidate = path.join(root, "candidate.tgz");
  writeFileSync(candidate, "package fixture");
  const executable = (name: string, source: string) =>
    writeFileSync(path.join(root, name), source, { mode: 0o755 });
  const run = (env: NodeJS.ProcessEnv, args = [DOCKER_SCRIPT_PATH]) =>
    spawnSync("bash", args, {
      encoding: "utf8",
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${root}${path.delimiter}${process.env.PATH}`,
        OPENCLAW_NPM_TELEGRAM_PACKAGE_TGZ: candidate,
        OPENCLAW_NPM_TELEGRAM_PACKAGE_DIR: "",
        OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR: "",
        OPENCLAW_NPM_TELEGRAM_PROVIDER_MODE: "mock-openai",
        OPENCLAW_NPM_TELEGRAM_PACKAGE_SPEC: published,
        ...env,
      },
    });
  return { root, candidate, executable, run };
}

it.each([false, true])("uses the published registry only for baseline install=%s", (baseline) => {
  const { executable, run } = upgradeFixture();
  const start = script.indexOf('npm_install_timeout="');
  const install = script.slice(start, script.indexOf("\ncommand -v openclaw", start));
  executable("npm", '#!/bin/bash\nprintf "%s" "$NPM_CONFIG_REGISTRY"\n');
  const result = run(
    {
      OPENCLAW_E2E_NPM_INSTALL_TIMEOUT: "0",
      OPENCLAW_NPM_TELEGRAM_INSTALL_PUBLISHED_BASELINE: baseline ? "1" : "0",
      OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_URL: "https://candidate.invalid",
      OPENCLAW_NPM_REGISTRY_UPSTREAM: "https://registry.npmjs.org",
      NPM_CONFIG_REGISTRY: "https://candidate.invalid",
    },
    [
      "-c",
      `set -euo pipefail\nsource scripts/e2e/lib/prepublish-plugin-registry.sh\ninstall_source=${published}\n${install}`,
    ],
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe(baseline ? "https://registry.npmjs.org" : "https://candidate.invalid");
});

it.each([
  [`${scenario},channel-canary`, published, "must run alone"],
  [`channel-canary,\n${scenario}`, published, "must run alone"],
  [scenario, "openclaw@latest", "exact published baseline"],
  [scenario, published, "deterministic mock-openai", "live-frontier"],
])(
  "rejects invalid upgrade requests: %s",
  (scenarios, spec, message, providerMode = "mock-openai") => {
    const result = upgradeFixture().run({
      OPENCLAW_NPM_TELEGRAM_SCENARIOS: scenarios,
      OPENCLAW_NPM_TELEGRAM_PACKAGE_SPEC: spec,
      OPENCLAW_NPM_TELEGRAM_PROVIDER_MODE: providerMode,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    expect(result.stdout).not.toContain("Docker");
  },
);

function captureDocker(env: NodeJS.ProcessEnv = {}) {
  const { root, candidate, executable, run } = upgradeFixture();
  const callsPath = path.join(root, "docker.jsonl");
  executable(
    "docker",
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'run' && args.includes('-i')) fs.readFileSync(0);
fs.appendFileSync(process.env.DOCKER_CALLS, JSON.stringify(args) + '\\n');
`,
  );
  const result = run({
    DOCKER_CALLS: callsPath,
    OPENCLAW_SKIP_DOCKER_BUILD: "1",
    OPENCLAW_NPM_TELEGRAM_COMMAND_SCENARIO: "",
    OPENCLAW_NPM_TELEGRAM_SCENARIOS: "",
    OPENCLAW_NPM_TELEGRAM_OUTPUT_DIR: path.join(root, "output"),
    OPENCLAW_NPM_TELEGRAM_CREDENTIAL_SOURCE: "convex",
    OPENCLAW_NPM_TELEGRAM_CREDENTIAL_ROLE: "ci",
    OPENCLAW_QA_CONVEX_SITE_URL: "https://broker.invalid",
    OPENCLAW_QA_CONVEX_SECRET_CI: "synthetic-fixture-secret",
    OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS: "",
    ...env,
  });
  const runs = existsSync(callsPath)
    ? readFileSync(callsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[])
        .filter((args) => args[0] === "run")
    : [];
  return { root, candidate, result, runs };
}

it.each([false, true])("isolates install and runtime credentials (upgrade=%s)", (upgrade) => {
  const { root, candidate, result, runs } = captureDocker({
    OPENCLAW_NPM_TELEGRAM_SCENARIOS: upgrade ? scenario : "",
    OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS: upgrade ? "1" : "",
  });
  expect(result.status, result.stderr).toBe(0);
  expect(runs).toEqual([
    expect.arrayContaining([
      `OPENCLAW_NPM_TELEGRAM_INSTALL_SOURCE=${upgrade ? published : candidatePath}`,
      `OPENCLAW_NPM_TELEGRAM_INSTALL_PUBLISHED_BASELINE=${upgrade ? "1" : "0"}`,
    ]),
    expect.arrayContaining([
      "OPENCLAW_QA_CONVEX_SECRET_CI",
      `OPENCLAW_NPM_TELEGRAM_UPGRADE_CANDIDATE=${upgrade ? candidatePath : ""}`,
      "TMPDIR=/tmp",
      "OPENCLAW_NPM_TELEGRAM_OUTPUT_DIR=.artifacts/qa-e2e/npm-telegram-live-output",
      `${path.join(root, "output")}:/app/.artifacts/qa-e2e/npm-telegram-live-output`,
      `${repoRoot}/node_modules:/trusted-harness/node_modules:ro`,
    ]),
  ]);
  expect(runs[0]?.some((arg) => arg.startsWith("OPENCLAW_QA_CONVEX_SECRET_"))).toBe(false);
  expect(runs[1]?.includes(`${candidate}:${candidatePath}:ro`)).toBe(upgrade);
  expect(runs[0]?.includes("OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS")).toBe(false);
  expect(runs[1]?.includes("OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS")).toBe(upgrade);
  const harness = runs[1]!.find((arg) => arg.endsWith(":/app/package.json:ro"));
  expect(harness).toBeDefined();
  expect(runs[1]).toContain(
    harness!.replace(
      ":/app/package.json:ro",
      ":/app/extensions/qa-lab/node_modules/openclaw/package.json:ro",
    ),
  );
  expect(runs[1]?.some((arg) => arg.startsWith(`${repoRoot}:/app`))).toBe(false);
  expect(readFileSync(path.join(root, "output/run-metadata.txt"), "utf8")).toBe(
    "schema=1\nexit_code=0\nlive_output=job_log\n",
  );
});
