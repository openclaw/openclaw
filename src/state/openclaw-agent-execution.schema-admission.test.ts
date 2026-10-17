import fs from "node:fs";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import { AgentDatabaseSchemaAdmissionInvalidError } from "./agent-database-admission-error.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import type { AgentDatabaseRequestExecutionSource } from "./openclaw-agent-execution-admission-contract.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

it("rejects malformed native schema receipts without replaying caller work", async () => {
  const env = { OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("agent-schema-invalid-")) };
  const options = { agentId: "main", env };
  const database = openOpenClawAgentDatabase(options);
  closeOpenClawAgentDatabaseByPath(database.path);
  const execution = captureOpenClawAgentDatabaseExecution(options);
  let publications = 0;
  const malformed = sqliteWorkerOwnerProbe.admission(workerAdmission, (request, grant, admit) => {
    const facts = request.facts;
    if (
      request.stage === "prepare" &&
      isRecord(facts) &&
      isRecord(facts.identity) &&
      facts.identity.nativeLocation === database.path &&
      facts.validation !== undefined
    ) {
      publications += 1;
      request.facts = { ...facts, validation: {} };
    }
    admit(request, grant);
  });
  const source: AgentDatabaseRequestExecutionSource = {
    assertCurrent: () => execution.assertCurrent(),
    createAdmission: (binding) => () => ({
      nativeLocations: binding.nativeLocations,
      admission: workerAdmission.createSqliteWorkerOperationAdmission((request, grant) => {
        binding.authorize(request);
        if (!grant()) {
          throw new Error("Malformed schema fixture lost admission");
        }
      }, binding.attachment),
    }),
  };
  const operation = vi.fn(async () => "not admitted");
  try {
    await expect(execution.runExisting(source, operation)).rejects.toBeInstanceOf(
      AgentDatabaseSchemaAdmissionInvalidError,
    );
    expect(publications).toBe(1);
    expect(operation).not.toHaveBeenCalled();
  } finally {
    malformed.mockRestore();
    await execution.release();
  }
});
