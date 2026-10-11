import { createHash } from "node:crypto";
import path from "node:path";
import { normalizeGitPathForFilesystem, type GitCommandOptions } from "../../infra/git-exec.js";
import type { WorktreeGitPolicy } from "./checkout-git-config.js";
import { parseGitTreePaths, splitNullBuffer } from "./git-path-inventory.js";
import { commandError, requireGit, worktreePathExists } from "./git.js";
import { setWorktreePreparationTemplate } from "./preparation-timing.js";

type CheckoutSource = {
  repoRoot: string;
  commonDir: string;
  destination: string;
  commit: string;
  gitOptions: GitCommandOptions;
  git: WorktreeGitPolicy;
};

// Path-dependent filters and sparse configuration need a fresh checkout.
// Hash effective checkout configuration so policy changes retire the cache.
export async function resolveWorktreeCheckoutKey(
  options: CheckoutSource,
  scope: "template" | "prompt" = "template",
): Promise<string | undefined> {
  const { git, commit } = options;
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
  return createHash("sha256")
    .update(`source-v2\n${git.sourceOnly}\n${commit}\n${checkoutConfig.join("\0")}`)
    .digest("hex");
}

async function promptPaths(options: CheckoutSource): Promise<string[] | undefined> {
  if (!(await resolveWorktreeCheckoutKey(options, "prompt"))) {
    return undefined;
  }
  const tree = await options.git.worker.buffered(
    options.repoRoot,
    ["ls-tree", "-r", "-z", options.commit],
    {
      ...options.gitOptions,
      maxOutputBytes: 16 * 1024 ** 2,
    },
  );
  if (tree.termination === "output-limit") {
    return undefined;
  }
  if (tree.code !== 0 || tree.termination !== "exit") {
    throw commandError("git ls-tree", tree);
  }
  const selected: { path: string; oid: string }[] = [];
  for (const entry of parseGitTreePaths(tree.stdout)) {
    const name = entry.path.toString("utf8");
    const normalized = name.toLowerCase();
    if (
      !Buffer.from(name).equals(entry.path) ||
      normalized === ".worktreeinclude" ||
      normalized === ".codex/config.toml" ||
      (path.posix.basename(normalized) === ".gitattributes" &&
        path.posix.basename(name) !== ".gitattributes")
    ) {
      return undefined;
    }
    if (!name.includes("/") || /^(?:\.agents|\.codex|skills)\//u.test(normalized)) {
      if (!/^100(?:644|755)$/u.test(entry.mode)) {
        return undefined;
      }
      selected.push({ path: name, oid: entry.oid });
    }
  }
  if (!selected.length || selected.length > 4096) {
    return undefined;
  }
  const sizes = await options.git.require(
    options.repoRoot,
    ["cat-file", "--batch-check=%(objectsize)"],
    {
      ...options.gitOptions,
      env: { GIT_NO_LAZY_FETCH: "1" },
      input: `${selected.map((entry) => entry.oid).join("\n")}\n`,
    },
  );
  const bytes = sizes.split("\n").map(Number);
  if (
    bytes.length !== selected.length ||
    bytes.some((size) => !Number.isSafeInteger(size) || size < 0) ||
    bytes.reduce((total, size) => total + size, 0) > 8 * 1024 ** 2
  ) {
    return undefined;
  }
  return selected.map((entry) => entry.path);
}

/** Materialize immutable prompt inputs; registration and rollback remain with the checkout owner. */
export async function prepareWorktreePromptFiles(
  options: CheckoutSource & {
    destination: string;
    checkoutOptions: GitCommandOptions;
    onMaterializationStart: () => void;
  },
): Promise<boolean> {
  const paths = await promptPaths(options);
  if (!paths) {
    return false;
  }
  options.onMaterializationStart();
  await options.git.require(
    options.destination,
    ["read-tree", "--no-recurse-submodules", options.commit],
    options.checkoutOptions,
  );
  const attributes = await options.git.worker.buffered(
    options.destination,
    ["check-attr", "--cached", "--all", "-z", "--stdin"],
    { ...options.gitOptions, input: `${paths.join("\0")}\0`, maxOutputBytes: 1024 ** 2 },
  );
  const fields = splitNullBuffer(attributes.stdout);
  const safeAttributes =
    attributes.code === 0 &&
    attributes.termination === "exit" &&
    fields.length % 3 === 0 &&
    fields.every(
      (field, index) =>
        index % 3 !== 1 ||
        /^(?:text|eol|diff|merge|linguist-[a-z-]+)$/u.test(field.toString("utf8")),
    );
  if (!safeAttributes) {
    return false;
  }
  const attributeFiles = paths
    .filter((name) => path.posix.basename(name) === ".gitattributes")
    .toSorted((a, b) => a.split("/").length - b.split("/").length);
  const files = paths.filter((name) => path.posix.basename(name) !== ".gitattributes");
  // Seed attributes first, then cache file stats so full checkout preserves prompt files.
  for (const batch of [attributeFiles, files]) {
    if (batch.length) {
      await options.git.require(
        options.destination,
        ["checkout-index", "--index", "-z", "--stdin"],
        {
          ...options.checkoutOptions,
          input: `${batch.join("\0")}\0`,
        },
      );
    }
  }
  return true;
}
