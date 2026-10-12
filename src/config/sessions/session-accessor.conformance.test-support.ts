import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";

export type SessionAccessorConformancePaths = {
  sqlitePath: string;
  stateDir: string;
  storePath: string;
  tempDir: string;
};

export function createSessionAccessorConformanceFixture(
  prefix: string,
): SessionAccessorConformancePaths {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    sqlitePath: path.join(tempDir, "openclaw-agent.sqlite"),
    stateDir: path.join(tempDir, "state"),
    storePath: path.join(tempDir, "sessions.json"),
    tempDir,
  };
}

/** Keep conformance roots until their native database users have settled. */
export async function closeSessionAccessorConformanceFixture(tempDir: string): Promise<void> {
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
