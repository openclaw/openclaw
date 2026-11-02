import { withWorktreeGitConfig } from "./checkout-git-config.js";
import { resolveWorktreeCheckoutKey } from "./checkout-policy-key.js";
import { hasWorktreeUnknownOutcome } from "./errors.js";
import type { WorktreeFilesystemOptions } from "./filesystem-backend.types.js";
import { resolveGitMetadataPath } from "./git.js";
import { retainWorktreeTemplate } from "./template-cache.js";
import { readTemplateAsync } from "./template-registry-async.js";
import type { WorktreeTemplateRecord, WorktreeWarmPoolRequest } from "./template-registry.js";

export const selectWarmWorktree = (template: WorktreeTemplateRecord) => ({
  cacheKey: `warm:${template.cacheKey}`,
  contentKey: `${template.id}:${template.contentKey}`,
  backend: `warm-${template.backend}`,
});

export async function isWarmWorktreeClean(
  record: WorktreeTemplateRecord,
  options: WorktreeFilesystemOptions,
  sourceOnly: boolean,
  contentKey: string,
) {
  const gitOptions = {
    signal: options.signal,
    beforeRun: options.commitGuard,
    killProcessTree: true,
  };
  const output = await withWorktreeGitConfig(record.path, sourceOnly, gitOptions, async (git) => {
    if (
      (await resolveWorktreeCheckoutKey({
        destination: record.path,
        commonDir: record.commonDir,
        commit: record.sourceCommit,
        gitOptions,
        git,
      })) !== contentKey
    ) {
      return undefined;
    }
    return await git.require(
      record.path,
      ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal", "--ignored"],
      gitOptions,
    );
  });
  if (output === undefined) {
    return false;
  }
  const fields = output.split("\0").filter(Boolean);
  return (
    fields.every((field) => field.startsWith("# ")) &&
    fields.filter((field) => field === `# branch.oid ${record.sourceCommit}`).length === 1
  );
}

/** One consumable slot shares the template registry's custody and crash/idle cleanup. */
export async function takeWarmWorktree(
  env: NodeJS.ProcessEnv,
  request: WorktreeWarmPoolRequest,
  options: WorktreeFilesystemOptions,
) {
  const wanted = selectWarmWorktree(request.template);
  const record = await readTemplateAsync(env, wanted.cacheKey, options.commitGuard);
  if (
    !record ||
    record.status !== "ready" ||
    record.contentKey !== wanted.contentKey ||
    record.backend !== wanted.backend
  ) {
    return undefined;
  }
  // Unpublication is atomic with exclusive reader admission. A preparing slot
  // is never consumable, even if another request observed it before this claim.
  const retained = await retainWorktreeTemplate(env, record, options.commitGuard, true);
  if (!retained) {
    return undefined;
  }
  try {
    if (
      retained.status === "ready" &&
      (await isWarmWorktreeClean(
        retained,
        options,
        request.sourceOnly,
        request.template.contentKey,
      ))
    ) {
      return {
        record: retained,
        sourceIndex: await resolveGitMetadataPath(retained.path, "index", {
          signal: options.signal,
          beforeRun: options.commitGuard,
        }),
      };
    }
  } catch (error) {
    await retained.release(error);
    options.signal?.throwIfAborted();
    options.commitGuard();
    if (hasWorktreeUnknownOutcome(error)) {
      throw error;
    }
    return undefined;
  }
  await retained.release();
  return undefined;
}
