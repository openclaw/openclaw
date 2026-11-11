import { randomUUID } from "node:crypto";
import { emitSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import type {
  GitHubPublicationRow,
  RepositoryGitHubPublicationRow,
} from "../state/github-publication-read.types.js";
import { createGitHubPublicationWorkerScope } from "../state/github-publication-worker.js";
import type {
  GitHubPublicationInsert,
  SharedGitHubPublicationInsert,
} from "../state/github-publication-worker.types.js";
import type { PersonalGitHubPublicationRow } from "./github-personal-publication-store.js";
import {
  bindGitHubPublicationSource,
  type GitHubPublicationSourceCapability,
} from "./github-publication-source.js";

async function insert(input: GitHubPublicationInsert, source: GitHubPublicationSourceCapability) {
  const binding = bindGitHubPublicationSource(source);
  const scope = createGitHubPublicationWorkerScope(binding.context);
  try {
    return await scope.mutate(
      {
        type: "githubPublications.insert",
        input: {
          ...input,
          operation: "insert",
          operationId: randomUUID(),
          source: binding.predicate,
        },
      },
      scope.assertCurrent,
      (receipt) => {
        for (const change of receipt.changes) {
          emitSessionLifecycleEvent({ ...change, reason: "github-publication" });
        }
      },
      source,
    );
  } finally {
    await scope.close();
    await source.release();
  }
}

/** Receipt and lifecycle binding share the source-fenced destination transaction. */
export async function insertGitHubPublicationRequestAsync(
  input: SharedGitHubPublicationInsert,
  source: GitHubPublicationSourceCapability,
): Promise<GitHubPublicationRow> {
  const receipt = await insert({ kind: "shared", input }, source);
  if (receipt.kind !== "shared" || !receipt.rows[0]) {
    throw new Error("GitHub publication request receipt is unavailable.");
  }
  return receipt.rows[0];
}

export async function insertPersonalGitHubPublicationAsync(
  row: PersonalGitHubPublicationRow,
  lifecycleRevision: string | null,
  source: GitHubPublicationSourceCapability,
): Promise<PersonalGitHubPublicationRow> {
  const receipt = await insert({ kind: "personal", row, lifecycleRevision }, source);
  if (receipt.kind !== "personal" || !receipt.rows[0]) {
    throw new Error("Personal GitHub publication request receipt is unavailable.");
  }
  return receipt.rows[0];
}

export async function insertRepositoryGitHubPublicationAsync(
  row: RepositoryGitHubPublicationRow,
  source: GitHubPublicationSourceCapability,
): Promise<RepositoryGitHubPublicationRow> {
  const receipt = await insert({ kind: "repository", row }, source);
  if (receipt.kind !== "repository" || !receipt.rows[0]) {
    throw new Error("Repository GitHub publication request receipt is unavailable.");
  }
  return receipt.rows[0];
}
