import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const command = resolve("scripts/e2e/lib/upgrade-survivor/assertions.mjs");

describe.skipIf(process.platform === "win32")("survivor resolved candidate schema contract", () => {
  it.each([
    {
      name: "uses schema 17 for a base tarball after archive removal",
      scenario: "base",
      kind: "tarball",
      baseline: "2026.9.2",
      version: "2026.9.3",
      schema: 17,
      actual: 17,
      succeeds: true,
    },
    {
      name: "uses schema 17 for a legacy tarball after archive removal",
      scenario: "legacy-operator-state",
      kind: "tarball",
      baseline: "2026.9.2",
      version: "2026.9.3",
      schema: 17,
      actual: 17,
      succeeds: true,
    },
    {
      name: "rejects an unmigrated base tarball schema",
      scenario: "base",
      kind: "tarball",
      baseline: "2026.9.2",
      version: "2026.9.3",
      schema: 17,
      actual: 16,
      succeeds: false,
    },
    {
      name: "rejects an unmigrated legacy tarball schema",
      scenario: "legacy-operator-state",
      kind: "tarball",
      baseline: "2026.9.2",
      version: "2026.9.3",
      schema: 17,
      actual: 16,
      succeeds: false,
    },
    {
      name: "requires metadata for the paired tarball transition",
      scenario: "base",
      kind: "tarball",
      baseline: "2026.9.2",
      version: "2026.9.3",
      schema: undefined,
      actual: 16,
      succeeds: false,
    },
    {
      name: "rejects a string schema in the candidate contract",
      scenario: "base",
      kind: "tarball",
      baseline: "2026.9.2",
      version: "2026.9.3",
      schema: "16",
      actual: 16,
      succeeds: false,
    },
    {
      name: "rejects a negative candidate schema",
      scenario: "base",
      kind: "tarball",
      baseline: "2026.9.2",
      version: "2026.9.3",
      schema: -1,
      actual: 16,
      succeeds: false,
    },
    {
      name: "rejects a fractional candidate schema",
      scenario: "base",
      kind: "tarball",
      baseline: "2026.9.2",
      version: "2026.9.3",
      schema: 16.5,
      actual: 16,
      succeeds: false,
    },
    {
      name: "keeps older metadata-less tarballs working",
      scenario: "base",
      kind: "tarball",
      baseline: "2026.7.1-2",
      version: "2026.8.1",
      schema: undefined,
      actual: 15,
      succeeds: true,
    },
    {
      name: "does not require metadata outside the paired baseline",
      scenario: "base",
      kind: "tarball",
      baseline: "2026.8.2",
      version: "2026.9.3",
      schema: undefined,
      actual: 15,
      succeeds: true,
    },
    {
      name: "keeps the published npm schema-16 contract",
      scenario: "base",
      kind: "npm",
      baseline: "2026.9.2",
      version: "2026.9.3",
      schema: undefined,
      actual: 16,
      succeeds: true,
    },
    {
      name: "rejects schema 17 for the published npm contract",
      scenario: "base",
      kind: "npm",
      baseline: "2026.9.2",
      version: "2026.9.3",
      schema: undefined,
      actual: 17,
      succeeds: false,
    },
  ])("$name", ({ scenario, kind, baseline, version, schema, actual, succeeds }) => {
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
    const source = readFileSync("scripts/e2e/lib/upgrade-survivor/run.sh", "utf8");
    const resolveCandidate = source.slice(
      source.indexOf("resolve_candidate_version()"),
      source.indexOf("\nresolve_candidate_install_mode()"),
    );
    const assertSurvival = source.slice(
      source.indexOf("assert_survival()"),
      source.indexOf("\nprobe_gateway_endpoint()"),
    );
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
        encoding: "utf8",
        timeout: 10_000,
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
});

describe("upgrade survivor updater restart ownership", () => {
  it.each(
    [
      { outcome: "success", future: false, repaired: false },
      { outcome: "recoverable", future: false, repaired: false },
      { outcome: "success", future: true, repaired: false },
      { outcome: "success", future: true, repaired: true },
    ].flatMap(({ outcome, future, repaired }) =>
      [true, false].map((replacement) => ({ outcome, future, repaired, replacement })),
    ),
  )(
    "$outcome future=$future repaired=$repaired replacement=$replacement",
    ({ outcome, future, repaired, replacement }) => {
      const root = tempDirs.make("survivor-restart-result-");
      const source = readFileSync("scripts/e2e/lib/upgrade-survivor/run.sh", "utf8");
      const helper = source.slice(
        source.indexOf("update_candidate()"),
        source.indexOf("\nreplace_historical_mobile_pairing_candidate()"),
      );
      const expectedVersion = future ? "2100.1.0" : "2026.9.2";
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
baseline_spec=2026.9.1
baseline_version=2026.9.1
candidate_version=2026.9.2
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
        ],
        { encoding: "utf8", timeout: 10_000 },
      );
      expect(result.status, result.stderr).toBe(replacement ? 0 : 1);
      const args = readFileSync(join(root, "argv"), "utf8").trim().split("\n");
      expect(args.slice(args.indexOf("openclaw") + 1)).toEqual([
        "update",
        "--tag",
        expectedSpec,
        "--yes",
        "--json",
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
});

function deniedUpdate() {
  return {
    status: "error",
    mode: "npm",
    reason: "post-update-plugins",
    before: { version: "2026.7.1-2" },
    after: { version: "2026.8.1" },
    steps: [
      { name: "global update", exitCode: 0 },
      { name: "global install swap", exitCode: 0 },
    ],
    postUpdate: {
      plugins: {
        status: "error",
        reason: "post-plugin-doctor-invalid-config",
        sync: { errors: [] as string[] },
        npm: { outcomes: [] as { status: string }[] },
        integrityDrifts: [] as string[],
        warnings: ["codex", "discord", "whatsapp"].map((id) => {
          const message = `Plugin "${id}" requires capability consent. Use openclaw plugins install or openclaw plugins enable with --accept-capabilities, then retry.`;
          return { reason: message, message };
        }),
      },
    },
  };
}

function deferredUpdate() {
  const update = deniedUpdate();
  const codexWarning = expectDefined(
    update.postUpdate.plugins.warnings[0],
    "Codex consent warning",
  );
  const reason = 'Plugin "codex" requires capability consent; rerun with --accept-capabilities.';
  const message = `Plugin "codex" could not be processed after the core update: ${reason} Run openclaw update repair to retry post-update plugin repair. Run openclaw plugins inspect codex --runtime --json for details.`;
  const retained = `Kept installed plugin "codex"; replacement deferred. ${codexWarning.reason}`;
  return {
    ...update,
    status: "ok",
    reason: undefined,
    postUpdate: {
      plugins: {
        ...update.postUpdate.plugins,
        status: "warning",
        reason: undefined,
        npm: {
          outcomes: [
            {
              pluginId: "codex",
              status: "error",
              code: "PLUGIN_CAPABILITY_CONSENT_REQUIRED",
              message,
            },
            { pluginId: "discord", status: "updated", nextVersion: "2026.8.1" },
          ],
        },
        warnings: [
          { reason, message },
          expectDefined(update.postUpdate.plugins.warnings[2], "WhatsApp consent warning"),
          { reason: retained, message: retained },
        ],
      },
    },
  };
}

function check(result: unknown, prefix = "") {
  const filename = join(tempDirs.make("survivor-update-result-"), "update.json");
  writeFileSync(filename, prefix + JSON.stringify(result));
  return spawnSync(
    process.execPath,
    [command, "assert-recoverable-update-json", filename, "2026.8.1", "", "2026.7.1-2"],
    {
      encoding: "utf8",
      timeout: 10_000,
    },
  );
}

describe("published upgrade survivor consent recovery", () => {
  it.each(
    ["acpx", "feishu"].flatMap((pluginId) =>
      ["error", "ok"].map((status) => ({ pluginId, status })),
    ),
  )("admits $pluginId fixture consent after a $status update", ({ pluginId, status }) => {
    const update = deniedUpdate();
    const reason = `Plugin "${pluginId}" requires capability consent. Use openclaw plugins install or openclaw plugins enable with --accept-capabilities, then retry.`;
    update.postUpdate.plugins.warnings.push({ reason, message: reason });
    const result = check({
      ...update,
      status,
      reason: status === "error" ? update.reason : undefined,
      postUpdate: {
        plugins: {
          ...update.postUpdate.plugins,
          status: status === "error" ? "error" : "warning",
          reason: status === "error" ? update.postUpdate.plugins.reason : undefined,
        },
      },
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it.each(["acpx", "feishu"])("rejects non-consent failures from reviewed %s", (pluginId) => {
    const update = deferredUpdate();
    const outcome = expectDefined(update.postUpdate.plugins.npm.outcomes[0], "plugin outcome");
    outcome.pluginId = pluginId;
    outcome.code = "INSTALL_FAILED";
    expect(check(update).status).not.toBe(0);
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

  it.each([
    [
      "core update failure",
      (result: ReturnType<typeof deniedUpdate>) =>
        (expectDefined(result.steps[0], "global update step").exitCode = 1),
    ],
    [
      "wrong installed version",
      (result: ReturnType<typeof deniedUpdate>) => (result.after.version = "2026.7.1-2"),
    ],
    [
      "wrong baseline version",
      (result: ReturnType<typeof deniedUpdate>) => (result.before.version = "2026.8.1"),
    ],
    ["missing core swap", (result: ReturnType<typeof deniedUpdate>) => result.steps.pop()],
    [
      "other update failure",
      (result: ReturnType<typeof deniedUpdate>) => (result.reason = "doctor"),
    ],
    [
      "plugin sync failure",
      (result: ReturnType<typeof deniedUpdate>) =>
        result.postUpdate.plugins.sync.errors.push("network failed"),
    ],
    [
      "plugin update failure",
      (result: ReturnType<typeof deniedUpdate>) =>
        result.postUpdate.plugins.npm.outcomes.push({ status: "error" }),
    ],
    [
      "integrity drift",
      (result: ReturnType<typeof deniedUpdate>) =>
        result.postUpdate.plugins.integrityDrifts.push("changed"),
    ],
    [
      "unreviewed plugin",
      (result: ReturnType<typeof deniedUpdate>) => {
        const warning = expectDefined(
          result.postUpdate.plugins.warnings[0],
          "Codex consent warning",
        );
        warning.reason = warning.reason.replace("codex", "unreviewed");
        warning.message = warning.reason;
      },
    ],
    [
      "unrelated warning",
      (result: ReturnType<typeof deniedUpdate>) =>
        result.postUpdate.plugins.warnings.push({
          reason: "broken config",
          message: "broken config",
        }),
    ],
    [
      "no consent denial",
      (result: ReturnType<typeof deniedUpdate>) => (result.postUpdate.plugins.warnings = []),
    ],
  ])("refuses repair after %s", (_name, mutate) => {
    const result = deniedUpdate();
    mutate(result);
    expect(check(result).status).not.toBe(0);
  });
});
