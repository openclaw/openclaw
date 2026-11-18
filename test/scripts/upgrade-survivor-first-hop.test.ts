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
import {
  readJson,
  runProcess,
  successSummary,
  writeJson,
} from "./upgrade-survivor-shard.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const observer = resolve("scripts/e2e/lib/upgrade-survivor/diagnostics.mjs");
const prettyJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const hash = "a".repeat(64);
const versions = { state: 16, agent: 19 };
const historyTables = [
  { table: "session_nodes", rows: 1, sha256: hash },
  { table: "transcript_events", rows: 2, sha256: hash },
];
const preflight = { status: "exact", foundVersion: 19, targetVersion: 19 };
const omission = {
  relative: "agents/main/sessions/upgrade-restored-index-history.jsonl",
  kind: "transcript",
  sha256: "b".repeat(64),
  archiveMember: "backup/payload/state/agents/main/sessions/upgrade-restored-index-history.jsonl",
  canonicalEventCount: 2,
  reason: "published-2026.9.4-volatile-transcript",
};

function failureFacts(message: string) {
  return [
    {
      check: "plugin-doctor-post-session-state",
      code: "blocked-by-session-repair-failure",
      message,
    },
  ];
}

function processFixture(version = "2026.7.1-2", source = "") {
  const root = realpathSync(tempDirs.make("survivor-first-hop-"));
  const tmp = join(root, "tmp");
  const ipcRoot = join(tmp, `openclaw${process.getuid ? `-${process.getuid()}` : ""}`);
  mkdirSync(ipcRoot, { recursive: true, mode: 0o700 });
  const ipc = join(ipcRoot, "openclaw-update-doctor-123-00000000-0000-4000-8000-000000000000.json");
  const manifest = join(root, "package.json");
  const entrypoint = join(root, "openclaw.mjs");
  writeJson(manifest, { name: "openclaw", version });
  writeFileSync(entrypoint, source);
  const env = { TMPDIR: tmp, TEMP: tmp, TMP: tmp, OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: root };
  return {
    root,
    ipc,
    ipcRoot,
    manifest,
    entrypoint,
    env,
    run: (command: string, extraEnv: NodeJS.ProcessEnv = {}, args: string[] = []) =>
      runNode(["--import", observer, entrypoint, command, ...args], { ...env, ...extraEnv }),
    reports: () =>
      readdirSync(join(root, "diagnostics")).map((name) =>
        readJson(join(root, "diagnostics", name)),
      ),
  };
}

function runNode(args: string[], env: NodeJS.ProcessEnv) {
  return runProcess(process.execPath, args, { ...process.env, ...env }, 10_000);
}

