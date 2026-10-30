import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const command = resolve("scripts/e2e/lib/upgrade-survivor/assertions.mjs");
const execOptions = { encoding: "utf8", timeout: 10_000 } as const;
type SchemaOverrides = Partial<{
  scenario: string;
  kind: string;
  baseline: string;
  version: string;
  schema: number | string | undefined;
  actual: number;
  succeeds: boolean;
}>;

function survivorFunctions(start: string, end: string) {
  const source = readFileSync("scripts/e2e/lib/upgrade-survivor/run.sh", "utf8");
  return source.slice(source.indexOf(`${start}()`), source.indexOf(`\n${end}()`));
}

it.skipIf(process.platform === "win32").each<[string, SchemaOverrides]>([
  ["base tarball after archive removal", {}],
  ["unmigrated base tarball", { actual: 16, succeeds: false }],
  ["paired transition without metadata", { schema: undefined, actual: 16, succeeds: false }],
  ["string schema", { schema: "16", actual: 16, succeeds: false }],
  ["negative schema", { schema: -1, actual: 16, succeeds: false }],
  ["fractional schema", { schema: 16.5, actual: 16, succeeds: false }],
  [
    "older metadata-less tarball",
    { baseline: "2026.7.1-2", version: "2026.8.1", schema: undefined, actual: 15 },
  ],
  ["unpaired baseline without metadata", { baseline: "2026.8.2", schema: undefined, actual: 15 }],
  ["published npm schema 16", { kind: "npm", schema: undefined, actual: 16 }],
  ["published npm rejects schema 17", { kind: "npm", schema: undefined, succeeds: false }],
])("candidate schema: %s", (_name, overrides) => {
  const { scenario, kind, baseline, version, schema, actual, succeeds } = {
    scenario: "base",
    kind: "tarball",
    baseline: "2026.9.2",
    version: "2026.9.3",
    schema: 17,
    actual: 17,
    succeeds: true,
    ...overrides,
  };
  const root = tempDirs.make("survivor-resolved-schema-");
  mkdirSync(join(root, "state"));
  const database = new DatabaseSync(join(root, "state", "openclaw.sqlite"));
  database.exec(`PRAGMA user_version = ${actual}`);
  database.close();
  const candidate = join(root, "candidate.tgz");
  if (kind === "tarball") {
    mkdirSync(join(root, "package"));
    writeFileSync(
      join(root, "package/package.json"),
      JSON.stringify({
        name: "openclaw",
        version,
        ...(schema === undefined ? {} : { openclaw: { schemaVersions: { state: schema } } }),
      }),
    );
    execFileSync("tar", ["-czf", candidate, "-C", root, "package"]);
  }
  const resolveCandidate = survivorFunctions(
    "resolve_candidate_version",
    "resolve_candidate_install_mode",
  );
  const assertSurvival = survivorFunctions("assert_survival", "probe_gateway_endpoint");
  const result = spawnSync(
    "bash",
    [
      "-c",
      `set -eu
ARTIFACT_ROOT="$1"
SCENARIO="$2"
CANDIDATE_KIND="$3"
CANDIDATE_SPEC="$4"
baseline_version="$5"
survival_assert_stage=automatic
read_installed_version() { printf '%s' "$FIXTURE_CANDIDATE_VERSION"; }
npm() { printf '%s' "$FIXTURE_CANDIDATE_VERSION"; }
node() {
  if [ "$1" = scripts/e2e/lib/upgrade-survivor/assertions.mjs ]; then return 0; fi
  "$FIXTURE_NODE" "$@"
}
${resolveCandidate}
${assertSurvival}
resolve_candidate_version
printf '%s' "$candidate_version" > "$ARTIFACT_ROOT/resolved-version"
if [ "$CANDIDATE_KIND" = tarball ]; then rm -- "$CANDIDATE_SPEC"; fi
assert_survival
`,
      "survivor-resolved-schema",
      root,
      scenario,
      kind,
      kind === "tarball" ? candidate : "openclaw@2026.9.3",
      baseline,
    ],
    {
      ...execOptions,
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: root,
        FIXTURE_NODE: process.execPath,
        FIXTURE_CANDIDATE_VERSION: version,
      },
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status, result.stderr).toBe(succeeds ? 0 : 1);
  if (succeeds) {
    expect(readFileSync(join(root, "resolved-version"), "utf8")).toBe(version);
    if (kind === "tarball") {
      expect(existsSync(candidate)).toBe(false);
    }
    if (baseline === "2026.9.2" && version === "2026.9.3") {
      expect(JSON.parse(readFileSync(join(root, "schema-after-update.json"), "utf8"))).toEqual({
        publishedVersion: actual,
        contentVersion: actual,
      });
    }
  }
});

