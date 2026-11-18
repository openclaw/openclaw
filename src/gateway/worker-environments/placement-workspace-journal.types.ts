import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { WorkerSessionPlacementRecord } from "./placement-record.js";
import type { WorkerWorkspaceReconciliationJournal } from "./workspace-manifest.js";

export type WorkerWorkspaceJournalOwner = {
  sessionId: string;
  environmentId: string;
  ownerEpoch: number;
  placementGeneration: number;
};

export type WorkspaceJournalChange =
  | { agentId: string; sessionKey: string }
  | { all: true; scope: "worker-placements" };

export type WorkspaceJournalMutation = {
  owners: WorkerWorkspaceJournalOwner[];
  changes: WorkspaceJournalChange[];
};

export type WorkspaceJournalReceipt = WorkspaceJournalMutation & {
  type: "placementJournals.begin" | "placementJournals.abort" | "placementJournals.prune";
};

export type WorkspaceJournalReadCommand =
  | { type: "placementJournals.owners" }
  | { type: "placementJournals.placement"; owner: WorkerWorkspaceJournalOwner }
  | {
      type: "placementJournals.load";
      owner: WorkerWorkspaceJournalOwner;
      allowFailedOwner?: boolean;
    };

export type WorkspaceJournalReadResult =
  | { type: "placementJournals.owners"; owners: WorkerWorkspaceJournalOwner[] }
  | {
      type: "placementJournals.placement";
      placement:
        | Extract<WorkerSessionPlacementRecord, { state: "active" | "draining" }>
        | undefined;
    }
  | {
      type: "placementJournals.load";
      journal: WorkerWorkspaceReconciliationJournal | undefined;
    };

function isJournalOwner(value: unknown): value is WorkerWorkspaceJournalOwner {
  return (
    isRecord(value) &&
    typeof value.sessionId === "string" &&
    typeof value.environmentId === "string" &&
    typeof value.ownerEpoch === "number" &&
    typeof value.placementGeneration === "number"
  );
}

export function isWorkspaceJournalReadCommand(
  value: unknown,
): value is WorkspaceJournalReadCommand {
  return (
    isRecord(value) &&
    (value.type === "placementJournals.owners" ||
      ((value.type === "placementJournals.placement" || value.type === "placementJournals.load") &&
        isJournalOwner(value.owner) &&
        (value.allowFailedOwner === undefined || typeof value.allowFailedOwner === "boolean")))
  );
}

export function isWorkspaceJournalReceipt(value: unknown): value is WorkspaceJournalReceipt {
  return (
    isRecord(value) &&
    (value.type === "placementJournals.begin" ||
      value.type === "placementJournals.abort" ||
      value.type === "placementJournals.prune") &&
    Array.isArray(value.owners) &&
    value.owners.every(isJournalOwner) &&
    Array.isArray(value.changes) &&
    value.changes.every(
      (change) =>
        isRecord(change) &&
        ((change.all === true && change.scope === "worker-placements") ||
          (typeof change.agentId === "string" && typeof change.sessionKey === "string")),
    )
  );
}
