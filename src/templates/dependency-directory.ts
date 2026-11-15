import { lstat, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { assertNoSymlinkParents } from "@openclaw/fs-safe/advanced";
import { tempWorkspace } from "@openclaw/fs-safe/temp";
import * as tar from "tar";
import { root as fsSafeRoot, walkDirectory } from "../infra/fs-safe.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { digestTemplateBytes, digestTemplateValue } from "./digest.js";
import { isSafeTemplateRelativePath, portableTemplatePathKey } from "./schema-portability.js";
import {
  MAX_MANAGED_FILE_BYTES,
  MAX_TEMPLATE_DIRECTORY_BYTES,
  MAX_TEMPLATE_DIRECTORY_DEPTH,
  MAX_TEMPLATE_DIRECTORY_ENTRIES,
} from "./source-limits.js";

export type TemplateDirectorySnapshot = {
  files: Array<{ path: string; byteLength: number; digest: string }>;
  byteLength: number;
  digest: string;
};

/** One selection contract serves packaging, review, installation and installed-content comparison. */
export async function snapshotTemplateDependencyDirectory(params: {
  rootDir: string;
  path?: string;
}): Promise<TemplateDirectorySnapshot> {
  if (
    params.path !== undefined &&
    (!isSafeTemplateRelativePath(params.path) ||
      portableTemplatePathKey(params.path)
        .split("/")
        .some((part) => part === ".git" || part === "node_modules"))
  ) {
    throw new Error("Bundled dependency path must be package-relative.");
  }
  const directory = resolve(params.rootDir, params.path ?? "");
  await assertNoSymlinkParents({
    rootDir: params.rootDir,
    targetPath: directory,
    allowMissing: false,
    messagePrefix: "Bundled dependency",
  });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Bundled dependency must be a regular directory.");
  }
  const excluded = (path: string) =>
    portableTemplatePathKey(path)
      .split("/")
      .some((part) => part === ".git" || part === "node_modules");
  const walked = await walkDirectory(directory, {
    // Read one boundary level so depth exhaustion cannot silently omit eligible files.
    maxDepth: MAX_TEMPLATE_DIRECTORY_DEPTH + 1,
    maxEntries: MAX_TEMPLATE_DIRECTORY_ENTRIES,
    symlinks: "include",
    descend: (entry) => !excluded(entry.relativePath),
    include: (entry) => !excluded(entry.relativePath),
  });
  if (walked.truncated || walked.failedDirs.length) {
    throw new Error(
      "Bundled dependency directory exceeds traversal limits or could not be read completely.",
    );
  }
  const root = await fsSafeRoot(directory);
  const files: TemplateDirectorySnapshot["files"] = [];
  const portablePaths = new Set<string>();
  let byteLength = 0;
  for (const entry of walked.entries.toSorted((a, b) =>
    Buffer.compare(Buffer.from(a.relativePath), Buffer.from(b.relativePath)),
  )) {
    if (entry.depth > MAX_TEMPLATE_DIRECTORY_DEPTH) {
      throw new Error("Bundled dependency exceeds its directory depth limit.");
    }
    const path = entry.relativePath.replaceAll("\\", "/");
    const key = portableTemplatePathKey(path);
    if (!isSafeTemplateRelativePath(path) || portablePaths.has(key)) {
      throw new Error(`Bundled dependency has an unsafe or colliding path: ${path}.`);
    }
    portablePaths.add(key);
    if (entry.kind === "directory") {
      continue;
    }
    if (entry.kind !== "file") {
      throw new Error(`Bundled dependency contains a link or nonregular file: ${path}.`);
    }
    const read = await root.read(path, {
      symlinks: "reject",
      hardlinks: "reject",
      maxBytes: MAX_MANAGED_FILE_BYTES,
    });
    byteLength += read.buffer.byteLength;
    if (byteLength > MAX_TEMPLATE_DIRECTORY_BYTES) {
      throw new Error("Bundled dependency exceeds its total byte limit.");
    }
    files.push({
      path,
      byteLength: read.buffer.byteLength,
      digest: digestTemplateBytes(read.buffer),
    });
  }
  return { files, byteLength, digest: digestTemplateValue(files) };
}

/** Installers consume an immutable copy of exactly the reviewed eligible bytes. */
export async function materializeTemplateDependencyDirectory(params: {
  rootDir: string;
  path: string;
  snapshot: TemplateDirectorySnapshot;
}): Promise<AsyncDisposable & { directory: string; createArchive(): Promise<string> }> {
  const current = await snapshotTemplateDependencyDirectory(params);
  if (current.digest !== params.snapshot.digest) {
    throw new Error("Bundled dependency changed after review; create a fresh Add plan.");
  }
  const temporary = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "openclaw-template-dependency-",
  });
  try {
    const directory = temporary.path("package");
    await mkdir(directory);
    const source = await fsSafeRoot(resolve(params.rootDir, params.path));
    const target = await fsSafeRoot(directory);
    for (const file of params.snapshot.files) {
      const read = await source.read(file.path, {
        hardlinks: "reject",
        symlinks: "reject",
        maxBytes: MAX_MANAGED_FILE_BYTES,
      });
      if (
        read.buffer.byteLength !== file.byteLength ||
        digestTemplateBytes(read.buffer) !== file.digest
      ) {
        throw new Error("Bundled dependency changed while preparing installation.");
      }
      await mkdir(join(directory, dirname(file.path)), { recursive: true });
      await target.create(file.path, read.buffer);
    }
    const afterCopy = await snapshotTemplateDependencyDirectory(params);
    if (afterCopy.digest !== params.snapshot.digest) {
      throw new Error("Bundled dependency membership changed while preparing installation.");
    }
    let archive: string | undefined;
    return {
      directory,
      createArchive: async () => {
        if (!archive) {
          archive = temporary.path("dependency.tgz");
          await tar.c(
            {
              cwd: directory,
              file: archive,
              prefix: "package",
              portable: true,
              mtime: new Date(0),
              gzip: { level: 9, portable: true, strategy: 1 },
            },
            params.snapshot.files.map((file) =>
              file.path.startsWith("@") ? `./${file.path}` : file.path,
            ),
          );
        }
        return archive;
      },
      [Symbol.asyncDispose]: temporary[Symbol.asyncDispose],
    };
  } catch (error) {
    await temporary[Symbol.asyncDispose]();
    throw error;
  }
}