it.each<{
  outcome?: "success" | "recoverable";
  future?: boolean;
  repaired?: boolean;
  replacement?: boolean;
  baseline?: string;
  candidate?: string;
  switchChannel?: boolean;
  persistedChannel?: string;
}>([
  {},
  { baseline: "2026.8.33", switchChannel: true },
  { baseline: "2026.8.32" },
  { baseline: "2026.9.1-beta.1" },
  { baseline: "2026.8.33+build" },
  { baseline: "2026.8.33", candidate: "2026.9.33" },
  { baseline: "2026.8.33", candidate: "2026.9.33-beta.1", switchChannel: true },
  { baseline: "2026.8.33", switchChannel: true, persistedChannel: "extended-stable" },
  { outcome: "recoverable" },
  { future: true },
  { future: true, repaired: true },
  { replacement: false },
])(
  "updater restart: $outcome future=$future repaired=$repaired replacement=$replacement baseline=$baseline",
  ({
    outcome = "success",
    future = false,
    repaired = false,
    replacement = true,
    baseline = "2026.9.1",
    candidate = "2026.9.2",
    switchChannel = false,
    persistedChannel = "stable",
  }) => {
    const root = tempDirs.make("survivor-restart-result-");
    const helper = survivorFunctions(
      "is_extended_stable_release_version",
      "replace_historical_mobile_pairing_candidate",
    );
    const expectedVersion = future ? "2100.1.0" : candidate;
    writeFileSync(
      join(root, "config.json"),
      JSON.stringify({ update: { channel: persistedChannel } }),
    );
    const expectedSpec = future ? "file:/fixture/future.tgz" : "file:/fixture/candidate.tgz";
    const result = spawnSync(
      "bash",
      [
        "-c",
        `set -eu
ARTIFACT_ROOT="$1"
EXPECTED_VERSION="$2"
OUTCOME="$3"
AFTER_REPAIR="$4"
REPLACEMENT="$5"
update_repair_required="$6"
SCENARIO="$7"
UPDATE_RESTART_MODE=auto-auth
COMMAND_TIMEOUT=1
ROOT_MANAGED_VPS=0
baseline_spec="$9"
baseline_version="$9"
candidate_version="\${10}"
OPENCLAW_CONFIG_PATH="$ARTIFACT_ROOT/config.json"
CANDIDATE_KIND=ref
UPDATE_JSON="$ARTIFACT_ROOT/update.json"
UPDATE_ERR="$ARTIFACT_ROOT/update.err"
POST_UPDATE_VALIDATE_JSON="$ARTIFACT_ROOT/validate.json"
POST_UPDATE_VALIDATE_ERR="$ARTIFACT_ROOT/validate.err"
SYSTEMCTL_SHIM_PID_FILE="$ARTIFACT_ROOT/service.pid"
SYSTEMCTL_SHIM_LOG="$ARTIFACT_ROOT/service.log"
printf '1234\n' >"$SYSTEMCTL_SHIM_PID_FILE"
printf 'start\nready\n' >"$SYSTEMCTL_SHIM_LOG"
: >"$ARTIFACT_ROOT/events"
candidate_update_spec() { printf 'file:/fixture/candidate.tgz'; }
read_installed_version() { printf '%s' "$EXPECTED_VERSION"; }
openclaw_e2e_print_log() { :; }
openclaw_e2e_maybe_timeout() {
  printf '%s\n' "$@" >"$ARTIFACT_ROOT/argv"
  printf 'update\n' >>"$ARTIFACT_ROOT/events"
  if [ "$REPLACEMENT" = 1 ]; then
    printf '5678\n' >"$SYSTEMCTL_SHIM_PID_FILE"
    printf 'restart\n' >>"$SYSTEMCTL_SHIM_LOG"
  fi
  [ "$OUTCOME" = success ]
}
node() {
  if [ "$1" = --input-type=module ]; then "$FIXTURE_NODE" "$@"; return; fi
  if [ "$1" = -e ]; then printf 1000; return; fi
  [ "$1" = scripts/e2e/lib/upgrade-survivor/assertions.mjs ] || return 90
  printf '%s|%s\n' "$2" "$4" >>"$ARTIFACT_ROOT/events"
  [ "$4" = "$EXPECTED_VERSION" ] || return 91
  [ "$5" = "$last_update_observation_root" ] && [ -d "$5" ] || return 92
  case "$2" in
    assert-recoverable-update-json) [ "$6" = "$baseline_version" ] && [ "$OUTCOME" = recoverable ] ;;
    assert-successful-update-json) [ "$OUTCOME" = success ] ;;
    *) return 93 ;;
  esac
}
assert_update_restart_service_replaced() {
  printf 'replacement|%s|%d\n' "$1" "$2" >>"$ARTIFACT_ROOT/events"
  [ "$1" = 1234 ] && [ "$2" -eq 2 ] && [ "$REPLACEMENT" = 1 ]
}
${helper}
result_status=0
update_candidate "$AFTER_REPAIR" "$8" "$EXPECTED_VERSION" || result_status=$?
printf '\nresult:%s:%s:%s\n' "\${update_outcome:-unset}" "\${update_restart_source:-unset}" "\${update_exit_code:-unset}"
exit "$result_status"
`,
        "restart-result",
        root,
        expectedVersion,
        outcome,
        future ? "1" : "0",
        replacement ? "1" : "0",
        repaired ? "1" : "0",
        future ? "mobile-pairing-reconnect" : "legacy-operator-state",
        expectedSpec,
        baseline,
        candidate,
      ],
      {
        ...execOptions,
        env: { ...process.env, FIXTURE_NODE: process.execPath },
      },
    );
    expect(result.status, result.stderr).toBe(
      replacement && (!switchChannel || persistedChannel === "stable") ? 0 : 1,
    );
    if (switchChannel && persistedChannel !== "stable") {
      expect(result.stderr).toContain("update channel was not persisted as stable");
    }
    const args = readFileSync(join(root, "argv"), "utf8").trim().split("\n");
    expect(args.slice(args.indexOf("openclaw") + 1)).toEqual([
      "update",
      "--tag",
      expectedSpec,
      "--yes",
      "--json",
      ...(switchChannel ? ["--channel", "stable"] : []),
    ]);
    const events = readFileSync(join(root, "events"), "utf8").trim().split("\n");
    expect(events).toEqual([
      "update",
      ...(!future ? [`assert-recoverable-update-json|${expectedVersion}`] : []),
      ...(outcome === "success" ? [`assert-successful-update-json|${expectedVersion}`] : []),
      "replacement|1234|2",
    ]);
    const attribution = !replacement
      ? "unset"
      : !future
        ? "baseline-update"
        : repaired
          ? "candidate-after-repair"
          : "candidate-to-future";
    expect(result.stdout).toContain(
      `result:${outcome}:${attribution}:${outcome === "recoverable" ? 1 : 0}`,
    );
  },
);

