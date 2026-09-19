import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { publishDiagnostics } from "../../scripts/e2e/lib/upgrade-survivor/diagnostics.mjs";
import { redactSensitiveText } from "../../src/logging/redact.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const node = resolveTestNodeExecPath();
const observer = path.resolve("scripts/e2e/lib/upgrade-survivor/diagnostics.mjs");
const sibling = path.resolve("scripts/e2e/lib/upgrade-survivor/custom-plugin-siblings.mjs");
const secret = "sk-survivorMigrationCaptureSecret1234567890";
const privateBody = "PRIVATE_TRANSCRIPT_CONFIG_AND_UNLISTED_FIELDS";
const hash = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function fixture() {
  const root = fs.realpathSync(dirs.make("survivor-migration-capture-"));
  const artifacts = path.join(root, "artifacts");
  const state = path.join(root, "state");
  fs.mkdirSync(artifacts);
  fs.mkdirSync(path.join(state, "state"), { recursive: true });
  return {
    root,
    artifacts,
    state,
    env: {
      PATH: process.env.PATH,
      HOME: root,
      TMPDIR: root,
      NODE_OPTIONS: "--no-warnings",
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
      OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT: root,
      OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: artifacts,
    },
  };
}

function write(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function capture(f: ReturnType<typeof fixture>) {
  const result = spawnSync(node, [observer, "capture", f.artifacts, "update-candidate", "1"], {
    env: f.env,
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.status, result.stderr).toBe(0);
  const output = path.join(f.root, "public");
  publishDiagnostics(f.artifacts, output, redactSensitiveText);
  const text = fs.readFileSync(path.join(output, "failure.json"), "utf8");
  expect(text).not.toContain(secret);
  expect(text).not.toContain(privateBody);
  return JSON.parse(text);
}

it("retains Doctor IPC refusal facts before the parent consumes its file and log prefix", () => {
  const f = fixture();
  write(path.join(f.root, "package.json"), {
    name: "openclaw",
    version: "2026.9.5",
    type: "module",
  });
  const entry = path.join(f.root, "openclaw.mjs");
  const uid = process.getuid?.();
  const doctorRoot = path.join(f.root, uid === undefined ? "openclaw" : `openclaw-${uid}`);
  fs.mkdirSync(doctorRoot, { mode: 0o700 });
  const resultPath = path.join(
    doctorRoot,
    `openclaw-update-doctor-${process.pid}-${randomUUID()}.json`,
  );
  const result = {
    status: "error",
    failureFacts: [{ check: "sessions", code: "step-refused", message: `token=${secret}` }],
    warnings: [`migration warning token=${secret}`],
    configChanges: [{ privateBody }],
    privateBody,
  };
  fs.writeFileSync(
    entry,
    `import fs from "node:fs"; fs.writeFileSync(process.env.OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH, ${JSON.stringify(JSON.stringify(result))}); process.exit(1);`,
  );
  const child = spawnSync(node, ["--import", observer, entry, "doctor"], {
    env: { ...f.env, OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH: resultPath },
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(child.status, child.stderr).toBe(1);
  fs.unlinkSync(resultPath);
  write(path.join(f.artifacts, "update.json"), { padding: "prior step\n".repeat(3000), steps: [] });
  const report = capture(f);
  expect(report.migration.doctor).toMatchObject({
    availability: "captured",
    processes: [
      {
        exitCode: 1,
        result: { status: "error", failureFacts: [{ check: "sessions", code: "step-refused" }] },
      },
    ],
  });
  expect(report.migration.doctor.processes[0].result.warnings).toHaveLength(1);
  expect(report.migration.doctor.processes[0].result).not.toHaveProperty("configChanges");
});

it("projects retained-import obligations and archive receipts without reading session bodies or migrating SQLite", () => {
  const f = fixture();
  const store = path.join(f.state, "agents/main/sessions/sessions.json");
  const transcript = path.join(f.state, "agents/main/sessions/retained.jsonl");
  const archive = path.join(f.state, "agents/main/session-sqlite-import-archive/retained.jsonl");
  write(store, { privateBody });
  fs.writeFileSync(transcript, privateBody);
  const dbPath = path.join(f.state, "state/openclaw.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(
    "PRAGMA user_version=20; CREATE TABLE migration_runs(id TEXT, status TEXT, report_json TEXT); CREATE TABLE migration_sources(migration_kind TEXT, source_path TEXT, source_sha256 TEXT, status TEXT, removed_source INTEGER, report_json TEXT);",
  );
  db.prepare("INSERT INTO migration_runs VALUES (?, ?, ?)").run(
    "deferred-plugin-migration:discord",
    "pending",
    JSON.stringify({
      pluginId: "discord",
      reason: `waiting token=${secret}`,
      command: privateBody,
      requiresStateMigration: true,
    }),
  );
  db.prepare("INSERT INTO migration_sources VALUES (?, ?, ?, ?, ?, ?)").run(
    "deferred-plugin-session-import",
    store,
    hash(store),
    "completed",
    0,
    JSON.stringify({
      pluginIds: ["discord"],
      databaseIdentity: privateBody,
      sources: [{ path: transcript, identity: { sha256: hash(transcript) } }],
      privateBody,
    }),
  );
  db.close();
  const before = hash(dbPath);
  write(path.join(f.state, "session-sqlite-migration-runs/run.json"), {
    runId: "synthetic-run",
    completedAt: "2026-09-15T00:00:00.000Z",
    targets: [
      {
        agentId: "main",
        storePath: store,
        sqlitePath: path.join(f.state, "agents/main/agent/openclaw-agent.sqlite"),
        validationBeforeArchive: "passed",
        plannedMoves: [{ kind: "transcript", sourcePath: transcript, archivePath: archive }],
        completedMoves: [],
        issues: [
          {
            code: "plugin_migration_source_retained",
            message: `waiting token=${secret}`,
            sessionKey: privateBody,
          },
        ],
      },
    ],
    privateBody,
  });
  const report = capture(f);
  expect(report.migration.sessions).toMatchObject({
    availability: "captured",
    deferred: [{ status: "pending", pluginId: "discord" }],
    imports: [
      {
        status: "completed",
        removedSource: false,
        pluginIds: ["discord"],
        sources: [{ path: transcript, sha256: hash(transcript) }],
      },
    ],
  });
  expect(report.migration.archives).toMatchObject({
    availability: "captured",
    runs: [
      { targets: [{ plannedMoveCount: 1, completedMoves: [], validationBeforeArchive: "passed" }] },
    ],
  });
  expect(hash(dbPath)).toBe(before);
  expect(fs.readFileSync(transcript, "utf8")).toBe(privateBody);
});

it("retains the custom fixture's actual Doctor module and callback identities without argv contents", () => {
  const f = fixture();
  const seeded = spawnSync(node, [sibling, "seed"], {
    env: f.env,
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(seeded.status, seeded.stderr).toBe(0);
  const doctor = path.join(f.root, "custom-plugins/memory/doctor-contract-api.mjs");
  const invoked = spawnSync(
    node,
    [
      "--input-type=module",
      "-e",
      `const m = await import(${JSON.stringify(pathToFileURL(doctor).href)}); m.normalizeCompatibilityConfig({cfg:{}});`,
      privateBody,
    ],
    { env: f.env, encoding: "utf8", timeout: 10_000 },
  );
  expect(invoked.status, invoked.stderr).toBe(0);
  const report = capture(f);
  expect(report.migration.sibling).toMatchObject({
    availability: "captured",
    registrations: [
      { surface: "doctor-module", sourceSha256: hash(doctor), updateCanary: false },
      { surface: "doctor-contract", sourceSha256: hash(doctor), updateCanary: false },
    ],
  });
  expect(report.migration.sibling.registrations[0]).not.toHaveProperty("argv");
  expect(report.migration.sibling.registrations[0]).not.toHaveProperty("value");
});

it("omits unsafe migration files and oversized registration collections without treating missing evidence as success", () => {
  const f = fixture();
  const outside = path.join(f.root, "outside");
  fs.writeFileSync(outside, privateBody);
  fs.symlinkSync(outside, path.join(f.state, "state/openclaw.sqlite"));
  fs.symlinkSync(f.root, path.join(f.state, "session-sqlite-migration-runs"));
  fs.writeFileSync(
    path.join(f.artifacts, "sibling-registrations.jsonl"),
    Array.from({ length: 129 }, () =>
      JSON.stringify({
        surface: "runtime",
        stateDir: f.state,
        source: "file:///fixture",
        sharedSource: "file:///fixture",
        argv: [],
      }),
    ).join("\n"),
  );
  const report = capture(f);
  for (const section of ["sessions", "archives", "sibling", "doctor"]) {
    expect(report.migration[section].availability).toBe("unavailable");
  }
  expect(report.limits).toMatchObject({
    inputBytesPerFile: 262144,
    outputBytesPerLog: 16384,
    reportBytes: 524288,
    entriesPerCollection: 128,
  });
});

it("does not reuse sibling observations when a retry fails before fixture seeding", () => {
  const f = fixture();
  fs.writeFileSync(
    path.join(f.artifacts, "sibling-registrations.jsonl"),
    JSON.stringify({
      surface: "doctor-contract",
      stateDir: f.state,
      source: "file:///previous-attempt",
      sharedSource: "file:///previous-attempt",
      argv: [],
      sourceSha256: "a".repeat(64),
    }) + "\n",
  );
  const prepared = spawnSync(
    "bash",
    [
      "-c",
      'source "$1"; prepare_diagnostics_capture',
      "capture-test",
      path.resolve("scripts/lib/upgrade-survivor-diagnostics.sh"),
    ],
    {
      env: { ...f.env, ARTIFACT_DIR: f.artifacts },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  expect(prepared.status, prepared.stderr).toBe(0);
  const report = capture(f);
  expect(report.migration.sibling.availability).toBe("unavailable");
});

it("does not create missing WAL sidecars through either receipt or plugin-index capture", () => {
  const f = fixture();
  const dbPath = path.join(f.state, "state/openclaw.sqlite");
  const database = new DatabaseSync(dbPath);
  database.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE migration_runs(id TEXT, status TEXT, report_json TEXT); CREATE TABLE migration_sources(migration_kind TEXT, source_path TEXT, source_sha256 TEXT, status TEXT, removed_source INTEGER, report_json TEXT);",
  );
  database.close();
  expect(fs.readFileSync(dbPath)[18]).toBe(2);
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    expect(fs.existsSync(dbPath + suffix)).toBe(false);
  }
  const before = hash(dbPath);
  const report = capture(f);
  expect(report.migration.sessions.availability).toBe("unavailable");
  expect(report.pluginIdentity.availability).toBe("unknown");
  expect(hash(dbPath)).toBe(before);
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    expect(fs.existsSync(dbPath + suffix), suffix).toBe(false);
  }
});

it("keeps the existing complete WAL family unchanged after observation closes", () => {
  const f = fixture();
  const dbPath = path.join(f.state, "state/openclaw.sqlite");
  const database = new DatabaseSync(dbPath);
  try {
    database.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE migration_runs(id TEXT, status TEXT, report_json TEXT); CREATE TABLE migration_sources(migration_kind TEXT, source_path TEXT, source_sha256 TEXT, status TEXT, removed_source INTEGER, report_json TEXT); PRAGMA wal_checkpoint(FULL);",
    );
    const files = [dbPath, dbPath + "-wal", dbPath + "-shm"];
    const before = files.map(hash);
    const report = capture(f);
    expect(report.migration.sessions.availability).toBe("unavailable");
    expect(report.omissions["migration-sessions"]).toContain("omitted before native open");
    expect(files.map(hash)).toEqual(before);
    expect(fs.existsSync(dbPath + "-journal")).toBe(false);
  } finally {
    database.close();
  }
});
