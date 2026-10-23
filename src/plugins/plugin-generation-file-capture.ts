import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  createRootFileCopyBatchSync,
  createRootFileOpenBatchSync,
  type RootFileCopyBatchSync,
  type RootFileOpenBatchSync,
} from "@openclaw/fs-safe/advanced";
import { hasErrnoCode } from "../infra/errno.js";
import { isPathInside } from "../infra/path-guards.js";
import type { createPluginGenerationReceipt } from "./plugin-generation-receipt.js";
import type { PluginRecoverySource } from "./plugin-generation-source-lookup.js";
import type { createPluginNativeAdmission } from "./plugin-native-admission.js";
import type { createPluginSourceCapture } from "./plugin-package-metadata-capture.js";
import { copyPluginSourceFile } from "./plugin-source-file.js";
import {
  readPluginSourceDirectory,
  type PluginCapturedSourceFact,
} from "./plugin-source-verification.js";

/** Publish only verified dependency links; real nested installs keep their own bytes. */
export function linkPluginGenerationDependency(link: string, target: string): boolean {
  const entry = fs.lstatSync(link, { throwIfNoEntry: false });
  if (entry && !entry.isSymbolicLink()) {
    return false;
  }
  if (
    entry &&
    path.resolve(path.dirname(link), fs.readlinkSync(link)) === target &&
    fs.statSync(link, { throwIfNoEntry: false })
  ) {
    return false;
  }
  fs.mkdirSync(path.dirname(link), { recursive: true, mode: 0o700 });
  if (process.platform === "win32") {
    if (entry) {
      // MoveFileEx cannot replace a directory junction. Unlink only the reparse point.
      if (!fs.lstatSync(link).isSymbolicLink()) {
        throw new Error(`Dependency link became a real entry: ${link}`);
      }
      fs.unlinkSync(link);
    }
    fs.symlinkSync(target, link, "junction");
  } else {
    const staged = `${link}.${randomUUID()}.tmp`;
    try {
      fs.symlinkSync(path.relative(path.dirname(link), target), staged, "junction");
      fs.renameSync(staged, link);
    } finally {
      fs.rmSync(staged, { force: true });
    }
  }
  if (!fs.lstatSync(link).isSymbolicLink() || fs.realpathSync(link) !== fs.realpathSync(target)) {
    throw new Error(`Dependency link does not resolve to its captured target: ${link}`);
  }
  if (entry) {
    process.emitWarning(`Replacing plugin dependency link ${link}`);
  }
  return true;
}

/** Native child imports can follow host identity without borrowing parent resolver hooks. */
export function linkPluginGenerationHostModule(link: string, target: string): boolean {
  if (fs.lstatSync(link, { throwIfNoEntry: false })) {
    return false;
  }
  fs.mkdirSync(path.dirname(link), { recursive: true, mode: 0o700 });
  try {
    fs.symlinkSync(target, link, "file");
    return true;
  } catch (error) {
    // Directory junctions can work where file links are denied. Keep the
    // existing parent redirect; never copy a second SDK graph.
    if (!["EPERM", "EACCES", "ENOSYS", "ENOTSUP"].some((code) => hasErrnoCode(error, code))) {
      throw error;
    }
    return false;
  }
}

export function createPluginSourceLinkCapture() {
  const links = new Set<string>();
  return {
    defer(filename: string, root: string, source = filename): boolean {
      if (
        !fs.lstatSync(filename).isSymbolicLink() ||
        isPathInside(root, fs.realpathSync(filename))
      ) {
        return false;
      }
      links.add(source);
      return true;
    },
    contains: (filename: string) => [...links].some((link) => isPathInside(link, filename)),
  };
}

