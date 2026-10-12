import path from "node:path";
import type { GitCommandOptions } from "../../infra/git-exec.js";
import type { WorktreeGitPolicy } from "./checkout-git-config.js";
import { resolveWorktreeCheckoutKey } from "./checkout-policy-key.js";
import { parseGitTreePaths, splitNullBuffer } from "./git-path-inventory.js";
import { commandError } from "./git.js";

type CheckoutSource = {
  repoRoot: string;
  commonDir: string;
  destination: string;
  commit: string;
  gitOptions: GitCommandOptions;
  git: WorktreeGitPolicy;
};

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
    // Personal bootstrap reads users/<canonical profile>/USER.md; include its attribute ancestry.
    const personalBootstrap =
      normalized === "users/.gitattributes" ||
      /^users\/[a-z0-9][a-z0-9_-]{0,127}\/(?:user\.md|\.gitattributes)$/u.test(normalized);
    if (
      !name.includes("/") ||
      /^(?:\.agents|\.codex|skills)\//u.test(normalized) ||
      personalBootstrap
    ) {
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
