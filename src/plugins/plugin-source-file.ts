import { createHash, type Hash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  copyFileDescriptorSync,
  copyRootFileSync,
  createFileSync,
} from "@openclaw/fs-safe/advanced";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import { openRootFileSync } from "../infra/boundary-file-read.js";
import { hasErrnoCode } from "../infra/errno.js";
import {
  collectErrorGraphCandidates,
  extractErrorCode,
  formatErrorMessage,
  readErrorCauses,
} from "../infra/errors.js";
import { isPathInside } from "../infra/path-guards.js";
import { isGitRuntimeStagingName } from "../infra/update-runtime-staging.js";
import { getPluginGenerationMetrics } from "./plugin-generation-metrics.js";
import {
  acquirePluginSource,
  clearPluginSourceAcquisitionError,
  createPluginSourceValidationError,
  markPluginSourceAcquisitionError,
} from "./plugin-instance-error.js";

// Git rollback trees retain links relative to their final location. Only explicit
// dependency selection may own them; incidental plugin walks must leave them alone.
export const isPluginSourceEntry = (name: string): boolean =>
  name !== "node_modules" && name !== ".git" && !isGitRuntimeStagingName(name);

export function readPluginCapturedCode(filename: string, capturedDirectory = false): string {
  try {
    return fs.readFileSync(filename, "utf8");
  } catch (error) {
    // Only a recorded directory selection is source validation; changed private type loses custody.
    throw capturedDirectory && hasErrnoCode(error, "EISDIR")
      ? markPluginSourceAcquisitionError(error)
      : clearPluginSourceAcquisitionError(error);
  }
}

export function realpathPluginSource(source: string, originalSource = true): string {
  return acquirePluginSource(() => fs.realpathSync(source), originalSource);
}

export function inspectPluginCaptureSource(
  source: string,
  boundary: string,
  prepared: { path: string; boundary: string } | undefined,
  isRetainedReference: (source: string, real: string) => boolean,
  outputRoot: string | undefined,
) {
  const real = realpathPluginSource(prepared?.path ?? source, !prepared);
  if (!isPathInside(prepared?.boundary ?? boundary, real) && !isRetainedReference(source, real)) {
    throw createPluginSourceValidationError(
      "Standalone plugin input leaves its source directory",
      !prepared,
    );
  }
  if (!prepared && outputRoot && isPathInside(outputRoot, real)) {
    return undefined;
  }
  return { real, directory: acquirePluginSource(() => fs.statSync(real), !prepared).isDirectory() };
}

export function createPluginSourceDirectoryCapture(
  captureFile: (source: string, ancestors: Set<string>) => void,
) {
  const scannedDirectories = new Set<string>();
  return (
    source: string,
    real: string,
    target: string,
    directoryAncestors: Set<string> | undefined,
    originalSource: boolean,
  ) => {
    if (directoryAncestors?.has(real)) {
      throw createPluginSourceValidationError(
        "Standalone plugin input contains a directory cycle",
        originalSource,
      );
    }
    if (!scannedDirectories.has(target)) {
      const ancestors = directoryAncestors ?? new Set<string>();
      ancestors.add(real);
      scannedDirectories.add(target);
      for (const name of acquirePluginSource(
        () => fs.readdirSync(real),
        originalSource,
      ).toSorted()) {
        if (isPluginSourceEntry(name)) {
          captureFile(path.join(source, name), ancestors);
        }
      }
      ancestors.delete(real);
      scannedDirectories.delete(target);
    }
  };
}

// Capture and native module hooks are synchronous; no read retains this scratch buffer.
const scratch = Buffer.allocUnsafe(64 * 1024);
const SMALL_SOURCE_COPY_BYTES = 64 * 1024;

