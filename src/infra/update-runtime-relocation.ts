import fs from "node:fs/promises";
import path from "node:path";
import { canonicalPathFromExistingAncestor } from "@openclaw/fs-safe/advanced";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { parseBunCliLauncher, renderBunCliLauncher } from "../../scripts/lib/bun-cli-launcher.mjs";
import { ignoreMissingPath as ignoreMissingUpdateCandidateFile } from "./errno.js";
import { hasErrnoCode } from "./errors.js";
import { isPathInside } from "./path-guards.js";
import {
  hasInnerExpansion,
  joinLeadingExpansion,
  readShellLauncherWords,
  rewriteShellLauncher,
  splitLeadingExpansion,
} from "./update-launcher-shell.js";
import { createRuntimePathLookup } from "./update-runtime-path-index.js";

export type RuntimeRelocation = {
  sourceRoot: string;
  destinationRoot: string;
  sourceAliases?: string[];
};

type PreparedRuntimeRelocations = {
  rules: readonly RuntimeRelocation[];
  find: (value: string) => { root: string; relocation: RuntimeRelocation } | undefined;
};
type RuntimeRelocations = readonly RuntimeRelocation[] | PreparedRuntimeRelocations;

// Windows cmd-shim (`%~dp0\target`) and PowerShell (`$basedir/target`) references.
const windowsLauncherRelativePath =
  /(\$(?:basedir_abs|basedir_win|basedir)[/\\]|%~dp0\\)([^"\r\n]+)/gu;
const SHELL_BASEDIR = new Set(["basedir", "basedir_abs", "basedir_win"]);

// pnpm 11+ shims define `basedir_abs` with `pwd -P` and derive `basedir` from it, so every
// basedir word resolves physically. Older shims never assign it; a path that merely
// contains the name (NODE_PATH, the target comment) is not a definition.
function usesPhysicalBasedir(content: string): boolean {
  return /^[ \t]*basedir_abs=/mu.test(content);
}

/**
 * The path a POSIX shim's `$basedir` words resolve from: the physical bin directory when the
 * shim defines `basedir_abs`, else the directory as the shell reached it. Detection and
 * repair use this one answer, so a symlinked bin directory cannot make them disagree.
 */
export async function resolveLauncherShellFile(file: string, content: string): Promise<string> {
  return usesPhysicalBasedir(content)
    ? path.join(await fs.realpath(path.dirname(file)), path.basename(file))
    : file;
}

function isWindowsLauncher(file: string): boolean {
  return /\.(?:cmd|ps1)$/iu.test(file);
}

/** Directory-relative targets of `$basedir...` words in a POSIX shell launcher. */
function readShellRelativeTargets(content: string): string[] {
  const targets: string[] = [];
  for (const word of readShellLauncherWords(content)) {
    const leading = splitLeadingExpansion(word.value);
    if (
      leading &&
      SHELL_BASEDIR.has(leading.name) &&
      leading.rest.startsWith("/") &&
      !hasInnerExpansion(leading.rest)
    ) {
      targets.push(leading.rest.slice(1));
    }
  }
  return targets;
}

/** The entry paths a launcher file executes, resolved the way its shell resolves them. */
export async function resolveRuntimeLauncherTargets(
  file: string,
  entryName: string,
  knownContent?: string,
): Promise<string[]> {
  const content = knownContent ?? (await fs.readFile(file, "utf8"));
  const bunLauncher = parseBunCliLauncher(content);
  if (bunLauncher) {
    return [bunLauncher.entryPath];
  }
  const base = path.dirname(await resolveLauncherShellFile(file, content));
  const relatives = isWindowsLauncher(file)
    ? [...content.matchAll(windowsLauncherRelativePath)]
        .map((match) => match[2]!.replaceAll("\\", path.sep))
        .filter((relative) => !/[$%]/u.test(relative))
    : readShellRelativeTargets(content);
  return relatives
    .filter((relative) => path.basename(relative) === entryName)
    .map((relative) => path.resolve(base, relative));
}

/** Check executable references, not cmd-shim-target metadata that may already be correct. */
export async function verifyRuntimeLauncher(
  file: string,
  entryName: string,
): Promise<"verified" | "unknown-format"> {
  if ((await fs.lstat(file)).isSymbolicLink()) {
    await fs.stat(file);
    return "verified";
  }
  const targets = await resolveRuntimeLauncherTargets(file, entryName);
  // A format this reader does not recognize proves nothing either way.
  if (targets.length === 0) {
    return "unknown-format";
  }
  for (const target of new Set(targets)) {
    await fs.access(target);
  }
  return "verified";
}

/** Prepare once for the whole tree; never cache mutable filesystem observations. */
export function prepareRuntimeRelocations(
  relocations: RuntimeRelocations,
): PreparedRuntimeRelocations {
  if ("rules" in relocations) {
    return relocations;
  }
  return {
    rules: relocations,
    find: createRuntimePathLookup(
      relocations.flatMap((relocation) =>
        [relocation.sourceRoot, ...(relocation.sourceAliases ?? [])].map(
          (root) => [root, { root, relocation }] as const,
        ),
      ),
    ),
  };
}

export function relocateRuntimePath(value: string, relocations: RuntimeRelocations): string {
  if ("rules" in relocations) {
    const match = relocations.find(value);
    return match
      ? path.join(match.relocation.destinationRoot, path.relative(match.root, value))
      : value;
  }
  // One-shot callers generally rebase a single root; only tree operations need
  // an index. Preserve their direct lookup without allocating a prepared plan.
  for (const relocation of relocations) {
    const root = [relocation.sourceRoot, ...(relocation.sourceAliases ?? [])].find((candidate) =>
      isPathInside(candidate, value),
    );
    if (root) {
      return path.join(relocation.destinationRoot, path.relative(root, value));
    }
  }
  return value;
}

async function isOptionalPackageLink(file: string): Promise<boolean> {
  const parent = path.dirname(file);
  const modules = path.basename(parent).startsWith("@") ? path.dirname(parent) : parent;
  if (path.basename(modules) !== "node_modules") {
    return false;
  }
  const name = path.relative(modules, file).split(path.sep).join("/");
  const owner = path.dirname(modules);
  const roots = [owner];
  if (path.basename(path.dirname(owner)) === ".pnpm") {
    // pnpm puts a package's dependencies beside its payload in the virtual store.
    // Inspect only real payload directories, never follow sibling dependency links.
    for (const entry of await fs.readdir(modules, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) {
        continue;
      }
      const directory = path.join(modules, entry.name);
      if (entry.name.startsWith("@")) {
        for (const child of await fs.readdir(directory, { withFileTypes: true })) {
          if (child.isDirectory()) {
            roots.push(path.join(directory, child.name));
          }
        }
      } else {
        roots.push(directory);
      }
    }
  }
  for (const root of roots) {
    const content = await fs
      .readFile(path.join(root, "package.json"), "utf8")
      .catch(ignoreMissingUpdateCandidateFile);
    const manifest: unknown = content === undefined ? undefined : JSON.parse(content);
    if (
      isRecord(manifest) &&
      isRecord(manifest.optionalDependencies) &&
      typeof manifest.optionalDependencies[name] === "string"
    ) {
      return true;
    }
  }
  return false;
}

export async function relocateRuntimeSymlink(
  file: string,
  sourceFile: string,
  destinationFile: string,
  relocations: RuntimeRelocations,
  assertBeforeMutation?: () => void,
): Promise<void> {
  const link = await fs.readlink(file);
  const target = relocateRuntimePath(path.resolve(path.dirname(sourceFile), link), relocations);
  const replacement = path.isAbsolute(link)
    ? target
    : path.relative(path.dirname(destinationFile), target) || ".";
  if (replacement === link) {
    return;
  }
  // Copied relative links still describe their original location. Inspect that
  // source before rebinding; Windows junctions require the final absolute target.
  let type: "junction" | "file" = "file";
  if (process.platform === "win32") {
    try {
      type = (await fs.stat(sourceFile)).isDirectory() ? "junction" : "file";
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT") || !(await isOptionalPackageLink(sourceFile))) {
        throw error;
      }
      // Platform-filtered optional payloads may leave dangling pnpm links.
      // Keep them absent in the copy instead of publishing a stale staging path.
      assertBeforeMutation?.();
      await fs.unlink(file);
      return;
    }
  }
  assertBeforeMutation?.();
  await fs.unlink(file);
  assertBeforeMutation?.();
  await fs.symlink(type === "junction" ? target : replacement, file, type);
}

export async function relocateRuntimeLauncher(
  file: string,
  sourceFile: string,
  destinationFile: string,
  relocations: RuntimeRelocations,
  assertBeforeMutation?: () => void,
): Promise<void> {
  const prepared = prepareRuntimeRelocations(relocations);
  const original = await fs.readFile(file, "utf8");
  const bunLauncher = parseBunCliLauncher(original);
  let content: string;
  if (bunLauncher) {
    content = renderBunCliLauncher({
      bunPath: relocateRuntimePath(bunLauncher.bunPath, prepared),
      entryPath: relocateRuntimePath(bunLauncher.entryPath, prepared),
    });
  } else {
    // pnpm cmd-shim uses directory-relative references on sh, cmd and PowerShell.
    // Resolve them before changing the directory; absolute store/runtime paths stay external.
    const sourceDir = path.dirname(sourceFile);
    const destinationDir = path.dirname(destinationFile);
    // pnpm 12 resolves the bin directory physically, including for not-yet-published groups.
    const shellBase = usesPhysicalBasedir(original)
      ? await canonicalPathFromExistingAncestor(destinationDir)
      : destinationDir;
    // A launcher rewritten in place (repair) does not move with its directory, so a
    // relocated root inside that directory (pnpm's home-level shim) still applies.
    const inPlace = sourceDir === destinationDir;
    const relocateRelative = (relative: string, destinationBase: string) => {
      const sourceTarget = path.resolve(sourceDir, relative);
      const relocated = relocateRuntimePath(sourceTarget, prepared);
      const target =
        isPathInside(sourceDir, sourceTarget) && !(inPlace && relocated !== sourceTarget)
          ? path.resolve(destinationBase, path.relative(sourceDir, sourceTarget))
          : relocated;
      return path.relative(destinationBase, target);
    };
    // Windows launchers can also spell project paths with forward slashes.
    const relocateAbsolute = (value: string, forwardSlashes = false) => {
      let next = value;
      const spell = (root: string) => (forwardSlashes ? root.replaceAll("\\", "/") : root);
      const separator = forwardSlashes ? "/" : path.sep;
      for (const relocation of prepared.rules) {
        for (const sourceRoot of [relocation.sourceRoot, ...(relocation.sourceAliases ?? [])]) {
          // A callback keeps `$'`, `$&` and similar in a path literal, not replacement tokens.
          const destination = `${spell(relocation.destinationRoot)}${separator}`;
          next = next.replaceAll(`${spell(sourceRoot)}${separator}`, () => destination);
        }
      }
      return next;
    };
    const relocateAbsoluteEverySpelling = (value: string) =>
      path.sep === "\\" ? relocateAbsolute(relocateAbsolute(value), true) : relocateAbsolute(value);
    if (isWindowsLauncher(destinationFile) || isWindowsLauncher(file)) {
      content = original.replace(
        windowsLauncherRelativePath,
        (match, prefix: string, relative: string) => {
          if (/[$%]/u.test(relative)) {
            return match;
          }
          const destinationBase = prefix.startsWith("$basedir") ? shellBase : destinationDir;
          const replacement = relocateRelative(
            relative.replaceAll("\\", path.sep),
            destinationBase,
          );
          return `${prefix}${prefix.startsWith("%") ? replacement.replaceAll("/", "\\") : replacement.replaceAll("\\", "/")}`;
        },
      );
      content = relocateAbsoluteEverySpelling(content);
    } else {
      // Rewrite each shell word by value, so every quoting form pnpm emits (including
      // `'\''` for an apostrophe and paths containing `"`, `$` or `\\`) is handled alike.
      content = rewriteShellLauncher(
        original,
        (word) => {
          const leading = splitLeadingExpansion(word.value);
          if (
            leading &&
            SHELL_BASEDIR.has(leading.name) &&
            leading.rest.startsWith("/") &&
            !hasInnerExpansion(leading.rest)
          ) {
            const replacement = relocateRelative(leading.rest.slice(1), shellBase);
            // A POSIX file name may contain `\`; only Windows paths use it as a separator.
            const posix = path.sep === "\\" ? replacement.replaceAll("\\", "/") : replacement;
            return joinLeadingExpansion(leading.name, `/${posix}`);
          }
          // NODE_PATH and other absolute project paths.
          return relocateAbsoluteEverySpelling(word.value);
        },
        // The cmd-shim-target record is a literal path in a comment.
        (line) => relocateAbsoluteEverySpelling(line),
      );
    }
  }
  if (content !== original) {
    assertBeforeMutation?.();
    await fs.writeFile(file, content);
  }
}

export async function readRuntimeModulesManifest(file: string) {
  const original = await fs
    .readFile(file, "utf8")
    .catch((error: unknown) => ignoreMissingUpdateCandidateFile(error) ?? null);
  if (original === null) {
    return null;
  }
  const manifest: unknown = parseYaml(original);
  return isRecord(manifest) ? { original, manifest } : null;
}

async function relocateModulesManifest(
  file: string,
  sourceFile: string,
  destinationFile: string,
  relocations: RuntimeRelocations,
  assertBeforeMutation?: () => void,
): Promise<void> {
  const contents = await readRuntimeModulesManifest(file);
  if (!contents) {
    return;
  }
  const { original, manifest } = contents;
  let changed = false;
  // pnpm writes relative virtual-store paths on POSIX and absolute ones on Windows.
  // Resolve from the original manifest so external stores keep their exact identity.
  for (const key of ["virtualStoreDir", "storeDir"]) {
    const value = manifest[key];
    if (typeof value === "string") {
      const target = relocateRuntimePath(
        path.resolve(path.dirname(sourceFile), value),
        relocations,
      );
      const replacement = path.isAbsolute(value)
        ? target
        : path.relative(path.dirname(destinationFile), target);
      if (replacement !== value) {
        manifest[key] = replacement;
        changed = true;
      }
    }
  }
  if (changed) {
    const content = original.trimStart().startsWith("{")
      ? `${JSON.stringify(manifest, null, 2)}\n`
      : stringifyYaml(manifest);
    assertBeforeMutation?.();
    await fs.writeFile(file, content);
  }
}

/** Files rewritten during relocation must never share an inode with the live package. */
export function resolveRuntimeFileRelocator(file: string) {
  if (path.basename(file) === ".modules.yaml") {
    return relocateModulesManifest;
  }
  if (path.basename(path.dirname(file)) === ".bin" && !file.endsWith(".exe")) {
    return relocateRuntimeLauncher;
  }
  return undefined;
}

/** Rebind copied entries only; following a store symlink would mutate external data. */
export async function relocateRuntimeTree(
  root: string,
  sourceRoot: string,
  destinationRoot: string,
  relocations: RuntimeRelocations,
): Promise<void> {
  const prepared = prepareRuntimeRelocations(relocations);
  if ((await fs.lstat(root)).isSymbolicLink()) {
    await relocateRuntimeSymlink(root, sourceRoot, destinationRoot, prepared);
    return;
  }
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    const relocate = entry.isDirectory()
      ? relocateRuntimeTree
      : entry.isSymbolicLink()
        ? relocateRuntimeSymlink
        : entry.isFile()
          ? resolveRuntimeFileRelocator(file)
          : undefined;
    if (relocate) {
      await relocate(
        file,
        path.join(sourceRoot, entry.name),
        path.join(destinationRoot, entry.name),
        prepared,
      );
    }
  }
}
