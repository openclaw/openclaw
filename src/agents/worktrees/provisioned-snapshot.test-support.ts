import { createProvisionedSnapshotWriter } from "./provisioned-snapshot-store.js";

export async function insertRegistryWorktreeProvisionedChunk(
  env: NodeJS.ProcessEnv,
  input: { worktreeId: string; path: string; chunkIndex: number; data: Uint8Array },
): Promise<void> {
  await createProvisionedSnapshotWriter(
    env,
    input.worktreeId,
  )({
    type: "worktree.snapshot-provisioned-chunk",
    input: { path: input.path, chunkIndex: input.chunkIndex, data: input.data },
  });
}
