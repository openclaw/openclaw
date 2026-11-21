import { describe, expect, it } from "vitest";
import {
  readBackupRunFreshness,
  readBackupRuns,
  recordBackupRunOutcome,
} from "../../state/backup-run-records.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { isPostgresSqlConnection } from "../sql-connection.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

describe.skipIf(!mixedAgentConnection)("PostgreSQL backup run ledger", () => {
  useMixedAgentPair("postgres", "sqlite");

  it("retains successful and failed worker outcomes with newest-first readback", async () => {
    withEngineStoreAdmission(() => {
      expect(isPostgresSqlConnection(openOpenClawStateDatabase().db)).toBe(true);
    });
    const env = { ...process.env };
    for (const outcome of [
      { status: "ok", createdAt: 100, archivePath: "/synthetic/first.tar.gz" },
      { status: "failed", createdAt: 200, archivePath: "/synthetic/second.tar.gz" },
    ] as const) {
      await recordBackupRunOutcome({
        env,
        kind: "archive",
        target: "synthetic-offsite",
        ...outcome,
      });
    }

    const runs = await readBackupRuns(env);
    expect(
      runs.map(({ status, createdAt, archivePath }) => ({ status, createdAt, archivePath })),
    ).toEqual([
      { status: "failed", createdAt: 200, archivePath: "/synthetic/second.tar.gz" },
      { status: "ok", createdAt: 100, archivePath: "/synthetic/first.tar.gz" },
    ]);
    await expect(readBackupRunFreshness(env)).resolves.toMatchObject({
      latest: { status: "failed", createdAt: 200 },
      latestOk: { status: "ok", createdAt: 100 },
      latestOffsite: { status: "failed", createdAt: 200 },
    });
  });
});