function rollbackSuccessSummary() {
  return {
    ...successSummary("2026.9.4", "2026.9.5"),
    backupRollback: {
      status: "passed",
      baselineVersion: "2026.9.4",
      candidateVersion: "2026.9.5",
      runtime: {
        version: "2026.9.4",
        schemaVersions: versions,
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
              { ...historyTables[0]!, columns: ["PRIVATE_COLUMN"] },
              { ...historyTables[1]!, raw: "PRIVATE_TRANSCRIPT" },
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
          ...preflight,
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

async function publishSuccess(
  summary: unknown,
  logs: Record<string, unknown> = {},
  sanitize = (text: string) => text,
) {
  const root = tempDirs.make("survivor-rollback-publication-");
  const artifacts = join(root, "private");
  const published = join(root, "published");
  mkdirSync(artifacts);
  writeJson(join(artifacts, "summary.json"), summary);
  for (const [name, value] of Object.entries(logs)) {
    writeJson(join(artifacts, name), value);
  }
  const { publishDiagnostics } = await import(observer);
  return {
    artifacts,
    published,
    publish: () => publishDiagnostics(artifacts, published, sanitize, "passed"),
  };
}

describe("upgrade survivor rollback publication", () => {
  it("publishes rollback proof without claiming omitted transcripts", async () => {
    const summary = rollbackSuccessSummary();
    const created = { verified: true, skippedVolatileCount: 3, skipped: [] };
    const restored = { ok: true, archiveRoot: "backup" };
    Object.assign(summary.backupRollback, {
      backupCreate: created,
      rawTranscriptRestoration: "unsupported-by-published-backup",
      omittedRawTranscripts: [{ ...omission, sessionId: "PRIVATE_SESSION_ID" }],
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
    writeJson(join(artifacts, "backup-rollback.json"), rawProof);
    writeJson(join(artifacts, "backup-rollback-create.json"), created);
    writeJson(join(artifacts, "backup-rollback-restore.json"), restored);
    publish();
    const text = readFileSync(join(published, "summary.json"), "utf8");
    expect(text).not.toMatch(/PRIVATE_|\/private\/host/);
    const receipt = JSON.parse(text);
    expect(receipt.backupRollback).toMatchObject({
      skippedVolatileCount: 3,
      rawTranscriptRestoration: "unsupported-by-published-backup",
      omittedRawTranscripts: [omission],
    });
    expect(JSON.parse(receipt.logs["backup-rollback-create.json"])).toEqual(created);
    expect(JSON.parse(receipt.logs["backup-rollback-restore.json"])).toEqual(restored);
    expect(JSON.parse(receipt.logs["backup-rollback.json"])).toEqual(rawProof);
    expect(receipt.backupRollback).toMatchObject({
      status: "passed",
      baselineVersion: "2026.9.4",
      candidateVersion: "2026.9.5",
      baselineSchemaVersions: versions,
      candidateSchemaVersions: { state: 17, agent: 21 },
      archiveSha256: hash,
      baselineRuntime: { manifestSha256: hash, entrySha256: hash },
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
          tables: historyTables,
          preflight,
          sessionRead: { count: 1 },
        },
        { kind: "agent", agentId: "ops", present: false },
      ],
      files: [
        { kind: "legacy-store", sha256: hash },
        { kind: "transcript", sha256: omission.sha256 },
      ],
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
      const receipt = readJson(join(published, "summary.json"));
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

  it.each<[string, (proof: ReturnType<typeof rollbackSuccessSummary>["backupRollback"]) => void]>([
    ["missing", () => undefined],
    ["null", () => undefined],
    ["unfinished", (p) => Object.assign(p, { status: "captured" })],
    ["wrong-candidate", (p) => Object.assign(p, { candidateVersion: "2026.9.6" })],
    ["missing-preflight", (p) => Object.assign(p, { preflights: [] })],
    ["duplicate-read", (p) => p.sessionReads.push(p.sessionReads[0]!)],
    ["wrong-count", (p) => Object.assign(p.sessionReads[0]!, { count: 2 })],
    ["wrong-schema", (p) => Object.assign(p.preflights[0]!, { targetVersion: 21 })],
    ["invalid-hash", (p) => Object.assign(p.archive, { sha256: "PRIVATE_HASH" })],
    [
      "unsafe-table-name",
      (p) => Object.assign(p.before.databases[1]!.tables![0]!, { table: "/private/host/table" }),
    ],
    [
      "oversized-collection",
      (p) =>
        Object.assign(p.before, { files: Array.from({ length: 129 }, () => p.before.files[0]!) }),
    ],
    ["no-history", (p) => Object.assign(p.before.databases[1]!.tables![1]!, { rows: 0 })],
    [
      "unbound-omission",
      (p) =>
        Object.assign(p, {
          backupCreate: { skippedVolatileCount: 1 },
          rawTranscriptRestoration: "unsupported-by-published-backup",
          omittedRawTranscripts: [
            {
              ...omission,
              relative: "agents/main/sessions/unrecorded.jsonl",
              archiveMember: "backup/payload/unrecorded.jsonl",
            },
          ],
        }),
    ],
    [
      "unsupported-restoration-claim",
      (p) => Object.assign(p, { rawTranscriptRestoration: "unsupported-by-published-backup" }),
    ],
    [
      "invalid-volatile-count",
      (p) => Object.assign(p, { backupCreate: { skippedVolatileCount: -1 } }),
    ],
  ])("refuses invalid rollback proof: %s", async (kind, alter) => {
    const summary = rollbackSuccessSummary();
    const proof = summary.backupRollback;
    alter(proof);
    const { publish, published } = await publishSuccess({
      ...summary,
      backupRollback: kind === "missing" ? undefined : kind === "null" ? null : proof,
    });
    expect(publish).toThrow(
      kind === "missing" || kind === "null" ? "Invalid backup rollback evidence" : undefined,
    );
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
  const manifest = prettyJson({
    runId,
    manifestVersion: 3,
    openClawVersion: "2026.8.1",
    startedAt: "2026-09-16T03:22:21.490Z",
    failureReports: { jsonPath: "/outside/do-not-read.json" },
    targets: [{ ...target, completedMoves: [], plannedMoves: [] }],
  });
  const failureReport = prettyJson({
    runId,
    version: "2026.8.1",
    restoreStatus: "not_attempted",
    targets: [{ ...target, completedMoves: 0, plannedMoves: 0 }],
  });
  writeFileSync(join(directory, `${runId}.json`), manifest);
  writeFileSync(join(directory, `${runId}.failure.json`), failureReport);
  return { directory, runId, manifest, failureReport };
}

describe("upgrade survivor first-hop process evidence", () => {
  it.each([0, 1])("retains first-hop identities and Doctor IPC on exit %i", async (code) => {
    const { root, ipc, manifest, entrypoint, run } = processFixture();
    const artifacts = join(root, "artifacts");
    mkdirSync(artifacts);
    const migration = code === 1 ? seedSessionMigration(root, 4791) : null;
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
    const result = run(
      "update",
      {
        OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: artifacts,
        OPENCLAW_GATEWAY_TOKEN: "private-environment-value",
      },
      ["--tag", "private-argument-value"],
    );
    expect(result.status, result.stderr).toBe(code);
    expect(result).toMatchObject({ stdout: "doctor fixture finished\n", stderr: "" });
    const files = readdirSync(join(artifacts, "diagnostics"));
    const reports = files.map((name) => readJson(join(artifacts, "diagnostics", name)));
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
      failureFacts: failureFacts("private-doctor-value"),
    });
    const capture = runNode(
      [observer, "capture", artifacts, "update-candidate", String(code), "", artifacts],
      { OPENCLAW_STATE_DIR: root, OPENCLAW_CONFIG_PATH: join(root, "missing-config.json") },
    );
    expect(capture.status, capture.stderr).toBe(0);
    if (migration) {
      expect(Buffer.byteLength(migration.manifest)).toBeGreaterThan(256 * 1024);
      expect(Buffer.byteLength(migration.failureReport)).toBeGreaterThan(256 * 1024);
      const raw = readJson(join(artifacts, "diagnostics/raw.json"));
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
    const report = readJson(join(published, "failure.json"));
    expect(report.doctorResults).toEqual({
      availability: "captured",
      observations: [
        {
          pid: doctor.pid,
          parentPid: parent.pid,
          packageVersion: "2026.8.1",
          exitCode: code,
          status: code === 0 ? "ok" : "error",
          failureFacts: failureFacts("[REDACTED]"),
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
    const raw = readJson(rawPath);
    raw.doctorResults[0].exited.parentPid++;
    if (migration) {
      raw.sessionMigration.manifest = JSON.stringify({
        ...JSON.parse(migration.manifest),
        runId: "session-sqlite-1789528941490-00000000",
      });
    }
    writeJson(rawPath, raw);
    const mismatched = join(root, "mismatched");
    publishDiagnostics(artifacts, mismatched, (text: string) => text);
    expect(readJson(join(mismatched, "failure.json")).doctorResults).toEqual({
      availability: "unknown",
      observations: [],
    });
    if (migration) {
      const changed = readJson(join(mismatched, "failure.json"));
      expect(changed.sessionMigration.manifest).toBeNull();
      expect(changed.omissions["session migration manifest"]).toBe("invalid observation; omitted");
    }
    const serialized = JSON.stringify(reports);
    for (const value of ["private-argument-value", "private-environment-value", root]) {
      expect(serialized).not.toContain(value);
    }
    expect(serialized).not.toMatch(/private-ignored-value|private-config-value/);
  });

  it.each([
    ["missing", "missing or unsafe file"],
    ["oversized", "input exceeds cap; omitted whole"],
    ["malformed", "invalid observation; omitted"],
    ...(process.platform === "win32" ? [] : [["symlink", "missing or unsafe file"]]),
  ])("retains the manifest with a %s failure report", async (kind, reason) => {
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
    const captured = runNode([observer, "capture", artifacts, "doctor", "1"], {
      OPENCLAW_STATE_DIR: root,
      OPENCLAW_CONFIG_PATH: join(root, "absent.json"),
    });
    expect(captured.status, captured.stderr).toBe(0);
    const raw = readJson(join(artifacts, "diagnostics/raw.json"));
    expect(raw.sessionMigration.manifest).toBe(migration.manifest);
    expect(raw.sessionMigration.failureReport).toBeNull();
    expect(raw.omissions["session migration failure report"]).toBe(reason);
    const { publishDiagnostics } = await import(observer);
    const published = join(root, "published");
    publishDiagnostics(artifacts, published, (text: string) => text);
    const report = readJson(join(published, "failure.json"));
    expect(report.sessionMigration).toMatchObject({
      availability: "captured",
      failureReport: null,
    });
    expect(report.omissions["session migration failure report"]).toBe(reason);
  });

  it.each<[string, string | null, string | null]>([
    ["available", null, null],
    ["unavailable", null, null],
    ["invalid", null, null],
    ["absent", "supported", null],
    ["absent", "unsupported-driver", "published-cli-rejects-invalid-config-before-staging"],
    ["absent", "private-invalid-value", null],
    ["absent", "unsupported-driver", "private-invalid-value"],
  ])(
    "publishes companion %s and missing path %s / %s",
    async (availability, applicability, reason) => {
      const missingLoadPath = applicability === null ? null : { applicability, reason };
      const invalid =
        applicability === "private-invalid-value" || reason === "private-invalid-value";
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
      const { publish, published } = await publishSuccess(
        {
          ...successSummary("2026.8.1-beta.1", "2026.9.4"),
          baseline: { spec: "2026.8.1-beta.1", version: "2026.8.1-beta.1" },
          candidate: { kind: "package", version: "2026.9.4" },
          candidateInstallMode: "published",
          baselineCompanion,
          missingLoadPath,
        },
        {},
        (text) => text.replaceAll("E404", "redacted"),
      );
      if (availability === "invalid" || invalid) {
        expect(publish).toThrow();
        expect(existsSync(join(published, "summary.json"))).toBe(false);
        return;
      }
      publish();
      const receipt = readJson(join(published, "summary.json"));
      expect(receipt.missingLoadPath).toEqual(missingLoadPath);
      expect(receipt.baselineCompanion).toEqual(
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
    const fixture = processFixture("2026.9.4", "process.exitCode = 7;");
    const { root, ipcRoot } = fixture;
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
    const result = fixture.run("doctor", {
      OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH: ipc,
    });
    expect(result.status, result.stderr).toBe(7);
    expect(result.stdout + result.stderr).toBe("");
    expect(readFileSync(target, "utf8")).toBe(payload);
    const reports = fixture.reports();
    expect(reports).toHaveLength(2);
    expect(reports.find((report) => report.event === "exited")).toEqual({
      ...reports.find((report) => report.event === "started"),
      event: "exited",
      exitCode: 7,
    });
    expect(JSON.stringify(reports)).not.toContain("private-doctor-value");
  });

  it.skipIf(process.platform === "win32")("does not turn a signal into a successful exit", () => {
    const fixture = processFixture("2026.7.1-2", 'process.kill(process.pid, "SIGTERM");');
    const result = fixture.run("update");
    expect(result).toMatchObject({ status: null, signal: "SIGTERM" });
    expect(result.stdout + result.stderr).toBe("");
    expect(fixture.reports()).toEqual([
      expect.objectContaining({ role: "update", event: "started", packageVersion: "2026.7.1-2" }),
    ]);
  });
});

it.each([
  {
    name: "restored-index readback",
    scenario: "legacy-operator-state",
    version: "2026.9.4",
    mode: "manual",
    logs: {
      "restored-index-post-update.json": {
        status: "passed",
        current: { label: "Renamed session", pinnedAt: 1234 },
      },
    },
  },
  {
    name: "report recovery receipts and transport witnesses",
    scenario: "update-report-recovery",
    version: "2026.9.6",
    mode: "manual",
    logs: {
      "update-report-recovery.json": { postCounts: [2, 1] },
      "update-report-baseline.json": { version: "2026.9.6" },
      "update-report-retry-status.log": { runId: "retry-run" },
      "update-report-pending-status.log": { runId: "pending-run" },
      "update-report-retry.gh.jsonl": { kind: "create", status: 422 },
      "update-report-pending.gh.jsonl": { kind: "lookup", matches: [] },
    },
  },
  ...[
    { version: "2026.9.4", mode: "manual" },
    { version: "2026.9.6", mode: "auto-auth" },
  ].map(({ version, mode }) => ({
    name: `${version} ${mode} Cron readback`,
    scenario: "legacy-operator-state",
    version,
    mode,
    logs: Object.fromEntries(
      ["post-update", "candidate"].map((stage) => [
        `legacy-operator-${stage}-cron-history.json`,
        {
          status: "passed",
          stage,
          source: version === "2026.9.4" ? "legacy-doctor-import" : "published-native-runs",
          pages: [{ jobId: "synthetic", runId: "retained" }],
        },
      ]),
    ),
  })),
])("publishes $name", async ({ scenario, version, mode, logs }) => {
  const summary = rollbackSuccessSummary();
  summary.baseline = { spec: `openclaw@${version}`, version };
  summary.backupRollback.baselineVersion = version;
  summary.backupRollback.runtime.version = version;
  const publication = await publishSuccess(
    {
      ...summary,
      scenario,
      updateRestartMode: mode,
      backupRollback: scenario === "legacy-operator-state" ? summary.backupRollback : undefined,
    },
    logs,
  );
  publication.publish();
  const result = readJson(join(publication.published, "summary.json"));
  expect(result.logs).toMatchObject(
    Object.fromEntries(Object.entries(logs).map(([name, proof]) => [name, JSON.stringify(proof)])),
  );
});
