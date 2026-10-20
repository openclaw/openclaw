import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, expect, it } from "vitest";
import {
  assertProjectWorktreeImportReport as assertImport,
  assertProjectWorktreeStartupLog as assertStartupLog,
  assertProjectWorktreeStartupPreservation as assertPreserved,
} from "../../scripts/e2e/lib/upgrade-survivor/project-worktree-startup.mjs";
import {
  readWorkerCellPackageIdentity as readIdentity,
  resolveWorkerCellExport as resolveExport,
  resolveWorkerCellFunctionBinding as resolveBinding,
} from "../../scripts/e2e/lib/upgrade-survivor/worker-cell-package.mjs";
import { createNativeTypeScriptParser } from "../../scripts/lib/native-typescript.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { runProcess, writeJson, writeExecutable } from "./upgrade-survivor-shard.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const parser = createNativeTypeScriptParser();
afterAll(() => parser.close());

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
function migrated(workspace = "/fixture/project") {
  const result = structuredClone(original);
  const row = result.agent.sessions[0]!;
  const entry = JSON.parse(row.entry_json);
  entry.worktree.canonicalWorkspaceDir = workspace;
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
function doctorOwnerFixture(chunks: string[], definition = schemaDefinition) {
  const root = tempDirs.make("openclaw-doctor-owner-binding-");
  mkdirSync(path.join(root, "dist"));
  writeJson(path.join(root, "package.json"), { name: "openclaw", version: "0.0.0-test" });
  writeFileSync(path.join(root, "openclaw.mjs"), "// synthetic package identity\n");
  writeJson(path.join(root, "dist/build-info.json"), {
    version: "0.0.0-test",
    commit: "1".repeat(40),
  });
  for (const name of chunks) {
    writeFileSync(
      path.join(root, "dist", `doctor-owner-${name}.mjs`),
      name === "entry" ? schemaForwarder : definition,
    );
  }
  return { root, identity: readIdentity(root) };
}

it.each<[string, string[], RegExp?, string?, boolean?]>([
  ["forwarded owner", ["entry", "real"]],
  ["two defining owners", ["real", "other"], /one installed defining/],
  ["forwarder without a definition", ["entry"], /one installed defining/],
  ["malformed definition", ["real"], /Cannot parse package owner/, `function ${schemaSymbol}( {`],
  ["changed candidate bytes", ["real"], /Package owner changed/, undefined, true],
])(
  "resolves only an unchanged defining Doctor chunk: %s",
  async (_name, chunks, error, definition, changed) => {
    const { root, identity } = doctorOwnerFixture(chunks, definition);
    if (changed) {
      writeFileSync(
        path.join(root, "dist/doctor-owner-real.mjs"),
        `${schemaDefinition}\n// changed\n`,
      );
    }
    const binding = resolveBinding(identity, root, "doctor-owner", schemaSymbol, parser);
    if (error) {
      await expect(binding).rejects.toThrow(error);
    } else {
      expect(resolveExport(schemaForwarder, schemaSymbol)).toBe(schemaSymbol);
      expect(await binding).toEqual([
        "doctor-owner-real.mjs",
        schemaSymbol,
        createHash("sha256").update(schemaDefinition).digest("hex"),
      ]);
    }
  },
);

it("prepares the independent schema before startup and repairs workspace metadata between runs", () => {
  const root = tempDirs.make("openclaw-project-worktree-doctor-order-");
  const runtime = path.join(root, "runtime");
  const events = path.join(root, "events");
  for (const dir of ["bin", "artifacts", "runtime"]) {
    mkdirSync(path.join(root, dir));
  }
  // This orchestration unit test replaces package operations, not the runner's phase sequence.
  writeExecutable(
    path.join(root, "bin/openclaw"),
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
  const result = runProcess("/bin/bash", [
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
workspace() { cat "$OPENCLAW_STATE_DIR/workspace-state"; }
event() { printf '%s %s%s\\n' "$1" "$OPENCLAW_STATE_DIR" "\${2:+ $2}" >> "$UNIT_EVENTS"; }
set_state() {
  printf '%s' "$1" > "$OPENCLAW_STATE_DIR/workspace-state"
  printf '%s' "$2" > "$OPENCLAW_STATE_DIR/schema-version"
}
node() {
  if [ "$1" = -e ]; then
    printf '%s\\n' "$OPENCLAW_STATE_DIR/sessions.json"
  elif [ "$1" = scripts/e2e/lib/upgrade-survivor/worker-cell-package.mjs ]; then
    printf '{}\\n' > "$ARTIFACT_ROOT/baseline-package-identity.json"
  elif [ "$1" = scripts/e2e/lib/upgrade-survivor/project-worktree-startup.mjs ]; then
    case "$2" in
      seed)
        set_state legacy 19
        event seed ;;
      prepare-schema)
        [ "$(cat "$OPENCLAW_STATE_DIR/schema-version")" = 19 ]
        printf 21 > "$OPENCLAW_STATE_DIR/schema-version"
        event schema-doctor ;;
      snapshot)
        case "$3" in
          published-import|before-schema) [ "$(cat "$OPENCLAW_STATE_DIR/schema-version")" = 19 ] ;;
          *)
            if [ "$(cat "$OPENCLAW_STATE_DIR/schema-version")" != 21 ]; then
              printf 'Candidate schema migration required before Gateway startup\\n' >&2
              return 96
            fi ;;
        esac
        printf 'snapshot %s %s %s\\n' "$3" "$OPENCLAW_STATE_DIR" "$(workspace)" >> "$UNIT_EVENTS" ;;
      assert-import|assert-logs) : ;;
      *) return 97 ;;
    esac
  else
    return 97
  fi
}
update_candidate() {
  set_state repaired 21
  printf '{}\\n' > "$ARTIFACT_ROOT/installed-package-identity.json"
  event update
}
start_gateway() { event start "$(workspace)"; }
stop_gateway() { event stop; }
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
  ]);
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

