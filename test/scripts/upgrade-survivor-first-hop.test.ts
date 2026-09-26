import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const observer = resolve("scripts/e2e/lib/upgrade-survivor/diagnostics.mjs");

function rollbackSuccessSummary() {
  const hash = "a".repeat(64);
  return {
    status: "passed",
    baseline: { spec: "openclaw@2026.9.4", version: "2026.9.4" },
    candidate: { kind: "tarball", version: "2026.9.5" },
    scenario: "legacy-operator-state",
    installedVersion: "2026.9.5",
    candidateInstallMode: "updater",
    updateRestartMode: "manual",
    updateOutcome: "success",
    phases: [],
    backupRollback: {
      status: "passed",
      baselineVersion: "2026.9.4",
      candidateVersion: "2026.9.5",
      runtime: {
        version: "2026.9.4",
        schemaVersions: { state: 16, agent: 19 },
        packageRoot: "/private/host/runtime",
        entry: "/private/host/index.mjs",
        manifestSha256: hash,
        entrySha256: hash,
      },
      candidateSchemaVersions: { state: 17, agent: 21 },
      archive: { path: "/private/host/archive.tgz", sha256: hash },
      restoredStateDir: "/private/host/restored",
      before: {
        databases: [
          {
            kind: "state",
            present: true,
            relative: "/private/host/state",
            userVersion: 16,
            contentVersion: 16,
            sessions: [],
            tables: [],
          },
          {
            kind: "agent",
            agentId: "main",
            present: true,
            userVersion: 19,
            contentVersion: 19,
            relative: "/private/host/agent",
            metadata: { secret: "PRIVATE_VALUE" },
            sessions: [{ key: "PRIVATE_SESSION_KEY", sessionId: "PRIVATE_SESSION_ID" }],
            tables: [
              { table: "session_nodes", rows: 1, sha256: hash, columns: ["PRIVATE_COLUMN"] },
              { table: "transcript_events", rows: 2, sha256: hash, raw: "PRIVATE_TRANSCRIPT" },
            ],
          },
          { kind: "agent", agentId: "ops", present: false, relative: "/private/host/ops" },
        ],
        files: [
          {
            kind: "legacy-store",
            relative: "/private/host/legacy",
            sha256: hash,
            raw: "PRIVATE_JSON",
          },
        ],
      },
      preflights: [
        {
          agentId: "main",
          status: "exact",
          foundVersion: 19,
          targetVersion: 19,
          output: "/private/host/preflight.json",
        },
      ],
      sessionReads: [
        {
          agentId: "main",
          count: 1,
          output: "/private/host/sessions.json",
          path: "/private/host/agent.sqlite",
        },
      ],
    },
  };
}

async function publishSuccess(summary: unknown, logs: Record<string, unknown> = {}) {
  const root = tempDirs.make("survivor-rollback-publication-");
  const artifacts = join(root, "private");
  const published = join(root, "published");
  mkdirSync(artifacts);
  writeFileSync(join(artifacts, "summary.json"), JSON.stringify(summary));
  for (const [name, value] of Object.entries(logs)) {
    writeFileSync(join(artifacts, name), JSON.stringify(value));
  }
  const { publishDiagnostics } = await import(observer);
  return {
    artifacts,
    published,
    publish: () => publishDiagnostics(artifacts, published, (text: string) => text, "passed"),
  };
}

