import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { resolveFrozenTelegramScenarioOmissions } from "../../scripts/e2e/lib/npm-telegram-live/resolve-target-scenarios.mts";
import { testing } from "../../scripts/e2e/npm-telegram-live-runner.ts";
import { privateLocalOnlyPluginSdkEntrypoints } from "../../scripts/lib/plugin-sdk-entries.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

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

function expectText(text: string, included: string[], excluded: string[] = []) {
  for (const value of included) {
    expect(text).toContain(value);
  }
  for (const value of excluded) {
    expect(text).not.toContain(value);
  }
}

function dockerEnv(source: string) {
  const start = source.indexOf("docker_env=(");
  const end = source.indexOf(")\n\nforward_env_if_set", start);
  return { start, end, text: source.slice(start, end) };
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

it("installs the package candidate before forwarding runtime secrets", () => {
  const installRunStart = script.indexOf('echo "Running package Telegram live Docker E2E');
  const installRunEnd = script.indexOf("# Mount the trusted current-source QA harness");
  const installRun = script.slice(installRunStart, installRunEnd);

  expect(installRunStart).toBeGreaterThanOrEqual(0);
  expect(installRunEnd).toBeGreaterThan(installRunStart);
  expectText(
    installRun,
    [
      '-e OPENCLAW_E2E_NPM_INSTALL_TIMEOUT="${OPENCLAW_E2E_NPM_INSTALL_TIMEOUT:-600s}"',
      '"$timeout_bin" --kill-after=30s "$npm_install_timeout" npm install -g "$install_source" --no-fund --no-audit',
      "elif command -v gtimeout >/dev/null 2>&1; then",
      'timeout_bin="gtimeout"',
      'echo "timeout or gtimeout is required for OPENCLAW_E2E_NPM_INSTALL_TIMEOUT=$npm_install_timeout" >&2',
      '"$timeout_bin" --kill-after=1s 1s true >/dev/null 2>&1',
      '"$timeout_bin" "$npm_install_timeout" npm install -g "$install_source" --no-fund --no-audit',
      '"${package_mount_args[@]}"',
      'run_logged_print_heartbeat "npm-telegram-package-install" 60 docker_e2e_docker_run_cmd run --rm',
    ],
    [
      "running package install without OPENCLAW_E2E_NPM_INSTALL_TIMEOUT",
      '"${docker_env[@]}"',
      "run_logged_print_heartbeat docker run --rm",
    ],
  );
  expectText(
    script,
    [
      'run_logged_print_heartbeat "npm-telegram-live-suite" 60 docker_e2e_run_with_harness',
      '"${docker_env[@]}"',
      'if [ -z "$credential_role" ] && [ "$credential_source" = "convex" ]; then',
      'credential_role="ci"',
      'credential_role="maintainer"',
    ],
    ['cat "$run_log"'],
  );
});

it("uses unique direct-run output dirs by default", () => {
  const repoRoot = mkTempRoot();
  const firstDir = testing.resolvePackageTelegramOutputDir({}, repoRoot);
  const secondDir = testing.resolvePackageTelegramOutputDir({}, repoRoot);

  expect(path.dirname(firstDir)).toBe(path.join(repoRoot, ".artifacts", "qa-e2e"));
  expect(path.basename(firstDir)).toMatch(/^npm-telegram-live-[a-z0-9]+-[a-f0-9]{8}$/u);
  expect(secondDir).not.toBe(firstDir);
  expect(
    testing.resolvePackageTelegramOutputDir(
      { OPENCLAW_NPM_TELEGRAM_OUTPUT_DIR: ".artifacts/custom" },
      repoRoot,
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
  expectText(
    script,
    ["Telegram package QA requires Convex credential mode."],
    ["OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN", "OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN"],
  );
});

it("mounts configured output paths before entering the container", () => {
  expectText(script, [
    '*) OUTPUT_DIR_HOST="$ROOT_DIR/$OUTPUT_DIR" ;;',
    'mkdir -p "$OUTPUT_DIR_HOST"',
    'printf \'schema=1\\nexit_code=%s\\nlive_output=job_log\\n\' "$rc" > "$OUTPUT_DIR_HOST/run-metadata.txt"',
    "trap cleanup EXIT",
    '-v "$OUTPUT_DIR_HOST:$OUTPUT_DIR_CONTAINER"',
  ]);
  expectText(
    dockerEnv(script).text,
    ['-e OPENCLAW_NPM_TELEGRAM_OUTPUT_DIR="$OUTPUT_DIR_CONTAINER_RELATIVE"'],
    [
      '-e OPENCLAW_NPM_TELEGRAM_OUTPUT_DIR="$OUTPUT_DIR_CONTAINER"',
      '-e OPENCLAW_NPM_TELEGRAM_OUTPUT_DIR="$OUTPUT_DIR"',
    ],
  );
});

it("uses the container temp root for OpenClaw runtime scratch files", () => {
  const { start, end, text } = dockerEnv(script);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  expect(text).toContain("-e TMPDIR=/tmp");
});

it("forwards destructive downgrade approval only through the explicit env list", () => {
  const { end, text } = dockerEnv(script);
  const forwardingStart = script.indexOf("for key in \\", end);
  const forwardingEnd = script.indexOf("; do", forwardingStart);

  expect(text).not.toContain("OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS");
  expect(script.slice(forwardingStart, forwardingEnd)).toContain(
    "OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS",
  );
});

it("isolates the trusted private QA harness from the installed package candidate", () => {
  expectText(
    script,
    [
      'cp "$ROOT_DIR/package.json" "$harness_package_json"',
      'node --import tsx "$ROOT_DIR/scripts/e2e/lib/npm-telegram-live/prepare-package.mts" "$harness_package_json"',
      '-v "$harness_package_json:/app/package.json:ro"',
      '-v "$harness_package_json:/app/extensions/qa-lab/node_modules/openclaw/package.json:ro"',
      '-v "$ROOT_DIR/node_modules:/trusted-harness/node_modules:ro"',
      '-v "$ROOT_DIR/.agents:/app/.agents:ro"',
      ...["dist", "packages", "extensions", "taxonomy.yaml", "qa/scenarios"].map(
        (entry) => `-v "$ROOT_DIR/${entry}:/app/${entry}:ro"`,
      ),
      "for dependency_dir in /trusted-harness/node_modules/*",
      "for workspace_dir in /app/packages/* /app/extensions/*",
      'link_harness_dependency "$workspace_dir" "$workspace_name"',
      "link_harness_dependency /app openclaw",
    ],
    [
      'openclaw_package_dir="/npm-global/lib/node_modules/openclaw"',
      'cp "$openclaw_package_dir/package.json" /app/package.json',
      "/app/node_modules/openclaw/package.json",
      "link_installed_package_dependency",
      '-v "$ROOT_DIR:/app',
    ],
  );
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

it("adds private SDK exports only to the trusted harness manifest", () => {
  const root = mkTempRoot();
  const harnessManifestPath = path.join(root, "package.json");
  const candidateManifestPath = path.join(root, "candidate-package.json");
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
  writeFileSync(candidateManifestPath, '{"name":"candidate","exports":{}}\n');
  const candidateBefore = readFileSync(candidateManifestPath, "utf8");

  execFileSync(process.execPath, [PREPARE_PACKAGE_PATH, harnessManifestPath]);

  const prepared = JSON.parse(readFileSync(harnessManifestPath, "utf8")) as {
    exports: Record<string, unknown>;
  };
  expect(prepared.exports["./kept"]).toBe("./dist/kept.js");
  expect(prepared.exports["./plugin-sdk/gateway-runtime"]).toEqual(existingGatewayExport);
  const privateQaSubpaths = ["qa-channel", "qa-channel-protocol", "qa-lab", "qa-runtime"];
  for (const subpath of [...privateLocalOnlyPluginSdkEntrypoints, ...privateQaSubpaths]) {
    expect(prepared.exports[`./plugin-sdk/${subpath}`]).toEqual({
      default: `./dist/plugin-sdk/${subpath}.js`,
    });
  }
  for (const subpath of privateQaSubpaths) {
    writeFixture(root, `dist/plugin-sdk/${subpath}.js`, "export const harnessOnly = true;\n");
  }
  // Resolve the private manifest with Node, without the test runner's source SDK aliases.
  const loader = writeFixture(
    root,
    "load-private.mjs",
    `import assert from "node:assert/strict";
for (const subpath of ${JSON.stringify(privateQaSubpaths)}) {
  assert.equal((await import("openclaw/plugin-sdk/" + subpath)).harnessOnly, true);
}
`,
  );
  execFileSync(process.execPath, [loader], { cwd: root });
  expect(readFileSync(candidateManifestPath, "utf8")).toBe(candidateBefore);
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

it.each([[], ["telegram-policy-hot-reload"]])(
  "qualifies default policy reload scenarios from the selected source (%j)",
  (...supported: string[]) => {
    const root = mkTempRoot();
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
    const policyScenarios = ["telegram-policy-hot-reload", "telegram-group-policy-hot-reload"];
    for (const id of supported) {
      writeFixture(root, `qa/scenarios/channels/${id}.yaml`, `scenario:\n  id: ${id}\n`);
    }
    git("init", "-q");
    git("add", ".");
    git(
      ..."-c user.name=Fixture -c user.email=fixture@example.test commit -qm target --allow-empty".split(
        " ",
      ),
    );
    const output = path.join(root, "github.env");
    const qualifier = path.resolve(
      TEST_DIR,
      "../../scripts/e2e/lib/npm-telegram-live/resolve-target-scenarios.mts",
    );
    const qualify = (sha: string) =>
      execFileSync(process.execPath, [qualifier, root], {
        env: { ...process.env, OPENCLAW_SELECTED_SHA: sha, GITHUB_ENV: output },
        stdio: "pipe",
      });
    qualify(git("rev-parse", "HEAD").trim());
    const omissions = readFileSync(output, "utf8").trim().split("=")[1];
    const env = { OPENCLAW_NPM_TELEGRAM_OMIT_DEFAULT_SCENARIOS: omissions };
    const resolve = (ids: readonly string[]) =>
      ids.length ? [...ids] : ["channel-canary", ...policyScenarios];
    expect(testing.resolvePackageTelegramScenarios(env, resolve).resolvedScenarioIds).toEqual([
      "channel-canary",
      ...policyScenarios.filter((id) => supported.includes(id)),
    ]);
    for (const id of policyScenarios) {
      for (const key of ["OPENCLAW_NPM_TELEGRAM_SCENARIOS", "OPENCLAW_NPM_TELEGRAM_RTT_CHECKS"]) {
        expect(
          testing.resolvePackageTelegramScenarios({ ...env, [key]: id }, resolve)
            .resolvedScenarioIds,
        ).toEqual([id]);
      }
    }
    expect(() => qualify("0".repeat(40))).toThrow(
      "frozen Telegram source checkout does not match package source SHA",
    );
  },
);

it("combines only the unsupported frozen Telegram scenario contracts", () => {
  const root = mkTempRoot();
  const writeOwner = (file: string, source: string) => writeFixture(root, file, source);
  writeOwner("src/agents/embedded-agent-subscribe.ts", "void params.onPartialReply(data);");
  writeOwner("extensions/telegram/src/draft-stream.ts", "flush: loop.flush,");
  writeOwner(
    "extensions/telegram/src/bot-message-dispatch.ts",
    "enqueueDraftLaneEvent(async () => {});",
  );

  for (const id of ["telegram-policy-hot-reload", "telegram-group-policy-hot-reload"]) {
    writeOwner(`qa/scenarios/channels/${id}.yaml`, `scenario:\n  id: ${id}\n`);
  }

  const omissions = [
    "telegram-partial-failure-recovery",
    "telegram-empty-response-after-write-recovery",
    "telegram-prepared-delivery-recovery",
    "telegram-progress-tool-visibility",
    "telegram-provider-failure-before-output",
    "telegram-queue-invalid-mode",
    "telegram-rich-inline-composition",
  ];
  expect(resolveFrozenTelegramScenarioOmissions(root)).toEqual(omissions);
  writeOwner("extensions/telegram/src/draft-stream.ts", "waitForInFlight();");
  let remaining = omissions.slice(1);
  expect(resolveFrozenTelegramScenarioOmissions(root)).toEqual(remaining);
  // Restore prepared delivery last, preserving every intermediate omission snapshot.
  for (const id of [omissions[1]!, ...omissions.slice(3), omissions[2]!]) {
    writeOwner(`qa/scenarios/channels/${id}.yaml`, `id: ${id}\n`);
    remaining = remaining.filter((omitted) => omitted !== id);
    expect(resolveFrozenTelegramScenarioOmissions(root)).toEqual(remaining);
  }
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