it("preserves imported bytes and permits only the Doctor-owned workspace repair", () => {
  const check = (actual: typeof original, workspace?: string) => () =>
    assertPreserved(actual, original, workspace);
  for (const [actual, workspace, accepted] of [
    [original, undefined, true],
    [migrated(), "/fixture/project", true],
    [migrated(), undefined, false],
    [original, "/fixture/project", false],
  ] as const) {
    if (accepted) {
      expect(check(actual, workspace)).not.toThrow();
    } else {
      expect(check(actual, workspace)).toThrow();
    }
  }
  const corruptions: Array<(value: typeof original) => void> = [
    (value) => value.agent.sessions[0]!.updated_at++,
    (value) => (value.agent.sessions[0]!.current_session_id = "replacement"),
    (value) => (value.agent.transcript[0]!.event_json = "rewritten"),
    (value) => (value.shared.project[0]!.id = "other"),
    (value) => (value.agent.sessions[1]!.entry_json = '{"changed":true}'),
    (value) => value.agent.sessions.pop(),
    (value) =>
      (value.agent.sessions[0]!.entry_json =
        migrated("/fixture/agent-default").agent.sessions[0]!.entry_json),
  ];
  for (const corrupt of corruptions) {
    const value = migrated();
    corrupt(value);
    expect(check(value, "/fixture/project")).toThrow();
  }
  const rewritten = structuredClone(original);
  const row = rewritten.agent.sessions[0]!;
  row.entry_json = JSON.stringify(JSON.parse(row.entry_json), null, 2);
  expect(check(rewritten)).toThrow();
});

it.each(["raw message", "rendered console"])(
  "requires clean shutdown without a runtime repair in %s logs",
  (format) => {
    const prefix = (area: string) =>
      format === "raw message" ? "" : `2026-09-16T15:10:34.169+00:00 [${area}] `;
    const migration = `${prefix("gateway")}session: recorded canonical workspaces for 1 managed-worktree session(s)`;
    const shutdownPrefix = prefix("shutdown") || "shutdown ";
    const closed = `${shutdownPrefix}completed cleanly in 19ms`;
    const warned = `${shutdownPrefix}completed in 19ms with warnings: database drain`;
    const failed = `${shutdownPrefix}failed in 19ms`;
    for (const start of ["first", "second"]) {
      expect(assertStartupLog(closed, start)).toEqual({
        backfills: [],
        cleanShutdown: true,
      });
    }
    for (const log of [
      "gateway ready",
      migration,
      `${migration}\n${closed}`,
      `${migration}\n${warned}`,
      `${migration}\n${failed}`,
      `${migration}\n${closed}\n${warned}`,
      `${migration}\n${closed}\n${failed}`,
    ]) {
      expect(() => assertStartupLog(log, "first")).toThrow();
    }
    expect(() => assertStartupLog(`${migration}\n${closed}`, "second")).toThrow();
  },
);

it("accepts complete published imports and rejects incomplete or mismatched evidence", () => {
  const valid = publishedImportEvidence();
  const check = ({ report, dryRun, manifest }: ReturnType<typeof publishedImportEvidence>) =>
    assertImport(report, report.targets[0]!.storePath, dryRun, manifest);
  expect(check(valid)).toEqual(valid.report.targets[0]);
  const rejectChanges = (
    select: (e: typeof valid) => object,
    fields: Record<string, unknown[]>,
  ) => {
    for (const [key, values] of Object.entries(fields)) {
      for (const value of values) {
        const evidence = publishedImportEvidence();
        Object.assign(select(evidence), { [key]: value });
        expect(() => check(evidence)).toThrow();
      }
    }
  };
  rejectChanges((e) => e.report.targets[0]!, {
    agentId: ["other"],
    importedEntries: [1],
    importedTranscriptEvents: [3],
    sqliteEntries: [1],
    legacyEntries: [1],
    referencedTranscriptFiles: [1],
    validatedEntries: [1],
    validatedTranscriptEvents: [1],
    issues: [[{ code: "transcript_missing" }]],
  });
  rejectChanges((e) => e.dryRun.targets[0]!, {
    validatedEntries: [1],
    validatedTranscriptEvents: [3],
    sqlitePath: ["/fixture/other.sqlite"],
    issues: [[{ code: "transcript_malformed" }]],
  });
  rejectChanges((e) => e.manifest.targets[0]!, {
    validationBeforeArchive: ["not_run", "failed", undefined],
    agentId: ["other"],
    storePath: ["/fixture/other.json"],
    sqlitePath: ["/fixture/other.sqlite"],
    issues: [[{ code: "sqlite_entry_missing" }]],
  });
  rejectChanges((e) => e.manifest, {
    completedAt: [undefined],
    failedAt: [valid.manifest.completedAt],
    runId: ["other-run"],
    targets: [[valid.manifest.targets[0], valid.manifest.targets[0]]],
  });
});