function consentWarning(id: string) {
  const reason = `Plugin "${id}" requires capability consent. Use openclaw plugins install or openclaw plugins enable with --accept-capabilities, then retry.`;
  return { reason, message: reason };
}

type PluginOutcome = {
  status: string;
  pluginId?: string;
  code?: string | undefined;
  message?: string;
  nextVersion?: string;
};

function deniedUpdate(status = "error") {
  return {
    status,
    mode: "npm",
    reason: status === "error" ? "post-update-plugins" : undefined,
    before: { version: "2026.7.1-2" },
    after: { version: "2026.8.1" },
    steps: ["global update", "global install swap"].map((name) => ({ name, exitCode: 0 })),
    postUpdate: {
      plugins: {
        status: status === "error" ? "error" : "warning",
        reason: status === "error" ? "post-plugin-doctor-invalid-config" : undefined,
        sync: { errors: [] as string[] },
        npm: { outcomes: [] as PluginOutcome[] },
        integrityDrifts: [] as string[],
        warnings: ["codex", "discord", "whatsapp"].map(consentWarning),
      },
    },
  };
}

function deferredUpdate() {
  const update = deniedUpdate("ok");
  const plugins = update.postUpdate.plugins;
  const reason = 'Plugin "codex" requires capability consent; rerun with --accept-capabilities.';
  const message = `Plugin "codex" could not be processed after the core update: ${reason} Run openclaw update repair to retry post-update plugin repair. Run openclaw plugins inspect codex --runtime --json for details.`;
  const retained = `Kept installed plugin "codex"; replacement deferred. ${consentWarning("codex").reason}`;
  plugins.npm.outcomes = [
    {
      pluginId: "codex",
      status: "error",
      code: "PLUGIN_CAPABILITY_CONSENT_REQUIRED",
      message,
    },
    { pluginId: "discord", status: "updated", nextVersion: "2026.8.1" },
  ];
  plugins.warnings = [
    { reason, message },
    consentWarning("whatsapp"),
    { reason: retained, message: retained },
  ];
  return update;
}

