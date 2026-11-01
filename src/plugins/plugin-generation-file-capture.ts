import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  createRootFileCopyBatchSync,
  createRootFileOpenBatchSync,
  type RootFileCopyBatchSync,
  type RootFileOpenBatchSync,
} from "@openclaw/fs-safe/advanced";
import { isPathInside, normalizeWindowsPathPreservingCase } from "../infra/path-guards.js";
import { getPluginGenerationMetrics } from "./plugin-generation-metrics.js";
import type { createPluginGenerationReceipt } from "./plugin-generation-receipt.js";
import type { PluginRecoverySource } from "./plugin-generation-source-lookup.js";
import { acquirePluginSource, createPluginSourceValidationError } from "./plugin-instance-error.js";
import type { createPluginNativeAdmission } from "./plugin-native-admission.js";
import type { createPluginSourceCapture } from "./plugin-package-metadata-capture.js";
import { copyPluginSourceFile } from "./plugin-source-file.js";
import {
  readPluginSourceDirectory,
  type PluginCapturedSourceFact,
} from "./plugin-source-verification.js";

/** Publish only verified dependency links; real nested installs keep their own bytes. */
export function linkPluginGenerationDependency(
  link: string,
  target: string,
  pendingTarget?: string,
): boolean {
  const entry = fs.lstatSync(link, { throwIfNoEntry: false });
  if (pendingTarget && (entry || !fs.lstatSync(pendingTarget).isDirectory())) {
    throw new Error(`Pending dependency link does not own an empty destination: ${link}`);
  }
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
  acquirePluginSource(() => fs.mkdirSync(path.dirname(link), { recursive: true, mode: 0o700 }));
  if (process.platform === "win32") {
    if (entry) {
      // MoveFileEx cannot replace a directory junction. Unlink only the reparse point.
      if (!fs.lstatSync(link).isSymbolicLink()) {
        throw new Error(`Dependency link became a real entry: ${link}`);
      }
      acquirePluginSource(() => fs.unlinkSync(link));
    }
    acquirePluginSource(() => fs.symlinkSync(target, link, "junction"));
  } else {
    const staged = `${link}.${randomUUID()}.tmp`;
    try {
      acquirePluginSource(() => {
        fs.symlinkSync(path.relative(path.dirname(link), target), staged, "junction");
        fs.renameSync(staged, link);
      });
    } finally {
      fs.rmSync(staged, { force: true });
    }
  }
  const normalize = (value: string) =>
    process.platform === "win32" ? normalizeWindowsPathPreservingCase(value) : value;
  if (
    !fs.lstatSync(link).isSymbolicLink() ||
    (pendingTarget
      ? normalize(path.resolve(path.dirname(link), fs.readlinkSync(link))) !==
          normalize(path.resolve(target)) ||
        normalize(fs.realpathSync(pendingTarget)) !== normalize(pendingTarget)
      : fs.realpathSync(link) !== fs.realpathSync(target))
  ) {
    throw new Error(`Dependency link does not resolve to its captured target: ${link}`);
  }
  if (entry) {
    process.emitWarning(`Replacing plugin dependency link ${link}`);
  }
  return true;
}

