import fs from "node:fs";
import path from "node:path";

type ArtifactOptions = {
  executableFiles?: Iterable<string>;
  allowLinksWithin?: string;
  publishedRoot?: string;
  preserveExecutable?: boolean;
  ownerRoot?: string;
  readFiles?: boolean;
  resolveLinks?: boolean;
};

export function generatedArtifactMode(
  mode: number,
  directory: boolean,
  executable = false,
): number {
  return directory || executable || (mode & 0o100) !== 0 ? 0o755 : 0o644;
}

export function artifactPermissionError(
  mode: number,
  directory: boolean,
  executable = false,
): string | undefined {
  if ((mode & 0o7000) !== 0 || (mode & 0o022) !== 0) {
    return "has special or group/other-writable permission bits";
  }
  if ((mode & 0o444) !== 0o444) {
    return "is not world-readable";
  }
  if ((directory || executable || (mode & 0o111) !== 0) && (mode & 0o111) !== 0o111) {
    return "is not world-traversable/executable";
  }
  return undefined;
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function regularPath(file: string): fs.Stats {
  const stat = fs.lstatSync(file);
  if (!stat.isDirectory() && !stat.isFile()) {
    throw new Error(`Artifact mutation requires a regular file or directory: ${file}`);
  }
  return stat;
}

function realParent(file: string) {
  const parent = path.dirname(file);
  if (fs.realpathSync(parent) !== parent) {
    throw new Error(`Artifact parent is a symbolic link: ${parent}`);
  }
}

/** Only generated descendants are widened; the caller's package/home root is not. */
export function ensureGeneratedArtifactDirectory(directory: string, ownerRoot: string): void {
  const root = fs.realpathSync(ownerRoot);
  const target = path.resolve(directory);
  if (!inside(root, target)) {
    throw new Error(`Generated directory must be below its owner: ${target}`);
  }
  if (target === root) {
    regularPath(root);
    return;
  }
  let current = root;
  const directories: string[] = [];
  for (const part of path.relative(root, target).split(path.sep)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat && !stat.isDirectory()) {
      throw new Error(`Generated directory is not a real directory: ${current}`);
    }
    directories.push(current);
  }
  // Preflight every existing component before changing any of them.
  for (const entry of directories) {
    if (!fs.existsSync(entry)) {
      fs.mkdirSync(entry, { recursive: false });
    }
    fs.chmodSync(entry, 0o755);
  }
}

function executablePaths(root: string, files: Iterable<string> = []): Set<string> {
  const result = new Set<string>();
  for (const file of files) {
    const resolved = path.resolve(root, file);
    if (!inside(root, resolved) || resolved === root) {
      throw new Error(`Executable declaration escapes artifact root: ${file}`);
    }
    result.add(resolved);
  }
  return result;
}

type ArtifactEntry = { file: string; stat: fs.Stats };

function artifactEntries(root: string, options: ArtifactOptions, resolveLinks: boolean) {
  realParent(root);
  const entries: ArtifactEntry[] = [];
  const visited = new Set<string>();
  const closure = options.allowLinksWithin && fs.realpathSync(options.allowLinksWithin);
  const visit = (file: string) => {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) {
      const base = options.publishedRoot
        ? path.join(path.resolve(options.publishedRoot), path.relative(root, file))
        : file;
      const target = path.resolve(path.dirname(base), fs.readlinkSync(file));
      if (!closure || !inside(closure, target)) {
        throw new Error(`Artifact link escapes its immutable closure: ${file}`);
      }
      if (resolveLinks) {
        const real = fs.realpathSync(file);
        if (!inside(closure, real)) {
          throw new Error(`Artifact link resolves outside its immutable closure: ${file}`);
        }
        if (options.resolveLinks !== false) {
          visit(real);
        }
      }
      return;
    }
    if (!stat.isDirectory() && !stat.isFile()) {
      throw new Error(`Unsupported artifact entry: ${file}`);
    }
    if (visited.has(file)) {
      return;
    }
    visited.add(file);
    entries.push({ file, stat });
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file)) {
        visit(path.join(file, name));
      }
    }
  };
  regularPath(root);
  visit(root);
  return entries;
}

