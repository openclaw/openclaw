import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { hasErrnoCode } from "./errno.js";
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

export async function relocateRuntimeSymlink(
  file: string,
  sourceFile: string,
  destinationFile: string,
  relocations: RuntimeRelocations,
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
  const type =
    process.platform === "win32" && (await fs.stat(sourceFile)).isDirectory() ? "junction" : "file";
  await fs.unlink(file);
  await fs.symlink(type === "junction" ? target : replacement, file, type);
}

export async function relocateRuntimeLauncher(
  file: string,
  sourceFile: string,
  destinationFile: string,
  relocations: RuntimeRelocations,
): Promise<void> {
  const prepared = prepareRuntimeRelocations(relocations);
  const original = await fs.readFile(file, "utf8");
  // pnpm cmd-shim uses these directory-relative references on sh, cmd and PowerShell.
  // Resolve them before changing the directory; absolute store/runtime paths stay external.
  let content = original.replace(
    /(\$(?:basedir|basedir_win)[/\\]|%~dp0\\)([^"\r\n]+)/gu,
    (match, prefix: string, relative: string) => {
      if (/[$%]/u.test(relative)) {
        return match;
      }
      const sourceTarget = path.resolve(
        path.dirname(sourceFile),
        relative.replaceAll("\\", path.sep),
      );
      const target = isPathInside(path.dirname(sourceFile), sourceTarget)
        ? path.resolve(
            path.dirname(destinationFile),
            path.relative(path.dirname(sourceFile), sourceTarget),
          )
        : relocateRuntimePath(sourceTarget, prepared);
      const replacement = path.relative(path.dirname(destinationFile), target);
      return `${prefix}${prefix.startsWith("%") ? replacement.replaceAll("/", "\\") : replacement.replaceAll("\\", "/")}`;
    },
  );
  for (const relocation of prepared.rules) {
    for (const sourceRoot of [relocation.sourceRoot, ...(relocation.sourceAliases ?? [])]) {
      // NODE_PATH and the shim's target comment can carry absolute project paths.
      content = content.replaceAll(
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
  if (content !== original) {
    await fs.writeFile(file, content);
  }
}

export async function readRuntimeModulesManifest(file: string) {
  const original = await fs.readFile(file, "utf8").catch((error: unknown) => {
    if (hasErrnoCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  });
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
    await fs.writeFile(file, content);
  }
}

/** Relocate one admitted entry without traversing neighboring private files. */
export async function relocateRuntimeEntry(
  file: string,
  sourceFile: string,
  destinationFile: string,
  kind: "file" | "symlink",
  relocations: RuntimeRelocations,
): Promise<void> {
  if (kind === "symlink") {
    await relocateRuntimeSymlink(file, sourceFile, destinationFile, relocations);
  } else if (path.basename(file) === ".modules.yaml") {
    await relocateModulesManifest(file, sourceFile, destinationFile, relocations);
  } else if (path.basename(path.dirname(file)) === ".bin" && !file.endsWith(".exe")) {
    await relocateRuntimeLauncher(file, sourceFile, destinationFile, relocations);
  }
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
    const sourceFile = path.join(sourceRoot, entry.name);
    const destinationFile = path.join(destinationRoot, entry.name);
    if (entry.isDirectory()) {
      await relocateRuntimeTree(file, sourceFile, destinationFile, prepared);
    } else if (entry.isSymbolicLink()) {
      await relocateRuntimeEntry(file, sourceFile, destinationFile, "symlink", prepared);
    } else if (entry.isFile()) {
      await relocateRuntimeEntry(file, sourceFile, destinationFile, "file", prepared);
    }
  }
}
