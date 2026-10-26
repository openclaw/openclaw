import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { redactPublicSupportDiagnosticLine } from "../logging/diagnostic-support-redaction.js";
import { repairOpenClawStateDatabaseSchema } from "../state/openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import {
  addPreCutoverClientCredentialTablesForTest,
  withStateMigrationBackupForTest,
} from "../state/openclaw-state-schema.test-support.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { launchCanary } from "./update-candidate-canary-process.js";
import { createUpdateCanaryFailureFacts } from "./update-failure-facts.js";
import { prepareUpdateFailureReport } from "./update-failure-report-prepare.js";

const directories = useAutoCleanupTempDirTracker(afterEach);

it("preserves an invalid socket cause through migration, candidate capture, and public reporting", async () => {
  const root = directories.make("private-socket-migration-");
  const stateDir = path.join(root, "private state");
  const pathname = path.join(stateDir, "state", "openclaw.sqlite");
  const env = { ...process.env, HOME: root, OPENCLAW_STATE_DIR: stateDir };
  await fs.mkdir(path.dirname(pathname), { recursive: true });
  {
    using db = openNodeSqliteDatabase(pathname);
    db.exec(OPENCLAW_STATE_SCHEMA_SQL);
    addPreCutoverClientCredentialTablesForTest(db);
    db.exec(`
      INSERT INTO schema_meta VALUES ('primary', 'global', 28, NULL, 'fixture', 123, 123);
      INSERT INTO config_machine_state VALUES ('state.schema.contentVersion', '28', 1);
      PRAGMA user_version=28;
    `);
    db.prepare("INSERT INTO exec_approvals_config VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "current",
      JSON.stringify({ version: 1, socket: { path: 42, token: "private-socket-token" } }),
      null,
      1,
      null,
      null,
      null,
      null,
      0,
      0,
      1,
    );
  }
  const result = await withStateMigrationBackupForTest({ env }, () =>
    repairOpenClawStateDatabaseSchema({ env, versionMigrationOnly: true }),
  );
  expect(result.changes).toEqual([]);
  expect(result.warnings).toHaveLength(1);
  expect(result.warnings[0]).toContain("invalid socket credentials or projections");
  const entry = path.join(root, "candidate.mjs");
  await fs.writeFile(
    entry,
    `console.error(${JSON.stringify(`[openclaw] Reason: ${result.warnings[0]}`)}); process.exitCode = 1;`,
  );
  const running = launchCanary({
    target: { kind: "worker", url: pathToFileURL(entry) },
    args: [],
    root,
    env,
    stateDir,
    capture() {},
  });
  await running.closed;
  const failureFacts = createUpdateCanaryFailureFacts({
    phase: "doctor",
    name: "candidate-doctor",
    signal: null,
    timedOut: false,
    failureMessage: "Update doctor failed",
    diagnostic: running.stderrDiagnostic(),
    env,
  });
  const report = await prepareUpdateFailureReport(
    {
      attemptId: "socket-migration-cause",
      result: {
        status: "error",
        mode: "npm",
        reason: "candidate-doctor-failed",
        steps: [
          {
            name: "candidate-doctor",
            command: "doctor --fix",
            cwd: root,
            durationMs: 1,
            exitCode: 1,
            failureFacts,
          },
        ],
        durationMs: 1,
      },
    },
    { env, stateDir },
  );
  expect(report.body).toContain("Client credential socket material is invalid.");
  expect(report.body).not.toMatch(/private-socket|private state|private-socket-token/);
});

it("does not publish arbitrary text following a lookalike socket diagnostic", () => {
  const context = { env: {}, stateDir: "" };
  expect(
    redactPublicSupportDiagnosticLine(
      "Client credential socket material is invalid. private-value",
      context,
    ),
  ).toBe("[redacted-diagnostic]");
});
