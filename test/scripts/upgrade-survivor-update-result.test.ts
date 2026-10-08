import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs, { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import sqlite, { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publishDiagnostics } from "../../scripts/e2e/lib/upgrade-survivor/diagnostics.mjs";
import {
  observeSnapshotAllocations,
  readSnapshotWorkerLaunch,
} from "../../scripts/e2e/lib/upgrade-survivor/snapshot-capture-binding.mjs";
import { createSnapshotAcquisitionRecorder } from "../../scripts/e2e/lib/upgrade-survivor/snapshot-cleanup-evidence.mjs";
import {
  assertSnapshotCleanupRefusal,
  bindSnapshotRuntimeIdentity,
  readSnapshotProcessIdentity,
  writeSnapshotCleanupEvidence,
} from "../../scripts/e2e/lib/upgrade-survivor/snapshot-cleanup-refusal.mjs";
import { observeSnapshotNativeBackups } from "../../scripts/e2e/lib/upgrade-survivor/snapshot-copy-fault.mjs";
import { readWorkerCellPackageIdentity } from "../../scripts/e2e/lib/upgrade-survivor/worker-cell-package.mjs";
import { redactSensitiveText } from "../../src/logging/redact.js";
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
    { baseline: "2026.8.34", switchChannel: true },
    { baseline: "2026.8.32" },
    { baseline: "2026.8.33-beta.1" },
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
    "$outcome future=$future repaired=$repaired replacement=$replacement baseline=$baseline",
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
      const source = readFileSync("scripts/e2e/lib/upgrade-survivor/run.sh", "utf8");
      const helper = source.slice(
        source.indexOf("is_extended_stable_release_version()"),
        source.indexOf("\nreplace_historical_mobile_pairing_candidate()"),
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
          encoding: "utf8",
          timeout: 10_000,
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
  it.each([
    { pluginId: "acpx", status: "error" },
    { pluginId: "feishu", status: "ok" },
  ])("admits $pluginId fixture consent after a $status update", ({ pluginId, status }) => {
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

// Synthetic validator records only; real caller/native proof uses the maintenance owner.
function nativeTransportFixture(ipc: boolean): {
  transport: "ipc" | "one-shot";
  ipcRequestId: number | null;
  close: { code: number | null; signal: string | null };
  stops: Array<{
    kind: string;
    signal: string;
    accepted: boolean;
    at: string;
    owner: { name: string; file: string; sha256: string };
  }>;
  reply?: { id: number; ok: boolean; sha256: string; receivedAt: string };
  observationError?: string;
} {
  return {
    transport: ipc ? "ipc" : "one-shot",
    ipcRequestId: ipc ? 2 : null,
    close: ipc ? { code: null, signal: "SIGKILL" } : { code: 1, signal: null },
    stops: ipc
      ? [
          {
            kind: "failed-reply-retirement",
            signal: "SIGKILL",
            accepted: true,
            at: "115",
            owner: {
              name: "retire",
              file: "dist/sqlite-readonly-worker-session-fixture.mjs",
              sha256: "f".repeat(64),
            },
          },
        ]
      : [],
    ...(ipc ? { reply: { id: 2, ok: false, sha256: "e".repeat(64), receivedAt: "110" } } : {}),
  };
}
function refusalRecords(artifacts: string) {
  const write = (name: string, value: unknown) =>
    writeFileSync(join(artifacts, name), JSON.stringify(value));
  const candidateCommit = "a".repeat(40);
  const baseline = { commit: "b".repeat(40) };
  const identity = {
    commit: candidateCommit,
    payloadSha256: createHash("sha256").update("{}").digest("hex"),
  };
  const source = join(artifacts, "source.sqlite");
  const stagingRoot = join(artifacts, "outer");
  const staging = join(stagingRoot, "inner");
  const marker = source + ".bak.capturing";
  writeFileSync(marker, "");
  const stat = fs.statSync(marker, { bigint: true });
  const native = {
    key: "d".repeat(64),
    pid: 101,
    childStart: "125",
    parentStart: "123",
    ...nativeTransportFixture(false),
    request: 1,
    operationId: "99:123:1",
    parentPid: 99,
    source,
    stagingRoot,
    binding: {
      source,
      target: source + ".bak",
      marker,
      markerIdentity: {
        dev: String(stat.dev),
        ino: String(stat.ino),
        mtimeNs: String(stat.mtimeNs),
      },
    },
    closedAt: "120",
    retirement: {
      afterNativeClose: true,
      producerRefused: true,
      removed: true,
      startedAt: "121",
      finishedAt: "122",
    },
  };
  const doctor = {
    pid: 99,
    identity,
    updateInProgress: true,
    fullPayloadVerified: true,
    result: { status: "error" },
  };
  const fault = {
    pid: 101,
    threadId: 0,
    identity,
    doctor,
    native: structuredClone(native),
    injectedAt: "100",
    staging,
    cleanupDenials: 1,
    terminalRefusal: true,
    retainedAtRefusal: true,
    sourcePreservedAtRefusal: true,
    unpublishedAtRefusal: true,
    groupIncompleteAtRefusal: true,
    failure: {
      message: "SQLite artifact-preserving copy and cleanup failed",
      sha256: "c".repeat(64),
      resultSha256: "e".repeat(64),
      channel: "stdout",
    },
    removed: false,
  };
  const save = () => {
    write("snapshot-cleanup-fixture.json", { candidateCommit, baseline, source });
    write("snapshot-cleanup-driver.json", { identity: baseline });
    write("snapshot-cleanup-candidate-identity.json", {});
    write("snapshot-cleanup-copy-" + fault.native.key + ".json", fault);
    write("snapshot-cleanup-native-" + "d".repeat(64) + ".json", native);
    write("snapshot-cleanup-doctor-99.json", doctor);
    write("snapshot-cleanup-attempts-101-0.json", {
      pid: 101,
      threadId: 0,
      identity,
      acquisitions: [{ directory: staging, at: "99", operationId: native.operationId }],
    });
    write("update.stdout", {
      status: "error",
      reason: fault.failure.message,
      steps: [{ name: "openclaw doctor", exitCode: 1 }],
    });
    writeFileSync(join(artifacts, "update.stderr"), "");
  };
  save();
  return { write, save, fault, native, doctor, identity };
}

describe("snapshot cleanup refusal evidence", () => {
  it.each(["selected", "other-source", "other-mode"])(
    "observes real allocation for %s native request",
    (kind) => {
      const root = tempDirs.make("snapshot-native-allocation-");
      const source = join(root, "source.sqlite");
      const sibling = join(root, "sibling");
      mkdirSync(sibling);
      const request = readSnapshotWorkerLaunch([
        "/package/worker.mjs",
        "--openclaw-sqlite-readonly-child",
        kind === "other-mode" ? "async" : "sync",
        kind === "other-source" ? source + ".other" : source,
        root,
      ]);
      const observed: string[] = [];
      const restore = observeSnapshotAllocations(
        source,
        () => request,
        (directory: string) => observed.push(directory),
      );
      try {
        // openclaw-temp-dir: allow exercises the actual intercepted allocator boundary
        const first = fs.mkdtempSync(join(root, "openclaw-sqlite-readonly-"));
        // openclaw-temp-dir: allow another real allocation in the same selected request
        const second = fs.mkdtempSync(join(root, "openclaw-sqlite-readonly-"));
        // openclaw-temp-dir: allow same-prefix allocation outside this request's staging parent
        fs.mkdtempSync(join(sibling, "openclaw-sqlite-readonly-"));
        expect(observed).toEqual(kind === "selected" ? [first, second] : []);
      } finally {
        restore();
      }
    },
  );
  it.each([
    { fault: "other process retry", receipt: "102-0", error: "Selected operation reacquired" },
    {
      fault: "native backup retry",
      receipt: "103-0",
      native: true,
      error: "Selected operation reacquired",
    },
    { fault: "other thread retry", receipt: "101-1", error: "Selected operation reacquired" },
    { fault: "successful exit", exitCode: 0, error: "Updater swallowed" },
    { fault: "successful result", status: "ok", error: "failed result" },
    { fault: "unverified payload", payload: false, error: "false !== true" },
  ])(
    "rejects $fault despite refusal text",
    async ({ receipt, native = false, exitCode = 1, status = "error", payload = true, error }) => {
      const artifacts = tempDirs.make("snapshot-refusal-evidence-");
      const f = refusalRecords(artifacts);
      f.doctor.fullPayloadVerified = payload;
      f.save();
      if (receipt) {
        const record = (directory: string) =>
          f.write("snapshot-cleanup-attempts-" + receipt + ".json", {
            identity: f.identity,
            acquisitions: [{ directory, at: "101", operationId: f.native.operationId }],
          });
        const retried = join(artifacts, "retried-copy");
        if (native) {
          mkdirSync(retried);
          const sourcePath = join(artifacts, "source.sqlite");
          const source = new DatabaseSync(sourcePath);
          const restore = observeSnapshotNativeBackups(sourcePath, record);
          try {
            source.exec("CREATE TABLE witness(value); INSERT INTO witness VALUES(1)");
            expect(await sqlite.backup(source, join(retried, "copy.sqlite"))).toBeGreaterThan(0);
          } finally {
            restore();
            source.close();
          }
        } else {
          record(retried);
        }
      }
      f.write("update.stdout", {
        status,
        reason: f.fault.failure.message,
        steps: [{ name: "openclaw doctor", exitCode: 1 }],
      });
      expect(() => assertSnapshotCleanupRefusal(artifacts, { exitCode, signal: null })).toThrow(
        error,
      );
      expect(existsSync(join(artifacts, "snapshot-cleanup-proof.json"))).toBe(false);
    },
  );
  it.each([
    {
      fault: "successful native worker",
      change: (f: ReturnType<typeof refusalRecords>) => {
        f.native.close.code = 0;
      },
      error: "refusal code 1",
    },
    {
      fault: "unretained failed scratch",
      change: (f: ReturnType<typeof refusalRecords>) => {
        f.fault.retainedAtRefusal = false;
      },
      error: "not retained at refusal",
    },
    {
      fault: "unjoined child",
      change: (f: ReturnType<typeof refusalRecords>) => {
        f.native.closedAt = "";
      },
      error: "native child close",
    },
    {
      fault: "unobserved retirement",
      change: (f: ReturnType<typeof refusalRecords>) => {
        f.native.retirement.afterNativeClose = false;
      },
      error: "Parent retirement",
    },
    {
      fault: "unsettled staging",
      change: (f: ReturnType<typeof refusalRecords>) => {
        f.native.retirement.removed = false;
      },
      error: "did not settle",
    },
    {
      fault: "successful Doctor",
      change: (f: ReturnType<typeof refusalRecords>) => {
        f.doctor.result.status = "ok";
      },
      error: "Doctor status:error",
    },
    {
      fault: "completed failed group",
      change: (f: ReturnType<typeof refusalRecords>) => {
        f.fault.groupIncompleteAtRefusal = false;
      },
      error: "not incomplete",
    },
  ])("rejects $fault", ({ change, error }) => {
    const artifacts = tempDirs.make("snapshot-custody-evidence-");
    const f = refusalRecords(artifacts);
    change(f);
    f.save();
    expect(() => assertSnapshotCleanupRefusal(artifacts, { exitCode: 1, signal: null })).toThrow(
      error,
    );
  });
  it.each(["SIGKILL", "exit1"])(
    "accepts only owner-retired IPC refusal with %s close",
    (outcome) => {
      const artifacts = tempDirs.make("snapshot-ipc-close-");
      const f = refusalRecords(artifacts);
      Object.assign(f.native, nativeTransportFixture(true));
      f.fault.native = structuredClone(f.native);
      f.fault.failure.channel = "process.send";
      if (outcome === "exit1") {
        f.native.close = { code: 1, signal: null };
      }
      f.save();
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        expect(() =>
          assertSnapshotCleanupRefusal(artifacts, { exitCode: 1, signal: null }),
        ).not.toThrow();
      } finally {
        log.mockRestore();
      }
    },
  );
  it.each([
    {
      name: "external cancel",
      change: (f: ReturnType<typeof refusalRecords>) => {
        expectDefined(f.native.stops[0], "selected retirement stop").kind =
          "external-or-unobserved";
      },
      error: "External cancellation",
    },
    {
      name: "unobserved kill",
      change: (f: ReturnType<typeof refusalRecords>) => {
        f.native.stops = [];
      },
      error: "retirement was not observed",
    },
    {
      name: "unsent kill",
      change: (f: ReturnType<typeof refusalRecords>) => {
        expectDefined(f.native.stops[0], "selected retirement stop").accepted = false;
      },
      error: "close was not",
    },
    {
      name: "other signal",
      change: (f: ReturnType<typeof refusalRecords>) => {
        f.native.close.signal = "SIGTERM";
      },
      error: "close was not",
    },
    {
      name: "wrong request",
      change: (f: ReturnType<typeof refusalRecords>) => {
        expectDefined(f.native.reply, "selected failure reply").id++;
      },
      error: "selected failure reply",
    },
    {
      name: "wrong result",
      change: (f: ReturnType<typeof refusalRecords>) => {
        expectDefined(f.native.reply, "selected failure reply").sha256 = "0".repeat(64);
      },
      error: "failure replies differ",
    },
    {
      name: "reused pid",
      change: (f: ReturnType<typeof refusalRecords>) => {
        f.native.childStart = "999";
      },
      error: "native request identity",
    },
    {
      name: "wrong parent birth",
      change: (f: ReturnType<typeof refusalRecords>) => {
        f.native.parentStart = "999";
      },
      error: "native request identity",
    },
    {
      name: "observer failure",
      change: (f: ReturnType<typeof refusalRecords>) => {
        f.native.observationError = "unreadable owner";
      },
      error: "observation was incomplete",
    },
    {
      name: "stdout substitute",
      change: (f: ReturnType<typeof refusalRecords>) => {
        f.fault.failure.channel = "stdout";
      },
      error: "real IPC reply",
    },
    {
      name: "retirement before reply",
      change: (f: ReturnType<typeof refusalRecords>) => {
        expectDefined(f.native.stops[0], "selected retirement stop").at = "109";
      },
      error: "External cancellation",
    },
    {
      name: "cleanup before close",
      change: (f: ReturnType<typeof refusalRecords>) => {
        f.native.retirement.startedAt = "119";
      },
      error: "cleanup ordering",
    },
    {
      name: "same worker another request",
      change: (f: ReturnType<typeof refusalRecords>) => {
        f.write("snapshot-cleanup-native-" + "a".repeat(64) + ".json", {
          ...f.native,
          ipcRequestId: 3,
        });
      },
      error: "another native request",
    },
  ])("rejects IPC custody with $name", ({ change, error }) => {
    const artifacts = tempDirs.make("snapshot-ipc-negative-");
    const f = refusalRecords(artifacts);
    Object.assign(f.native, nativeTransportFixture(true));
    f.fault.native = structuredClone(f.native);
    f.fault.failure.channel = "process.send";
    change(f);
    f.save();
    expect(() => assertSnapshotCleanupRefusal(artifacts, { exitCode: 1, signal: null })).toThrow(
      error,
    );
  });
  it("does not retain an allocator request after its completion or on a neighboring request", () => {
    const root = tempDirs.make("snapshot-request-lifetime-");
    const source = join(root, "source.sqlite");
    let current: { source: string; stagingRoot: string } | undefined;
    const observed: string[] = [];
    const restore = observeSnapshotAllocations(
      source,
      () => current,
      (directory: string) => observed.push(directory),
    );
    const allocate = () => {
      // openclaw-temp-dir: allow actual allocator under the test-owned parent
      return fs.mkdtempSync(join(root, "openclaw-sqlite-readonly-"));
    };
    try {
      allocate();
      current = { source, stagingRoot: root };
      const selected = allocate();
      current = undefined;
      allocate();
      current = { source: source + ".other", stagingRoot: root };
      allocate();
      expect(observed).toEqual([selected]);
    } finally {
      restore();
    }
    expect(
      readSnapshotWorkerLaunch(["worker.mjs", "--openclaw-sqlite-readonly-child", "session"]),
    ).toEqual({ entrypoint: "worker.mjs", transport: "ipc" });
  });
  it("counts repeated acquisition observations in the same directory", () => {
    const artifacts = tempDirs.make("snapshot-same-directory-");
    const f = refusalRecords(artifacts);
    const record = createSnapshotAcquisitionRecorder(artifacts, {
      identity: f.identity,
      pid: 101,
      threadId: 0,
      operationId: () => f.native.operationId,
    });
    record(f.fault.staging);
    record(f.fault.staging);
    expect(() => assertSnapshotCleanupRefusal(artifacts, { exitCode: 1, signal: null })).toThrow(
      "Selected operation reacquired",
    );
  });
  it("does not count 80 unrelated acquisitions as selected retries or require failed scratch forever", () => {
    const artifacts = tempDirs.make("snapshot-selected-count-");
    const f = refusalRecords(artifacts);
    for (let index = 0; index < 80; index++) {
      f.write("snapshot-cleanup-attempts-" + (200 + index) + "-0.json", {
        identity: f.identity,
        acquisitions: [
          { directory: join(artifacts, "unrelated-" + index), at: index < 40 ? "90" : "110" },
        ],
      });
    }
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(() =>
        assertSnapshotCleanupRefusal(artifacts, { exitCode: 1, signal: null }),
      ).not.toThrow();
    } finally {
      log.mockRestore();
    }
    const proof = JSON.parse(readFileSync(join(artifacts, "snapshot-cleanup-proof.json"), "utf8"));
    expect(proof.acquisitions).toMatchObject({
      selected: 1,
      unselectedBefore: 40,
      unselectedAfter: 40,
      unknown: 0,
    });
  });
});

// Exercise the existing private capture -> host-redaction publication boundary.
it.each(["failed", "timeout", "passed"] as const)(
  "publishes snapshot-cell diagnostics after %s",
  (outcome) => {
    const root = tempDirs.make("snapshot-proof-artifacts-");
    const artifacts = join(root, "artifacts");
    mkdirSync(artifacts);
    const state = join(root, "state");
    mkdirSync(state);
    const write = (name: string, value: unknown) =>
      writeFileSync(join(artifacts, name), JSON.stringify(value));
    const f = refusalRecords(artifacts);
    Object.assign(f.native, nativeTransportFixture(true));
    f.fault.native = structuredClone(f.native);
    f.fault.failure.channel = "process.send";
    f.fault.failure.message =
      "SQLite artifact-preserving copy and cleanup failed; " + '\\"\n'.repeat(2000);
    f.save();
    write("snapshot-cleanup-candidate.json", { sha256: "b".repeat(64) });
    write("snapshot-cleanup-candidate-identity.json", { privatePackageInventory: true });
    write("snapshot-cleanup-result.json", {
      exitCode: 1,
      signal: null,
      status: "error",
      failedDoctorStep: true,
    });
    for (let index = 0; index < 120; index++) {
      write("snapshot-cleanup-attempts-" + (200 + index) + "-0.json", {
        pid: 200 + index,
        threadId: 0,
        identity: { ...f.identity, privatePackageInventory: "privatePackageInventory".repeat(30) },
        acquisitions: [
          {
            directory: join(artifacts, "private-path-" + index + '\\"\n'.repeat(1000)),
            at: index < 80 ? "90" : "110",
          },
        ],
      });
    }
    writeSnapshotCleanupEvidence(artifacts);
    write("update.stdout", { status: "error", reason: "fixture failure before fault" });
    const probePhases = [
      "service-probe-install",
      "service-probe-reload",
      "service-probe-verify",
      "service-probe-restore",
      "service-probe-restore-reload",
      "service-probe-restore-verify",
    ];
    for (const phase of probePhases) {
      write(phase + ".stdout", { unitSha256: "c".repeat(64) });
      writeFileSync(join(artifacts, phase + ".stderr"), "synthetic probe diagnostic");
      write(phase + "-exit.json", { exitCode: 0, processTreeState: "terminated" });
    }
    writeFileSync(join(artifacts, "update.stderr"), "Authorization: Bearer snapshot-fixture-token");
    write("summary.json", {
      status: "passed",
      baseline: { spec: "openclaw@2026.9.7", version: "2026.9.7" },
      candidate: { kind: "tarball", version: "2026.9.8" },
      scenario: "snapshot-cleanup-refusal",
      installedVersion: "2026.9.7",
      candidateInstallMode: "npm",
      updateRestartMode: "manual",
      updateOutcome: "expected-refusal",
      phases: [],
    });
    const capture = spawnSync(
      process.execPath,
      [
        resolve("scripts/e2e/lib/upgrade-survivor/diagnostics.mjs"),
        "capture",
        artifacts,
        "snapshot-cleanup-refusal",
        outcome === "passed" ? "0" : outcome === "timeout" ? "124" : "1",
      ],
      {
        env: { ...process.env, HOME: root, OPENCLAW_STATE_DIR: state },
        encoding: "utf8",
        timeout: 10000,
      },
    );
    expect(capture.status, capture.stderr).toBe(0);
    const published = join(root, "published");
    publishDiagnostics(
      artifacts,
      published,
      redactSensitiveText,
      outcome === "passed" ? "passed" : "failed",
    );
    const text = readFileSync(
      join(published, outcome === "passed" ? "summary.json" : "failure.json"),
      "utf8",
    );
    const report = JSON.parse(text);
    if (outcome !== "passed") {
      expect(report.exitStatus).toBe(outcome === "timeout" ? 124 : 1);
    }
    expect(JSON.parse(report.logs["update.stdout"]).reason).toBe("fixture failure before fault");
    for (const phase of probePhases) {
      expect(JSON.parse(report.logs[phase + ".stdout"]).unitSha256).toBe("c".repeat(64));
      expect(report.logs[phase + ".stderr"]).toBe("synthetic probe diagnostic");
      expect(JSON.parse(report.logs[phase + "-exit.json"]).processTreeState).toBe("terminated");
    }
    const evidence = report.logs["snapshot-cleanup-evidence.json"];
    expect(Buffer.byteLength(JSON.stringify(evidence))).toBeLessThanOrEqual(8 * 1024);
    expect(JSON.parse(evidence)).toMatchObject({
      version: 2,
      overflow: false,
      unknown: [],
      inventoryOmitted: true,
      fault: {
        pid: 101,
        terminalRefusal: true,
        groupIncompleteAtRefusal: true,
        failure: { channel: "process.send", resultSha256: "e".repeat(64) },
      },
      custody: {
        transport: "ipc",
        ipcRequestId: 2,
        childStart: "125",
        stopCount: 1,
        close: { code: null, signal: "SIGKILL" },
      },
      doctor: { pid: 99, result: { status: "error" } },
      outer: { status: "error", exitCode: 1, failedDoctorStep: true },
      acquisitions: { selected: 1, unselectedBefore: 80, unselectedAfter: 40, unknown: 0 },
      candidate: { sha256: "b".repeat(64) },
    });
    expect(report.omissions?.["snapshot-cleanup-evidence.json"]).toBeUndefined();
    expect(text).not.toContain("snapshot-fixture-token");
    expect(text).not.toContain("privatePackageInventory");
  },
);

it("leaves package lifecycle scripts outside the snapshot runtime observer", () => {
  const identity = {
    entrypoint: "scripts/preinstall-package-manager-warning.mjs",
    entrypointSha256: "d6eb7f880a3a5aa9bb4ed6e79229e8defcefc51884b22de41629b8f304bb5103",
    manifestSha256: "b".repeat(64),
    buildInfoSha256: "c".repeat(64),
  };
  const expected = {
    files: {
      "openclaw.mjs": { sha256: "a".repeat(64) },
      "package.json": { sha256: identity.manifestSha256 },
      "dist/build-info.json": { sha256: identity.buildInfoSha256 },
    },
  };
  expect(bindSnapshotRuntimeIdentity(identity, expected)).toBeUndefined();
  const runtime = { ...identity, entrypoint: "openclaw.mjs", entrypointSha256: "a".repeat(64) };
  expect(bindSnapshotRuntimeIdentity(runtime, expected)).toMatchObject({
    ...runtime,
    payloadSha256: expect.any(String),
  });
  expect(() =>
    bindSnapshotRuntimeIdentity({ ...runtime, entrypointSha256: "x".repeat(64) }, expected),
  ).toThrow();
  expect(() =>
    bindSnapshotRuntimeIdentity({ ...runtime, entrypoint: "dist/unexpected.worker.js" }, expected),
  ).toThrow();
});

it("retains a settled updater timeout before reading snapshot proof", () => {
  const failure = Object.assign(new Error("Published updater timed out after settlement"), {
    exitCode: 124,
    command: "update",
  });
  let actual: unknown;
  try {
    assertSnapshotCleanupRefusal("/missing-snapshot-proof", undefined, failure);
  } catch (error) {
    actual = error;
  }
  expect(actual).toBe(failure);
  expect(actual).toMatchObject({ exitCode: 124, command: "update" });
});

function admittedRuntimeFixture(version = "2026.9.8", commit = "a".repeat(40)) {
  const root = fs.realpathSync(tempDirs.make("snapshot-admitted-runtime-"));
  mkdirSync(join(root, "dist"));
  const entry = join(root, "openclaw.mjs");
  writeFileSync(entry, "export const fixture = true;");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "openclaw", version }));
  writeFileSync(join(root, "dist", "build-info.json"), JSON.stringify({ version, commit }));
  mkdirSync(join(root, "dist", "native"));
  writeFileSync(join(root, "dist", "native", "worker.mjs"), "export const worker = true;");
  return { root, entry, expected: readWorkerCellPackageIdentity(root) };
}

