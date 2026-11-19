import fs from "node:fs/promises";
import path from "node:path";
import { canonicalPathFromExistingAncestor } from "@openclaw/fs-safe/advanced";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { parseBunCliLauncher, renderBunCliLauncher } from "../../scripts/lib/bun-cli-launcher.mjs";
import { ignoreMissingPath as ignoreMissingUpdateCandidateFile } from "./errno.js";
import { hasErrnoCode } from "./errors.js";
import { isPathInside } from "./path-guards.js";
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

// Older pnpm shims write `"$basedir/target"`; current ones (seen from 11.28 and 12.21)
// write `"$basedir"/'target'`, a single-quoted shell word where `'` is spelled `'\''`.
const launcherRelativePath =
  /(\$(?:basedir_abs|basedir_win|basedir)(?:"[/\\]'|[/\\])|%~dp0\\)([^"\r\n]+)/gu;
const ESCAPED_QUOTE = "'\\''";

/** Split a matched reference into its decoded directory-relative target and the text after it. */
function splitLauncherReference(prefix: string, reference: string): [string, string] {
  if (!prefix.endsWith("'")) {
    return [reference, ""];
  }
  let target = "";
  for (let index = 0; index < reference.length;) {
    const quote = reference.indexOf("'", index);
    if (quote < 0) {
      return [reference, ""];
    }
    target += reference.slice(index, quote);
    if (!reference.startsWith(ESCAPED_QUOTE, quote)) {
      return [target, reference.slice(quote)];
    }
    target += "'";
    index = quote + ESCAPED_QUOTE.length;
  }
  return [reference, ""];
}

/**
 * Replace an absolute path prefix, spelling a destination `'` as `'\''` where the
 * occurrence sits inside a single-quoted shell word (pnpm's NODE_PATH export).
 */
function replaceShellPath(content: string, source: string, destination: string): string {
  if (!destination.includes("'")) {
    return content.replaceAll(source, destination);
  }
  return content
    .split("\n")
    .map((line) => {
      let result = "";
      let quoted = false;
      for (let index = 0; index < line.length;) {
        if (!line.startsWith("#") && line.startsWith(source, index)) {
          result += quoted ? destination.replaceAll("'", ESCAPED_QUOTE) : destination;
          index += source.length;
          continue;
        }
        if (line[index] === "\\" && !quoted) {
          result += line.slice(index, index + 2);
          index += 2;
          continue;
        }
        if (line[index] === "'") {
          quoted = !quoted;
        }
        result += line[index];
        index += 1;
      }
      // Comments (the cmd-shim-target record) keep the literal path.
      return line.startsWith("#") ? line.replaceAll(source, destination) : result;
    })
    .join("\n");
}

/** Encode a relative target for the reference form it came from. */
function encodeLauncherReference(prefix: string, target: string): string {
  return prefix.endsWith("'") ? target.replaceAll("'", ESCAPED_QUOTE) : target;
}

/** The entry paths a launcher file executes, resolved the way its shell resolves them. */
export async function resolveRuntimeLauncherTargets(
  file: string,
  entryName: string,
  knownContent?: string,
): Promise<string[]> {
  const content = knownContent ?? (await fs.readFile(file, "utf8"));
  const bunLauncher = parseBunCliLauncher(content);
  const base = content.includes("$basedir_abs")
    ? await fs.realpath(path.dirname(file))
    : path.dirname(file);
  return bunLauncher
    ? [bunLauncher.entryPath]
    : [...content.matchAll(launcherRelativePath)]
        .map((match) => splitLauncherReference(match[1]!, match[2]!)[0].replaceAll("\\", path.sep))
        .filter((relative) => path.basename(relative) === entryName && !/[$%]/u.test(relative))
        .map((relative) => path.resolve(base, relative));
}

/** Check executable references, not cmd-shim-target metadata that may already be correct. */
export async function verifyRuntimeLauncher(file: string, entryName: string): Promise<void> {
  if ((await fs.lstat(file)).isSymbolicLink()) {
    await fs.stat(file);
    return;
  }
  const targets = await resolveRuntimeLauncherTargets(file, entryName);
  if (targets.length === 0) {
    throw new Error("Cannot resolve the launcher's executable target");
  }
  for (const target of new Set(targets)) {
    await fs.access(target);
  }
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
    // pnpm cmd-shim uses these directory-relative references on sh, cmd and PowerShell.
    // Resolve them before changing the directory; absolute store/runtime paths stay external.
    const sourceDir = path.dirname(sourceFile);
    const destinationDir = path.dirname(destinationFile);
    // pnpm 12 resolves the bin directory physically, including for not-yet-published groups.
    const shellBase = original.includes("$basedir_abs")
      ? await canonicalPathFromExistingAncestor(destinationDir)
      : destinationDir;
    content = original.replace(launcherRelativePath, (match, prefix: string, reference: string) => {
      const [relative, rest] = splitLauncherReference(prefix, reference);
      if (/[$%]/u.test(relative)) {
        return match;
      }
      const destinationBase = prefix.startsWith("$basedir") ? shellBase : destinationDir;
      const sourceTarget = path.resolve(sourceDir, relative.replaceAll("\\", path.sep));
      const target = isPathInside(sourceDir, sourceTarget)
        ? path.resolve(destinationBase, path.relative(sourceDir, sourceTarget))
        : relocateRuntimePath(sourceTarget, prepared);
      const replacement = path.relative(destinationBase, target);
      return `${prefix}${prefix.startsWith("%") ? replacement.replaceAll("/", "\\") : encodeLauncherReference(prefix, replacement.replaceAll("\\", "/"))}${rest}`;
    });
    for (const relocation of prepared.rules) {
      for (const sourceRoot of [relocation.sourceRoot, ...(relocation.sourceAliases ?? [])]) {
        // NODE_PATH and the shim's target comment can carry absolute project paths.
        content = replaceShellPath(
          content,
          `${sourceRoot}${path.sep}`,
          `${relocation.destinationRoot}${path.sep}`,
        );
        if (path.sep === "\\") {
          content = content.replaceAll(
            `${sourceRoot.replaceAll("\\", "/")}/`,
            `${relocation.destinationRoot.replaceAll("\\", "/")}/`,
          );
        }
      }
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
