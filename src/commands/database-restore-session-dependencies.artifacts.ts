import fs from "node:fs/promises";
import path from "node:path";
import { computeWorkspaceManifest } from "../gateway/worker-environments/workspace-manifest-worker.js";
import {
  requireWorkspaceResultGit as git,
  workspaceResultCheckpointInitArgs,
  withWorkspaceResultRefMutation,
} from "../gateway/worker-environments/workspace-result-git.js";
import {
  ensureDurableDirectory,
  pinDirectory,
  requireDirectorySync,
  syncDirectory,
} from "../infra/directory-durability.js";
import { hasErrnoCode } from "../infra/errno.js";
import {
  prepareSkillLibraryBundle,
  readSkillLibraryManifestTree,
  stageSkillLibraryBundle,
} from "../skills/library/bundle.js";
import { createSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import type { readSessionDependencyInput } from "./database-restore-session-dependencies.input.js";

type Input = Awaited<ReturnType<typeof readSessionDependencyInput>>;
async function checkCheckpoint(root: string, input: Input) {
  const row = input.rows.workspace;
  if (row.checkpoint_ref === null) {
    return;
  }
  const snapshot = await computeWorkspaceManifest({
    type: "workspace.manifest.result",
    input: { root, ref: row.checkpoint_ref, verifyContents: true },
  });
  if (
    snapshot.base.baseCommit !== row.base_commit ||
    snapshot.current.baseCommit !== row.base_commit ||
    snapshot.baseManifestRef !== row.base_manifest_hash ||
    snapshot.currentManifestRef !== row.manifest_hash
  ) {
    throw new Error("Repository checkpoint differs from the selected original workspace");
  }
}

async function syncCheckpointTree(directory: string) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await syncCheckpointTree(file);
    } else if (entry.isFile()) {
      await using handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      await handle.sync();
    } else {
      throw new Error("Repository checkpoint store contains a non-regular artifact");
    }
  }
  requireDirectorySync(await syncDirectory(directory), "Repository checkpoint durability");
}

export async function prepareSessionDependencyArtifacts(input: Input) {
  const files = await readSkillLibraryManifestTree(
    path.join(input.root, "skill-revision"),
    input.rows.revision.files_json,
    input.request.skillRevision,
  );
  const skill = prepareSkillLibraryBundle(files);
  if (
    skill.revision !== input.request.skillRevision ||
    skill.description !== input.rows.revision.description
  ) {
    throw new Error("Pinned skill content differs from its selected revision");
  }
  const source = path.join(input.root, "workspace.git");
  await checkCheckpoint(source, input);
  return { skill, source };
}

/** Immutable artifacts precede database pointers; failures never replace a conflicting store. */
export async function publishSessionDependencyArtifacts(
  input: Input,
  prepared: Awaited<ReturnType<typeof prepareSessionDependencyArtifacts>>,
  statePath: string,
  env: NodeJS.ProcessEnv,
  assertCurrent: () => void,
) {
  const staged = await stageSkillLibraryBundle(
    input.request.skillId,
    prepared.skill,
    env,
    assertCurrent,
  );
  try {
    await staged.publish();
  } finally {
    await staged.cleanup();
  }
  if (input.rows.workspace.checkpoint_ref === null) {
    return;
  }
  const store = createSessionRepositoryWorkspaceStore({ path: statePath, env });
  const destination = store.artifactPath(input.request.workspaceId);
  if (
    await fs.lstat(destination).then(
      () => true,
      (error: unknown) => {
        if (hasErrnoCode(error, "ENOENT")) {
          return false;
        }
        throw error;
      },
    )
  ) {
    await checkCheckpoint(destination, input);
    await syncCheckpointTree(destination);
    requireDirectorySync(
      await syncDirectory(path.dirname(destination)),
      "Repository checkpoint durability",
    );
    return;
  }
  assertCurrent();
  const parent = path.dirname(destination);
  const parentReceipt = await ensureDurableDirectory({ directoryPath: parent, mode: 0o700 });
  requireDirectorySync(parentReceipt.parentSync, "Repository checkpoint directory");
  const staging = await fs.mkdtemp(path.join(parent, ".dependency-restore-"));
  try {
    await git(staging, workspaceResultCheckpointInitArgs());
    await withWorkspaceResultRefMutation(staging, async (baseEnv) => {
      assertCurrent();
      const ref = input.rows.workspace.checkpoint_ref;
      await git(
        staging,
        ["fetch", "--quiet", "--no-tags", "--", prepared.source, ref + ":" + ref],
        { baseEnv },
      );
    });
    await checkCheckpoint(staging, input);
    await syncCheckpointTree(staging);
    const held = await pinDirectory(parent, { label: "repository dependency publication" });
    try {
      assertCurrent();
      await fs.rename(staging, destination);
      requireDirectorySync(await syncDirectory(held.receipt), "Repository dependency publication");
    } finally {
      await held.close();
    }
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}