export function createPluginSourceLinkCapture() {
  const links = new Set<string>();
  return {
    defer(
      filename: string,
      root: string,
      source: string,
      entry: fs.BigIntStats,
      originalSource = true,
    ): boolean {
      if (
        !entry.isSymbolicLink() ||
        isPathInside(
          root,
          acquirePluginSource(() => fs.realpathSync(filename), originalSource),
        )
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
  packageKind,
  outputRoot,
  capturedPaths,
  capturedDirectories,
  originalSources,
  hardlinkedSources,
  sourceCapture,
  sourceLinks,
  deferExternalLinks,
  nativeAdmission,
  sourceOnly = false,
  retainedSnapshotSource = false,
  receipt,
  retained,
  sourceFacts,
  onPackageMetadata,
}: {
  boundary: string;
  destination: string;
  directory: string;
  packageKind: "package" | "dependency";
  outputRoot?: string;
  capturedPaths: Map<string, string>;
  capturedDirectories: Set<string>;
  originalSources: Map<string, string>;
  hardlinkedSources: Set<string>;
  sourceCapture: Pick<ReturnType<typeof createPluginSourceCapture>, "additions">;
  sourceLinks: ReturnType<typeof createPluginSourceLinkCapture>;
  deferExternalLinks: boolean;
  nativeAdmission: ReturnType<typeof createPluginNativeAdmission>;
  sourceOnly?: boolean;
  retainedSnapshotSource?: boolean;
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
    realParent?: string,
    sourceEntry?: fs.BigIntStats,
  ) => {
    const metrics = getPluginGenerationMetrics();
    // Metadata can precede its package body; promotion never replaces those captured bytes.
    if (capturedPaths.get(path.resolve(source)) === target) {
      return;
    }
    const prepared = nativeAdmission.resolvePreparedSource(source);
    const input = prepared?.path ?? source;
    const inputBoundary = prepared?.boundary ?? boundary;
    // Directory recursion shares child metadata and the real parent; only links need a path walk.
    const entry =
      !prepared && realParent
        ? (sourceEntry ?? acquirePluginSource(() => fs.lstatSync(input, { bigint: true })))
        : undefined;
    const ordinary = entry && !entry.isSymbolicLink();
    const real = ordinary
      ? path.join(realParent!, path.basename(input))
      : acquirePluginSource(() => fs.realpathSync(input), !prepared);
    const retainedNative = nativeAdmission.isRetainedReference(source, real);
    if (!isPathInside(inputBoundary, real) && !retainedNative) {
      throw createPluginSourceValidationError(
        `Plugin source link leaves its package: ${path.relative(boundary, source)}. Declare shared code as a package dependency.`,
        !prepared,
      );
    }
    if (!prepared && outputRoot && isPathInside(outputRoot, real)) {
      return;
    }
    const stat = ordinary
      ? entry
      : acquirePluginSource(() => fs.statSync(real, { bigint: true }), !prepared);
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
      capturedDirectories.add(target);
      if (ancestors.has(real)) {
        throw createPluginSourceValidationError(
          `Plugin source contains a directory cycle: ${source}`,
          !prepared,
        );
      }
      ancestors.add(real);
      fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      for (const name of readPluginSourceDirectory(real, !prepared)) {
        const childSource = path.join(source, name);
        const childInput = path.join(input, name);
        const childEntry =
          deferExternalLinks && !nativeAdmission.isRetainedReference(childSource)
            ? acquirePluginSource(() => fs.lstatSync(childInput, { bigint: true }), !prepared)
            : undefined;
        if (
          !childEntry ||
          !sourceLinks.defer(childInput, inputBoundary, childSource, childEntry, !prepared)
        ) {
          copy(childSource, path.join(target, name), copyFile, openFile, real, childEntry);
        }
      }
      ancestors.delete(real);
    } else if (stat.isFile()) {
      if (metrics) {
        metrics[packageKind === "package" ? "packageFiles" : "dependencyFiles"]++;
      }
      if (stat.nlink > 1n) {
        hardlinkedSources.add(target);
      }
      if (!realParent) {
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      }
      // Register before copying or admission can fail: known aliases must remain
      // rejected by the acquisition owner even when the first attempt is incomplete.
      additions.add(target);
      const retainedFile = retained?.files.get(path.relative(directory, target));
      const retainedReference = retained?.source.native?.references.has(target);
      if (
        metrics &&
        !retainedSnapshotSource &&
        !prepared &&
        !captured &&
        (!retainedFile || retainedReference)
      ) {
        metrics.originalBytes += Number(stat.size);
      }
      if (retainedReference) {
        // The fork owns this validated reference; the new lease must admit its own native owner.
        fs.unlinkSync(target);
      }
      const native = sourceOnly
        ? undefined
        : nativeAdmission.materialize(real, inputBoundary, target, stat, source);
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
            sourceFacts?.set(path.relative(directory, target), {
              ...content,
              mode: 0o600 | Number(stat.mode & 0o100n),
            });
          },
        },
        openFile,
      );
      if (path.basename(target) === "package.json") {
        onPackageMetadata(source, target);
      }
    } else {
      throw createPluginSourceValidationError(
        `Plugin build input is not a regular file: ${source}`,
        !prepared,
      );
    }
  };
  return (source: string, target: string) => {
    using batch = createRootFileCopyBatchSync();
    // Retained roots never outlive this synchronous capture or reach tree retirement.
    using opened = createRootFileOpenBatchSync();
    return copy(source, target, batch.copyFile.bind(batch), opened.openFile.bind(opened));
  };
}
