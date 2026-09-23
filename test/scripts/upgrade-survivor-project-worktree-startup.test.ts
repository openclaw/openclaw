import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertProjectWorktreeImportReport,
  assertProjectWorktreeStartupLog,
  assertProjectWorktreeStartupPreservation,
} from "../../scripts/e2e/lib/upgrade-survivor/project-worktree-startup.mjs";
import {
  readWorkerCellPackageIdentity,
  resolveWorkerCellExport,
  resolveWorkerCellFunctionBinding,
} from "../../scripts/e2e/lib/upgrade-survivor/worker-cell-package.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const sessionKey = "agent:main:dashboard:legacy-project-worktree";
const original = {
  shared: { project: [{ id: "project" }], worktrees: [{ id: "worktree" }] },
  agent: {
    sessions: [
      {
        session_key: sessionKey,
        current_session_id: "target",
        updated_at: 10,
        entry_json: JSON.stringify({
          sessionId: "target",
          updatedAt: 10,
          lastActivityAt: 10,
          projectId: "project",
          worktree: { id: "worktree", repoRoot: "/fixture/project" },
        }),
      },
      { session_key: "other", current_session_id: "sentinel", updated_at: 20, entry_json: "{}" },
    ],
    transcript: [{ session_id: "target", seq: 1, event_json: "original bytes", created_at: 10 }],
  },
};
function migrated() {
  const result = structuredClone(original);
  const row = result.agent.sessions[0]!;
  const entry = JSON.parse(row.entry_json);
  entry.worktree.canonicalWorkspaceDir = "/fixture/project";
  row.entry_json = JSON.stringify(entry);
  return result;
}

function publishedImportEvidence() {
  const target = {
    agentId: "main",
    storePath: "/fixture/sessions.json",
    sqlitePath: "/fixture/agent.sqlite",
    legacyEntries: 2,
    referencedTranscriptFiles: 2,
    sqliteEntries: 2,
    importedEntries: 2,
    importedTranscriptEvents: 4,
    validatedEntries: 0,
    validatedTranscriptEvents: 0,
    issues: [],
  };
  return {
    report: { mode: "import", targets: [target], migrationRun: { runId: "published-import" } },
    dryRun: {
      mode: "dry-run",
      targets: [
        {
          ...target,
          sqliteEntries: 0,
          importedEntries: 0,
          importedTranscriptEvents: 0,
          validatedEntries: 2,
          validatedTranscriptEvents: 4,
        },
      ],
    },
    manifest: {
      runId: "published-import",
      completedAt: "2026-09-16T10:42:34.189Z",
      targets: [
        {
          agentId: target.agentId,
          storePath: target.storePath,
          sqlitePath: target.sqlitePath,
          validationBeforeArchive: "passed",
          issues: [],
        },
      ],
    },
  };
}

const schemaSymbol = "migrateLegacyMediaPersistence";
const schemaDefinition = `throw new Error("Fixture modules must not execute");
async function ${schemaSymbol}() {}
export { ${schemaSymbol} as t };
`;
const schemaForwarder = `import { t as ${schemaSymbol} } from "./doctor-owner-real.mjs";
export { ${schemaSymbol} };
`;
function doctorOwnerFixture(files: Record<string, string>) {
  const root = tempDirs.make("openclaw-doctor-owner-binding-");
  mkdirSync(path.join(root, "dist"));
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", version: "0.0.0-test" }),
  );
  writeFileSync(path.join(root, "openclaw.mjs"), "// synthetic package identity\n");
  writeFileSync(
    path.join(root, "dist/build-info.json"),
    JSON.stringify({ version: "0.0.0-test", commit: "1".repeat(40) }),
  );
  for (const [name, source] of Object.entries(files)) {
    writeFileSync(path.join(root, "dist", name), source);
  }
  return { root, identity: readWorkerCellPackageIdentity(root) };
}