it("classifies admitted runtime aliases separately from lifecycle and eval probe arguments", () => {
  const f = admittedRuntimeFixture();
  const alias = join(tempDirs.make("snapshot-cli-link-"), "package");
  fs.symlinkSync(f.root, alias, process.platform === "win32" ? "junction" : "dir");
  const dependency = join(f.root, "node_modules", "koffi");
  mkdirSync(dependency, { recursive: true });
  const lifecycle = join(f.root, "scripts", "preinstall.mjs");
  mkdirSync(join(f.root, "scripts"));
  writeFileSync(lifecycle, "export const lifecycle = true;");
  // The native dependency probe occurs before Doctor admission; the same data
  // argument remains unrelated if inherited below an already admitted Doctor.
  expect(readSnapshotProcessIdentity(dependency, f.expected)).toBeUndefined();
  expect(readSnapshotProcessIdentity(dependency, f.expected, f.root)).toBeUndefined();
  expect(readSnapshotProcessIdentity(lifecycle, f.expected, f.root)).toBeUndefined();
  for (const entry of [f.entry, join(alias, "openclaw.mjs")]) {
    expect(readSnapshotProcessIdentity(entry, f.expected, f.root)).toMatchObject({
      root: f.root,
      commit: f.expected.buildInfo.commit,
      entrypoint: "openclaw.mjs",
      payloadSha256: expect.any(String),
    });
  }
  for (const [version, commit] of [
    ["2026.9.7", "b".repeat(40)],
    ["2026.9.9", "c".repeat(40)],
  ]) {
    const other = admittedRuntimeFixture(version, commit);
    const identity = readSnapshotProcessIdentity(other.entry, f.expected, f.root);
    expect(identity).toMatchObject({ version, commit });
    expect(identity).not.toHaveProperty("payloadSha256");
  }
});

