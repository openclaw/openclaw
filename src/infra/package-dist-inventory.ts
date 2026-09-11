// Collects and verifies package dist inventory metadata.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { sortUniqueStrings } from "@openclaw/normalization-core/string-normalization";
import pLimit, { type LimitFunction } from "p-limit";
import { isLocalBuildMetadataDistPath } from "../../scripts/lib/local-build-metadata-paths.mts";
import {
  PACKAGE_DIST_CONTENT_INVENTORY_RELATIVE_PATH,
  parsePackageDistContentInventory,
  comparePackageDistContentInventory,
  type PackageDistContentInventoryEntry,
} from "../../scripts/lib/package-dist-inventory-contract.mts";
import { escapeRegExp } from "../shared/regexp.js";
import { isMissingPathError } from "./errno.js";
import { root as openFsRoot } from "./fs-safe.js";
import { readJsonIfExists } from "./json-files.js";
export {
  PACKAGE_DIST_CONTENT_INVENTORY_RELATIVE_PATH,
  type PackageDistContentInventoryEntry,
} from "../../scripts/lib/package-dist-inventory-contract.mts";

export const PACKAGE_DIST_INVENTORY_RELATIVE_PATH = "dist/postinstall-inventory.json";
const PACKAGE_DIST_INVENTORY_SCAN_CONCURRENCY = 32;
const LEGACY_QA_CHANNEL_DIR = ["qa", "channel"].join("-");
const LEGACY_QA_LAB_DIR = ["qa", "lab"].join("-");
const OMITTED_QA_EXTENSION_PREFIXES = [
  `dist/extensions/${LEGACY_QA_CHANNEL_DIR}/`,
  `dist/extensions/${LEGACY_QA_LAB_DIR}/`,
];
const OMITTED_PRIVATE_QA_PLUGIN_SDK_PREFIXES = [
  `dist/plugin-sdk/extensions/${LEGACY_QA_CHANNEL_DIR}/`,
  `dist/plugin-sdk/extensions/${LEGACY_QA_LAB_DIR}/`,
];
const OMITTED_PRIVATE_QA_PLUGIN_SDK_FILES = new Set([
  `dist/plugin-sdk/${LEGACY_QA_CHANNEL_DIR}.d.ts`,
  `dist/plugin-sdk/${LEGACY_QA_CHANNEL_DIR}.js`,
  `dist/plugin-sdk/${LEGACY_QA_CHANNEL_DIR}-protocol.d.ts`,
  `dist/plugin-sdk/${LEGACY_QA_CHANNEL_DIR}-protocol.js`,
  `dist/plugin-sdk/${LEGACY_QA_LAB_DIR}.d.ts`,
  `dist/plugin-sdk/${LEGACY_QA_LAB_DIR}.js`,
  "dist/plugin-sdk/qa-runtime.d.ts",
  "dist/plugin-sdk/qa-runtime.js",
  `dist/plugin-sdk/src/plugin-sdk/${LEGACY_QA_CHANNEL_DIR}.d.ts`,
  `dist/plugin-sdk/src/plugin-sdk/${LEGACY_QA_CHANNEL_DIR}-protocol.d.ts`,
  `dist/plugin-sdk/src/plugin-sdk/${LEGACY_QA_LAB_DIR}.d.ts`,
  "dist/plugin-sdk/src/plugin-sdk/qa-runtime.d.ts",
]);
// The build keeps source-shaped SDK declarations for local boundary projects,
// but the npm package ships flat declarations and must not inventory the old tree.
const OMITTED_DEEP_PLUGIN_SDK_DECLARATION_PREFIX = "dist/plugin-sdk/src/";
const OMITTED_PRIVATE_QA_DIST_PREFIXES = ["dist/qa-runtime-"];
const OMITTED_PLUGIN_SDK_TEST_FILES = new Set([
  "dist/plugin-sdk/agent-runtime-test-contracts.d.ts",
  "dist/plugin-sdk/agent-runtime-test-contracts.js",
  "dist/plugin-sdk/channel-contract-testing.d.ts",
  "dist/plugin-sdk/channel-contract-testing.js",
  "dist/plugin-sdk/channel-target-testing.d.ts",
  "dist/plugin-sdk/channel-target-testing.js",
  "dist/plugin-sdk/channel-test-helpers.d.ts",
  "dist/plugin-sdk/channel-test-helpers.js",
  "dist/plugin-sdk/plugin-test-api.d.ts",
  "dist/plugin-sdk/plugin-test-api.js",
  "dist/plugin-sdk/plugin-test-contracts.d.ts",
  "dist/plugin-sdk/plugin-test-contracts.js",
  "dist/plugin-sdk/plugin-test-runtime.d.ts",
  "dist/plugin-sdk/plugin-test-runtime.js",
  "dist/plugin-sdk/provider-http-test-mocks.d.ts",
  "dist/plugin-sdk/provider-http-test-mocks.js",
  "dist/plugin-sdk/provider-test-contracts.d.ts",
  "dist/plugin-sdk/provider-test-contracts.js",
  "dist/plugin-sdk/test-env.d.ts",
  "dist/plugin-sdk/test-env.js",
  "dist/plugin-sdk/test-fixtures.d.ts",
  "dist/plugin-sdk/test-fixtures.js",
  "dist/plugin-sdk/test-live.d.ts",
  "dist/plugin-sdk/test-live.js",
  "dist/plugin-sdk/test-live-auth.d.ts",
  "dist/plugin-sdk/test-live-auth.js",
  "dist/plugin-sdk/test-media-generation.d.ts",
  "dist/plugin-sdk/test-media-generation.js",
  "dist/plugin-sdk/test-media-understanding.d.ts",
  "dist/plugin-sdk/test-media-understanding.js",
  "dist/plugin-sdk/test-node-mocks.d.ts",
  "dist/plugin-sdk/test-node-mocks.js",
]);
const OMITTED_PLUGIN_SDK_TEST_PREFIXES = [
  "dist/plugin-sdk/src/agents/test-helpers/",
  "dist/plugin-sdk/src/plugin-sdk/test-helpers/",
  "dist/plugin-sdk/src/test-helpers/",
  "dist/plugin-sdk/src/test-utils/",
];
const OMITTED_DIST_SUBTREE_PATTERNS = [
  /^dist\/extensions\/node_modules(?:\/|$)/u,
  /^dist\/extensions\/[^/]+\/node_modules(?:\/|$)/u,
  /^dist\/plugin-sdk\/src(?:\/|$)/u,
  new RegExp(`^dist/plugin-sdk/extensions/${LEGACY_QA_CHANNEL_DIR}(?:/|$)`, "u"),
  new RegExp(`^dist/plugin-sdk/extensions/${LEGACY_QA_LAB_DIR}(?:/|$)`, "u"),
] as const;
type PackageDistExclusionRules = {
  includePackageExcludedFiles?: boolean;
  files: ReadonlySet<string>;
  prefixes: readonly string[];
  patterns: readonly RegExp[];
};

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, "/");
}
function splitRelativePath(relativePath: string): string[] {
  return normalizeRelativePath(relativePath).split("/");
}