describe("upgrade survivor rollback publication", () => {
  it("retains producer results and distinguishes canonical rollback from omitted raw transcripts", async () => {
    const summary = rollbackSuccessSummary();
    const omission = {
      relative: "agents/main/sessions/upgrade-restored-index-history.jsonl",
      kind: "transcript",
      sha256: "b".repeat(64),
      archiveMember:
        "backup/payload/state/agents/main/sessions/upgrade-restored-index-history.jsonl",
      sessionId: "PRIVATE_SESSION_ID",
      canonicalEventCount: 2,
      reason: "published-2026.9.4-volatile-transcript",
    };
    const created = { verified: true, skippedVolatileCount: 3, skipped: [] };
    const restored = { ok: true, archiveRoot: "backup" };
    Object.assign(summary.backupRollback, {
      backupCreate: created,
      rawTranscriptRestoration: "unsupported-by-published-backup",
      omittedRawTranscripts: [omission],
    });
    summary.backupRollback.before.files.push({
      kind: omission.kind,
      relative: omission.relative,
      sha256: omission.sha256,
      raw: "PRIVATE_JSON",
    });
    const { artifacts, publish, published } = await publishSuccess(summary);
    const rawProof = {
      status: "passed",
      runtime: {
        version: "2026.9.4",
        manifestSha256: "a".repeat(64),
        entrySha256: "a".repeat(64),
      },
      rawTranscriptRestoration: "unsupported-by-published-backup",
      omittedRawTranscripts: [{ ...omission, sessionId: "upgrade-restored-index-history" }],
    };
    writeFileSync(join(artifacts, "backup-rollback.json"), JSON.stringify(rawProof));
    writeFileSync(join(artifacts, "backup-rollback-create.json"), JSON.stringify(created));
    writeFileSync(join(artifacts, "backup-rollback-restore.json"), JSON.stringify(restored));
    publish();
    const text = readFileSync(join(published, "summary.json"), "utf8");
    expect(text).not.toMatch(/PRIVATE_|\/private\/host/);
    const receipt = JSON.parse(text);
    expect(receipt.backupRollback).toMatchObject({
      skippedVolatileCount: 3,
      rawTranscriptRestoration: "unsupported-by-published-backup",
      omittedRawTranscripts: [
        {
          relative: omission.relative,
          kind: "transcript",
          sha256: omission.sha256,
          archiveMember: omission.archiveMember,
          canonicalEventCount: 2,
          reason: omission.reason,
        },
      ],
    });
    expect(JSON.parse(receipt.logs["backup-rollback-create.json"])).toEqual(created);
    expect(JSON.parse(receipt.logs["backup-rollback-restore.json"])).toEqual(restored);
    expect(JSON.parse(receipt.logs["backup-rollback.json"])).toEqual(rawProof);
  });

  it("retains restored-index result evidence through host publication", async () => {
    const { artifacts, publish, published } = await publishSuccess(rollbackSuccessSummary());
    writeFileSync(
      join(artifacts, "restored-index-post-update.json"),
      JSON.stringify({ status: "passed", current: { label: "Renamed session", pinnedAt: 1234 } }),
    );
    publish();
    const receipt = JSON.parse(readFileSync(join(published, "summary.json"), "utf8"));
    expect(JSON.parse(receipt.logs["restored-index-post-update.json"])).toEqual({
      status: "passed",
      current: { label: "Renamed session", pinnedAt: 1234 },
    });
  });

  it("publishes the validated rollback schema, session counts and hashes without private state", async () => {
    const { publish, published } = await publishSuccess(rollbackSuccessSummary());
    publish();
    const text = readFileSync(join(published, "summary.json"), "utf8");
    expect(text).not.toMatch(/PRIVATE_|\/private\/host/);
    const proof = JSON.parse(text).backupRollback;
    expect(proof).toMatchObject({
      status: "passed",
      baselineVersion: "2026.9.4",
      candidateVersion: "2026.9.5",
      baselineSchemaVersions: { state: 16, agent: 19 },
      candidateSchemaVersions: { state: 17, agent: 21 },
      archiveSha256: "a".repeat(64),
      baselineRuntime: { manifestSha256: "a".repeat(64), entrySha256: "a".repeat(64) },
      databases: [
        {
          kind: "state",
          present: true,
          userVersion: 16,
          contentVersion: 16,
          sessionCount: 0,
          tables: [],
        },
        {
          kind: "agent",
          agentId: "main",
          present: true,
          userVersion: 19,
          contentVersion: 19,
          sessionCount: 1,
          tables: [
            { table: "session_nodes", rows: 1, sha256: "a".repeat(64) },
            { table: "transcript_events", rows: 2, sha256: "a".repeat(64) },
          ],
          preflight: { status: "exact", foundVersion: 19, targetVersion: 19 },
          sessionRead: { count: 1 },
        },
        { kind: "agent", agentId: "ops", present: false },
      ],
      files: [{ kind: "legacy-store", sha256: "a".repeat(64) }],
    });
    expect(readdirSync(published)).toEqual(["summary.json"]);
  });

  it.each(["absent", "older-legacy-absent", "not-applicable"])(
    "preserves %s rollback evidence from older scenarios",
    async (kind) => {
      const summary = rollbackSuccessSummary();
      const { publish, published } = await publishSuccess({
        ...summary,
        scenario: kind === "absent" ? "base" : "legacy-operator-state",
        baseline: { spec: "openclaw@2026.9.3", version: "2026.9.3" },
        backupRollback:
          kind === "not-applicable"
            ? {
                status: "not-applicable",
                baselineVersion: "2026.9.3",
                minimumBaseline: "2026.9.4",
                reason: "/private/host/PRIVATE_REASON",
              }
            : undefined,
      });
      publish();
      const receipt = JSON.parse(readFileSync(join(published, "summary.json"), "utf8"));
      expect(receipt.backupRollback).toEqual(
        kind === "not-applicable"
          ? {
              status: "not-applicable",
              baselineVersion: "2026.9.3",
              minimumBaseline: "2026.9.4",
            }
          : undefined,
      );
    },
  );

  it.each([
    { kind: "missing", value: undefined },
    { kind: "null", value: null },
  ])("rejects $kind required rollback evidence before publishing success", async ({ value }) => {
    const { publish, published } = await publishSuccess({
      ...rollbackSuccessSummary(),
      backupRollback: value,
    });
    expect(publish).toThrow("Invalid backup rollback evidence");
    expect(existsSync(join(published, "summary.json"))).toBe(false);
  });

  it.each([
    "unfinished",
    "wrong-candidate",
    "missing-preflight",
    "duplicate-read",
    "wrong-count",
    "wrong-schema",
    "invalid-hash",
    "unsafe-table-name",
    "oversized-collection",
    "no-history",
    "unbound-omission",
    "unsupported-restoration-claim",
    "invalid-volatile-count",
  ])("refuses %s rollback evidence without writing a successful receipt", async (kind) => {
    const summary = rollbackSuccessSummary();
    const proof = summary.backupRollback;
    if (kind === "unfinished") {
      proof.status = "captured";
    }
    if (kind === "wrong-candidate") {
      proof.candidateVersion = "2026.9.6";
    }
    if (kind === "missing-preflight") {
      proof.preflights = [];
    }
    if (kind === "duplicate-read") {
      proof.sessionReads.push(proof.sessionReads[0]!);
    }
    if (kind === "wrong-count") {
      proof.sessionReads[0]!.count = 2;
    }
    if (kind === "wrong-schema") {
      proof.preflights[0]!.targetVersion = 21;
    }
    if (kind === "invalid-hash") {
      proof.archive.sha256 = "PRIVATE_HASH";
    }
    if (kind === "unsafe-table-name") {
      proof.before.databases[1]!.tables![0]!.table = "/private/host/table";
    }
    if (kind === "oversized-collection") {
      proof.before.files = Array.from({ length: 129 }, () => proof.before.files[0]!);
    }
    if (kind === "no-history") {
      proof.before.databases[1]!.tables![1]!.rows = 0;
    }
    if (kind === "unbound-omission") {
      Object.assign(proof, {
        backupCreate: { skippedVolatileCount: 1 },
        rawTranscriptRestoration: "unsupported-by-published-backup",
        omittedRawTranscripts: [
          {
            kind: "transcript",
            relative: "agents/main/sessions/unrecorded.jsonl",
            archiveMember: "backup/payload/unrecorded.jsonl",
            sha256: "b".repeat(64),
            canonicalEventCount: 2,
            reason: "published-2026.9.4-volatile-transcript",
          },
        ],
      });
    }
    if (kind === "unsupported-restoration-claim") {
      Object.assign(proof, { rawTranscriptRestoration: "unsupported-by-published-backup" });
    }
    if (kind === "invalid-volatile-count") {
      Object.assign(proof, { backupCreate: { skippedVolatileCount: -1 } });
    }
    const { publish, published } = await publishSuccess(summary);
    expect(publish).toThrow();
    expect(existsSync(join(published, "summary.json"))).toBe(false);
  });
});

