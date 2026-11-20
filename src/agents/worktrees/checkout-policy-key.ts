import { createHash } from "node:crypto";
import path from "node:path";
import { normalizeGitPathForFilesystem, type GitCommandOptions } from "../../infra/git-exec.js";
import type { WorktreeGitPolicy } from "./checkout-git-config.js";
import { requireGit, worktreePathExists } from "./git.js";
import { setWorktreePreparationTemplate } from "./preparation-timing.js";
import type { WorktreeTemplateRecord } from "./template-registry.js";

// Path-dependent filters and sparse configuration need a fresh checkout.
// Hash effective checkout configuration so policy changes retire the cache.
export async function resolveWorktreeCheckoutPolicy(
  options: {
    destination: string;
    commonDir: string;
    git: WorktreeGitPolicy;
    gitOptions: GitCommandOptions;
  },
  scope: "template" | "prompt" = "template",
): Promise<((commit: string) => string) | undefined> {
  const { git } = options;
  if (
    [
      "GIT_INDEX_FILE",
      "GIT_WORK_TREE",
      "GIT_DIR",
      "GIT_COMMON_DIR",
      "GIT_CONFIG",
      "GIT_ATTR_SOURCE",
    ].some((key) => process.env[key])
  ) {
    if (scope === "template") {
      setWorktreePreparationTemplate("unavailable", { reason: "git-environment" });
    }
    return undefined;
  }
  const config = await git.require(
    options.destination,
    ["config", "--null", "--list"],
    options.gitOptions,
  );
  const checkoutConfig: string[] = [];
  for (const field of config.split("\0")) {
    const key = field.split("\n", 1)[0]?.toLowerCase() ?? "";
    // Branch settings govern tracking and merge behavior, not checkout contents.
    // Registration adds remote/merge keys; deleting the branch removes them.
    if (key.startsWith("branch.")) {
      continue;
    }
    // Installed drivers (for example Git LFS) need not apply to prompt files.
    // Their effective attributes are checked against the selected index below.
    if (scope === "prompt" && key.startsWith("filter.")) {
      continue;
    }
    if (
      /^(filter\.|includeif\.|core\.(attributesfile|worktree|sparsecheckout|splitindex)$|index\.sparse$)/u.test(
        key,
      )
    ) {
      if (scope === "template") {
        setWorktreePreparationTemplate("unavailable", { reason: "checkout-configuration" });
      }
      return undefined;
    }
    checkoutConfig.push(field);
  }
  if (git.sourceOnly) {
    // Native worktree config can already have changed the retained index and files.
    const fields = (
      await requireGit(
        options.destination,
        ["config", "--null", "--show-scope", "--list"],
        options.gitOptions,
      )
    ).split("\0");
    checkoutConfig.push(
      ...fields.filter(
        (field, index) =>
          index % 2 === 1 && fields[index - 1] === "worktree" && !field.startsWith("branch."),
      ),
    );
  }
  // Outside-tree attributes can select transforms that depend on the checkout path.
  // Leave those repositories with Git until a backend models that contract.
  if (
    !git.sourceOnly &&
    (await worktreePathExists(path.join(options.commonDir, "info", "attributes")))
  ) {
    if (scope === "template") {
      setWorktreePreparationTemplate("unavailable", { reason: "repository-attributes" });
    }
    return undefined;
  }
  // Join both probes before returning or throwing, including cancellation, so
  // checkout cleanup cannot race an admitted Git process.
  const attributePaths = await Promise.allSettled(
    ["GIT_ATTR_GLOBAL", "GIT_ATTR_SYSTEM"].map((variable) =>
      git.run(options.destination, ["var", variable], options.gitOptions),
    ),
  );
  for (const probe of attributePaths) {
    if (probe.status === "rejected") {
      throw probe.reason;
    }
    const result = probe.value;
    // git var exits 1 without output for a known but disabled path (for example
    // GIT_ATTR_NOSYSTEM=1). Unknown variables on older Git still report an error.
    if (
      result.termination === "exit" &&
      result.code === 1 &&
      !result.stdout.trim() &&
      !result.stderr.trim()
    ) {
      continue;
    }
    // Older Git cannot report its attribute search paths: retain native checkout.
    if (
      result.termination !== "exit" ||
      result.code !== 0 ||
      result.stdoutTruncatedBytes ||
      (result.stdout.trim() &&
        (await worktreePathExists(normalizeGitPathForFilesystem(result.stdout.trim()))))
    ) {
      if (scope === "template") {
        setWorktreePreparationTemplate("unavailable", {
          reason: result.code === 0 ? "external-attributes" : "attributes-probe-failed",
        });
      }
      return undefined;
    }
  }
  const policy = checkoutConfig.join("\0");
  return (commit) =>
    createHash("sha256").update(`source-v2\n${git.sourceOnly}\n${commit}\n${policy}`).digest("hex");
}

