import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { publishDiagnostics } from "../../scripts/e2e/lib/upgrade-survivor/diagnostics.mjs";
import {
  assertCronHistory,
  seedCronHistory,
} from "../../scripts/e2e/lib/upgrade-survivor/legacy-operator-cron-history.mjs";
import { migrateLegacyCronRunLogsToTaskRuns } from "../../src/infra/state-migrations.cron-run-logs.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../../src/state/openclaw-state-schema.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  readJson,
  runProcess,
  successSummary,
  writeJson,
} from "./upgrade-survivor-shard.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const helper = path.resolve("scripts/e2e/lib/upgrade-survivor/legacy-operator-cron-history.mjs");
const diagnostics = path.resolve("scripts/e2e/lib/upgrade-survivor/diagnostics.mjs");

function prepare(version = "2026.9.4") {
  const root = tempDirs.make("survivor-cron-history-");
  const stateDir = path.join(root, "state");
  const artifacts = path.join(root, "artifacts");
  const observations = path.join(artifacts, "observation");
  const baseline = path.join(root, "baseline");
  const candidate = path.join(root, "package");
  mkdirSync(path.join(stateDir, "state"), { recursive: true });
  mkdirSync(observations, { recursive: true });
  const schema = version === "2026.9.4" ? 17 : 16;
  for (const [directory, packageVersion, stateSchema] of [
    [baseline, version, schema],
    [candidate, "2026.9.4", 17],
  ] as const) {
    mkdirSync(path.join(directory, "dist"), { recursive: true });
    writeJson(path.join(directory, "package.json"), {
      name: "openclaw",
      version: packageVersion,
      type: "module",
      openclaw: { schemaVersions: { state: stateSchema } },
    });
    writeJson(path.join(directory, "dist/build-info.json"), { fixture: directory });
  }
  const databasePath = path.join(stateDir, "state/openclaw.sqlite");
  const db = new DatabaseSync(databasePath);
  db.exec(OPENCLAW_STATE_SCHEMA_SQL);
  db.exec(`PRAGMA user_version = ${schema}`);
  db.close();
  writeJson(path.join(artifacts, "legacy-operator-baseline.json"), {
    jobs: [{ id: "retained-main" }, { id: "retained-ops" }],
  });
  const tarball = path.join(root, "candidate.tgz");
  execFileSync("tar", ["-czf", tarball, "-C", root, "package"]);
  seedCronHistory(stateDir, artifacts, baseline, tarball);
  const entry = path.join(candidate, "openclaw.mjs");
  const updater = path.join(baseline, "openclaw.mjs");
  const preloads = [path.resolve("scripts/tsx.mjs"), diagnostics, helper].flatMap((file) => [
    "--import",
    file,
  ]);
  // This process qualifies the observer, not an installed Doctor. The real
  // published updater cell must exercise Doctor's admission and full ordering.
  const program = `
    import { execFileSync } from 'node:child_process';
    import { DatabaseSync } from 'node:sqlite';
    import { migrateLegacyCronRunLogsToTaskRuns } from ${JSON.stringify(pathToFileURL(path.resolve("src/infra/state-migrations.cron-run-logs.ts")).href)};
    const updating = process.argv[2] === 'update';
    const db = new DatabaseSync(${JSON.stringify(databasePath)});
    db.exec('BEGIN IMMEDIATE');
    if (updating || process.env.FIXTURE_IMPORT === '1') {
      migrateLegacyCronRunLogsToTaskRuns(db);
    }
    if (updating && process.env.FIXTURE_AFTER_IMPORT_SQL) {
      db.exec(process.env.FIXTURE_AFTER_IMPORT_SQL);
    }
    if (!updating) db.exec('PRAGMA user_version = 17');
    db.exec('COMMIT');
    db.close();
    if (updating) {
      execFileSync(process.execPath, ${JSON.stringify([...preloads, entry, "doctor", "--fix", "--non-interactive"])}, {
        env: { ...process.env, FIXTURE_IMPORT: '0', OPENCLAW_UPDATE_IN_PROGRESS: '1' },
        stdio: 'inherit',
      });
    }
  `;
  for (const file of [entry, updater]) {
    writeFileSync(file, program);
  }
  const invokeProcess = (
    file: string,
    command: string,
    importHistory: boolean,
    afterImportSql?: string,
  ) => {
    const result = runProcess(
      process.execPath,
      [
        ...preloads,
        file,
        command,
        ...(command === "doctor" ? ["--fix", "--non-interactive"] : ["--yes", "--no-restart"]),
      ],
      {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: observations,
        OPENCLAW_UPGRADE_SURVIVOR_CRON_HISTORY_FIXTURE: path.join(
          artifacts,
          "legacy-operator-cron-history.json",
        ),
        FIXTURE_IMPORT: importHistory ? "1" : "0",
        FIXTURE_AFTER_IMPORT_SQL: afterImportSql,
      },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
  };
  return {
    artifacts,
    observations,
    databasePath,
    stateDir,
    proof: () => readJson(path.join(artifacts, "legacy-operator-cron-history-proof.json")),
    assert: () => assertCronHistory(artifacts, observations),
    invoke: (importHistory: boolean) => invokeProcess(entry, "doctor", importHistory),
    invokeUpdater: (afterImportSql?: string) =>
      invokeProcess(updater, "update", false, afterImportSql),
  };
}

it.each(["2026.9.3", "2026.9.4"])(
  "proves %s retained-history ownership through the updater and Doctor",
  (version) => {
    const fixture = prepare(version);
    if (version === "2026.9.3") {
      fixture.invokeUpdater();
    } else {
      fixture.invoke(true);
    }
    fixture.assert();
    const evidence = fixture.proof();
    expect(evidence).toMatchObject({
      currentSchemaAtDoctorEntry: version === "2026.9.4",
      contract:
        version === "2026.9.3" ? "published-updater-import-preserved" : "candidate-doctor-import",
    });
    expect(evidence.doctor.before.legacyRows).toHaveLength(version === "2026.9.3" ? 0 : 2);
    expect(evidence.doctor.after.tasks).toHaveLength(2);
    if (version === "2026.9.3") {
      expect(evidence.updater.before.legacyRows).toHaveLength(2);
      expect(evidence.updater.before.tasks).toEqual([]);
      expect(evidence.updater.identity).toEqual(evidence.baseline);
      expect(evidence.doctor.before.tasks).toEqual(evidence.doctor.after.tasks);
      writeJson(path.join(fixture.artifacts, "summary.json"), successSummary(version, "2026.9.4"));
      const published = path.join(fixture.artifacts, "published");
      publishDiagnostics(fixture.artifacts, published, (text: string) => text, "passed");
      const summary = readJson(path.join(published, "summary.json"));
      expect(JSON.parse(summary.logs["legacy-operator-cron-history-proof.json"])).toEqual(evidence);
    }
  },
);

it.each([
  ["2026.9.4", false, "table was not retired"],
  ["2026.9.3", true, "published updater never received the unchanged retained cron history"],
] as const)(
  "rejects successful %s Doctor with import=%s at the wrong owner",
  (version, imported, error) => {
    const fixture = prepare(version);
    fixture.invoke(imported);
    expect(fixture.assert).toThrow(error);
  },
);

it("rejects parent-side import even when canonical task rows and Doctor exit are correct", () => {
  const fixture = prepare();
  const db = new DatabaseSync(fixture.databasePath);
  migrateLegacyCronRunLogsToTaskRuns(db);
  db.close();
  fixture.invoke(false);
  const receiptName = readdirSync(fixture.observations).find((name) =>
    name.startsWith("cron-history-doctor-"),
  );
  expect(receiptName).toBeDefined();
  const receipt = readJson(path.join(fixture.observations, receiptName!));
  for (let index = 1; index < 8; index++) {
    writeJson(path.join(fixture.observations, `cron-history-doctor-${receipt.pid + index}.json`), {
      ...receipt,
      pid: receipt.pid + index,
      startedAtMs: receipt.startedAtMs + index,
      observationError: "rejected rehearsal observation ".repeat(40),
    });
  }
  expect(fixture.assert).toThrow("never received the unchanged retained cron history");
  const evidence = fixture.proof();
  expect(evidence.status).toBe("failed");
  expect(evidence.observations).toHaveLength(8);
  expect(Buffer.byteLength(JSON.stringify(evidence, null, 2))).toBeLessThan(16 * 1024);
  expect(evidence.observations[0]).toMatchObject({
    role: "doctor",
    exitCode: 0,
    before: { legacyRows: 0, tasks: 2 },
    after: { legacyRows: 0, tasks: 2 },
  });
  const captured = runProcess(
    process.execPath,
    [diagnostics, "capture", fixture.artifacts, "assert-retained-cron-doctor", "1"],
    { ...process.env, OPENCLAW_STATE_DIR: fixture.stateDir },
  );
  expect(captured.status, captured.stderr).toBe(0);
  const published = path.join(fixture.artifacts, "published");
  publishDiagnostics(fixture.artifacts, published, (text: string) => text);
  const failure = readJson(path.join(published, "failure.json"));
  expect(JSON.parse(failure.logs["legacy-operator-cron-history-proof.json"])).toEqual(evidence);
});

it.each([
  ["task count", "DELETE FROM task_runs WHERE source_id = 'retained-ops'", "task count changed"],
  [
    "task content",
    "UPDATE task_runs SET terminal_summary = 'changed' WHERE source_id = 'retained-main'",
    "retained cron task changed: terminal_summary",
  ],
  [
    "import report",
    `UPDATE migration_runs SET report_json = '{"imported":1,"alreadyMirrored":0,"malformed":0,"skipped":false}' WHERE id = 'state:cron-run-logs-to-task-runs:v1'`,
    "Expected values to be strictly deep-equal",
  ],
])("rejects damaged %s from the 9.3 updater before Doctor", (_, sql, message) => {
  const fixture = prepare("2026.9.3");
  fixture.invokeUpdater(sql);
  expect(fixture.assert).toThrow(message);
});
