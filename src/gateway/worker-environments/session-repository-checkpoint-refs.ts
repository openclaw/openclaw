import { createHash } from "node:crypto";
import type { SessionRepositoryWorkspaceRecord } from "../../state/session-repository-workspaces.types.js";
import {
  publishImmutableWorkspaceResultRefs,
  readWorkspaceResultRefObjects,
} from "./workspace-result-git.js";
import { workerWorkspaceResultRef } from "./workspace-result-staging.js";

export const publicationRef = (ref: string) =>
  workerWorkspaceResultRef(`publication-${createHash("sha256").update(ref).digest("hex")}`);

export function checkpointRef(workspace: SessionRepositoryWorkspaceRecord, ref?: string): string {
  const selected = ref ?? workspace.checkpointRef;
  if (!selected || !/^refs\/openclaw\/worker-results\/[A-Za-z0-9-]+$/u.test(selected)) {
    throw new Error("Repository workspace has no valid checkpoint");
  }
  return selected;
}

export function publishCheckpointRefs(
  root: string,
  workspace: SessionRepositoryWorkspaceRecord,
  objectId: string,
  companionId: string | undefined,
  refs: readonly string[],
  assertCurrent: () => void,
) {
  return publishImmutableWorkspaceResultRefs(
    root,
    [...new Set(refs)].flatMap(
      (target) =>
        [
          [checkpointRef(workspace, target), objectId],
          [publicationRef(target), companionId],
        ] as const,
    ),
    assertCurrent,
  );
}

export async function aliasSessionRepositoryCheckpoint(params: {
  root: string;
  workspace: SessionRepositoryWorkspaceRecord;
  checkpointRef: string;
  aliases: readonly string[];
  assertCurrent: () => void;
}): Promise<void> {
  const { workspace, root } = params;
  const ref = checkpointRef(workspace, params.checkpointRef);
  const companion = publicationRef(ref);
  const objects = await readWorkspaceResultRefObjects(root, [ref, companion]);
  const object = objects.get(ref);
  if (!object) {
    throw new Error("Repository publication checkpoint is no longer available");
  }
  // Include the source pair so the immutable-ref owner also rejects changed source identities.
  await publishCheckpointRefs(
    root,
    workspace,
    object,
    objects.get(companion),
    [ref, ...params.aliases],
    params.assertCurrent,
  );
}
