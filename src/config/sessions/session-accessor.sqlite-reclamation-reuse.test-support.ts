import fs from "node:fs";
import type { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { readOpenClawAgentDatabaseWorkerLeaseReceipt } from "../../state/openclaw-agent-db-lifecycle.js";
import { invalidateOpenClawAgentDatabaseValidation } from "../../state/openclaw-agent-db-validation-cache.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { AgentDatabaseRequestExecutionSource } from "../../state/openclaw-agent-execution-admission-contract.js";
import * as nativeExecution from "../../state/openclaw-agent-execution-native.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import * as archiveWorker from "./session-accessor.sqlite-archive.js";
import { loadSessionEntryReadOnly } from "./session-accessor.sqlite-entry.js";
import { ensureSessionEntrySync } from "./session-accessor.sqlite-initial-entry.js";
import type { SqliteReclamationWorkerMessage } from "./session-accessor.sqlite-reclamation-worker.types.js";
import { createLifecycleArtifactReclamationPlan } from "./session-accessor.sqlite-reclamation.js";

export const tempDirs = createTempDirTracker();

export function createFixture(sessionIds = ["first", "second"], agentId = "main") {
  const env = { OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("reclamation-reuse-")) };
  const options = { agentId, env };
  const scopes = sessionIds.map((sessionId) => ({
    agentId: options.agentId,
    env,
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
  }));
  for (const scope of scopes) {
    ensureSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  }
  const database = openOpenClawAgentDatabase(options);
  const plans = scopes.map((scope) =>
    createLifecycleArtifactReclamationPlan({
      agentId: "main",
      databaseOptions: { ...options, path: database.path },
      entries: [{ sessionKey: scope.sessionKey, expectedEntry: loadSessionEntryReadOnly(scope) }],
      materializedPlans: [],
    }),
  );
  return { options, scopes, database, plans };
}

export function observeReclamationWorkers(onSpawn?: (worker: Worker) => void) {
  const spawned: Worker[] = [];
  const create = archiveWorker.createSqliteTranscriptArchiveWorker;
  vi.spyOn(archiveWorker, "createSqliteTranscriptArchiveWorker").mockImplementation((data) => {
    const worker = create(data);
    spawned.push(worker);
    onSpawn?.(worker);
    return worker;
  });
  return spawned;
}

export function leasesFor(fixture: ReturnType<typeof createFixture>) {
  return openOpenClawStateDatabase({ env: fixture.options.env })
    .db.prepare("SELECT lease_id FROM agent_database_leases WHERE path = ?")
    .all(fixture.database.path);
}

export function createNativeReclamationSource(
  fixture: Pick<ReturnType<typeof createFixture>, "database" | "options">,
  revokeDuringOpen: boolean,
) {
  const { database, options } = fixture;
  const context = captureOpenClawStateWorkerContext(options);
  const assertCurrent = () => context.admission.assertCurrent();
  let revokedDuringOpen = false;
  const source: AgentDatabaseRequestExecutionSource = {
    assertCurrent,
    createAdmission(binding) {
      return () => ({
        nativeLocations: binding.nativeLocations,
        admission: workerAdmission.createSqliteWorkerOperationAdmission((request, grant) => {
          if (
            revokeDuringOpen &&
            !revokedDuringOpen &&
            request.stage === "prepare" &&
            isRecord(request.facts) &&
            isRecord(request.facts.identity) &&
            request.facts.identity.kind === "file"
          ) {
            invalidateOpenClawAgentDatabaseValidation(database.path);
            revokedDuringOpen = true;
          }
          binding.authorize(request);
          assertCurrent();
          if (!grant()) {
            throw new Error("Native reclamation fixture lost admission");
          }
        }, binding.attachment),
      });
    },
  };
  return { source, wasRevokedDuringOpen: () => revokedDuringOpen };
}

export function observeNativeGenerationRetirement(databasePath: string) {
  const closes: Promise<void>[] = [];
  const create = nativeExecution.createAgentDatabaseNativeGeneration;
  vi.spyOn(nativeExecution, "createAgentDatabaseNativeGeneration").mockImplementation((...args) => {
    const generation = create(...args);
    if (args[1] === databasePath) {
      const close = generation.close.bind(generation);
      vi.spyOn(generation, "close").mockImplementation(() => {
        const pending = close();
        closes.push(pending);
        return pending;
      });
    }
    return generation;
  });
  return closes;
}

/** Observe actual native admission and reclamation receipts without replacing either owner. */
export function observeReclamationLeaseReceipts(database: { agentId: string; path: string }) {
  let admittedLeaseId = readOpenClawAgentDatabaseWorkerLeaseReceipt(database.path).leaseId;
  let reclamationLeaseId: string | undefined;
  probe.admission(workerAdmission, (request, grant, admit) => {
    admit(request, grant);
    const facts = request.facts;
    if (
      request.stage === "prepare" &&
      isRecord(facts) &&
      facts.kind === "shared-owner" &&
      isRecord(facts.lease) &&
      facts.lease.path === database.path &&
      facts.lease.agentId === database.agentId &&
      typeof facts.lease.leaseId === "string"
    ) {
      admittedLeaseId = facts.lease.leaseId;
    }
  });
  return {
    onSpawn: (worker: Worker) => {
      worker.on("message", (message: SqliteReclamationWorkerMessage) => {
        if (message.type === "lease" && message.receipt.path === database.path) {
          reclamationLeaseId = message.receipt.leaseId;
        }
      });
    },
    read: () => ({ admittedLeaseId, reclamationLeaseId }),
  };
}