/** Capture each selected package file once, retaining its source facts and ordered receipt. */
export function createPluginGenerationFileCapture({
  boundary,
  destination,
  directory,
  outputRoot,
  capturedPaths,
  originalSources,
  hardlinkedSources,
  sourceCapture,
  sourceLinks,
  deferExternalLinks,
  nativeAdmission,
  receipt,
  retained,
  sourceFacts,
  onPackageMetadata,
}: {
  boundary: string;
  destination: string;
  directory: string;
  outputRoot?: string;
  capturedPaths: Map<string, string>;
  originalSources: Map<string, string>;
  hardlinkedSources: Set<string>;
  sourceCapture: Pick<ReturnType<typeof createPluginSourceCapture>, "additions">;
  sourceLinks: ReturnType<typeof createPluginSourceLinkCapture>;
  deferExternalLinks: boolean;
  nativeAdmission: ReturnType<typeof createPluginNativeAdmission>;
  receipt: ReturnType<typeof createPluginGenerationReceipt>;
  retained?: { source: PluginRecoverySource; files: ReadonlyMap<string, PluginCapturedSourceFact> };
  sourceFacts?: Map<string, PluginCapturedSourceFact>;
  onPackageMetadata: (source: string, target: string) => void;
}) {
  const { additions } = sourceCapture;
  const ancestors = new Set<string>();
  const copy = (
    source: string,
    target: string,
    copyFile: RootFileCopyBatchSync["copyFile"],
    openFile: RootFileOpenBatchSync["openFile"],
  ) => {
    // Metadata can precede its package body; promotion never replaces those captured bytes.
    if (capturedPaths.get(path.resolve(source)) === target) {
      return;
    }
    const prepared = nativeAdmission.resolvePreparedSource(source);
    const input = prepared?.path ?? source;
    const inputBoundary = prepared?.boundary ?? boundary;
    const real = fs.realpathSync(input);
    const retainedNative = nativeAdmission.isRetainedReference(source, real);
    if (!isPathInside(inputBoundary, real) && !retainedNative) {
      throw new Error(
        `Plugin source link leaves its package: ${path.relative(boundary, source)}. Declare shared code as a package dependency.`,
      );
    }
    if (!prepared && outputRoot && isPathInside(outputRoot, real)) {
      return;
    }
    const stat = fs.statSync(real, { bigint: true });
    const captured = capturedPaths.get(real);
    capturedPaths.set(path.resolve(source), target);
    originalSources.set(target, path.resolve(source));
    // SDK companion loaders receive copied paths; those exact aliases retain this owner.
    capturedPaths.set(target, target);
    if (!capturedPaths.has(real)) {
      capturedPaths.set(real, target);
    }
    // Receipts cover copied empty directories as well as file contents.
    receipt.marker(
      `${stat.isDirectory() ? "directory" : "file"}\0${path.relative(destination, target)}\0`,
    );
    if (stat.isDirectory()) {
      if (ancestors.has(real)) {
        throw new Error(`Plugin source contains a directory cycle: ${source}`);
      }
      ancestors.add(real);
      fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      for (const name of readPluginSourceDirectory(real)) {
        if (
          !(
            deferExternalLinks &&
            !nativeAdmission.isRetainedReference(path.join(source, name)) &&
            sourceLinks.defer(path.join(input, name), inputBoundary, path.join(source, name))
          )
        ) {
          copy(path.join(source, name), path.join(target, name), copyFile, openFile);
        }
      }
      ancestors.delete(real);
    } else if (stat.isFile()) {
      if (stat.nlink > 1n) {
        hardlinkedSources.add(target);
      }
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      // Register before copying or admission can fail: known aliases must remain
      // rejected by the acquisition owner even when the first attempt is incomplete.
      additions.add(target);
      const retainedFile = retained?.files.get(path.relative(directory, target));
      const retainedReference = retained?.source.native?.references.has(target);
      if (retainedReference) {
        // The fork owns this validated reference; the new lease must admit its own native owner.
        fs.unlinkSync(target);
      }
      const native = nativeAdmission.materialize(real, inputBoundary, target, stat, source);
      let copiedContent: PluginCapturedSourceFact | undefined;
      if (!native && retainedFile && !retainedReference) {
        // The receipt verifies the private copy against these retained content facts.
        copiedContent = retainedFile;
      } else if (!native) {
        // A second filename for a prefetched entry retains its first bytes.
        copiedContent = copyPluginSourceFile(
          captured ?? real,
          captured ? directory : inputBoundary,
          target,
          {
            hashCopiedContent: true,
            copyFile,
            openFile,
            ...(captured ? { preserveSourceMode: true } : {}),
          },
        );
      }
      receipt.file(
        {
          target: native?.path ?? target,
          boundary: native?.boundary ?? directory,
          sizeBytes: Number(stat.size),
          native: native !== undefined,
          prepared: native?.content ?? copiedContent,
          onContent: (content) => {
            native?.record(content);
            sourceFacts?.set(path.relative(directory, target), content);
          },
        },
        openFile,
      );
      if (path.basename(target) === "package.json") {
        onPackageMetadata(source, target);
      }
    } else {
      throw new Error(`Plugin build input is not a regular file: ${source}`);
    }
  };
  return (source: string, target: string) => {
    using batch = createRootFileCopyBatchSync();
    // Retained roots never outlive this synchronous capture or reach tree retirement.
    using opened = createRootFileOpenBatchSync();
    return copy(source, target, batch.copyFile.bind(batch), opened.openFile.bind(opened));
  };
}
