import { createHash } from "node:crypto";
import path from "node:path";
import { normalizeGitPathForFilesystem, type GitCommandOptions } from "../../infra/git-exec.js";
import type { WorktreeGitPolicy } from "./checkout-git-config.js";
import { requireGit, worktreePathExists } from "./git.js";
import { setWorktreePreparationTemplate } from "./preparation-timing.js";

// Path-dependent filters and sparse configuration need a fresh checkout.
// Hash effective checkout configuration so policy changes retire the cache.
export async function resolveWorktreeCheckoutKey(
  options: { destination: string; commonDir: string },
  commit: string,
  git: WorktreeGitPolicy,
  commandOptions: GitCommandOptions,
): Promise<string | undefined> {
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
    setWorktreePreparationTemplate("unavailable", { reason: "git-environment" });
    return undefined;
  }
  const config = await git.require(
    options.destination,
    ["config", "--null", "--list"],
    commandOptions,
  );
  const checkoutConfig: string[] = [];
  for (const field of config.split("\0")) {
    const key = field.split("\n", 1)[0]?.toLowerCase() ?? "";
    // Branch settings govern tracking and merge behavior, not checkout contents.
    // Registration adds remote/merge keys; deleting the branch removes them.
    if (key.startsWith("branch.")) {
      continue;
    }
    if (
      /^(filter\.|includeif\.|core\.(attributesfile|worktree|sparsecheckout|splitindex)$|index\.sparse$)/u.test(
        key,
      )
    ) {
      setWorktreePreparationTemplate("unavailable", { reason: "checkout-configuration" });
      return undefined;
    }
    checkoutConfig.push(field);
  }
  if (git.sourceOnly) {
    // The isolated policy hides native config, but a sparse checkout can already
    // have changed the retained index and files. Bind that worktree's config too.
    const fields = (
      await requireGit(
        options.destination,
        ["config", "--null", "--show-scope", "--list"],
        commandOptions,
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
    setWorktreePreparationTemplate("unavailable", { reason: "repository-attributes" });
    return undefined;
  }
  // Join both probes before returning or throwing, including cancellation, so
  // checkout cleanup cannot race an admitted Git process.
  const attributePaths = await Promise.allSettled(
    ["GIT_ATTR_GLOBAL", "GIT_ATTR_SYSTEM"].map((variable) =>
      git.run(options.destination, ["var", variable], commandOptions),
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
      setWorktreePreparationTemplate("unavailable", {
        reason: result.code === 0 ? "external-attributes" : "attributes-probe-failed",
      });
      return undefined;
    }
  }
  return createHash("sha256")
    .update(`source-v2\n${git.sourceOnly}\n${commit}\n${checkoutConfig.join("\0")}`)
    .digest("hex");
}
