import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDeferred, awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import {
  withAgentDeletion,
  type AgentDeletionOperation,
} from "../agents/agent-lifecycle-registry.js";
import {
  beginAgentDeletionJournal,
  readAgentDeletionJournal,
  readAgentDeletionJournalInDatabase,
} from "../state/agent-deletion-journal.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { releaseClawRemoveRows } from "./lifecycle-delete-support.js";
import {
  deleteClawInstallRecord,
  persistClawInstallRecord,
  persistClawMigrationOwnership,
  releaseAdoptedClawInstallRecord,
  readClawInstallRecord,
  updateClawInstallRecord,
  updateClawInstallRecordStatus,
} from "./provenance.js";
import { makeProvenancePlan } from "./provenance.test-helpers.js";

function deletionEntry(root: string, agentId = "worker") {
  return {
    agentId,
    agentDir: path.join(root, "agents", agentId),
    workspaceDir: path.join(root, `workspace-${agentId}`),
    sessionsDir: path.join(root, "agents", agentId, "sessions"),
    deleteFiles: false,
    databasePaths: [path.join(root, "agents", agentId, "openclaw-agent.sqlite")],
    cleanupPaths: [
      {
        path: path.join(root, `workspace-${agentId}`),
        canonicalPath: path.join(root, `workspace-${agentId}`),
        parentPath: root,
        kind: "target" as const,
        sourcePaths: [path.join(root, `workspace-${agentId}`)],
        dev: null,
        ino: null,
        coversDescendants: true,
        done: false,
      },
    ],
  };
}