describe("published project-worktree Doctor ownership evidence", () => {
  it("selects the defining Doctor chunk while retaining valid forwarding exports", () => {
    const { root, identity } = doctorOwnerFixture({
      "doctor-owner-entry.mjs": schemaForwarder,
      "doctor-owner-real.mjs": schemaDefinition,
    });
    expect(resolveWorkerCellExport(schemaForwarder, schemaSymbol)).toBe(schemaSymbol);
    expect(
      resolveWorkerCellFunctionBinding(identity, root, "doctor-owner", schemaSymbol, ts),
    ).toEqual([
      "doctor-owner-real.mjs",
      schemaSymbol,
      createHash("sha256").update(schemaDefinition).digest("hex"),
    ]);
  });

  it.each<{ name: string; files: Record<string, string>; error: RegExp }>([
    {
      name: "two defining owners",
      files: {
        "doctor-owner-real.mjs": schemaDefinition,
        "doctor-owner-other.mjs": schemaDefinition,
      },
      error: /one installed defining/,
    },
    {
      name: "forwarder without a definition",
      files: { "doctor-owner-entry.mjs": schemaForwarder },
      error: /one installed defining/,
    },
    {
      name: "malformed definition",
      files: { "doctor-owner-real.mjs": `function ${schemaSymbol}( {` },
      error: /Cannot parse package owner/,
    },
  ])("rejects $name before importing Doctor code", ({ files, error }) => {
    const { root, identity } = doctorOwnerFixture(files);
    expect(() =>
      resolveWorkerCellFunctionBinding(identity, root, "doctor-owner", schemaSymbol, ts),
    ).toThrow(error);
  });

  it("rejects changed candidate owner bytes", () => {
    const { root, identity } = doctorOwnerFixture({ "doctor-owner-real.mjs": schemaDefinition });
    writeFileSync(
      path.join(root, "dist/doctor-owner-real.mjs"),
      `${schemaDefinition}\n// changed\n`,
    );
    expect(() =>
      resolveWorkerCellFunctionBinding(identity, root, "doctor-owner", schemaSymbol, ts),
    ).toThrow(/Package owner changed/);
  });

  it("prepares the independent schema before startup and repairs workspace metadata between runs", () => {
    const root = tempDirs.make("openclaw-project-worktree-doctor-order-");
    const bin = path.join(root, "bin");
    const artifacts = path.join(root, "artifacts");
    const runtime = path.join(root, "runtime");
    const events = path.join(root, "events");
    mkdirSync(bin);
    mkdirSync(artifacts);
    mkdirSync(runtime);
    // This orchestration unit test replaces package operations, not the runner's phase sequence.
    writeFileSync(
      path.join(bin, "openclaw"),
      `#!/bin/bash
set -eu
if [ "$*" = 'doctor --fix --non-interactive' ]; then
  [ -z "\${OPENCLAW_UPDATE_IN_PROGRESS+x}" ]
  [ -z "\${OPENCLAW_UPDATE_POST_CORE_CONVERGENCE+x}" ]
  [ -z "\${OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE+x}" ]
  [ -z "\${OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR+x}" ]
  printf repaired > "$OPENCLAW_STATE_DIR/workspace-state"
  printf 'doctor %s\\n' "$OPENCLAW_STATE_DIR" >> "$UNIT_EVENTS"
else
  printf '{}\\n'
fi
`,
      { mode: 0o755 },
    );
    const source = readFileSync("scripts/e2e/lib/upgrade-survivor/run.sh", "utf8");
    const helpers = source.slice(
      source.indexOf("run_project_worktree_import()"),
      source.indexOf("validate_worker_cell()"),
    );
    const scenario = source.slice(
      source.indexOf('if [ "$WORKER_CELL" = "1" ]; then\n  phase worker-baseline-identity'),
      source.indexOf('\nif [ "$SCENARIO" = "workshop-doctor-recovery" ]; then\n  phase '),
    );
    const result = spawnSync(
      "/bin/bash",
      [
        "-c",
        `set -eu
source scripts/lib/openclaw-e2e-instance.sh
SCENARIO=projects-startup-migration
WORKER_CELL=1
COMMAND_TIMEOUT=5s
ARTIFACT_ROOT="$1/artifacts"
RUNTIME_ROOT="$1/runtime"
export UNIT_EVENTS="$1/events"
export PATH="$1/bin:$PATH"
export OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT="$ARTIFACT_ROOT"
export OPENCLAW_UPGRADE_SURVIVOR_STARTUP_BINDINGS=unit-bindings
export OPENCLAW_UPDATE_IN_PROGRESS=unit-marker
export OPENCLAW_UPDATE_POST_CORE_CONVERGENCE=unit-marker
export OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE=unit-marker
export OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR=unit-marker
baseline_spec=unit-baseline
candidate_version=unit-candidate
package_root() { printf '%s\\n' "$RUNTIME_ROOT/unit-package"; }
openclaw_test_state_create() {
  export HOME="$1" OPENCLAW_HOME="$1" OPENCLAW_STATE_DIR="$1/.openclaw"
  export OPENCLAW_CONFIG_PATH="$OPENCLAW_STATE_DIR/openclaw.json"
  unset OPENCLAW_AGENT_DIR
  mkdir -p "$OPENCLAW_STATE_DIR"
}
openclaw_test_state_create "$RUNTIME_ROOT/state-home"
node() {
  if [ "$1" = -e ]; then
    printf '%s\\n' "$OPENCLAW_STATE_DIR/sessions.json"
  elif [ "$1" = scripts/e2e/lib/upgrade-survivor/worker-cell-package.mjs ]; then
    printf '{}\\n' > "$ARTIFACT_ROOT/baseline-package-identity.json"
  elif [ "$1" = scripts/e2e/lib/upgrade-survivor/project-worktree-startup.mjs ]; then
    case "$2" in
      seed)
        printf legacy > "$OPENCLAW_STATE_DIR/workspace-state"
        printf 19 > "$OPENCLAW_STATE_DIR/schema-version"
        printf 'seed %s\\n' "$OPENCLAW_STATE_DIR" >> "$UNIT_EVENTS" ;;
      prepare-schema)
        [ "$(cat "$OPENCLAW_STATE_DIR/schema-version")" = 19 ]
        printf 21 > "$OPENCLAW_STATE_DIR/schema-version"
        printf 'schema-doctor %s\\n' "$OPENCLAW_STATE_DIR" >> "$UNIT_EVENTS" ;;
      snapshot)
        case "$3" in
          published-import|before-schema) [ "$(cat "$OPENCLAW_STATE_DIR/schema-version")" = 19 ] ;;
          *)
            if [ "$(cat "$OPENCLAW_STATE_DIR/schema-version")" != 21 ]; then
              printf 'Candidate schema migration required before Gateway startup\\n' >&2
              return 96
            fi ;;
        esac
        printf 'snapshot %s %s %s\\n' "$3" "$OPENCLAW_STATE_DIR" "$(cat "$OPENCLAW_STATE_DIR/workspace-state")" >> "$UNIT_EVENTS" ;;
      assert-import|assert-logs) : ;;
      *) return 97 ;;
    esac
  else
    return 97
  fi
}
update_candidate() {
  printf repaired > "$OPENCLAW_STATE_DIR/workspace-state"
  printf 21 > "$OPENCLAW_STATE_DIR/schema-version"
  printf '{}\\n' > "$ARTIFACT_ROOT/installed-package-identity.json"
  printf 'update %s\\n' "$OPENCLAW_STATE_DIR" >> "$UNIT_EVENTS"
}
start_gateway() {
  printf 'start %s %s\\n' "$OPENCLAW_STATE_DIR" "$(cat "$OPENCLAW_STATE_DIR/workspace-state")" >> "$UNIT_EVENTS"
}
stop_gateway() { printf 'stop %s\\n' "$OPENCLAW_STATE_DIR" >> "$UNIT_EVENTS"; }
check_gateway_probes() { :; }
phase() {
  shift
  case "$1" in
    node|prepare_project_worktree_startup_fixture|run_project_worktree_startup_fixture|run_project_worktree_doctor|backup_project_worktree_fixture|run_project_worktree_import|update_candidate|start_gateway|stop_gateway|check_gateway_probes) "$@" ;;
    *) : ;;
  esac
}
${helpers}
${scenario}
`,
        "project-worktree-doctor-order",
        root,
      ],
      { encoding: "utf8" },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const first = path.join(runtime, "state-home/.openclaw");
    const second = path.join(runtime, "worktree-startup-state/.openclaw");
    expect(readFileSync(events, "utf8").trim().split("\n")).toEqual([
      `seed ${first}`,
      `snapshot published-import ${first} legacy`,
      `seed ${second}`,
      `snapshot published-import ${second} legacy`,
      `update ${first}`,
      `snapshot after-update ${first} repaired`,
      `snapshot before-schema ${second} legacy`,
      `schema-doctor ${second}`,
      `snapshot before-startup ${second} legacy`,
      `start ${second} legacy`,
      `stop ${second}`,
      `snapshot after-first-stop ${second} legacy`,
      `doctor ${second}`,
      `snapshot after-doctor ${second} repaired`,
      `start ${second} repaired`,
      `stop ${second}`,
      `snapshot after-second-stop ${second} repaired`,
    ]);
  });

  it("preserves the imported shape until Doctor adds only the canonical workspace", () => {
    expect(() =>
      assertProjectWorktreeStartupPreservation(original, original, undefined),
    ).not.toThrow();
    expect(() =>
      assertProjectWorktreeStartupPreservation(migrated(), original, "/fixture/project"),
    ).not.toThrow();
    expect(() =>
      assertProjectWorktreeStartupPreservation(migrated(), original, undefined),
    ).toThrow();
    expect(() =>
      assertProjectWorktreeStartupPreservation(original, original, "/fixture/project"),
    ).toThrow();
  });

  it("rejects startup rewriting the imported session JSON without changing its fields", () => {
    const rewritten = structuredClone(original);
    const row = rewritten.agent.sessions[0]!;
    row.entry_json = JSON.stringify(JSON.parse(row.entry_json), null, 2);
    expect(() =>
      assertProjectWorktreeStartupPreservation(rewritten, original, undefined),
    ).toThrow();
  });

  it.each([
    "activity",
    "generation",
    "transcript",
    "project",
    "unrelated",
    "missing",
    "wrong-workspace",
  ])("rejects a changed %s instead of accepting readiness as migration proof", (change) => {
    const result = migrated();
    if (change === "activity") {
      result.agent.sessions[0]!.updated_at++;
    }
    if (change === "generation") {
      result.agent.sessions[0]!.current_session_id = "replacement";
    }
    if (change === "transcript") {
      result.agent.transcript[0]!.event_json = "rewritten";
    }
    if (change === "project") {
      result.shared.project[0]!.id = "other";
    }
    if (change === "unrelated") {
      result.agent.sessions[1]!.entry_json = '{"changed":true}';
    }
    if (change === "missing") {
      result.agent.sessions.pop();
    }
    if (change === "wrong-workspace") {
      const entry = JSON.parse(result.agent.sessions[0]!.entry_json);
      entry.worktree.canonicalWorkspaceDir = "/fixture/agent-default";
      result.agent.sessions[0]!.entry_json = JSON.stringify(entry);
    }
    expect(() =>
      assertProjectWorktreeStartupPreservation(result, original, "/fixture/project"),
    ).toThrow();
  });

  it.each([
    {
      format: "raw message",
      migration: "session: recorded canonical workspaces for 1 managed-worktree session(s)",
      shutdownPrefix: "shutdown",
    },
    {
      format: "rendered console",
      migration:
        "2026-09-16T15:10:34.169+00:00 [gateway] session: recorded canonical workspaces for 1 managed-worktree session(s)",
      shutdownPrefix: "2026-09-16T15:10:35.584+00:00 [shutdown]",
    },
  ])(
    "requires clean shutdown without a runtime repair in $format logs",
    ({ migration, shutdownPrefix }) => {
      const closed = `${shutdownPrefix} completed cleanly in 19ms`;
      const warned = `${shutdownPrefix} completed in 19ms with warnings: database drain`;
      const failed = `${shutdownPrefix} failed in 19ms`;
      expect(assertProjectWorktreeStartupLog(closed, "first")).toEqual({
        backfills: [],
        cleanShutdown: true,
      });
      expect(assertProjectWorktreeStartupLog(closed, "second")).toEqual({
        backfills: [],
        cleanShutdown: true,
      });
      for (const log of [
        "gateway ready",
        migration,
        `${migration}\n${closed}`,
        `${migration}\n${warned}`,
        `${migration}\n${failed}`,
        `${migration}\n${closed}\n${warned}`,
        `${migration}\n${closed}\n${failed}`,
      ]) {
        expect(() => assertProjectWorktreeStartupLog(log, "first")).toThrow();
      }
      expect(() => assertProjectWorktreeStartupLog(`${migration}\n${closed}`, "second")).toThrow();
    },
  );

  it("accepts published fresh-import counters with separate pre-archive validation", () => {
    const { report, dryRun, manifest } = publishedImportEvidence();
    const target = report.targets[0]!;
    expect(assertProjectWorktreeImportReport(report, target.storePath, dryRun, manifest)).toEqual(
      target,
    );
  });

  it("rejects incomplete import and dry-run receipts", () => {
    for (const change of [
      { agentId: "other" },
      { importedEntries: 1 },
      { importedTranscriptEvents: 3 },
      { sqliteEntries: 1 },
      { legacyEntries: 1 },
      { referencedTranscriptFiles: 1 },
      { validatedEntries: 1 },
      { validatedTranscriptEvents: 1 },
      { issues: [{ code: "transcript_missing" }] },
    ]) {
      const { report, dryRun, manifest } = publishedImportEvidence();
      const target = report.targets[0]!;
      expect(() =>
        assertProjectWorktreeImportReport(
          { ...report, targets: [{ ...target, ...change }] },
          target.storePath,
          dryRun,
          manifest,
        ),
      ).toThrow();
    }
    for (const change of [
      { validatedEntries: 1 },
      { validatedTranscriptEvents: 3 },
      { sqlitePath: "/fixture/other.sqlite" },
      { issues: [{ code: "transcript_malformed" }] },
    ]) {
      const { report, dryRun, manifest } = publishedImportEvidence();
      expect(() =>
        assertProjectWorktreeImportReport(
          report,
          report.targets[0]!.storePath,
          { ...dryRun, targets: [{ ...dryRun.targets[0], ...change }] },
          manifest,
        ),
      ).toThrow();
    }
  });

  it("requires a completed matching manifest with successful pre-archive validation", () => {
    for (const change of [
      { validationBeforeArchive: "not_run" },
      { validationBeforeArchive: "failed" },
      { validationBeforeArchive: undefined },
      { agentId: "other" },
      { storePath: "/fixture/other.json" },
      { sqlitePath: "/fixture/other.sqlite" },
      { issues: [{ code: "sqlite_entry_missing" }] },
    ]) {
      const { report, dryRun, manifest } = publishedImportEvidence();
      expect(() =>
        assertProjectWorktreeImportReport(report, report.targets[0]!.storePath, dryRun, {
          ...manifest,
          targets: [{ ...manifest.targets[0], ...change }],
        }),
      ).toThrow();
    }
    const { report, dryRun, manifest } = publishedImportEvidence();
    for (const invalid of [
      { ...manifest, completedAt: undefined },
      { ...manifest, failedAt: manifest.completedAt },
      { ...manifest, runId: "other-run" },
      { ...manifest, targets: [manifest.targets[0], manifest.targets[0]] },
    ]) {
      expect(() =>
        assertProjectWorktreeImportReport(report, report.targets[0]!.storePath, dryRun, invalid),
      ).toThrow();
    }
  });
});
