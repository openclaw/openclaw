import { serialize } from "node:v8";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import {
  reserveSqliteWorkerInputPreparation,
  type SqliteWorkerInputPreparation,
} from "../../infra/sqlite-worker-store.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { stagePlacementWorkspaceJournalWorkerPublication } from "./placement-turn-authority.js";
import { createPlacementWorkerMutation } from "./placement-worker-mutation.js";
import {
  isWorkspaceJournalReceipt,
  type WorkerWorkspaceJournalOwner,
  type WorkspaceJournalReadCommand,
  type WorkspaceJournalReadResult,
  type WorkspaceJournalReceipt,
} from "./placement-workspace-journal.types.js";
import type { WorkspaceJournalWorkerOperations } from "./placement-workspace-journal.worker-contract.js";
import type { WorkerWorkspaceReconciliationJournal } from "./workspace-manifest.js";

export function createPlacementWorkspaceJournalWorkerOps(runtime: {
  path: string;
  now?: () => number;
}) {
  const context = captureOpenClawStateWorkerContext({ path: runtime.path });

  async function read(
    command: WorkspaceJournalReadCommand,
    assertCurrent?: () => void,
  ): Promise<WorkspaceJournalReadResult> {
    context.admission.assertCurrent();
    assertCurrent?.();
    const reply = await executeExistingOpenClawStateRead({ path: runtime.path }, command, {
      current: true,
    });
    context.admission.assertCurrent();
    assertCurrent?.();
    if (reply?.ok && reply.type === command.type) {
      switch (reply.type) {
        case "placementJournals.owners":
        case "placementJournals.placement":
        case "placementJournals.load":
          return reply;
      }
    }
    throw new Error("Worker workspace journal reader is unavailable");
  }

  async function execute(
    command: SqliteWorkerCommand<WorkspaceJournalWorkerOperations>,
    assertCurrent?: () => void,
    preparation?: SqliteWorkerInputPreparation,
  ): Promise<WorkspaceJournalReceipt> {
    let published = false;
    const readReceipt = (facts: unknown) =>
      isWorkspaceJournalReceipt(facts) && facts.type === command.type ? facts : undefined;
    const mutation = createPlacementWorkerMutation({
      context,
      label: "Worker workspace journal",
      nativeLocation: runtime.path,
      assertCurrent() {
        assertCurrent?.();
        preparation?.assertCurrent();
      },
      readReceipt,
      stageCommit(facts) {
        const receipt = readReceipt(facts);
        if (!receipt) {
          throw new Error("Worker workspace journal commit has an invalid receipt");
        }
        const publications: ReturnType<typeof stagePlacementWorkspaceJournalWorkerPublication>[] =
          [];
        const rollback = () => publications.forEach((publication) => publication.rollback());
        try {
          for (const owner of receipt.owners) {
            publications.push(
              stagePlacementWorkspaceJournalWorkerPublication(
                context.admission.identity,
                owner.sessionId,
              ),
            );
          }
        } catch (error) {
          rollback();
          throw error;
        }
        return {
          commit: () => publications.forEach((publication) => publication.commit()),
          rollback,
          invalidate: () => publications.forEach((publication) => publication.invalidate()),
        };
      },
      publish(receipt) {
        if (!published) {
          published = true;
          sessionChanges.emitBatch(receipt.changes);
        }
      },
    });
    try {
      return await mutation.run((scope) =>
        preparation ? preparation.handoff(() => scope.execute(command)) : scope.execute(command),
      );
    } finally {
      preparation?.release();
    }
  }

  return {
    async getWorkspaceReconciliationPlacement(
      owner: WorkerWorkspaceJournalOwner,
      assertCurrent?: () => void,
    ) {
      const reply = await read(
        { type: "placementJournals.placement", owner: { ...owner } },
        assertCurrent,
      );
      if (reply.type !== "placementJournals.placement") {
        throw new Error("Unexpected workspace journal placement reply");
      }
      return reply.placement;
    },
    async listWorkspaceReconciliationOwners(assertCurrent?: () => void) {
      const reply = await read({ type: "placementJournals.owners" }, assertCurrent);
      if (reply.type !== "placementJournals.owners") {
        throw new Error("Unexpected workspace journal owners reply");
      }
      return reply.owners;
    },
    async loadWorkspaceReconciliation(
      owner: WorkerWorkspaceJournalOwner,
      options: { allowFailedOwner?: boolean } = {},
      assertCurrent?: () => void,
    ) {
      const reply = await read(
        {
          type: "placementJournals.load",
          owner: { ...owner },
          allowFailedOwner: options.allowFailedOwner,
        },
        assertCurrent,
      );
      if (reply.type !== "placementJournals.load") {
        throw new Error("Unexpected workspace journal load reply");
      }
      return reply.journal;
    },
    async beginWorkspaceReconciliation(
      owner: WorkerWorkspaceJournalOwner,
      journal: WorkerWorkspaceReconciliationJournal,
      assertCurrent?: () => void,
    ): Promise<void> {
      const input = { owner: { ...owner }, journal, nowMs: runtime.now?.() };
      const metadataBytes = serialize({
        type: "placementJournals.begin",
        input: { ...input, journal: { ...journal, basePack: new Uint8Array() } },
      }).byteLength;
      const preparation = reserveSqliteWorkerInputPreparation(
        metadataBytes + journal.basePack.byteLength,
      );
      try {
        const captured = structuredClone(input);
        await execute(
          { type: "placementJournals.begin", input: captured },
          assertCurrent,
          preparation,
        );
      } finally {
        preparation.release();
      }
    },
    async abortWorkspaceReconciliation(
      owner: WorkerWorkspaceJournalOwner,
      options: { force?: boolean } = {},
      assertCurrent?: () => void,
    ): Promise<void> {
      await execute(
        { type: "placementJournals.abort", input: { owner: { ...owner }, force: options.force } },
        assertCurrent,
      );
    },
    async pruneOrphanedWorkspaceReconciliations(assertCurrent?: () => void) {
      return (await execute({ type: "placementJournals.prune", input: {} }, assertCurrent)).owners;
    },
  };
}