it.each(["missing", "directory", "bytes", "manifest", "build", "missing-build"])(
  "refuses an admitted selected runtime after %s changes",
  (change) => {
    const f = admittedRuntimeFixture();
    if (change === "missing" || change === "directory") {
      fs.unlinkSync(f.entry);
      if (change === "directory") {
        mkdirSync(f.entry);
      }
    } else if (change === "bytes") {
      writeFileSync(f.entry, "export const replaced = true;");
    } else if (change === "manifest") {
      writeFileSync(join(f.root, "package.json"), JSON.stringify({ name: "other-package" }));
    } else if (change === "missing-build") {
      fs.unlinkSync(join(f.root, "dist", "build-info.json"));
    } else {
      writeFileSync(
        join(f.root, "dist", "build-info.json"),
        JSON.stringify({ version: "2026.9.7", commit: "b".repeat(40) }),
      );
    }
    expect(() => readSnapshotProcessIdentity(f.entry, f.expected, f.root)).toThrow();
  },
);

it("propagates an admitted runtime read denial instead of declining the observation", () => {
  const f = admittedRuntimeFixture();
  const failure = Object.assign(new Error("fixture read denied"), { code: "EACCES" });
  const read = vi.spyOn(fs, "readFileSync").mockImplementation(() => {
    throw failure;
  });
  try {
    expect(() => readSnapshotProcessIdentity(f.entry, f.expected, f.root)).toThrow(failure);
  } finally {
    read.mockRestore();
  }
});

it("rejects a selected alias retargeted to an unlisted runtime with identical bytes", () => {
  const f = admittedRuntimeFixture();
  const selected = join(f.root, "dist", "native");
  const replacement = join(f.root, "dist", "alternate");
  mkdirSync(replacement);
  writeFileSync(join(replacement, "worker.mjs"), readFileSync(join(selected, "worker.mjs")));
  fs.rmSync(selected, { recursive: true });
  fs.symlinkSync(replacement, selected, process.platform === "win32" ? "junction" : "dir");
  expect(() =>
    readSnapshotProcessIdentity(join(selected, "worker.mjs"), f.expected, f.root),
  ).toThrow();
});

it("retains admitted selection through an alias after runtime parents disappear", () => {
  const f = admittedRuntimeFixture();
  const alias = join(tempDirs.make("snapshot-missing-parent-alias-"), "package");
  fs.symlinkSync(f.root, alias, process.platform === "win32" ? "junction" : "dir");
  fs.rmSync(join(f.root, "dist"), { recursive: true });
  expect(() =>
    readSnapshotProcessIdentity(join(alias, "dist", "native", "worker.mjs"), f.expected, f.root),
  ).toThrow();
});