export async function canAdvanceWorktreeTemplate(
  previous: WorktreeTemplateRecord,
  commit: string,
  git: WorktreeGitPolicy,
  gitOptions: GitCommandOptions,
): Promise<boolean> {
  const changed = await git.run(
    previous.path,
    [
      "diff-tree",
      "--no-commit-id",
      "--raw",
      "--no-abbrev",
      "--no-renames",
      "-r",
      "-z",
      previous.sourceCommit,
      commit,
      "--",
    ],
    { ...gitOptions, maxOutputBytes: 16 * 1024 },
  );
  if (changed.code !== 0 || changed.termination !== "exit" || changed.stdoutTruncatedBytes) {
    return false;
  }
  const fields = changed.stdout.split("\0").filter(Boolean);
  if (fields.length > 128) {
    return false;
  }
  const objects: string[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    if (path.posix.basename(fields[index + 1]!) === ".gitattributes") {
      return false;
    }
    for (const object of fields[index]!.slice(1).split(" ").slice(2, 4)) {
      if (!/^0+$/.test(object)) {
        objects.push(object);
      }
    }
  }
  if (!objects.length) {
    return true;
  }
  const sizes = await git.run(
    previous.path,
    ["cat-file", "--batch-check=%(objecttype) %(objectsize)"],
    {
      ...gitOptions,
      input: objects.join("\n") + "\n",
      maxOutputBytes: 8192,
    },
  );
  if (sizes.code !== 0 || sizes.termination !== "exit" || sizes.stdoutTruncatedBytes) {
    return false;
  }
  let bytes = 0;
  for (const line of sizes.stdout.trim().split("\n")) {
    const [kind, size] = line.split(" ");
    if (kind !== "blob") {
      return false;
    }
    bytes += Number(size);
  }
  return bytes <= 4 * 1024 * 1024;
}

export async function validateWorktreeTemplateCheckout(
  existing: WorktreeTemplateRecord,
  options: { commonDir: string; git: WorktreeGitPolicy; gitOptions: GitCommandOptions },
): Promise<boolean> {
  const { git, gitOptions } = options;
  // Include config.worktree: a clean sparse template can look like a full checkout.
  const policy = await resolveWorktreeCheckoutPolicy({ ...options, destination: existing.path });
  if (policy?.(existing.sourceCommit) !== existing.contentKey) {
    return false;
  }
  const status = await git.run(
    existing.path,
    ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all", "--ignored"],
    gitOptions,
  );
  // NUL records keep filenames from impersonating HEAD headers.
  const fields = status.stdout.split("\0");
  const heads = fields.filter((field) => field.startsWith("# branch.oid "));
  return (
    status.termination === "exit" &&
    status.code === 0 &&
    !status.stdoutTruncatedBytes &&
    fields.pop() === "" &&
    fields.every((field) => field.startsWith("# ")) &&
    heads.length === 1 &&
    heads[0] === `# branch.oid ${existing.sourceCommit}`
  );
}

export async function canRefreshWorktreeTemplate(
  existing: WorktreeTemplateRecord,
  commit: string,
  contentKey: string,
  options: { commonDir: string; git: WorktreeGitPolicy; gitOptions: GitCommandOptions },
): Promise<boolean> {
  // Attribute changes can transform unchanged blobs; rebuild those trees.
  const attributes = await options.git.run(
    existing.path,
    ["diff-tree", "--quiet", "-r", existing.sourceCommit, commit, "--", ":(glob)**/.gitattributes"],
    options.gitOptions,
  );
  if (attributes.code !== 0 || attributes.termination !== "exit") {
    return false;
  }
  const policy = await resolveWorktreeCheckoutPolicy({ ...options, destination: existing.path });
  return policy?.(commit) === contentKey;
}
