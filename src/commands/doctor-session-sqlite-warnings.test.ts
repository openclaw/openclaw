import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import {
  createSessionSqliteMigrationRun,
  writeSessionSqliteMigrationManifest,
} from "../infra/session-sqlite-migration-manifest.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { readSessionSqliteMigrationWarnings } from "./doctor-session-sqlite-warnings.js";

function activeFileIssue(transcriptPath: string) {
  return {
    code: "active_sqlite_transcript_jsonl",
    message: `SQLite-backed session has a legacy JSONL transcript awaiting verification: ${transcriptPath}. Run openclaw doctor --fix or openclaw doctor --session-sqlite recover with the Gateway stopped to verify, import any missing events, and archive the original.`,
  };
}

it("omits resolved active-file warnings without changing migration evidence or live state", async () => {
  await withOpenClawTestState({ label: "resolved-migration-warnings" }, async (state) => {
    const sqlitePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env });
    openOpenClawAgentDatabase({ agentId: "main", path: sqlitePath, env: state.env });
    await closeOpenClawAgentDatabasesAsync();
    const sessionsDir = state.sessionsDir();
    fs.mkdirSync(sessionsDir, { recursive: true });
    const presentPath = path.join(sessionsDir, "still-present.jsonl");
    fs.writeFileSync(presentPath, "original transcript\n");
    const retained = [
      activeFileIssue(presentPath),
      activeFileIssue("unresolved-relative.jsonl"),
      { code: "active_sqlite_transcript_jsonl", message: "Older unresolvable wording" },
      { code: "transcript_missing", message: "Other historical evidence" },
    ];
    const run = createSessionSqliteMigrationRun(state.env, [
      { agentId: "main", sqlitePath, storePath: path.join(sessionsDir, "sessions.json") },
    ]);
    run.manifest.completedAt = "2026-10-15T00:00:01Z";
    run.manifest.failedAt = run.manifest.completedAt;
    const target = expectDefined(run.manifest.targets[0], "migration target");
    target.issues = [
      activeFileIssue(path.join(sessionsDir, "already-archived.jsonl")),
      activeFileIssue(path.join(state.root, "outside-sessions.jsonl")),
      ...retained,
    ];
    writeSessionSqliteMigrationManifest(run);
    const protectedFiles = [run.manifestPath, sqlitePath, presentPath];
    const originalBytes = protectedFiles.map((file) => fs.readFileSync(file));

    expect(readSessionSqliteMigrationWarnings(state.env)).toEqual(
      retained.map((issue) => `${target.storePath}: [${issue.code}] ${issue.message}`),
    );
    expect(protectedFiles.map((file) => fs.readFileSync(file))).toEqual(originalBytes);
  });
});

it("keeps active-file warnings when the live database cannot establish resolution", async () => {
  await withOpenClawTestState({ label: "unresolved-migration-warnings" }, async (state) => {
    const targets = ["missing", "corrupt", "schema-missing"].map((agentId) => ({
      agentId,
      sqlitePath: path.join(state.agentDir(agentId), "agent.sqlite"),
      storePath: path.join(state.sessionsDir(agentId), "sessions.json"),
    }));
    for (const target of targets.slice(1)) {
      fs.mkdirSync(path.dirname(target.sqlitePath), { recursive: true });
      fs.writeFileSync(target.sqlitePath, target.agentId === "corrupt" ? "not sqlite" : "");
    }
    const run = createSessionSqliteMigrationRun(state.env, targets);
    run.manifest.completedAt = "2026-10-15T00:00:01Z";
    for (const target of run.manifest.targets) {
      target.issues = [activeFileIssue(path.join(path.dirname(target.storePath), "gone.jsonl"))];
    }
    writeSessionSqliteMigrationManifest(run);

    expect(readSessionSqliteMigrationWarnings(state.env)).toEqual(
      run.manifest.targets.map(
        (target) => `${target.storePath}: [active_sqlite_transcript_jsonl] ${target.issues[0]?.message}`,
      ),
    );
    expect(fs.existsSync(expectDefined(targets[0], "missing target").sqlitePath)).toBe(false);
  });
});
