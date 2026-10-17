import fs from "node:fs";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readSqliteDatabaseCleanClose } from "../infra/sqlite-database-admission.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import { AgentDatabaseSchemaAdmissionInvalidError } from "./agent-database-admission-error.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import type { AgentDatabaseRequestExecutionSource } from "./openclaw-agent-execution-admission-contract.js";
import { AgentDatabaseExecutionLifetime } from "./openclaw-agent-execution-authority.js";
import { createAgentDatabaseNativeGeneration } from "./openclaw-agent-execution-native.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";
import { closeOpenClawStateDatabaseAsync, openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

function createSource(assertCurrent = () => {}): AgentDatabaseRequestExecutionSource {
  return {
    assertCurrent,
    createAdmission: (binding) => () => ({
      nativeLocations: binding.nativeLocations,
      admission: workerAdmission.createSqliteWorkerOperationAdmission((request, grant) => {
        binding.authorize(request);
        if (!grant()) {
          throw new Error("Schema admission fixture lost admission");
        }
      }, binding.attachment),
    }),
  };
}

it.each([false, true])(
  "preserves clean restart proof on refused worker admission (prepared: %s)",
  async (prepared) => {
    const env = { OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("agent-refused-restart-")) };
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    closeOpenClawAgentDatabaseByPath(database.path);
    const seal = fs.readFileSync(`${database.path}.seal`, "utf8");
    const identity = readDatabasePathIdentitySync(database.path);
    const generation = createAgentDatabaseNativeGeneration(
      "main",
      database.path,
      captureOpenClawStateWorkerContext({ env }),
      new AgentDatabaseExecutionLifetime().state,
      () => {},
      () => {},
      prepared
        ? {
            kind: "file",
            physicalIdentity: identity.key.slice("file:".length),
            birthtime: identity.birthtime,
            nativeLocation: identity.canonicalPath,
          }
        : undefined,
      () => {},
      () => {},
    );
    let refused = false;
    const refusal = sqliteWorkerOwnerProbe.admission(workerAdmission, (request, grant, admit) => {
      if (
        request.stage === "prepare" &&
        isRecord(request.facts) &&
        request.facts.kind === "agent-validation-start"
      ) {
        refused = true;
        throw new Error("Synthetic shutdown refused late admission");
      }
      admit(request, grant);
    });
    try {
      await expect(generation.run(createSource(), async () => "forbidden")).rejects.toThrow();
    } finally {
      try {
        await generation.close();
      } finally {
        refusal.mockRestore();
      }
    }
    expect(refused).toBe(true);
    expect(
      openOpenClawStateDatabase({ env })
        .db.prepare("SELECT lease_id FROM agent_database_leases")
        .all(),
    ).toEqual([]);
    expect(fs.readFileSync(`${database.path}.seal`, "utf8")).toBe(seal);
    expect(readSqliteDatabaseCleanClose(database.path)).toBe(true);
  },
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
  const source = createSource(() => execution.assertCurrent());
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
