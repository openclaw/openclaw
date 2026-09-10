import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PreparedGitHubPublicationIdentity } from "../agents/github-tool-identity.js";
import { requirePublicationCommand } from "../gateway/github-publication-git-transport.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import type {
  SupervisedOperation,
  SupervisedOperationExecution,
} from "./supervised-operation.types.js";
import type { SupervisedWorkflowDatabaseOptions } from "./supervised-workflow.persistence.js";
import type {
  SupervisedWorkflowContract,
  SupervisedWorkflowProfile,
} from "./supervised-workflow.types.js";
import {
  captureSupervisedWorkspace,
  resolveSupervisedWorkspaceFile,
} from "./supervised-workspace.js";

export function supervisedPublicationArtifactPath(
  artifactId: string,
  options: SupervisedWorkflowDatabaseOptions,
) {
  if (!/^[a-f0-9-]{36}$/.test(artifactId)) {
    throw new Error("Invalid publication artifact identity");
  }
  const database =
    options.database?.path ?? options.path ?? resolveOpenClawStateSqlitePath(options.env);
  return path.join(path.dirname(database), "taskflow-artifacts", `${artifactId}.git`);
}

export function supervisedPublicationGitEnv(
  identity: PreparedGitHubPublicationIdentity,
): NodeJS.ProcessEnv {
  return {
    ...identity.env,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_SYSTEM: os.devNull,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

/** Build from verified bytes in a host-owned bare repository, never the model's .git. */
export async function prepareSupervisedPublicationArtifact(params: {
  contract: SupervisedWorkflowContract;
  profile: Extract<SupervisedWorkflowProfile, { kind: "publication" }>;
  execution: SupervisedOperationExecution;
  identity: PreparedGitHubPublicationIdentity;
  options: SupervisedWorkflowDatabaseOptions;
  assertCurrent: () => void;
}): Promise<NonNullable<SupervisedOperation["publication"]>> {
  const { contract, profile, execution, identity, assertCurrent } = params;
  const directory = supervisedPublicationArtifactPath(execution.executionId, params.options);
  const root = await fs.realpath(contract.workspace);
  const relative = path.relative(root, directory);
  if (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
    throw new Error("Publication artifacts must be outside the agent workspace");
  }
  // Git's author/committer environment overrides user.* config. Freeze both
  // identities from the accepted contract, never an inferred account email or
  // the launcher's ambient identity (which can disagree with the signing key).
  const author = profile.publisher.gitAuthor;
  const env = {
    ...supervisedPublicationGitEnv(identity),
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
  };
  const git = async (args: string[], input?: string) => {
    assertCurrent();
    const result = await requirePublicationCommand(["git", "--git-dir", directory, ...args], {
      env,
      input,
    });
    assertCurrent();
    return result;
  };
  const source = await captureSupervisedWorkspace(contract);
  assertCurrent();
  await fs.mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
  await fs.mkdir(directory, { mode: 0o700 });
  await git(["init", "--bare", directory]);
  await git([
    "-c",
    "credential.helper=",
    "-c",
    "credential.helper=!gh auth git-credential",
    "fetch",
    "--no-tags",
    "--",
    `https://github.com/${profile.repository}.git`,
    profile.baseCommit,
  ]);
  if ((await git(["rev-parse", "FETCH_HEAD^{commit}"])) !== profile.baseCommit) {
    throw new Error("Publication base is not the accepted commit");
  }
  await git(["read-tree", profile.baseCommit]);
  const tracked = (await git(["ls-files", "-z"])).split("\0").filter(Boolean);
  const selected = (file: string) =>
    contract.sourcePaths.some((sourcePath) => {
      const prefix = path.posix.normalize(sourcePath).replace(/\/$/, "");
      return prefix === "." || file === prefix || file.startsWith(`${prefix}/`);
    });
  // Remove selected base paths before inserting the exact captured inventory;
  // this includes deletions, without dropping unrelated base files.
  for (const file of tracked.filter(selected)) {
    await git(["update-index", "--force-remove", "--", file]);
  }
  for (const file of source.files) {
    const name = await resolveSupervisedWorkspaceFile(root, file.path);
    const bytes = await fs.readFile(name);
    if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
      throw new Error("Publication source changed while freezing its artifact");
    }
    // Binary-safe stdin lives in a private temporary file: the shared command
    // transport's input contract is UTF-8 text, not an arbitrary byte buffer.
    const blob = path.join(directory, "captured-blob");
    await fs.writeFile(blob, bytes, { mode: 0o600 });
    const object = await git(["hash-object", "-w", "--no-filters", "--", blob]);
    await git([
      "update-index",
      "--add",
      "--cacheinfo",
      `${file.executable ? "100755" : "100644"},${object},${file.path}`,
    ]);
  }
  await fs.rm(path.join(directory, "captured-blob"), { force: true });
  if ((await captureSupervisedWorkspace(contract)).hash !== source.hash) {
    throw new Error("Publication source changed before preparation commit");
  }
  const tree = await git(["write-tree"]);
  const headCommit = await git(
    [
      "-c",
      `user.name=${author.name}`,
      "-c",
      `user.email=${author.email}`,
      "-c",
      "gpg.format=openpgp",
      "commit-tree",
      `-S${profile.publisher.signingKey}`,
      tree,
      "-p",
      profile.baseCommit,
    ],
    `${profile.title}\n\nSupervised operation: ${execution.operationId}\nSource SHA256: ${source.hash}\n`,
  );
  await git(["update-ref", "refs/heads/prepared", headCommit]);
  return {
    artifactId: execution.executionId,
    sourceHash: source.hash,
    tree,
    headCommit,
    baseCommit: profile.baseCommit,
    preparedAt: Date.now(),
    pushReservedAt: null,
    createReservedAt: null,
    remoteHead: null,
    pullRequestUrl: null,
  };
}