function isLegacyPluginDependencyDirPath(relativePath: string): boolean {
  const parts = splitRelativePath(relativePath);
  if (parts[0]?.toLowerCase() !== "dist" || parts[1]?.toLowerCase() !== "extensions") {
    return false;
  }

  const rootDependencyDir = parts[2] ?? "";
  if (rootDependencyDir.toLowerCase() === "node_modules") {
    return true;
  }

  const pluginDependencyDir = parts[3] ?? "";
  return pluginDependencyDir.toLowerCase() === "node_modules";
}

function compilePackageFilesExclusionPattern(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        if (pattern[index + 2] === "/") {
          source += "(?:[^/]+/)*";
          index += 2;
        } else {
          source += ".*";
          index += 1;
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    source += escapeRegExp(char ?? "");
  }
  source += "$";
  return new RegExp(source, "u");
}

function collectPackageDistExclusionRules(rootPackageJson: unknown): PackageDistExclusionRules {
  if (!rootPackageJson || typeof rootPackageJson !== "object") {
    return { files: new Set(), prefixes: [], patterns: [] };
  }
  const files = (rootPackageJson as { files?: unknown }).files;
  if (!Array.isArray(files)) {
    return { files: new Set(), prefixes: [], patterns: [] };
  }
  const excludedFiles = new Set<string>();
  const excludedPrefixes = new Set<string>();
  const excludedPatterns: RegExp[] = [];
  for (const entry of files) {
    if (typeof entry !== "string") {
      continue;
    }
    const normalized = normalizeRelativePath(entry);
    const match = /^!dist\/extensions\/([^/]+)\/\*\*$/u.exec(normalized);
    if (match?.[1]) {
      // Preserve literal root and descendant exclusion alongside package-file glob rules.
      excludedFiles.add(`dist/extensions/${match[1]}`);
      excludedPrefixes.add(`dist/extensions/${match[1]}/`);
    }
    if (!normalized.startsWith("!dist/")) {
      continue;
    }
    const excludedPath = normalized.slice(1);
    if (excludedPath.endsWith("/**") && !excludedPath.slice(0, -3).includes("*")) {
      excludedPrefixes.add(excludedPath.slice(0, -2));
    } else if (excludedPath.includes("*")) {
      excludedPatterns.push(compilePackageFilesExclusionPattern(excludedPath));
    } else {
      excludedFiles.add(excludedPath);
    }
  }
  return {
    files: excludedFiles,
    prefixes: [...excludedPrefixes].toSorted((left, right) => left.localeCompare(right)),
    patterns: excludedPatterns,
  };
}

