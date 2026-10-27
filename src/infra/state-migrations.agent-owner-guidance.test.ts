import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createAgentDatabaseInspectionRefusal } from "../state/agent-database-admission.js";
import { withAgentDatabaseStartupAdmission } from "../state/agent-database-startup.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { assertOpenClawDatabasesReady } from "../state/openclaw-database-preflight.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { migrateLegacyMediaPersistence } from "./state-migrations.media-persistence.js";
import {
  createLegacyStateMigrationStepReceipt,
  DoctorStateMigrationRefusalError,
} from "./state-migrations.messages.js";
import { migrationStepInput } from "./state-migrations.step.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

it.each([
  { agentId: "worker", profile: undefined },
  { agentId: "a".repeat(64), profile: "p".repeat(64) },
])("reports corrupt $agentId recovery in Gateway and Doctor", async ({ agentId, profile }) => {
  vi.stubEnv("OPENCLAW_PROFILE", profile);
  vi.stubEnv("OPENCLAW_CONTAINER_HINT", undefined);
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("agent-database-recovery-") };
  const pathname = openOpenClawAgentDatabase({ agentId, env }).path;
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  const damaged = fs.readFileSync(pathname);
  damaged.write("XXXXXXXXX", 0);
  fs.writeFileSync(pathname, damaged);
  const command = `openclaw${profile ? ` --profile ${profile}` : ""} doctor --session-sqlite recover --session-sqlite-agent ${agentId}`;
  const config = { agents: { entries: { [agentId]: {} }, defaults: { systemAgent: { agentId } } } };
  await withAgentDatabaseStartupAdmission(
    () =>
      expect
        .soft(assertOpenClawDatabasesReady({ env, operation: "gateway-startup", config }))
        .rejects.toThrow(command),
    { deferInspections: false },
  );
  const receipt = createLegacyStateMigrationStepReceipt(
    migrationStepInput("media-persistence", "required", "checkpoint-required"),
    await migrateLegacyMediaPersistence({ env }),
  );
  expect(receipt.outcome).toBe("refused");
  expect.soft(new DoctorStateMigrationRefusalError([receipt]).message).toContain(command);
  expect(fs.readFileSync(pathname)).toEqual(damaged);
});

const nativeError = (fields: object) => Object.assign(new Error("native failure"), fields);
it.each([
  [{ errcode: 11 }, true],
  [{ errcode: 267 }, true],
  [{ code: "SQLITE_NOTADB" }, true],
  [{ name: "SqliteIntegrityError" }, true],
  [{ errcode: 5 }, false],
  [{ errcode: 13 }, false],
  [{ name: "SqliteIntegrityError", cause: nativeError({ errcode: 5 }) }, false],
] as const)("selects recovery from wrapped %j", (fields, recover) => {
  const refusal = createAgentDatabaseInspectionRefusal({
    agentId: "worker",
    paths: [],
    reason: "inspection failed",
    cause: new Error("inspection failed", { cause: nativeError(fields) }),
  });
  const recoveryHint = "--session-sqlite recover --session-sqlite-agent worker";
  expect(refusal.repairHint.includes(recoveryHint)).toBe(recover);
});
