import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { appendTranscriptEvent, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { createSessionSqliteMigrationRun } from "../infra/session-sqlite-migration-manifest.js";
import {
  closeOpenClawAgentDatabasesAsync,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { inspectSessionSqliteRecovery } from "./doctor-session-sqlite-recovery-inventory.js";
import { readSessionSqliteMigrationWarnings } from "./doctor-session-sqlite-warnings.js";
import { useDoctorSessionSqliteTestFixture } from "./doctor-session-sqlite.test-support.js";

const { createVerifiedRecoveryStore } = useDoctorSessionSqliteTestFixture();
const active = (file: string, sessionKey = "agent:main:live") => ({
  code: "active_sqlite_transcript_jsonl",
  sessionKey,
  message: `SQLite-backed session has a legacy JSONL transcript awaiting verification: ${file}. Run openclaw doctor --fix or openclaw doctor --session-sqlite recover with the Gateway stopped to verify, import any missing events, and archive the original.`,
});

it("revalidates completed migration findings without changing recovery evidence", async () => {
  await withOpenClawTestState({ layout: "state-only" }, async (state) => {
    const file = (name: string) => path.join(state.sessionsDir(), name);
    const storePath = file("sessions.json");
    const scope = { agentId: "main", sessionKey: "agent:main:live", storePath, env: state.env };
    for (const sessionId of ["live", "empty"]) {
      await replaceSessionEntry(
        { ...scope, sessionKey: `agent:main:${sessionId}` },
        { sessionId, updatedAt: 1 },
      );
    }
    await appendTranscriptEvent(
      { ...scope, sessionId: "live" },
      { type: "session", id: "live", version: 3 },
    );
    await closeOpenClawAgentDatabasesAsync();
    const sqlitePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env });
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const kept = file("kept.jsonl");
    fs.writeFileSync(kept, "{}\n");
    const missing = (sessionKey: string) => ({
      code: "transcript_missing",
      sessionKey,
      message: `Transcript file is missing: ${file(`${sessionKey.split(":").at(-1)}.jsonl`)}`,
    });
    const malformed = (name: string) => ({
      code: "transcript_malformed",
      sessionKey: scope.sessionKey,
      message: `${file(name)}: SyntaxError: invalid JSON. Only the readable prefix can be imported; the original remains protected for recovery.`,
    });
    fs.writeFileSync(file("broken.jsonl"), "{");
    fs.writeFileSync(file("repaired.jsonl"), "{}\n");
    const oldMissing = {
      ...missing(scope.sessionKey),
      message: `Transcript file is missing: ${file("older-generation.jsonl")}`,
    };
    const issues = [
      ...Array.from({ length: 12 }, (_, i) => active(file(`gone-${i}.jsonl`))),
      active(kept),
      active(file("gone-main.jsonl"), "agent:main:main"),
      missing(scope.sessionKey),
      missing("agent:main:pruned"),
      missing("agent:main:empty"),
      missing("agent:main:main"),
      missing("legacy"),
      oldMissing,
      malformed("broken.jsonl"),
      malformed("repaired.jsonl"),
      { code: "historical_transcript_deferred", message: "Archive remains unverified" },
    ];
    const { manifest, manifestPath } = createSessionSqliteMigrationRun(state.env, [
      { agentId: "main", sqlitePath, storePath },
    ]);
    manifest.completedAt = manifest.failedAt = manifest.startedAt;
    Object.assign(manifest.targets[0]!, { issues, validationBeforeArchive: "passed" });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const original = fs.readFileSync(manifestPath);
    const warnings = readSessionSqliteMigrationWarnings(state.env);
    expect(warnings).toEqual(
      [
        {
          code: "active_sqlite_transcript_jsonl",
          message: `SQLite-backed session has a legacy JSONL transcript awaiting verification: ${kept}. Run openclaw doctor --session-sqlite inspect to check current originals before choosing recovery.`,
        },
        missing("agent:main:empty"),
        missing("agent:main:main"),
        missing("legacy"),
        oldMissing,
        malformed("broken.jsonl"),
        issues.at(-1)!,
      ].map((issue) => `${storePath}: [${issue.code}] ${issue.message}`),
    );
    expect(fs.readFileSync(manifestPath)).toEqual(original);

    await closeOpenClawAgentDatabasesAsync();
    fs.renameSync(sqlitePath, `${sqlitePath}.saved`);
    const missingStoreWarnings = readSessionSqliteMigrationWarnings(state.env);
    expect(missingStoreWarnings).toHaveLength(issues.length);
    expect(missingStoreWarnings.join("\n")).not.toContain("Gateway stopped");
    fs.writeFileSync(sqlitePath, "not a database");
    expect(readSessionSqliteMigrationWarnings(state.env)).toHaveLength(issues.length);
    expect(fs.readFileSync(manifestPath)).toEqual(original);
  });
});

it("keeps cleanup import proof after resolved warnings disappear", async () => {
  const { store, manifestPath, manifest } = await createVerifiedRecoveryStore();
  manifest.targets[0]!.issues.push(active(store.transcriptPath, "agent:main:main"));
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const original = fs.readFileSync(manifestPath);
  const before = inspectSessionSqliteRecovery({ cfg: {}, env: store.env });
  expect(before.totals.candidateBytes).toBeGreaterThan(0);
  expect(readSessionSqliteMigrationWarnings(store.env)).toEqual([]);
  expect(inspectSessionSqliteRecovery({ cfg: {}, env: store.env })).toEqual(before);
  expect(fs.readFileSync(manifestPath)).toEqual(original);
});