function isOmittedPluginSdkTestPath(relativePath: string): boolean {
  return (
    OMITTED_PLUGIN_SDK_TEST_FILES.has(relativePath) ||
    OMITTED_PLUGIN_SDK_TEST_PREFIXES.some(
      (prefix) => relativePath === prefix.slice(0, -1) || relativePath.startsWith(prefix),
    )
  );
}

async function collectPackageDistExclusionRulesForRoot(
  packageRoot: string,
): Promise<PackageDistExclusionRules> {
  const packageJsonPath = path.join(packageRoot, "package.json");
  return collectPackageDistExclusionRules(await readJsonIfExists<unknown>(packageJsonPath));
}

function isPackageFilesExcludedDistPath(
  relativePath: string,
  exclusions: PackageDistExclusionRules,
): boolean {
  return (
    exclusions.files.has(relativePath) ||
    exclusions.prefixes.some((prefix) => relativePath.startsWith(prefix)) ||
    exclusions.patterns.some((pattern) => pattern.test(relativePath))
  );
}

function isPackagedDistPath(relativePath: string, rules: PackageDistExclusionRules): boolean {
  if (!relativePath.startsWith("dist/")) {
    return false;
  }
  if (rules.includePackageExcludedFiles) {
    return (
      relativePath !== PACKAGE_DIST_INVENTORY_RELATIVE_PATH &&
      !isLegacyPluginDependencyDirPath(relativePath)
    );
  }
  if (isPackageFilesExcludedDistPath(relativePath, rules)) {
    return false;
  }
  if (isLegacyPluginDependencyDirPath(relativePath)) {
    return false;
  }
  if (relativePath === PACKAGE_DIST_INVENTORY_RELATIVE_PATH) {
    return false;
  }
  if (isLocalBuildMetadataDistPath(relativePath)) {
    return false;
  }
  if (relativePath.endsWith(".map") && !rules.includePackageExcludedFiles) {
    return false;
  }
  if (relativePath === "dist/plugin-sdk/.tsbuildinfo") {
    return false;
  }
  if (isOmittedPluginSdkTestPath(relativePath)) {
    return false;
  }
  if (relativePath.startsWith(OMITTED_DEEP_PLUGIN_SDK_DECLARATION_PREFIX)) {
    return false;
  }
  if (
    OMITTED_PRIVATE_QA_PLUGIN_SDK_PREFIXES.some((prefix) => relativePath.startsWith(prefix)) ||
    OMITTED_PRIVATE_QA_PLUGIN_SDK_FILES.has(relativePath) ||
    OMITTED_PRIVATE_QA_DIST_PREFIXES.some((prefix) => relativePath.startsWith(prefix))
  ) {
    return false;
  }
  if (OMITTED_QA_EXTENSION_PREFIXES.some((prefix) => relativePath.startsWith(prefix))) {
    return false;
  }
  return true;
}

