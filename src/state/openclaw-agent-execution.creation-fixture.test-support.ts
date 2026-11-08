import fs from "node:fs";
import path from "node:path";
import { afterEach } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerAdmissionRequest,
} from "../infra/sqlite-worker-operation-admission.js";
import {
  closeOpenClawAgentDatabasesAsync,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.js";
import type { AgentDatabaseRequestExecutionSource } from "./openclaw-agent-execution-admission-contract.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db.js";

export const agentCreationWitnessTempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

export function createAgentCreationWitnessFixture() {
  const env = {
    OPENCLAW_STATE_DIR: fs.realpathSync(
      agentCreationWitnessTempDirs.make("agent-creation-witness-"),
    ),
  };
  const options = { agentId: "main", env };
  return { ...options, path: resolveOpenClawAgentSqlitePath(options) };
}

export function createAliasedAgentCreationWitnessFixture() {
  const options = createAgentCreationWitnessFixture();
  const alias = path.join(options.env.OPENCLAW_STATE_DIR, "alias");
  const directory = path.dirname(options.path);
  fs.mkdirSync(directory, { recursive: true });
  fs.symlinkSync(directory, alias, process.platform === "win32" ? "junction" : "dir");
  return {
    options,
    aliased: { ...options, path: path.join(alias, path.basename(options.path)) },
  };
}

export function createAgentCreationWitnessSource(
  beforeGrant: (request: SqliteWorkerAdmissionRequest) => void = () => {},
): AgentDatabaseRequestExecutionSource {
  return {
    assertCurrent() {},
    createAdmission(binding) {
      return () => ({
        nativeLocations: binding.nativeLocations,
        admission: createSqliteWorkerOperationAdmission((request, grant) => {
          beforeGrant(request);
          binding.authorize(request);
          if (!grant()) {
            throw new Error("Creation witness fixture lost admission");
          }
        }, binding.attachment),
      });
    },
  };
}
