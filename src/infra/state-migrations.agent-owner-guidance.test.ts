import fs from "node:fs";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createAgentDatabaseInspectionRefusal } from "../state/agent-database-admission.js";
import { withAgentDatabaseStartupAdmission } from "../state/agent-database-startup.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { assertOpenClawDatabasesReady } from "../state/openclaw-database-preflight.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { migrateLegacyMediaPersistence } from "./state-migrations.media-persistence.js";
import {
  createLegacyStateMigrationStepReceipt,
  DoctorStateMigrationRefusalError,
} from "./state-migrations.messages.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

it.each([
  { agentId: "worker", profile: undefined },
  { agentId: "a".repeat(64), profile: "p".repeat(64) },
])(
  "prints intact recovery commands for corrupt $agentId in Gateway and Doctor",
  async ({ agentId, profile }) => {
    await withEnvAsync(
      { OPENCLAW_PROFILE: profile, OPENCLAW_CONTAINER_HINT: undefined },
      async () => {
        const env = { OPENCLAW_STATE_DIR: tempDirs.make("agent-database-recovery-") };
        const pathname = openOpenClawAgentDatabase({ agentId, env }).path;
        closeOpenClawAgentDatabasesForTest();
        closeOpenClawStateDatabaseForTest();
        const damaged = fs.readFileSync(pathname);
        damaged.write("XXXXXXXXX", 0);
        fs.writeFileSync(pathname, damaged);
        const command = `openclaw${profile ? ` --profile ${profile}` : ""} doctor --session-sqlite recover --session-sqlite-agent ${agentId}`;
        await withAgentDatabaseStartupAdmission(
          async () => {
            await expect
              .soft(
                assertOpenClawDatabasesReady({
                  env,
                  operation: "gateway-startup",
                  config: {
                    agents: { entries: { [agentId]: {} }, defaults: { systemAgent: { agentId } } },
                  },
                }),
              )
              .rejects.toThrow(command);
          },
          { deferInspections: false },
        );
        const result = await migrateLegacyMediaPersistence({ env });
        const receipt = createLegacyStateMigrationStepReceipt(
          {
            id: "media-persistence",
            phase: "shared",
            source: [],
            target: [],
            requiredness: "required",
            reversibility: "checkpoint-required",
          },
          result,
        );
        expect(receipt.outcome).toBe("refused");
        expect.soft(new DoctorStateMigrationRefusalError([receipt]).message).toContain(command);
        expect(fs.readFileSync(pathname)).toEqual(damaged);
      },
    );
  },
);

it.each([
  { cause: Object.assign(new Error("native failure"), { errcode: 11 }), recover: true },
  { cause: Object.assign(new Error("native failure"), { errcode: 267 }), recover: true },
  { cause: Object.assign(new Error("native failure"), { code: "SQLITE_NOTADB" }), recover: true },
  { cause: Object.assign(new Error("bad page"), { name: "SqliteIntegrityError" }), recover: true },
  { cause: Object.assign(new Error("native failure"), { errcode: 5 }), recover: false },
  { cause: Object.assign(new Error("native failure"), { errcode: 13 }), recover: false },
  {
    cause: Object.assign(new Error("check unavailable"), {
      name: "SqliteIntegrityError",
      cause: Object.assign(new Error("database is locked"), { errcode: 5 }),
    }),
    recover: false,
  },
])("selects recovery=$recover from wrapped $cause", ({ cause, recover }) => {
  const refusal = createAgentDatabaseInspectionRefusal({
    agentId: "worker",
    paths: [],
    reason: "inspection failed",
    cause: new Error("inspection failed", { cause }),
  });
  expect(
    refusal.repairHint.includes("--session-sqlite recover --session-sqlite-agent worker"),
  ).toBe(recover);
});