describe("Claw installation identity during deletion", () => {
  it("fences foreign writes while cleanup waits and admits only its live retry owner", async () => {
    await withOpenClawTestState(
      { label: "claw-install-deletion", applyEnv: false },
      async ({ root, env }) => {
        const { plan } = await makeProvenancePlan(root, {
          schemaVersion: 1,
          agent: { id: "worker" },
        });
        const options = { env };
        const original = persistClawInstallRecord(plan, {
          ...options,
          nowMs: 1,
          agentOrigin: "adopted",
        });
        const next = {
          ...plan,
          claw: { ...plan.claw, version: "2.0.0", integrity: "sha256:replacement" },
        };
        const paused = createDeferred<AgentDeletionOperation>();
        const resume = createDeferred();
        const removal = withAgentDeletion(
          "worker",
          async (begin) => {
            const deletion = await begin(deletionEntry(root));
            paused.resolve(deletion);
            await resume.promise;
            const beforeHandoff = readAgentDeletionJournal("worker", options);
            updateClawInstallRecordStatus("worker", "partial", {
              ...options,
              nowMs: 2,
              deletionOperation: deletion,
            });
            const handedOff = readAgentDeletionJournal("worker", options);
            expect(handedOff).toEqual({ ...beforeHandoff, operationId: expect.any(String) });
            expect(handedOff?.operationId).not.toBe(deletion.entry.operationId);
            expect(handedOff?.cleanupCompleted).toBe(false);
            expect(() => deletion.assertCurrent()).toThrow("no longer owns");
            return deletion;
          },
          options,
        );
        let operation: AgentDeletionOperation;
        try {
          operation = await awaitGateBeforeSettlement(
            paused.promise,
            removal,
            "Deletion did not pause",
          );
          const journal = readAgentDeletionJournal("worker", options);
          expect(journal?.operationId).toBe(operation.entry.operationId);
          expect(() => updateClawInstallRecord(next, options)).toThrow("pending deletion");
          expect(() => persistClawMigrationOwnership(next, [], options)).toThrow(
            "pending deletion",
          );
          expect(() =>
            releaseAdoptedClawInstallRecord("worker", original.planIntegrity, options),
          ).toThrow("pending deletion");
          expect(() => updateClawInstallRecordStatus("worker", "partial", options)).toThrow(
            "pending deletion",
          );
          expect(() => deleteClawInstallRecord("worker", options)).toThrow("pending deletion");
          expect(readClawInstallRecord("worker", options)).toEqual(original);
          expect(readAgentDeletionJournal("worker", options)).toEqual(journal);
          await withAgentDeletion(
            "other",
            async (begin) => {
              const foreign = await begin(deletionEntry(root, "other"));
              try {
                expect(() =>
                  updateClawInstallRecordStatus("worker", "partial", {
                    ...options,
                    deletionOperation: foreign,
                  }),
                ).toThrow("does not belong to the current deletion");
              } finally {
                await foreign.rollback();
              }
            },
            options,
          );
        } finally {
          resume.resolve();
          await removal;
        }
        expect(readClawInstallRecord("worker", options)).toEqual({
          ...original,
          status: "partial",
          updatedAtMs: 2,
        });
        expect(() =>
          updateClawInstallRecordStatus("worker", "partial", {
            ...options,
            deletionOperation: operation,
          }),
        ).toThrow("does not belong to the current deletion");
        await withAgentDeletion(
          "worker",
          async (begin) => {
            const recovery = await begin(deletionEntry(root));
            expect(() =>
              updateClawInstallRecordStatus("worker", "partial", {
                ...options,
                deletionOperation: operation,
              }),
            ).toThrow("does not belong to the current deletion");
            expect(
              releaseClawRemoveRows(
                "worker",
                [],
                [],
                recovery.assertCurrent,
                recovery.completeInTransaction,
                options,
              ),
            ).toBe(true);
          },
          options,
        );
        expect(readClawInstallRecord("worker", options)).toBeUndefined();
        expect(readAgentDeletionJournal("worker", options)?.cleanupCompleted).toBe(true);
        expect(persistClawInstallRecord(next, { ...options, nowMs: 3 }).claw.version).toBe("2.0.0");
      },
    );
  });

  it("rolls back the retry handoff and status together without revoking the restored owner", async () => {
    await withOpenClawTestState(
      { label: "claw-retry-handoff-rollback", applyEnv: false },
      async ({ root, env }) => {
        const { plan } = await makeProvenancePlan(root, {
          schemaVersion: 1,
          agent: { id: "worker" },
        });
        const options = { env };
        const original = persistClawInstallRecord(plan, { ...options, nowMs: 1 });
        await withAgentDeletion(
          "worker",
          async (begin) => {
            const deletion = await begin(deletionEntry(root));
            const journal = readAgentDeletionJournal("worker", options);
            const failure = new Error("abort retry publication");
            expect(() =>
              runOpenClawStateWriteTransaction((database) => {
                updateClawInstallRecordStatus("worker", "partial", {
                  ...options,
                  database,
                  nowMs: 2,
                  deletionOperation: deletion,
                });
                expect(
                  readAgentDeletionJournalInDatabase(database, "worker")?.operationId,
                ).not.toBe(deletion.entry.operationId);
                expect(() => deletion.assertCurrent(database)).toThrow("no longer owns");
                throw failure;
              }, options),
            ).toThrow(failure);
            expect(readAgentDeletionJournal("worker", options)).toEqual(journal);
            expect(readClawInstallRecord("worker", options)).toEqual(original);
            expect(() => deletion.assertCurrent()).not.toThrow();
            await deletion.rollback();
          },
          options,
        );
        expect(readAgentDeletionJournal("worker", options)).toBeUndefined();
      },
    );
  });

  it.each(["missing", "legacy"] as const)(
    "keeps a %s install unchanged across an interrupted deletion until rollback",
    async (kind) => {
      await withOpenClawTestState(
        { label: `claw-install-deletion-${kind}`, applyEnv: false },
        async ({ root, env }) => {
          const { plan } = await makeProvenancePlan(root, {
            schemaVersion: 1,
            agent: { id: "worker" },
          });
          const options = { env };
          if (kind === "legacy") {
            persistClawInstallRecord(plan, { ...options, status: "pending", nowMs: 1 });
            runOpenClawStateWriteTransaction(({ db }) => {
              db.prepare("UPDATE claw_installs SET schema_version = ? WHERE agent_id = ?").run(
                "openclaw.clawInstallRecord.v1",
                "worker",
              );
            }, options);
          }
          const original = readClawInstallRecord("worker", options);
          beginAgentDeletionJournal(
            { ...deletionEntry(root), operationId: "interrupted-deletion" },
            options,
          );
          expect(() =>
            persistClawInstallRecord(plan, {
              ...options,
              status: "pending",
              expectedExistingRecord: original,
            }),
          ).toThrow("pending deletion");
          expect(readClawInstallRecord("worker", options)).toEqual(original);
          await withAgentDeletion(
            "worker",
            async (begin) => (await begin(deletionEntry(root))).rollback(),
            options,
          );
          expect(
            persistClawInstallRecord(plan, {
              ...options,
              status: "pending",
              expectedExistingRecord: original,
            }).schemaVersion,
          ).toBe("openclaw.clawInstallRecord.v2");
        },
      );
    },
  );
});