function isOmittedDistSubtree(relativePath: string, rules: PackageDistExclusionRules): boolean {
  if (rules.includePackageExcludedFiles) {
    return isLegacyPluginDependencyDirPath(relativePath);
  }
  return (
    // npm directory exclusions can select the root itself or its trailing-slash subtree.
    isPackageFilesExcludedDistPath(relativePath, rules) ||
    isPackageFilesExcludedDistPath(`${relativePath}/`, rules) ||
    isLegacyPluginDependencyDirPath(relativePath) ||
    isOmittedPluginSdkTestPath(relativePath) ||
    OMITTED_DIST_SUBTREE_PATTERNS.some((pattern) => pattern.test(relativePath))
  );
}

async function collectRelativeFiles(
  rootDir: string,
  baseDir: string,
  rules: PackageDistExclusionRules,
  fsLimit: LimitFunction,
  onDirectory?: (directoryPath: string) => Promise<void>,
): Promise<string[]> {
  const rootRelativePath = normalizeRelativePath(path.relative(baseDir, rootDir));
  if (rootRelativePath && isOmittedDistSubtree(rootRelativePath, rules)) {
    return [];
  }
  try {
    const rootStats = await fsLimit(() => fs.lstat(rootDir));
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      throw new Error(
        `Unsafe package dist path: ${normalizeRelativePath(path.relative(baseDir, rootDir))}`,
      );
    }
    await onDirectory?.(rootDir);
    const entries = await fsLimit(() => fs.readdir(rootDir, { withFileTypes: true }));
    const files = await Promise.all(
      entries.map(async (entry) => {
        const entryPath = path.join(rootDir, entry.name);
        const relativePath = normalizeRelativePath(path.relative(baseDir, entryPath));
        if (entry.isSymbolicLink()) {
          throw new Error(`Unsafe package dist path: ${relativePath}`);
        }
        if (entry.isDirectory()) {
          return await collectRelativeFiles(entryPath, baseDir, rules, fsLimit, onDirectory);
        }
        if (entry.isFile()) {
          return isPackagedDistPath(relativePath, rules) ? [relativePath] : [];
        }
        if (rules.includePackageExcludedFiles) {
          throw new Error(`Unsupported local package entry: ${relativePath}`);
        }
        return [];
      }),
    );
    return files.flat().toSorted((left, right) => left.localeCompare(right));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

/** Collects package dist files that should be present after install/update publication. */
export async function collectPackageDistInventory(
  packageRoot: string,
  options: {
    onDirectory?: (directoryPath: string) => Promise<void>;
    packageManifest?: unknown;
    includePackageExcludedFiles?: boolean;
  } = {},
): Promise<string[]> {
  const rules = options.includePackageExcludedFiles
    ? { ...collectPackageDistExclusionRules({}), includePackageExcludedFiles: true }
    : options.packageManifest === undefined
      ? await collectPackageDistExclusionRulesForRoot(packageRoot)
      : collectPackageDistExclusionRules(options.packageManifest);
  const fsLimit = pLimit(PACKAGE_DIST_INVENTORY_SCAN_CONCURRENCY);
  return await collectRelativeFiles(
    path.join(packageRoot, "dist"),
    packageRoot,
    rules,
    fsLimit,
    options.onDirectory,
  );
}

/** Reads an existing package dist inventory, returning null when the inventory is absent. */
export async function readPackageDistInventoryIfPresent(
  packageRoot: string,
): Promise<string[] | null> {
  const parsed = await readPackageDistJsonIfExists<unknown>(
    packageRoot,
    PACKAGE_DIST_INVENTORY_RELATIVE_PATH,
  );
  if (parsed === undefined) {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error(`Invalid package dist inventory at ${PACKAGE_DIST_INVENTORY_RELATIVE_PATH}`);
  }
  return sortUniqueStrings(parsed.map(normalizeRelativePath));
}

type PackageDistFsRoot = Awaited<ReturnType<typeof openFsRoot>>;

async function openPackageDistFsRootIfPresent(
  packageRoot: string,
): Promise<PackageDistFsRoot | null> {
  const packageFs = await openFsRoot(packageRoot, {
    hardlinks: "allow",
    nonBlockingRead: true,
    symlinks: "reject",
  });
  let distStats;
  try {
    distStats = await fs.lstat(path.join(packageFs.rootReal, "dist"));
  } catch (error) {
    if (isMissingPathError(error)) {
      return null;
    }
    throw error;
  }
  if (!distStats.isDirectory() || distStats.isSymbolicLink()) {
    throw new Error("Unsafe package dist path: dist");
  }
  return packageFs;
}

async function readPackageDistJsonIfExists<T>(
  packageRoot: string,
  relativePath: string,
): Promise<T | undefined> {
  const packageFs = await openPackageDistFsRootIfPresent(packageRoot);
  if (!packageFs) {
    return undefined;
  }
  try {
    return await packageFs.readJson<T>(relativePath, {
      hardlinks: "allow",
      maxBytes: 16 * 1024 * 1024,
      nonBlockingRead: true,
      symlinks: "reject",
    });
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  }
}

export async function collectPackageDistContentInventory(
  packageRoot: string,
  inventory?: string[],
): Promise<PackageDistContentInventoryEntry[]> {
  const files = (inventory ?? (await collectPackageDistInventory(packageRoot))).filter(
    (file) => file !== PACKAGE_DIST_CONTENT_INVENTORY_RELATIVE_PATH,
  );
  const packageFs = await openPackageDistFsRootIfPresent(packageRoot);
  if (!packageFs) {
    if (files.length === 0) {
      return [];
    }
    throw new Error("Unsafe package dist path: dist");
  }
  const fsLimit = pLimit(PACKAGE_DIST_INVENTORY_SCAN_CONCURRENCY);
  const entries = await Promise.all(
    files.map((relativePath) =>
      fsLimit(async () => {
        const current = await packageFs.read(relativePath, {
          hardlinks: "allow",
          maxBytes: Number.POSITIVE_INFINITY,
          nonBlockingRead: true,
          symlinks: "reject",
        });
        return {
          path: normalizeRelativePath(relativePath),
          sha256: createHash("sha256").update(current.buffer).digest("hex"),
          mode: current.stat.mode & 0o777,
          size: current.buffer.length,
        } satisfies PackageDistContentInventoryEntry;
      }),
    ),
  );
  return entries.toSorted((left, right) => left.path.localeCompare(right.path));
}

export async function readPackageDistContentInventoryIfPresent(
  packageRoot: string,
): Promise<PackageDistContentInventoryEntry[] | null> {
  const parsed = await readPackageDistJsonIfExists<unknown>(
    packageRoot,
    PACKAGE_DIST_CONTENT_INVENTORY_RELATIVE_PATH,
  );
  if (parsed !== undefined) {
    return parsePackageDistContentInventory(parsed);
  }
  // The filename inventory advertises the capability. No release-version guesses.
  const files = await readPackageDistInventoryIfPresent(packageRoot);
  if (files?.includes(PACKAGE_DIST_CONTENT_INVENTORY_RELATIVE_PATH)) {
    throw new Error(
      `missing package dist content inventory ${PACKAGE_DIST_CONTENT_INVENTORY_RELATIVE_PATH}`,
    );
  }
  return null;
}

export async function collectPackageDistContentInventoryErrors(
  packageRoot: string,
): Promise<string[]> {
  const expected = await readPackageDistContentInventoryIfPresent(packageRoot);
  if (expected === null) {
    return [];
  }
  return comparePackageDistContentInventory(
    expected,
    await collectPackageDistContentInventory(packageRoot),
  );
}
