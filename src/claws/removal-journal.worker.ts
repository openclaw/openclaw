import { isDeepStrictEqual } from "node:util";
import { assertAgentSessionStoreDeletionBlocker } from "../agents/agent-delete-session-store-safety.js";
import { findAgentSessionStoreDeletionBlocker } from "../agents/agent-delete-session-store-safety.kernel.js";
import { listAgentEntries, resolveAgentDir } from "../agents/agent-scope-config.js";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";
import { assertExistingDatabaseIdentity } from "../infra/sqlite-worker-identity.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import {
  beginAgentDeletionJournalInDatabase,
  readAgentDeletionJournalInDatabase,
  deleteAgentDeletionJournalInDatabase,
  type AgentDeletionJournalEntry,
} from "../state/agent-deletion-journal.js";
import { ensureAgentProvenanceSchema } from "../state/agent-provenance.schema.js";
import { requireOpenClawStateDatabaseIdentity } from "../state/openclaw-state-db-cache.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { verifyOpenClawStateLeaseOwnership } from "../state/openclaw-state-lease-storage.js";
import { isReservedSystemAgentId } from "../system-agent/agent-id.js";
import { digestClawValue } from "./digest.js";
import {
  readClawInstallRecordFromDatabase,
  readClawOrphanWorkspaceInDatabase,
} from "./provenance-read.kernel.js";
import type { ClawRemovalJournalWorkerInput } from "./removal-journal-contract.js";

export function mutateClawRemovalJournalInWorker(
  database: OpenClawStateDatabase,
  input: ClawRemovalJournalWorkerInput,
  options: Pick<OpenClawStateDatabaseOptions, "path" | "env">,
): { nonce: string } {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const { request } = input;
      if (
        isReservedSystemAgentId(request.agentId) ||
        request.lease.scope !== "core:agent-deletion" ||
        request.lease.key !== request.agentId ||
        request.binding.statePath !== database.path ||
        digestClawValue(input.config) !== request.configDigest
      ) {
        throw new Error("Claw journal mutation differs from its deletion owner or configuration.");
      }
      const assertLease = () => {
        if (
          !isDeepStrictEqual(requireOpenClawStateDatabaseIdentity(database), request.sourceIdentity)
        ) {
          throw new Error("Claw journal mutation no longer owns its original physical database.");
        }
        assertExistingDatabaseIdentity(
          database.path,
          request.sourceIdentity.key,
          request.sourceIdentity.birthtime,
        );
        verifyOpenClawStateLeaseOwnership({
          ...request.lease,
          leaseLabel: "agent deletion",
          transaction: db,
        });
      };
      assertLease();
      const install = readClawInstallRecordFromDatabase(db, request.agentId);
      const previous = readAgentDeletionJournalInDatabase({ db }, request.agentId);
      if (
        digestClawValue(install ?? null) !== request.expectedInstallDigest ||
        digestClawValue(previous ?? null) !== request.expectedJournalDigest
      ) {
        throw new Error(
          "Claw install or deletion journal changed before mutation; preview removal again.",
        );
      }
      requestSqliteWorkerOperationAdmission({
        stage: "transaction",
        facts: { nonce: input.nonce },
      });
      assertLease();
      const nativeOptions = { ...options, database };
      let journal: AgentDeletionJournalEntry | null;
      if (request.phase === "begin") {
        const safety = input.sessionStoreSafety;
        if (!safety || safety.agentId !== request.agentId) {
          throw new Error("Claw journal mutation lost its session-store preparation");
        }
        assertAgentSessionStoreDeletionBlocker(
          request.agentId,
          findAgentSessionStoreDeletionBlocker(
            database,
            safety.config,
            safety.agentId,
            safety.env,
            safety.targets,
          ),
        );
        const fallbackWorkspace =
          install?.workspace ??
          readClawOrphanWorkspaceInDatabase(db, request.agentId)?.workspace ??
          "";
        const agent = listAgentEntries(input.config).find((entry) => entry.id === request.agentId);
        const workspaceDir = agent?.workspace ?? fallbackWorkspace;
        const agentDir = resolveAgentDir(input.config, request.agentId, options.env);
        const sessionsDir = resolveSessionTranscriptsDirForAgent(request.agentId, options.env);
        ensureAgentProvenanceSchema(nativeOptions);
        journal = beginAgentDeletionJournalInDatabase(database, {
          agentId: request.agentId,
          operationId: request.operationId,
          workspaceDir,
          agentDir,
          sessionsDir,
          deleteFiles: previous?.deleteFiles ?? false,
        }).entry;
      } else {
        if (
          !previous ||
          previous.operationId !== request.operationId ||
          previous.cleanupCompleted ||
          !deleteAgentDeletionJournalInDatabase(
            database,
            request.agentId,
            request.operationId,
            false,
          )
        ) {
          throw new Error("Claw rollback no longer owns its deletion journal.");
        }
        journal = null;
      }
      deferSqliteWorkerCommitReceipt(db, {
        nonce: input.nonce,
        journal,
      });
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: { nonce: input.nonce } });
      assertLease();
      return { nonce: input.nonce };
    },
    { ...options, database },
    { operationLabel: "claw.removal-journal" },
  );
}
