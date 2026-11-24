import {
  deletePersonalGitHubSessionReceiptsInDatabase,
  readSessionReceiptDeletionIdentitiesInDatabase,
} from "./github-personal-publication-lifecycle.js";
import type { WorkerOperationContext } from "./worker-operation-registry.js";

export const githubSessionReceiptOperations = {
  "githubPublication.prepareSessionReceiptDeletion": (
    input: Parameters<typeof readSessionReceiptDeletionIdentitiesInDatabase>[1],
    context: WorkerOperationContext,
  ) => readSessionReceiptDeletionIdentitiesInDatabase(context.open(), input),
  "githubPublication.deleteSessionReceipts": (
    input: Parameters<typeof deletePersonalGitHubSessionReceiptsInDatabase>[1],
    context: WorkerOperationContext,
  ) => deletePersonalGitHubSessionReceiptsInDatabase(context.open(), input),
};