function check(result: unknown) {
  const filename = join(tempDirs.make("survivor-update-result-"), "update.json");
  writeFileSync(filename, JSON.stringify(result));
  return spawnSync(
    process.execPath,
    [command, "assert-recoverable-update-json", filename, "2026.8.1", "", "2026.7.1-2"],
    execOptions,
  );
}

describe("published upgrade survivor consent recovery", () => {
  it.each([
    { pluginId: "acpx", status: "error" },
    { pluginId: "feishu", status: "ok" },
  ])("admits $pluginId fixture consent after a $status update", ({ pluginId, status }) => {
    const update = deniedUpdate(status);
    update.postUpdate.plugins.warnings.push(consentWarning(pluginId));
    const result = check(update);
    expect(result.status, result.stderr).toBe(0);
  });

  it("repairs capability deferrals even when retaining the old plugin makes core update successful", () => {
    const update = deferredUpdate();
    const result = check(update);
    expect(result.status, result.stderr).toBe(0);
    update.steps.pop();
    expect(check(update).status).not.toBe(0);
  });

  it.each(["INSTALL_FAILED", undefined])("rejects unrelated plugin outcome %s", (code) => {
    const update = deferredUpdate();
    expectDefined(update.postUpdate.plugins.npm.outcomes[0], "Codex update outcome").code = code;
    expect(check(update).status).not.toBe(0);
  });

  it("accepts only the reviewed externalized fixture packages after successful core replacement", () => {
    const update = deniedUpdate();
    update.postUpdate.plugins.warnings.push({
      reason: "Config remained invalid after updated plugin migrations.",
      message: "Post-update plugin migration did not produce a valid config; refusing to restart.",
    });
    const result = check(update);
    expect(result.status, result.stderr).toBe(0);
  });

  const invalidUpdates: Record<string, (result: ReturnType<typeof deniedUpdate>) => unknown> = {
    "core update failure": (result) =>
      (expectDefined(result.steps[0], "global update step").exitCode = 1),
    "wrong installed version": (result) => (result.after.version = "2026.7.1-2"),
    "wrong baseline version": (result) => (result.before.version = "2026.8.1"),
    "missing core swap": (result) => result.steps.pop(),
    "other update failure": (result) => (result.reason = "doctor"),
    "plugin sync failure": (result) => result.postUpdate.plugins.sync.errors.push("network failed"),
    "plugin update failure": (result) =>
      result.postUpdate.plugins.npm.outcomes.push({ status: "error" }),
    "integrity drift": (result) => result.postUpdate.plugins.integrityDrifts.push("changed"),
    "unreviewed plugin": (result) => {
      const warning = expectDefined(result.postUpdate.plugins.warnings[0], "Codex consent warning");
      warning.reason = warning.reason.replace("codex", "unreviewed");
      warning.message = warning.reason;
    },
    "unrelated warning": (result) =>
      result.postUpdate.plugins.warnings.push({
        reason: "broken config",
        message: "broken config",
      }),
    "no consent denial": (result) => (result.postUpdate.plugins.warnings = []),
  };
  it.each(Object.entries(invalidUpdates))("refuses repair after %s", (_name, mutate) => {
    const result = deniedUpdate();
    mutate(result);
    expect(check(result).status).not.toBe(0);
  });
});