function seedSessionMigration(root: string, issueCount = 1) {
  const directory = join(root, "session-sqlite-migration-runs");
  mkdirSync(directory);
  const runId = "session-sqlite-1789528941490-661aa836";
  const target = {
    agentId: "private-agent-value",
    sqlitePath: join(root, "private.sqlite"),
    storePath: join(root, "private-sessions.json"),
    validationBeforeArchive: "passed",
    issues: Array.from({ length: issueCount }, (_, index) => ({
      code: index < 10 ? "transcript_missing" : "active_sqlite_transcript_jsonl",
      message: `private-issue-value ${"x".repeat(150)}`,
      sessionKey: "private-session-key",
    })),
  };
  const manifest = `${JSON.stringify(
    {
      runId,
      manifestVersion: 3,
      openClawVersion: "2026.8.1",
      startedAt: "2026-09-16T03:22:21.490Z",
      failureReports: { jsonPath: "/outside/do-not-read.json" },
      targets: [{ ...target, completedMoves: [], plannedMoves: [] }],
    },
    null,
    2,
  )}\n`;
  const failureReport = `${JSON.stringify(
    {
      runId,
      version: "2026.8.1",
      restoreStatus: "not_attempted",
      targets: [{ ...target, completedMoves: 0, plannedMoves: 0 }],
    },
    null,
    2,
  )}\n`;
  writeFileSync(join(directory, `${runId}.json`), manifest);
  writeFileSync(join(directory, `${runId}.failure.json`), failureReport);
  return { directory, runId, manifest, failureReport };
}