export const pluginSourceStatIdentity = (
  stat: fs.BigIntStats,
  identity: Pick<fs.BigIntStats, "dev" | "ino"> = stat,
): string =>
  `${identity.dev}:${identity.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;

export const pluginSourceIdentityChangedOnlyByCtime = (
  previous: string,
  current: string,
): boolean =>
  previous.slice(0, previous.lastIndexOf(":")) === current.slice(0, current.lastIndexOf(":"));

function withPluginSourceFile<T>(
  source: string,
  boundary: string,
  read: (fd: number) => T,
  openFile = openRootFileSync,
  originalSource = false,
): T {
  const opened = acquirePluginSource(
    () =>
      openFile({
        absolutePath: source,
        rootPath: boundary,
        boundaryLabel: "plugin build source",
        rejectHardlinks: false,
      }),
    originalSource,
  );
  if (!opened.ok) {
    const error = new Error(`Cannot capture plugin source ${source}`, { cause: opened.error });
    throw originalSource ? markPluginSourceAcquisitionError(error) : error;
  }
  try {
    return acquirePluginSource(() => read(opened.fd), false);
  } finally {
    acquirePluginSource(() => fs.closeSync(opened.fd), false);
  }
}

export function isPluginNativeExecutable(source: string, boundary: string): boolean {
  return withPluginSourceFile(source, boundary, isPluginNativeDescriptor);
}

export function isPluginWasmModule(source: string, boundary: string): boolean {
  return withPluginSourceFile(
    source,
    boundary,
    (fd) => fs.readSync(fd, scratch, 0, 4, 0) === 4 && scratch.readUInt32BE(0) === 0x0061736d,
  );
}

function isPluginNativeDescriptor(fd: number): boolean {
  if (fs.readSync(fd, scratch, 0, 4, 0) !== 4) {
    return false;
  }
  const magic = scratch.readUInt32BE(0);
  return (
    scratch.readUInt16BE(0) === 0x4d5a ||
    [0x7f454c46, 0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(
      magic,
    )
  );
}

/**
 * fs-safe copy admission compares an ordinary and a native realpath of its root, so a
 * Windows 8.3 alias such as `C:\Users\RUNNER~1` always reads as a moved root.
 * Rebase the admitted source onto the root's native spelling before handing it over.
 */
function resolveNativeCopySource(boundary: string, source: string) {
  if (process.platform !== "win32") {
    return { rootPath: boundary, absolutePath: source };
  }
  const rootPath = fs.realpathSync.native(boundary);
  const relative = path.relative(boundary, source);
  if (rootPath === boundary || relative.startsWith("..") || path.isAbsolute(relative)) {
    return { rootPath: boundary, absolutePath: source };
  }
  return { rootPath, absolutePath: path.join(rootPath, relative) };
}

export function copyPluginSourceFile(
  source: string,
  boundary: string,
  target: string,
  options: {
    hashCopiedContent?: boolean;
    preserveSourceMode?: boolean;
    copyFile?: typeof copyRootFileSync;
    openFile?: typeof openRootFileSync;
  } = {},
) {
  return withPluginSourceFile(
    source,
    boundary,
    (fd) => {
      const admitted = fs.fstatSync(fd, { bigint: true });
      try {
        const metrics = getPluginGenerationMetrics();
        const mode = options.preserveSourceMode
          ? Number(admitted.mode & 0o777n)
          : 0o600 | Number(admitted.mode & 0o100n);
        // Windows needs this path most: fs-safe skips native copies and path-admission
        // caching on win32, so guarded clones of every small file stall Gateway startup.
        if (
          admitted.size <= BigInt(SMALL_SOURCE_COPY_BYTES) &&
          !/\.(?:node|so|dylib|dll)$/iu.test(source) &&
          !isPluginNativeDescriptor(fd) &&
          fs.realpathSync.native(path.dirname(target)) === path.dirname(target)
        ) {
          const hashCopiedContent = options.hashCopiedContent;
          using copied = createFileSync(target, { mode: 0o600 });
          const identity = fs.fstatSync(copied.fd, { bigint: true });
          // The pinned source and exclusive output own this synchronous transfer.
          // Source edits after opening are best effort; validate the completed destination once.
          const bytes = copyFileDescriptorSync(fd, copied.fd, {
            maxBytes: Number(admitted.size),
          });
          if (bytes !== Number(admitted.size)) {
            throw new FsSafeError("path-mismatch", "Plugin source changed while copying");
          }
          if (metrics) {
            metrics.copiedBytes += bytes;
          }
          fs.fchmodSync(copied.fd, mode);
          const named = fs.lstatSync(target, { bigint: true });
          const current = fs.fstatSync(copied.fd, { bigint: true });
          if (
            !named.isFile() ||
            named.nlink !== 1n ||
            named.dev !== identity.dev ||
            named.ino !== identity.ino ||
            !current.isFile() ||
            current.nlink !== 1n ||
            current.dev !== identity.dev ||
            current.ino !== identity.ino
          ) {
            throw new FsSafeError(
              "path-mismatch",
              "Plugin capture destination changed during copying",
            );
          }
          return hashCopiedContent
            ? {
                ...hashPluginSourceDescriptor(copied.fd),
                sourceIdentity: pluginSourceStatIdentity(admitted),
              }
            : undefined;
        }
        // Keep our pin alive; fs-safe binds its own admitted open to this exact inode.
        using copied = (options.copyFile ?? copyRootFileSync)({
          source: resolveNativeCopySource(boundary, source),
          destination: { rootPath: path.dirname(target), absolutePath: target },
          expectedSourceIdentity: { dev: admitted.dev, ino: admitted.ino },
          clone: "auto",
          maxBytes: Number(admitted.size),
          mode,
          sourceHardlinks: "allow",
        });
        if (metrics) {
          metrics.copiedBytes += copied.bytes;
        }
        // The initial hash belongs to the copied descriptor; receipts still recheck its path.
        return options.hashCopiedContent
          ? {
              ...hashPluginSourceDescriptor(copied.fd),
              sourceIdentity: pluginSourceStatIdentity(admitted, copied.sourceIdentity),
            }
          : undefined;
      } catch (error) {
        // fs-safe wraps native failures; retain the disk-full code and detail that
        // plugin-load diagnostics use to explain how to recover.
        if (
          error instanceof FsSafeError &&
          collectErrorGraphCandidates(error, readErrorCauses).some(
            (cause) => extractErrorCode(cause) === "ENOSPC",
          )
        ) {
          throw Object.assign(new Error(formatErrorMessage(error), { cause: error }), {
            code: "ENOSPC",
          });
        }
        if (error instanceof FsSafeError && error.code === "too-large") {
          throw new Error(
            "Plugin source changed while preparing its reload; retry after the edit finishes.",
            { cause: error },
          );
        }
        throw error;
      }
    },
    options.openFile,
    // Retained copies and receipt reads validate private custody, rather than new source input.
    options.preserveSourceMode !== true,
  );
}

export function linkPluginSourceFile(source: string, boundary: string, target: string): void {
  withPluginSourceFile(source, boundary, (fd) => {
    const admitted = fs.fstatSync(fd, { bigint: true });
    fs.linkSync(source, target);
    const linked = fs.statSync(target, { bigint: true });
    if (linked.dev !== admitted.dev || linked.ino !== admitted.ino) {
      throw new Error("Native plugin artifact changed during admission");
    }
  });
}

export function hashPluginSourceFile(
  source: string,
  boundary: string,
  receipt?: Hash,
  prepared?: { contentHash: string; sizeBytes: number },
  openFile = openRootFileSync,
) {
  return withPluginSourceFile(
    source,
    boundary,
    (fd) => hashPluginSourceDescriptor(fd, receipt, prepared),
    openFile,
  );
}

function hashPluginSourceDescriptor(
  fd: number,
  receipt?: Hash,
  prepared?: { contentHash: string; sizeBytes: number },
) {
  const content = prepared ? undefined : createHash("sha256");
  const sizeBytes = prepared?.sizeBytes ?? fs.fstatSync(fd).size;
  receipt?.update(String(sizeBytes)).update("\0");
  let position = 0;
  for (;;) {
    const length = fs.readSync(
      fd,
      scratch,
      0,
      Math.min(scratch.length, sizeBytes - position + 1),
      position,
    );
    position += length;
    if (length === 0 || position > sizeBytes) {
      break;
    }
    const chunk = scratch.subarray(0, length);
    content?.update(chunk);
    receipt?.update(chunk);
  }
  const metrics = getPluginGenerationMetrics();
  if (metrics) {
    metrics.hashReadBytes += position;
  }
  if (position !== sizeBytes) {
    throw new Error(
      "Plugin source changed while preparing its reload; retry after the edit finishes.",
    );
  }
  return prepared ?? { contentHash: content!.digest("hex"), sizeBytes };
}