/** Preflight the entire mutation set; never chmod through a nested link. */
export function normalizeGeneratedArtifactTree(
  rootPath: string,
  options: ArtifactOptions = {},
): void {
  const root = path.resolve(rootPath);
  const required = executablePaths(root, options.executableFiles);
  const entries = artifactEntries(root, options, false);
  for (const { file, stat } of entries) {
    if (stat.isFile() && stat.nlink !== 1) {
      throw new Error(`Artifact mutation requires an exclusively owned file inode: ${file}`);
    }
  }
  for (const { file, stat } of entries) {
    const mode = options.preserveExecutable === false ? 0 : stat.mode;
    fs.chmodSync(file, generatedArtifactMode(mode, stat.isDirectory(), required.has(file)));
  }
}

/** Verification never repairs modes; readFiles exercises the actual runtime identity. */
export function assertArtifactTreeReadable(rootPath: string, options: ArtifactOptions = {}) {
  const root = path.resolve(rootPath);
  const required = executablePaths(root, options.executableFiles);
  const entries = artifactEntries(root, options, true);
  const paths = new Set(entries.map(({ file }) => file));
  for (const executable of required) {
    if (!paths.has(executable) || !fs.statSync(executable).isFile()) {
      throw new Error(`Missing declared artifact executable: ${executable}`);
    }
  }
  if (options.ownerRoot) {
    const owner = fs.realpathSync(options.ownerRoot);
    if (!inside(owner, root)) {
      throw new Error(`Artifact root escapes its owner: ${root}`);
    }
    if (root !== owner) {
      for (let parent = path.dirname(root); parent !== owner; parent = path.dirname(parent)) {
        const stat = regularPath(parent);
        entries.push({ file: parent, stat });
      }
    }
  }
  for (const { file, stat } of entries) {
    const error =
      process.platform !== "win32" &&
      artifactPermissionError(stat.mode, stat.isDirectory(), required.has(file));
    if (error) {
      throw new Error(`Artifact ${error} (0${(stat.mode & 0o7777).toString(8)}): ${file}`);
    }
    if (options.readFiles && stat.isFile()) {
      const handle = fs.openSync(file, "r");
      try {
        fs.readSync(handle, Buffer.alloc(1), 0, 1, 0);
      } finally {
        fs.closeSync(handle);
      }
    }
  }
  return {
    files: entries.filter(({ stat }) => stat.isFile()).length,
    directories: entries.filter(({ stat }) => stat.isDirectory()).length,
  };
}

/** Package declarations, not observed mode bits, define required launchers. */
export function declaredArtifactExecutableFiles(manifest: Record<string, unknown>): string[] {
  const bin = manifest.bin;
  if (
    bin !== undefined &&
    (bin === null || (typeof bin !== "string" && (typeof bin !== "object" || Array.isArray(bin))))
  ) {
    throw new Error("bin must be a string or an object of executable paths");
  }
  const files: unknown[] = typeof bin === "string" ? [bin] : bin ? Object.values(bin) : [];
  const config = manifest.publishConfig;
  if (config && typeof config === "object" && "executableFiles" in config) {
    const declarations = config.executableFiles;
    if (!Array.isArray(declarations)) {
      throw new Error("publishConfig.executableFiles must be an array");
    }
    files.push(...declarations);
  }
  return [
    ...new Set(
      files.map((file) => {
        if (
          typeof file !== "string" ||
          !file ||
          file.includes("\\") ||
          file.includes("\0") ||
          path.posix.isAbsolute(file) ||
          path.win32.isAbsolute(file)
        ) {
          throw new Error("Invalid artifact executable declaration");
        }
        const normalized = file.replace(/^\.\//u, "");
        if (
          !normalized ||
          normalized.split("/").some((part) => !part || part === "." || part === "..")
        ) {
          throw new Error("Invalid artifact executable declaration");
        }
        return normalized;
      }),
    ),
  ];
}