describe("upgrade survivor first-hop process evidence", () => {
  it("retains CLI receipt and transport witnesses in the opt-in report recovery proof", async () => {
    const { artifacts, publish, published } = await publishSuccess({
      status: "passed",
      baseline: { spec: "openclaw@2026.9.6", version: "2026.9.6" },
      candidate: { kind: "tarball", version: "2026.9.5" },
      scenario: "update-report-recovery",
      installedVersion: "2026.9.5",
      candidateInstallMode: "updater",
      updateRestartMode: "manual",
      updateOutcome: "success",
      phases: [],
    });
    const witnesses = {
      "update-report-recovery.json": JSON.stringify({ postCounts: [2, 1] }),
      "update-report-baseline.json": JSON.stringify({ version: "2026.9.6" }),
      "update-report-retry-status.log": JSON.stringify({ runId: "retry-run" }),
      "update-report-pending-status.log": JSON.stringify({ runId: "pending-run" }),
      "update-report-retry.gh.jsonl": JSON.stringify({ kind: "create", status: 422 }),
      "update-report-pending.gh.jsonl": JSON.stringify({ kind: "lookup", matches: [] }),
    };
    for (const [name, contents] of Object.entries(witnesses)) {
      writeFileSync(join(artifacts, name), contents);
    }
    publish();
    expect(JSON.parse(readFileSync(join(published, "summary.json"), "utf8")).logs).toMatchObject(
      witnesses,
    );
  });

  it.each([0, 1])("retains first-hop identities and Doctor IPC on exit %i", async (code) => {
    const root = realpathSync(tempDirs.make("survivor-first-hop-"));
    const artifacts = join(root, "artifacts");
    mkdirSync(artifacts);
    const migration = code === 1 ? seedSessionMigration(root, 4791) : null;
    const tmp = join(root, "tmp");
    const ipcRoot = join(tmp, `openclaw${process.getuid ? `-${process.getuid()}` : ""}`);
    mkdirSync(ipcRoot, { recursive: true, mode: 0o700 });
    const ipc = join(
      ipcRoot,
      "openclaw-update-doctor-123-00000000-0000-4000-8000-000000000000.json",
    );
    const manifest = join(root, "package.json");
    writeFileSync(manifest, JSON.stringify({ name: "openclaw", version: "2026.7.1-2" }));
    const entrypoint = join(root, "openclaw.mjs");
    // Files change under the running parent. Reading package.json at exit would
    // falsely attribute that parent's result to the newly installed updater.
    writeFileSync(
      entrypoint,
      `import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
if (process.argv[2] === 'update') {
  fs.writeFileSync(${JSON.stringify(manifest)}, JSON.stringify({name:'openclaw',version:'2026.8.1'}));
  const child = spawnSync(process.execPath, ['--import', ${JSON.stringify(observer)}, process.argv[1], 'doctor', '--non-interactive', '--fix'], {
    env: {...process.env, OPENCLAW_UPDATE_IN_PROGRESS:'1', OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH:${JSON.stringify(ipc)}}, stdio:'inherit'
  });
  fs.unlinkSync(${JSON.stringify(ipc)});
  process.exitCode = child.status;
} else {
  fs.writeFileSync(process.env.OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH, JSON.stringify({
    status: ${JSON.stringify(code === 0 ? "ok" : "error")},
    failureFacts: [{check:'plugin-doctor-post-session-state',code:'blocked-by-session-repair-failure',message:'private-doctor-value', extra:'private-ignored-value'}],
    configHash:'private-config-value'
  }), {mode:0o600});
  console.log('doctor fixture finished');
  process.exitCode = ${code};
}
`,
    );
    const result = spawnSync(
      process.execPath,
      ["--import", observer, entrypoint, "update", "--tag", "private-argument-value"],
      {
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: artifacts,
          OPENCLAW_GATEWAY_TOKEN: "private-environment-value",
          TMPDIR: tmp,
          TEMP: tmp,
          TMP: tmp,
        },
      },
    );
    expect(result.status, result.stderr).toBe(code);
    expect(result.stdout).toBe("doctor fixture finished\n");
    expect(result.stderr).toBe("");
    const files = readdirSync(join(artifacts, "diagnostics"));
    const reports = files.map((name) =>
      JSON.parse(readFileSync(join(artifacts, "diagnostics", name), "utf8")),
    );
    const started = reports.filter((report) => report.event === "started");
    const parent = started.find((report) => report.role === "update");
    const doctor = started.find((report) => report.role === "doctor");
    expect(started).toHaveLength(2);
    expect(parent).toMatchObject({ packageVersion: "2026.7.1-2" });
    expect(doctor).toMatchObject({ packageVersion: "2026.8.1", parentPid: parent.pid });
    expect(reports.filter((report) => report.event === "exited")).toEqual(
      expect.arrayContaining([
        { ...parent, event: "exited", exitCode: code },
        expect.objectContaining({ ...doctor, event: "exited", exitCode: code }),
      ]),
    );
    expect(existsSync(ipc)).toBe(false);
    const doctorExit = reports.find(
      (report) => report.role === "doctor" && report.event === "exited",
    );
    expect(doctorExit.doctorResult).toEqual({
      status: code === 0 ? "ok" : "error",
      failureFacts: [
        {
          check: "plugin-doctor-post-session-state",
          code: "blocked-by-session-repair-failure",
          message: "private-doctor-value",
        },
      ],
    });
    const capture = spawnSync(
      process.execPath,
      [observer, "capture", artifacts, "update-candidate", String(code), "", artifacts],
      {
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: root,
          OPENCLAW_CONFIG_PATH: join(root, "missing-config.json"),
        },
      },
    );
    expect(capture.status, capture.stderr).toBe(0);
    if (migration) {
      expect(Buffer.byteLength(migration.manifest)).toBeGreaterThan(256 * 1024);
      expect(Buffer.byteLength(migration.failureReport)).toBeGreaterThan(256 * 1024);
      const raw = JSON.parse(readFileSync(join(artifacts, "diagnostics/raw.json"), "utf8"));
      expect(raw.sessionMigration).toEqual({
        runId: migration.runId,
        manifest: migration.manifest,
        failureReport: migration.failureReport,
      });
      // Publication must still work after the failed container's runtime is gone.
      rmSync(migration.directory, { recursive: true });
    }
    const { publishDiagnostics } = await import(observer);
    const published = join(root, "published");
    publishDiagnostics(artifacts, published, (text: string) =>
      text
        .replaceAll("private-doctor-value", "[REDACTED]")
        .replaceAll("private-agent-value", "main"),
    );
    const report = JSON.parse(readFileSync(join(published, "failure.json"), "utf8"));
    expect(report.doctorResults).toEqual({
      availability: "captured",
      observations: [
        {
          pid: doctor.pid,
          parentPid: parent.pid,
          packageVersion: "2026.8.1",
          exitCode: code,
          status: code === 0 ? "ok" : "error",
          failureFacts: [
            {
              check: "plugin-doctor-post-session-state",
              code: "blocked-by-session-repair-failure",
              message: "[REDACTED]",
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(report)).not.toMatch(
      /private-doctor-value|private-ignored-value|private-config-value|private-issue-value|private-agent-value|private-session-key|outside\/do-not-read/,
    );
    if (migration) {
      const projected = {
        version: "2026.8.1",
        targets: [
          {
            agentId: "main",
            validationBeforeArchive: "passed",
            completedMoves: 0,
            plannedMoves: 0,
            issueCount: 4791,
            issueHistogram: [
              { code: "active_sqlite_transcript_jsonl", count: 4781 },
              { code: "transcript_missing", count: 10 },
            ],
          },
        ],
      };
      expect(report.sessionMigration).toEqual({
        availability: "captured",
        runId: migration.runId,
        manifest: projected,
        failureReport: projected,
      });
    }
    const rawPath = join(artifacts, "diagnostics/raw.json");
    const raw = JSON.parse(readFileSync(rawPath, "utf8"));
    raw.doctorResults[0].exited.parentPid++;
    if (migration) {
      raw.sessionMigration.manifest = JSON.stringify({
        ...JSON.parse(migration.manifest),
        runId: "session-sqlite-1789528941490-00000000",
      });
    }
    writeFileSync(rawPath, JSON.stringify(raw));
    const mismatched = join(root, "mismatched");
    publishDiagnostics(artifacts, mismatched, (text: string) => text);
    expect(
      JSON.parse(readFileSync(join(mismatched, "failure.json"), "utf8")).doctorResults,
    ).toEqual({ availability: "unknown", observations: [] });
    if (migration) {
      const changed = JSON.parse(readFileSync(join(mismatched, "failure.json"), "utf8"));
      expect(changed.sessionMigration.manifest).toBeNull();
      expect(changed.omissions["session migration manifest"]).toBe("invalid observation; omitted");
    }
    const serialized = JSON.stringify(reports);
    expect(serialized).not.toContain("private-argument-value");
    expect(serialized).not.toContain("private-environment-value");
    expect(serialized).not.toContain(root);
    expect(serialized).not.toMatch(/private-ignored-value|private-config-value/);
  });

  it.each([
    ["missing", "missing or unsafe file"],
    ["oversized", "input exceeds cap; omitted whole"],
    ["malformed", "invalid observation; omitted"],
    ...(process.platform === "win32" ? [] : [["symlink", "missing or unsafe file"]]),
  ])("retains manifest evidence when the migration failure report is %s", async (kind, reason) => {
    const root = realpathSync(tempDirs.make("survivor-migration-evidence-"));
    const artifacts = join(root, "artifacts");
    mkdirSync(artifacts);
    const migration = seedSessionMigration(root);
    const failurePath = join(migration.directory, `${migration.runId}.failure.json`);
    rmSync(failurePath);
    if (kind === "oversized" || kind === "malformed") {
      writeFileSync(failurePath, kind === "oversized" ? "x".repeat(2 * 1024 * 1024 + 1) : "{");
    } else if (kind === "symlink") {
      const external = join(root, "external.json");
      writeFileSync(external, migration.failureReport);
      symlinkSync(external, failurePath);
    }
    const captured = spawnSync(process.execPath, [observer, "capture", artifacts, "doctor", "1"], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: root,
        OPENCLAW_CONFIG_PATH: join(root, "absent.json"),
      },
    });
    expect(captured.status, captured.stderr).toBe(0);
    const raw = JSON.parse(readFileSync(join(artifacts, "diagnostics/raw.json"), "utf8"));
    expect(raw.sessionMigration.manifest).toBe(migration.manifest);
    expect(raw.sessionMigration.failureReport).toBeNull();
    expect(raw.omissions["session migration failure report"]).toBe(reason);
    const { publishDiagnostics } = await import(observer);
    const published = join(root, "published");
    publishDiagnostics(artifacts, published, (text: string) => text);
    const report = JSON.parse(readFileSync(join(published, "failure.json"), "utf8"));
    expect(report.sessionMigration).toMatchObject({
      availability: "captured",
      failureReport: null,
    });
    expect(report.omissions["session migration failure report"]).toBe(reason);
  });

  it.each(["available", "unavailable", "absent", "invalid"])(
    "publishes %s baseline companion coverage in successful receipts",
    async (availability) => {
      const root = realpathSync(tempDirs.make("survivor-companion-receipt-"));
      const baselineCompanion =
        availability === "absent"
          ? null
          : {
              package: "@openclaw/discord",
              version: "2026.8.1-beta.1",
              availability,
              reason:
                availability === "available"
                  ? null
                  : "Exact companion version is not published on npm (E404).",
            };
      writeFileSync(
        join(root, "summary.json"),
        JSON.stringify({
          status: "passed",
          baseline: { spec: "2026.8.1-beta.1", version: "2026.8.1-beta.1" },
          candidate: { kind: "package", version: "2026.9.4" },
          scenario: "legacy-operator-state",
          installedVersion: "2026.9.4",
          candidateInstallMode: "published",
          updateRestartMode: "manual",
          updateOutcome: "success",
          phases: [],
          baselineCompanion,
        }),
      );
      const { publishDiagnostics } = await import(observer);
      const published = join(root, "published");
      const publish = () =>
        publishDiagnostics(
          root,
          published,
          (text: string) => text.replaceAll("E404", "redacted"),
          "passed",
        );
      if (availability === "invalid") {
        expect(publish).toThrow();
        expect(existsSync(join(published, "summary.json"))).toBe(false);
        return;
      }
      publish();
      expect(
        JSON.parse(readFileSync(join(published, "summary.json"), "utf8")).baselineCompanion,
      ).toEqual(
        baselineCompanion
          ? {
              ...baselineCompanion,
              reason: baselineCompanion.reason?.replaceAll("E404", "redacted") ?? null,
            }
          : null,
      );
    },
  );

  it.each([
    "outside",
    "wrong-name",
    "malformed",
    "oversized",
    ...(process.platform === "win32" ? [] : ["symlink"]),
  ])("preserves Doctor exit when its IPC is %s", (kind) => {
    const root = realpathSync(tempDirs.make("survivor-unavailable-doctor-"));
    const tmp = join(root, "tmp");
    const ipcRoot = join(tmp, `openclaw${process.getuid ? `-${process.getuid()}` : ""}`);
    mkdirSync(ipcRoot, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.9.4" }),
    );
    const entrypoint = join(root, "openclaw.mjs");
    writeFileSync(entrypoint, "process.exitCode = 7;");
    const ipcFilename = "openclaw-update-doctor-123-00000000-0000-4000-8000-000000000000.json";
    const ipc =
      kind === "outside"
        ? join(root, ipcFilename)
        : join(ipcRoot, kind === "wrong-name" ? "other.json" : ipcFilename);
    const payload =
      kind === "malformed"
        ? "{"
        : JSON.stringify({
            status: "error",
            failureFacts: Array.from({ length: kind === "oversized" ? 6 : 1 }, () => ({
              check: "doctor",
              code: "failure",
              message: "private-doctor-value",
            })),
          });
    const target = kind === "symlink" ? join(root, "original.json") : ipc;
    writeFileSync(target, payload, { mode: 0o600 });
    if (kind === "symlink") {
      symlinkSync(target, ipc);
    }
    const result = spawnSync(process.execPath, ["--import", observer, entrypoint, "doctor"], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        TMPDIR: tmp,
        TEMP: tmp,
        TMP: tmp,
        OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: root,
        OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH: ipc,
      },
    });
    expect(result.status, result.stderr).toBe(7);
    expect(result.stdout + result.stderr).toBe("");
    expect(readFileSync(target, "utf8")).toBe(payload);
    const reports = readdirSync(join(root, "diagnostics")).map((name) =>
      JSON.parse(readFileSync(join(root, "diagnostics", name), "utf8")),
    );
    expect(reports).toHaveLength(2);
    expect(reports.find((report) => report.event === "exited")).toEqual({
      ...reports.find((report) => report.event === "started"),
      event: "exited",
      exitCode: 7,
    });
    expect(JSON.stringify(reports)).not.toContain("private-doctor-value");
  });

  it.skipIf(process.platform === "win32")("does not turn a signal into a successful exit", () => {
    const root = realpathSync(tempDirs.make("survivor-interrupted-hop-"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.7.1-2" }),
    );
    const entrypoint = join(root, "openclaw.mjs");
    writeFileSync(entrypoint, 'process.kill(process.pid, "SIGTERM");');
    const result = spawnSync(process.execPath, ["--import", observer, entrypoint, "update"], {
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: root },
    });
    expect(result.status).toBeNull();
    expect(result.signal).toBe("SIGTERM");
    expect(result.stdout + result.stderr).toBe("");
    const reports = readdirSync(join(root, "diagnostics")).map((name) =>
      JSON.parse(readFileSync(join(root, "diagnostics", name), "utf8")),
    );
    expect(reports).toEqual([
      expect.objectContaining({ role: "update", event: "started", packageVersion: "2026.7.1-2" }),
    ]);
  });
});

it.each([
  { version: "2026.9.4", mode: "manual" },
  { version: "2026.9.6", mode: "manual" },
  { version: "2026.9.6", mode: "auto-auth" },
])(
  "publishes Cron readback proof after a successful $version $mode upgrade",
  async ({ version, mode }) => {
    const summary = rollbackSuccessSummary();
    summary.baseline = { spec: `openclaw@${version}`, version };
    summary.backupRollback.baselineVersion = version;
    summary.backupRollback.runtime.version = version;
    summary.updateRestartMode = mode;
    const proofs = Object.fromEntries(
      ["post-update", "candidate"].map((stage) => [
        `legacy-operator-${stage}-cron-history.json`,
        {
          status: "passed",
          stage,
          source: version === "2026.9.4" ? "legacy-doctor-import" : "published-native-runs",
          pages: [{ jobId: "synthetic", runId: "retained" }],
        },
      ]),
    );
    const publication = await publishSuccess(summary, proofs);
    publication.publish();
    const result = JSON.parse(readFileSync(join(publication.published, "summary.json"), "utf8"));
    for (const [name, proof] of Object.entries(proofs)) {
      expect(JSON.parse(result.logs[name])).toEqual(proof);
    }
  },
);
